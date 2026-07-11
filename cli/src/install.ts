// install.ts — the `backthread install` onboarding glue.
//
// The one-motion first-run that lands capture in the rescue-mode aha moment. Three
// steps, in order:
//
//   1. AUTH HANDSHAKE — `ensureAuth`: if there's already a device token we
//      reuse it; otherwise run `backthread login` (the browser OAuth-loopback) once so the
//      device is authorized and `~/.backthread/config.json` is written at 0600.
//   2. REGISTER THE HOOKS — wire the per-turn `Stop` capture hook (decisions surface
//      mid-session, once merged) + the `SessionEnd` backstop so the log stays
//      self-maintaining. SEE the hook-mechanism note below.
//   3. CHAIN BACKFILL — `runBackfill` (this PR): walk the repo's past Claude Code
//      transcripts and run each through `runCapture`, so the decision log is
//      NON-EMPTY at the aha moment. Best-effort, never blocks.
//
// HOOK-REGISTRATION MECHANISM (the ticket asks us to choose + flag):
//   • PRIMARY = the PLUGIN MANIFEST. When Backthread is installed as a Claude Code plugin,
//     the SessionEnd hook is declared in `cli/hooks/hooks.json` (referenced from
//     `.claude-plugin/plugin.json`) and Claude Code registers it automatically on
//     install — we DON'T mutate the user's settings at all. This is the right home:
//     the hook ships + versions with the plugin, and uninstalling the plugin removes
//     it cleanly. (Schema confirmed against the current Claude Code plugin docs:
//     hooks/hooks.json, `command` type, exec form with `${CLAUDE_PLUGIN_ROOT}`.)
//   • FALLBACK = writing the USER-GLOBAL `~/.claude/settings.json`. For the bare
//     `npx backthread` (non-plugin) install path there is no manifest doing the
//     wiring, so `backthread install` writes the Stop + SessionEnd entries itself. It writes
//     the USER scope (`~/.claude/settings.json`), NOT the project `.claude/settings.json`
//     (ARP-680): a per-project hook is gitignored + absent from git worktrees, so
//     worktree/multi-repo sessions silently never capture — the exact bug that froze
//     the dogfood log for a week. The user-scope hook follows the user across every
//     repo + worktree, matching the plugin path. This is what `registerHook` does:
//     idempotent (re-running never duplicates the entry) + a strict MERGE (never
//     clobbers the user's other hooks/settings).
//
// TRUST COPY (never-store-source, restated for the plugin per /security): printed
// during install so the founder reads it before any transcript is processed —
// redaction happens LOCALLY; only DERIVED decisions leave the machine; on the
// server-inference path a REDACTED transcript (never source / tool I/O) is sent to
// our Worker. See TRUST_COPY below.
//
// POSTURE: install is interactive + user-invoked, so unlike the silent hook it
// REPORTS each step and returns a non-zero exit on a genuine auth failure. But the
// backfill leg is best-effort and never fails the install.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureAuth, type LoginOptions } from './login.js';
import { readConfig, type BackthreadConfig } from './config.js';
import { runBackfill, type BackfillSummary, type BackfillDeps, type BackfillInput } from './backfill.js';
import {
  runInstallAgent,
  type InstallAgent,
  type AgentInstallDeps,
  type AgentInstallResult,
} from './installAgent.js';

/** The never-store-source trust copy, restated for the plugin (consistent with /security). */
export const TRUST_COPY = [
  'How Backthread handles your code (the short version):',
  '  • Redaction happens LOCALLY, on this machine, before anything is sent.',
  '  • Your source code and tool output NEVER leave your machine.',
  '  • Only the DERIVED decisions (the "why") are stored in your Backthread log.',
  '  • Server-side inference (the default) sends a REDACTED transcript — prose only,',
  '    code blocks replaced with [code redacted] — to Backthread\'s Worker, never source.',
  '  Full details: https://app.backthread.dev/security',
].join('\n');

/**
 * The command the SessionEnd hook runs. It routes CC's SessionEnd through the shared
 * `--from-hook` entrypoint with `--detach`: the hook reads the payload off stdin,
 * re-spawns a DETACHED worker that does the slow redact→infer→persist round-trip, then
 * returns immediately. This keeps a ≥30s inference from being SIGTERM'd by CC's
 * SessionEnd hook timeout (or reaped on session exit) — completion-safe, never blocks
 * or delays the session, still always exits 0 (ARP-682). `--agent claude-code` selects
 * the CC payload shape; the detached child re-runs with `--no-detach` so it can't recurse.
 *
 * SELF-UPDATING (ARP-733): pinned to `backthread@latest` so npx RE-RESOLVES from the
 * registry each session instead of reusing a stale cached/global copy — turning the
 * bare-npx channel genuinely self-updating. It's already `--detach`ed, so the extra
 * resolve is invisible. NOTE: this is the `~/.claude/settings.json` FALLBACK only. The
 * PLUGIN manifest hook (cli/hooks/hooks.json) deliberately stays on the shipped self-
 * contained bundle (`${CLAUDE_PLUGIN_ROOT}/dist-bundle/backthread.js`), NOT `@latest` —
 * it updates via the marketplace, which keeps the plugin offline-safe + free of npm/
 * version-skew (the ARP-680/ARP-474 dogfood-freeze fix; founder-confirmed 2026-06-26).
 */
export const HOOK_COMMAND = 'npx backthread@latest capture --from-hook --agent claude-code --detach';

/**
 * Earlier hook commands we still recognize, so re-running `backthread install` after an
 * upgrade MIGRATES an existing registration to {@link HOOK_COMMAND} in place rather than
 * leaving the stale command or appending a duplicate (which would double-capture). Append
 * any future retired command strings here.
 *
 * Order doesn't matter (any match rewrites to HOOK_COMMAND). The two we've shipped:
 *   1. the pre-ARP-682 bare command (no `--from-hook`/`--detach`);
 *   2. the ARP-682 completion-safe form WITHOUT the `@latest` pin (ARP-733 adds it) —
 *      so a user who installed between ARP-682 and ARP-733 gets migrated to the self-
 *      updating form in place on their next `backthread install`.
 */
const LEGACY_HOOK_COMMANDS: readonly string[] = [
  'npx backthread capture',
  'npx backthread capture --from-hook --agent claude-code --detach',
];

/** Every command string that is "ours" — the current one plus any retired ones. */
const OUR_HOOK_COMMANDS: ReadonlySet<string> = new Set([HOOK_COMMAND, ...LEGACY_HOOK_COMMANDS]);

/** Options for `backthread install`. */
export interface InstallOptions {
  /** Working directory (the repo to backfill + write .claude/settings.json under). Defaults to cwd. */
  cwd?: string;
  /** Skip the browser login step (e.g. CI / already authed). Default false. */
  skipAuth?: boolean;
  /**
   * A single-use claim code from the web app's onboarding —
   * `npx backthread install --claim …`. Exchanged for a device token instead of
   * the browser loopback (threaded into ensureAuth → login). Ignored with skipAuth.
   */
  claim?: string;
  /** Skip writing .claude/settings.json (e.g. installed as a plugin → manifest registers the hook). Default false. */
  skipHook?: boolean;
  /** Skip the one-shot backfill. Default false. */
  skipBackfill?: boolean;
  /**
   * Target agent. undefined / 'claude-code' = the Claude Code path (user-global
   * settings.json hook + backfill). 'codex' | 'cursor' | 'gemini' = write THAT agent's
   * user-global MCP config + capture hook instead (no CC settings.json, no CC backfill).
   */
  agent?: InstallAgent | 'claude-code';
  env?: NodeJS.ProcessEnv;
  /** Where human-readable progress goes. Defaults to console.error (stderr). */
  log?: (msg: string) => void;
}

/** Seams so install runs with zero real network / browser / disk in tests. */
export interface InstallDeps {
  /** Test seam: the auth handshake. Defaults to ensureAuth. */
  ensureAuthImpl?: (opts: LoginOptions) => Promise<BackthreadConfig>;
  /** Test seam: the config reader (used to skip auth when already logged in). */
  readConfigImpl?: (env: NodeJS.ProcessEnv) => Promise<BackthreadConfig>;
  /** Test seam: read a file (the existing settings.json). Defaults to fs.readFile. */
  readFileImpl?: (path: string) => Promise<string>;
  /** Test seam: write a file (settings.json). Defaults to fs.writeFile. */
  writeFileImpl?: (path: string, data: string) => Promise<void>;
  /** Test seam: mkdir -p (.claude/). Defaults to fs.mkdir recursive. */
  mkdirImpl?: (dir: string) => Promise<void>;
  /** Test seam: the backfill. Defaults to runBackfill. */
  runBackfillImpl?: (input: BackfillInput, deps?: BackfillDeps) => Promise<BackfillSummary>;
  /** BackfillDeps threaded into the backfill (env, fetch, readers). */
  backfillDeps?: BackfillDeps;
  /** Home dir override for the user-global hook path (tests). Defaults to os.homedir(). */
  home?: string;
  /** Test seam: the per-agent (codex/cursor/gemini) writer. Defaults to runInstallAgent. */
  runInstallAgentImpl?: (agent: InstallAgent, deps?: AgentInstallDeps) => Promise<AgentInstallResult>;
  /** AgentInstallDeps threaded into the per-agent writer. */
  agentDeps?: AgentInstallDeps;
}

/** The outcome of an install run. */
export interface InstallResult {
  /** 0 on success (incl. best-effort backfill failures); 1 only on a genuine auth failure. */
  exitCode: number;
  /** Whether the device ended up authorized. */
  authed: boolean;
  /** Whether the capture hooks (Stop + SessionEnd) are registered in settings.json (false when skipped for the plugin path). */
  hookRegistered: boolean;
  /** The backfill summary (null when skipped). */
  backfill: BackfillSummary | null;
  /** The per-agent writer result (codex/cursor/gemini path), or null for the Claude Code path. */
  agentResult?: AgentInstallResult | null;
  /** CC path only: true when a stale PROJECT-scope hook was stripped during migration (ARP-689). */
  projectHookMigrated?: boolean;
}

/**
 * Register the capture hooks in the USER-GLOBAL `~/.claude/settings.json` (the bare-`npx
 * backthread` fallback — the plugin path declares them in the manifest): the once-per-
 * session `SessionEnd` backstop AND the per-turn `Stop` hook (so merged decisions surface
 * mid-session, not only at session end — the incremental capture watermark makes each
 * per-turn fire cheap). USER scope on purpose: a project `.claude/settings.json` hook is
 * gitignored + absent from git worktrees, so it silently never captures there; the
 * user-scope hook follows the user across every repo + worktree. Pure merge: reads the
 * existing settings, adds each `event → {@link HOOK_COMMAND}` entry ONLY if an identical one
 * isn't already present (and upgrades a retired SessionEnd command in place), preserving
 * every other key/hook. Idempotent. Returns whether a write happened (false = both already
 * present / no change).
 *
 * ONLY the async CAPTURE hooks (SessionEnd + Stop) are registered here. The two
 * SYNCHRONOUS hooks — SessionStart ambient routing and the PreToolUse grep-context
 * injection — are PLUGIN-ONLY (declared in cli/hooks/hooks.json, which runs the shipped
 * bundle): a synchronous `npx backthread …` command would block every session start /
 * every grep on npm's resolve, so they're deliberately never written into this
 * settings.json fallback (the capture hooks get away with `@latest` only because they're
 * `--detach`ed). Bare-npx users get capture; the plugin adds routing + the grep hook.
 */
export async function registerHook(
  deps: InstallDeps = {},
): Promise<{ wrote: boolean; path: string }> {
  const doReadFile = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  const doWriteFile = deps.writeFileImpl ?? ((p: string, d: string) => writeFile(p, d));
  const doMkdir = deps.mkdirImpl ?? (async (d: string) => void (await mkdir(d, { recursive: true })));

  const home = deps.home ?? homedir();
  const settingsDir = join(home, '.claude');
  const settingsPath = join(settingsDir, 'settings.json');

  // Read the existing settings. A MISSING file (ENOENT) → start from {} and write
  // a fresh one. But a file that EXISTS yet won't parse (a hand-edited typo) must
  // NOT be silently overwritten — that's data loss of the user's recoverable
  // content. We fail loudly instead; runInstall catches this and tells the user to
  // add the hook manually, leaving their broken-but-present file untouched.
  let settings: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = await doReadFile(settingsPath);
  } catch (e) {
    if (!isNotFound(e)) throw e; // a real read error (perms, etc.) → surface it
    raw = null; // ENOENT → no file yet, start fresh
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `${settingsPath} exists but is not valid JSON — refusing to overwrite it. ` +
          'Fix the JSON (or add the SessionEnd hook manually) and re-run `backthread install`.',
      );
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
    // A valid JSON non-object (e.g. `[]` or `"x"`) is unexpected for settings.json;
    // treat it the same as corrupt rather than clobber it.
    else {
      throw new Error(
        `${settingsPath} is not a JSON object — refusing to overwrite it. ` +
          'Fix it (or add the SessionEnd hook manually) and re-run `backthread install`.',
      );
    }
  }

  // Register BOTH the SessionEnd backstop AND the per-turn Stop hook: apply each merge in
  // turn, threading the result, so a single write lands both. Each merge is a no-op when
  // its event is already present, so re-running is idempotent — and an existing
  // SessionEnd-only install (pre-per-turn) gains the Stop hook on its next `backthread install`.
  let next = settings;
  let changed = false;
  for (const merge of [mergeSessionEndHook, mergeStopHook]) {
    const merged = merge(next);
    if (merged !== null) {
      next = merged;
      changed = true;
    }
  }
  if (!changed) {
    return { wrote: false, path: settingsPath }; // both already registered — no-op (idempotent)
  }

  await doMkdir(settingsDir);
  await doWriteFile(settingsPath, JSON.stringify(next, null, 2) + '\n');
  return { wrote: true, path: settingsPath };
}

/** Is this a file-not-found error (ENOENT)? Used to distinguish 'no file yet' from a real read error. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Pure merge of our SessionEnd hook into a settings object. Returns the new settings
 * object, or `null` when our hook is ALREADY present (so the caller can skip the
 * write). Exported for unit testing the merge in isolation. Never mutates `settings`.
 */
export function mergeSessionEndHook(
  settings: Record<string, unknown>,
): Record<string, unknown> | null {
  // Deep-ish clone of just the path we touch (hooks.SessionEnd); everything else is
  // copied by reference (we never mutate it).
  const hooks: Record<string, unknown> =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? { ...(settings.hooks as Record<string, unknown>) }
      : {};

  const sessionEnd: unknown[] = Array.isArray(hooks.SessionEnd) ? [...(hooks.SessionEnd as unknown[])] : [];

  // Already on the CURRENT command anywhere → no-op (re-running install / hand-added).
  if (sessionEnd.some((g) => groupHasCommand(g, HOOK_COMMAND))) return null;

  // Otherwise, MIGRATE: if a group runs a retired command (a prior install), rewrite it
  // to the current command in place — upgrading an existing install to the completion-safe
  // form without leaving the old command or appending a duplicate (which would double-capture).
  let migrated = false;
  const nextSessionEnd = sessionEnd.map((group) => {
    const rewritten = rewriteLegacyCommand(group);
    if (rewritten !== group) migrated = true;
    return rewritten;
  });

  // No prior registration of ours at all → append a fresh group, preserving any foreign hooks.
  if (!migrated) {
    nextSessionEnd.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  }

  hooks.SessionEnd = nextSessionEnd;
  return { ...settings, hooks };
}

/**
 * Pure merge of our per-turn `Stop` capture hook into a settings object — the SAME
 * command as SessionEnd ({@link HOOK_COMMAND}), under the `Stop` event, so the bare-npx
 * CC path captures PER TURN like the plugin (and like Codex/Cursor). A Stop fire is
 * incremental — the shared `--from-hook` entrypoint's per-session_id watermark infers
 * only the turns added since the last capture — so per-turn is not "re-capture
 * everything". Returns the new settings, or `null` when our Stop hook is already present
 * (idempotent, so re-running install is safe and an existing SessionEnd-only install
 * gains this on the next run). NO legacy migration: `Stop` was never registered before,
 * so there's nothing to rewrite — append if absent, preserving foreign Stop hooks + every
 * other key. Never mutates `settings`. Exported for unit testing.
 */
export function mergeStopHook(
  settings: Record<string, unknown>,
): Record<string, unknown> | null {
  const hooks: Record<string, unknown> =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? { ...(settings.hooks as Record<string, unknown>) }
      : {};

  const stop: unknown[] = Array.isArray(hooks.Stop) ? [...(hooks.Stop as unknown[])] : [];

  // Already on our command anywhere → no-op (re-running install / hand-added).
  if (stop.some((g) => groupHasCommand(g, HOOK_COMMAND))) return null;

  // Append a fresh group, preserving any foreign Stop hooks.
  stop.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  hooks.Stop = stop;
  return { ...settings, hooks };
}

/** Does a SessionEnd matcher group contain a command hook running exactly `command`? */
function groupHasCommand(group: unknown, command: string): boolean {
  if (!group || typeof group !== 'object') return false;
  const inner = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(inner)) return false;
  return inner.some(
    (h) => h && typeof h === 'object' && (h as { command?: unknown }).command === command,
  );
}

/**
 * Return a NEW group with any retired ({@link LEGACY_HOOK_COMMANDS}) command rewritten to
 * the current {@link HOOK_COMMAND}; returns the SAME reference when nothing changed (so the
 * caller can detect a migration by identity). Never mutates the input.
 */
function rewriteLegacyCommand(group: unknown): unknown {
  if (!group || typeof group !== 'object') return group;
  const inner = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(inner)) return group;
  let changed = false;
  const nextInner = inner.map((h) => {
    if (!h || typeof h !== 'object') return h;
    const cmd = (h as { command?: unknown }).command;
    // Rewrite retired commands only; the current command is left as-is (handled above).
    if (typeof cmd === 'string' && cmd !== HOOK_COMMAND && OUR_HOOK_COMMANDS.has(cmd)) {
      changed = true;
      return { ...(h as Record<string, unknown>), command: HOOK_COMMAND };
    }
    return h;
  });
  return changed ? { ...(group as Record<string, unknown>), hooks: nextInner } : group;
}

/**
 * Pure removal of OUR SessionEnd hook from a settings object — the inverse of
 * {@link mergeSessionEndHook}, for the project→user migration (ARP-689). Strips every
 * command hook whose command is one of {@link OUR_HOOK_COMMANDS} (current or retired),
 * drops a group that becomes empty, and prunes an emptied `SessionEnd` / `hooks` for
 * tidiness. Preserves every FOREIGN hook + every other key. Returns a NEW settings
 * object, or `null` when nothing of ours was present (so the caller can skip the write).
 * Never mutates `settings`. Exported for unit testing.
 */
export function stripSessionEndHook(
  settings: Record<string, unknown>,
): Record<string, unknown> | null {
  const hooksVal = settings.hooks;
  if (!hooksVal || typeof hooksVal !== 'object' || Array.isArray(hooksVal)) return null;
  const seVal = (hooksVal as Record<string, unknown>).SessionEnd;
  if (!Array.isArray(seVal)) return null;

  let changed = false;
  const nextSessionEnd: unknown[] = [];
  for (const group of seVal) {
    const inner = (group as { hooks?: unknown })?.hooks;
    if (!group || typeof group !== 'object' || !Array.isArray(inner)) {
      nextSessionEnd.push(group); // malformed / foreign-shaped → preserve as-is
      continue;
    }
    const keptInner = inner.filter((h) => {
      const cmd = (h as { command?: unknown })?.command;
      const isOurs = typeof cmd === 'string' && OUR_HOOK_COMMANDS.has(cmd);
      if (isOurs) changed = true;
      return !isOurs;
    });
    if (keptInner.length === 0) continue; // the whole group was ours → drop it
    if (keptInner.length !== inner.length) {
      nextSessionEnd.push({ ...(group as Record<string, unknown>), hooks: keptInner });
    } else {
      nextSessionEnd.push(group); // no change in this group → keep the original
    }
  }

  if (!changed) return null;

  const hooks: Record<string, unknown> = { ...(hooksVal as Record<string, unknown>) };
  if (nextSessionEnd.length === 0) delete hooks.SessionEnd;
  else hooks.SessionEnd = nextSessionEnd;
  const next: Record<string, unknown> = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks; // an emptied hooks{} → prune it too
  return next;
}

/**
 * Migrate a pre-ARP-503 PROJECT-scope hook to user scope (ARP-689): strip OUR SessionEnd
 * hook from `<cwd>/.claude/settings.json`, idempotently, after the user-global hook is
 * registered. WHY: CC fires hooks from BOTH user + project scope, so a repo that still
 * carries the old project hook would DOUBLE-capture every session (the server `dedupeKey`
 * collapses it — wasted inference, not corruption). A missing project file is a no-op; a
 * corrupt one is REFUSED (never clobbered — same discipline as {@link registerHook}).
 * Returns whether a strip-write happened.
 */
export async function unregisterProjectHook(
  cwd: string,
  deps: InstallDeps = {},
): Promise<{ stripped: boolean; path: string }> {
  const doReadFile = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  const doWriteFile = deps.writeFileImpl ?? ((p: string, d: string) => writeFile(p, d));
  const settingsPath = join(cwd, '.claude', 'settings.json');

  let raw: string;
  try {
    raw = await doReadFile(settingsPath);
  } catch (e) {
    if (isNotFound(e)) return { stripped: false, path: settingsPath }; // no project file → nothing to migrate
    throw e; // a real read error (perms, etc.) → surface it
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${settingsPath} exists but is not valid JSON — refusing to modify it. ` +
        'Remove the stale SessionEnd hook manually if present.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} is not a JSON object — refusing to modify it.`);
  }

  const stripped = stripSessionEndHook(parsed as Record<string, unknown>);
  if (stripped === null) return { stripped: false, path: settingsPath }; // nothing of ours → no-op
  // We only ever WRITE a file that already existed (read succeeded), so no mkdir needed.
  await doWriteFile(settingsPath, JSON.stringify(stripped, null, 2) + '\n');
  return { stripped: true, path: settingsPath };
}

/**
 * Run `backthread install` end to end: auth handshake → register hook → chain backfill.
 * Reports each step. Best-effort on the backfill (never fails the install); a real
 * auth failure exits non-zero so the user knows capture won't run yet.
 */
export async function runInstall(
  opts: InstallOptions = {},
  deps: InstallDeps = {},
): Promise<InstallResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.error(m));
  const cwd = opts.cwd ?? process.cwd();
  const doEnsureAuth = deps.ensureAuthImpl ?? ensureAuth;
  const doReadConfig = deps.readConfigImpl ?? readConfig;
  const doBackfill = deps.runBackfillImpl ?? runBackfill;

  log('Setting up Backthread capture for this repo.\n');
  // Trust copy FIRST — the founder sees the never-store-source claim before any
  // transcript is read.
  log(TRUST_COPY + '\n');

  // (1) AUTH HANDSHAKE.
  let authed = false;
  if (opts.skipAuth) {
    const cfg = await doReadConfig(env).catch(() => ({}) as BackthreadConfig);
    authed = !!cfg.device_token;
    log(authed ? '[1/3] Auth: already authorized (skipped login).' : '[1/3] Auth: skipped (no token).');
  } else {
    try {
      const cfg = await doEnsureAuth({ env, claim: opts.claim });
      authed = !!cfg.device_token;
      log(authed ? '[1/3] Auth: device authorized.' : '[1/3] Auth: completed but no token found.');
    } catch (e) {
      // A genuine auth failure means capture can't run — report + exit non-zero, but
      // DON'T crash: still try to register the hook so the next `backthread login` arms it.
      log(`[1/3] Auth: failed — ${(e as Error).message}`);
      log('      Run `backthread login` to authorize, then re-run `backthread install`.');
    }
  }

  // (2-alt) PER-AGENT WRITER — `--agent codex|cursor|gemini`. Write that agent's
  // USER-GLOBAL MCP config + capture hook (instead of the CC settings.json + backfill)
  // and return. The config is written regardless of auth (armed for the next
  // `backthread login`), mirroring the CC path; exit 1 only when still unauthorized.
  const targetAgent = opts.agent && opts.agent !== 'claude-code' ? opts.agent : null;
  if (targetAgent) {
    const doAgent = deps.runInstallAgentImpl ?? runInstallAgent;
    let agentResult: AgentInstallResult | null = null;
    try {
      agentResult = await doAgent(targetAgent, deps.agentDeps);
      if (agentResult.versionWarning) log(`      ⚠ ${agentResult.versionWarning}`);
      for (const w of agentResult.writes) {
        log(
          w.wrote
            ? `[2/2] ${targetAgent}: configured ${w.path}.`
            : `[2/2] ${targetAgent}: already configured in ${w.path} (no change).`,
        );
      }
      if (agentResult.deeplink) log(`      One-click MCP install: ${agentResult.deeplink}`);
    } catch (e) {
      // A corrupt existing config (refusing-to-clobber) lands here — report, don't fail.
      log(`[2/2] ${targetAgent}: not configured — ${(e as Error).message}`);
      log('      You can add the MCP server + hook manually (see the README).');
    }
    log(
      `\nBackthread is set up for ${targetAgent}. New sessions are captured automatically.` +
        (authed ? '' : ' Run `backthread login` to finish authorizing.'),
    );
    const exitCode = !authed && !opts.skipAuth ? 1 : 0;
    return { exitCode, authed, hookRegistered: agentResult !== null, backfill: null, agentResult };
  }

  // (2) REGISTER THE HOOK (settings.json fallback; the plugin path skips this).
  let hookRegistered = false;
  let projectHookMigrated = false;
  if (opts.skipHook) {
    log('[2/3] Hook: skipped (registered by the plugin manifest).');
  } else {
    try {
      const { wrote, path } = await registerHook(deps);
      hookRegistered = true;
      log(
        wrote
          ? `[2/3] Hook: capture hooks (per-turn Stop + SessionEnd) added to ${path}.`
          : `[2/3] Hook: capture hooks already present in ${path} (no change).`,
      );
    } catch (e) {
      // Includes the 'refusing to overwrite a corrupt settings.json' case — we
      // report it and move on; the install does NOT fail on a hook-write problem.
      log(`[2/3] Hook: not registered — ${(e as Error).message}`);
      log('      You can add it manually (see the README › Registering the hook).');
    }

    // (2b) MIGRATE the old PROJECT-scope hook to user scope (ARP-689). A pre-ARP-503
    // install wrote the SessionEnd hook into <cwd>/.claude/settings.json; now that we
    // register at USER scope, that repo would DOUBLE-capture (CC fires both scopes).
    // Strip our hook from the project file, idempotently, preserving foreign hooks/keys.
    // Best-effort: a missing project file is a no-op; a corrupt one is reported + left
    // intact; never fails the install.
    //
    // GATE on hookRegistered: only remove the old project fallback once the user-global
    // replacement is confirmed in place. If registerHook just THREW (a corrupt user
    // settings.json), stripping the still-working project hook would leave the repo with
    // ZERO capture — worse than the double-capture we're fixing.
    if (hookRegistered) {
      try {
        const { stripped, path } = await unregisterProjectHook(cwd, deps);
        if (stripped) {
          projectHookMigrated = true;
          log(`      Migrated: removed the stale project-scope SessionEnd hook from ${path} (it now lives at user scope).`);
        }
      } catch (e) {
        log(`      Note: left the project-scope settings.json untouched — ${(e as Error).message}`);
      }
    }
  }

  // (3) CHAIN BACKFILL — best-effort, never blocks/fails the install.
  let backfill: BackfillSummary | null = null;
  if (opts.skipBackfill) {
    log('[3/3] Backfill: skipped.');
  } else if (!authed) {
    // No token → capture would just no-auth every transcript. Skip the backfill now;
    // the user re-runs install after `backthread login` to seed history.
    log('[3/3] Backfill: skipped (not authorized yet — run `backthread login`, then re-run install).');
  } else {
    log('[3/3] Backfill: seeding your decision log from past sessions…');
    try {
      backfill = await doBackfill({ cwd }, { env, log, ...deps.backfillDeps });
    } catch (e) {
      // runBackfill is contracted never to throw; belt-and-braces so a backfill
      // hiccup can never fail the install.
      log(`[3/3] Backfill: skipped (error swallowed) — ${(e as Error).message}`);
    }
  }

  log('\nBackthread is set up. New sessions are captured automatically when they end.');

  // Exit non-zero ONLY when we ended up unauthorized AND didn't skip auth — that's
  // the one state where capture genuinely won't work and the user must act.
  const exitCode = !authed && !opts.skipAuth ? 1 : 0;
  return { exitCode, authed, hookRegistered, backfill, agentResult: null, projectHookMigrated };
}
