// install.ts — the `backthread install` onboarding glue.
//
// The one-motion first-run that lands capture in the rescue-mode aha moment. Three
// steps, in order:
//
//   1. AUTH HANDSHAKE — `ensureAuth`: if there's already a device token we
//      reuse it; otherwise run `backthread login` (the browser OAuth-loopback) once so the
//      device is authorized and `~/.backthread/config.json` is written at 0600.
//   2. REGISTER THE HOOK — wire the `SessionEnd` capture hook so the log stays
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
//   • FALLBACK = writing the user's `.claude/settings.json`. For the bare `npx backthread`
//     (non-plugin) install path there is no manifest doing the wiring, so
//     `backthread install` writes the SessionEnd entry into the project's
//     `.claude/settings.json` itself. This is what `registerHook` below does. It is
//     idempotent (re-running install never duplicates the entry) and a strict MERGE
//     (never clobbers the user's other hooks/settings).
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
import { join } from 'node:path';
import { ensureAuth, type LoginOptions } from './login.js';
import { readConfig, type BackthreadConfig } from './config.js';
import { runBackfill, type BackfillSummary, type BackfillDeps, type BackfillInput } from './backfill.js';

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
 */
export const HOOK_COMMAND = 'npx backthread capture --from-hook --agent claude-code --detach';

/**
 * Earlier hook commands we still recognize, so re-running `backthread install` after an
 * upgrade MIGRATES an existing registration to {@link HOOK_COMMAND} in place rather than
 * leaving the stale command or appending a duplicate (which would double-capture). Append
 * any future retired command strings here.
 */
const LEGACY_HOOK_COMMANDS: readonly string[] = ['npx backthread capture'];

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
}

/** The outcome of an install run. */
export interface InstallResult {
  /** 0 on success (incl. best-effort backfill failures); 1 only on a genuine auth failure. */
  exitCode: number;
  /** Whether the device ended up authorized. */
  authed: boolean;
  /** Whether the SessionEnd hook is registered in settings.json (false when skipped for the plugin path). */
  hookRegistered: boolean;
  /** The backfill summary (null when skipped). */
  backfill: BackfillSummary | null;
}

/**
 * Register the SessionEnd capture hook in the project's `.claude/settings.json`
 * (the bare-`npx backthread` fallback — the plugin path declares it in the manifest). Pure
 * merge: reads the existing settings, adds our `SessionEnd → {@link HOOK_COMMAND}` entry
 * ONLY if an identical one isn't already present (and upgrades a retired command in place),
 * preserving every other key/hook. Idempotent. Returns whether a write happened
 * (false = already present / no change).
 */
export async function registerHook(
  cwd: string,
  deps: InstallDeps = {},
): Promise<{ wrote: boolean; path: string }> {
  const doReadFile = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  const doWriteFile = deps.writeFileImpl ?? ((p: string, d: string) => writeFile(p, d));
  const doMkdir = deps.mkdirImpl ?? (async (d: string) => void (await mkdir(d, { recursive: true })));

  const settingsDir = join(cwd, '.claude');
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

  const merged = mergeSessionEndHook(settings);
  if (merged === null) {
    return { wrote: false, path: settingsPath }; // already registered — no-op (idempotent)
  }

  await doMkdir(settingsDir);
  await doWriteFile(settingsPath, JSON.stringify(merged, null, 2) + '\n');
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

  // (2) REGISTER THE HOOK (settings.json fallback; the plugin path skips this).
  let hookRegistered = false;
  if (opts.skipHook) {
    log('[2/3] Hook: skipped (registered by the plugin manifest).');
  } else {
    try {
      const { wrote, path } = await registerHook(cwd, deps);
      hookRegistered = true;
      log(
        wrote
          ? `[2/3] Hook: SessionEnd capture hook added to ${path}.`
          : `[2/3] Hook: SessionEnd capture hook already present in ${path} (no change).`,
      );
    } catch (e) {
      // Includes the 'refusing to overwrite a corrupt settings.json' case — we
      // report it and move on; the install does NOT fail on a hook-write problem.
      log(`[2/3] Hook: not registered — ${(e as Error).message}`);
      log('      You can add it manually (see the README › Registering the hook).');
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
  return { exitCode, authed, hookRegistered, backfill };
}
