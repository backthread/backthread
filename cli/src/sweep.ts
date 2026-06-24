// sweep.ts — GAP-RECOVERY sweep: heal a lapsed capture connection by recovering the
// repo's un-captured local sessions, not just resuming forward.
//
// WHY THIS EXISTS: capture is forward-only — the SessionEnd hook derives decisions
// from the session that just ended. When the connection lapses (hook broken/absent,
// worktree without the hook, a different machine, …) and is later restored, capture
// just resumes forward; the gap's sessions are never re-processed and their decisions
// never created. This sweep closes the gap: after a normal capture it detects the
// repo's earlier un-captured sessions and runs each through the SAME redact→infer→
// persist fence (`runCapture`), so the decision log self-heals silently.
//
// THIS GENERALIZES THE OLD ONE-SHOT install BACKFILL (backfill.ts now delegates here
// with `force`). One mechanism, not two: the first sweep after install recovers all
// history; every later sweep finds only what's new since. The differences from the
// old backfill — and the cross-cutting invariants — are:
//
//   • WORKTREE-AWARE. The old backfill walked ONE dir (`~/.claude/projects/<slug of
//     cwd>`). Worktree sessions live under SEPARATE slug dirs (a sibling
//     `…-clew-arp667` or a nested `…-clew--claude-worktrees-x`). We enumerate the
//     whole FAMILY — the main slug + every `mainSlug-*` dir — and attribute each to
//     the target repo, INCLUDING dirs whose worktree was deleted (the transcript dir
//     survives on disk even when its cwd is gone; see classifyDir).
//   • SKIP-BEFORE-INFERENCE. The old backfill re-paid inference for every transcript
//     and relied on the server-side dedupeKey to drop the duplicate AFTER the LLM
//     ran. We consult a DURABLE local ledger (sweepLedger.ts) FIRST and never re-
//     derive a session we've already captured (live or swept) → a re-sweep is 0
//     inference + 0 new decisions (the idempotence acceptance criterion).
//   • SCOPED + ATTRIBUTED. Only the TARGET repo's sessions are recovered (spend rides
//     this device's account; the freshness gate is per-repo). A dir whose embedded
//     cwd resolves to a DIFFERENT repo (e.g. a sibling `…-clew-lander`) is excluded.
//   • AUTO + SILENT + NON-BLOCKING. Triggered off the already-detached CC SessionEnd
//     worker (fromHook.ts) — no user action, no prompt. Best-effort, NEVER throws.
//
// SCOPE (Phase 1): CC transcript enumeration only (`~/.claude/projects/`). The
// Codex/Cursor/Gemini layouts are the Phase-2 enumerator port (de-vendor pattern,
// like @backthread/redact). Until then, a sweep triggered by another agent's hook
// still recovers this repo's CC sessions; we just don't yet enumerate the other
// agents' history.
//
// HONEST LIMIT: transcripts gone (rotated / different machine) are unrecoverable from
// capture — there's nothing to redact. We log what we can't attribute (never a silent
// drop) and the durable fallback is GitHub-derived decisions (ARP-538).

import { readFile, stat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { runCapture, type CaptureDeps, type CaptureOutcome, type HookInput } from './capture.js';
import { slugifyCwd } from './captureCommand.js';
import { readConfig, type BackthreadConfig } from './config.js';
import { resolveRepo, type RemoteReader, type RepoHandle } from './repo.js';
import {
  addProcessed,
  readSweepState,
  writeSweepState,
  type SweepState,
} from './sweepLedger.js';

// Re-export so consumers of SweepDeps (whose readSweepStateImpl/writeSweepStateImpl
// are typed in SweepState) can name the type without reaching into sweepLedger.
export type { SweepState } from './sweepLedger.js';

/** Inputs to a sweep. */
export interface SweepInput {
  /** A working directory inside the repo to sweep. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Force the full sweep even when the freshness debounce would skip it. Set by the
   * install backfill (an explicit user action always sweeps) and by validation runs.
   */
  force?: boolean;
  /**
   * SessionIds known to be already-captured from a source OTHER than the local ledger
   * (e.g. a one-time server read of `decisions.source.sessionId` for this repo). Merged
   * into the skip set so the FIRST sweep on a machine doesn't re-derive sessions an
   * earlier install/other machine already captured. The shipped hook path leaves this
   * empty (local-ledger only, per the v1 decision); it's the seam the dogfood recovery
   * uses to recover ONLY the genuine gap without title-drift duplicates of old sessions.
   */
  knownCapturedSessionIds?: readonly string[];
}

/** How long after a completed sweep to skip re-walking ~/.claude/projects (freshness gate). */
export const SWEEP_DEBOUNCE_MS = 15 * 60 * 1000; // 15 minutes

/** Seams so the sweep runs with zero real fs / git / network / capture in tests. */
export interface SweepDeps {
  env?: NodeJS.ProcessEnv;
  /** Where human-readable progress goes. Defaults to console.error (stderr). */
  log?: (msg: string) => void;
  /** Test seam: home directory. Defaults to os.homedir(). */
  homedirImpl?: () => string;
  /** Test seam: "now" as ISO (the freshness marker). Defaults to a real clock. */
  nowImpl?: () => string;
  /** Debounce window in ms (overridable for tests). Defaults to {@link SWEEP_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Test seam: list a dir's entry names. Defaults to fs.readdir (missing dir → []). */
  readDirImpl?: (dir: string) => Promise<string[]>;
  /** Test seam: read a file as utf8 (transcript cwd-probe). Defaults to fs.readFile. */
  readFileImpl?: (path: string) => Promise<string>;
  /** Test seam: does a path exist on disk? (deleted-worktree detection). Defaults to fs.stat. */
  pathExistsImpl?: (path: string) => Promise<boolean>;
  /** Test seam: the main-checkout root for a cwd (worktree-aware). Defaults to `git rev-parse`. */
  mainRootImpl?: (cwd: string) => string | null;
  /** Test seam: the git-remote reader for repo attribution. Defaults to repo.ts's git read. */
  readRemoteImpl?: RemoteReader;
  /** Test seam: the config reader (device-token gate). Defaults to readConfig(). */
  readConfigImpl?: (env: NodeJS.ProcessEnv) => Promise<BackthreadConfig>;
  /** Test seam: the capture pipeline. Defaults to runCapture. */
  runCaptureImpl?: (input: HookInput, deps?: CaptureDeps) => Promise<CaptureOutcome>;
  /** CaptureDeps threaded into each capture (env, fetch, readers). */
  captureDeps?: CaptureDeps;
  /** Test seam: read the durable sweep state. Defaults to readSweepState. */
  readSweepStateImpl?: (env: NodeJS.ProcessEnv) => Promise<SweepState>;
  /** Test seam: write the durable sweep state. Defaults to writeSweepState. */
  writeSweepStateImpl?: (state: SweepState, env: NodeJS.ProcessEnv) => Promise<void>;
}

/** Per-dir attribution outcome (for the summary + honest logging). */
export type DirMode =
  | 'git' // cwd exists and its git remote resolves to the target repo
  | 'heuristic' // cwd is GONE (deleted worktree) but its path matches the target's worktree layout
  | 'excluded-other-repo' // cwd exists but resolves to a DIFFERENT repo (e.g. a sibling lander)
  | 'unattributable'; // can't confirm the repo (no embedded cwd, or gone cwd that doesn't match)

/** One candidate transcript dir's attribution, for the summary/log. */
export interface DirAttribution {
  /** The `~/.claude/projects/<dir>` directory name. */
  dir: string;
  mode: DirMode;
  /** The embedded cwd we read from the dir's transcripts (null when none carried one). */
  cwd: string | null;
  /** How many `.jsonl` transcripts the dir holds. */
  transcripts: number;
}

/** What a sweep produced. Never thrown — the caller (a hook) tolerates any failure. */
export interface SweepSummary {
  /** A terse machine status for the caller/log. */
  status: 'swept' | 'debounced' | 'no-repo' | 'no-auth' | 'error';
  /** The target repo `owner/name`, when resolved. */
  repo: string | null;
  /** Transcript dirs we attributed to the target repo and swept. */
  dirsSwept: number;
  /** How many sessions we found across the swept dirs. */
  found: number;
  /** How many sessions we skipped (already captured — skip-before-inference). */
  skipped: number;
  /** How many sessions produced at least one persisted decision. */
  captured: number;
  /** Total decisions persisted across all swept sessions (when counts were reported). */
  decisions: number;
  /** Per-candidate-dir attribution (incl. excluded/unattributable, for honest logging). */
  attributions: DirAttribution[];
  /** A one-line human summary for the log. */
  text: string;
}

const EMPTY = (status: SweepSummary['status'], repo: string | null, text: string): SweepSummary => ({
  status,
  repo,
  dirsSwept: 0,
  found: 0,
  skipped: 0,
  captured: 0,
  decisions: 0,
  attributions: [],
  text,
});

/** True when a capture outcome means the session is DONE and should enter the ledger.
 *  (no-auth / transient failures are NOT recorded → a later sweep retries them.) */
export function isTerminallyProcessed(outcome: CaptureOutcome): boolean {
  return (
    outcome.status === 'persisted' ||
    outcome.status === 'persisted-by-server' ||
    outcome.status === 'nothing-to-capture'
  );
}

/** A device-token-bearing slug `owner/name` → a synthetic remote so resolveRepo pins
 *  every transcript in an attributed dir to that repo (works even when the cwd is gone;
 *  the server resolves canonical identity by slug, host-agnostic — see repo.ts). */
export function syntheticRemote(repo: RepoHandle): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

/** Pull the first embedded working-directory out of a raw transcript: CC stamps a
 *  top-level `cwd` on most records; Codex stamps `session_meta.payload.cwd`. Scans
 *  line-by-line and short-circuits on the first hit (cwd appears early), so we don't
 *  fully parse a multi-MB transcript just to attribute its dir. Returns null when no
 *  record carries one. Pure → unit-testable. */
export function extractCwdFromRaw(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // truncated/corrupt line — skip
    }
    if (!rec || typeof rec !== 'object') continue;
    const r = rec as { cwd?: unknown; type?: unknown; payload?: { cwd?: unknown } };
    if (typeof r.cwd === 'string' && r.cwd.trim().length > 0) return r.cwd.trim();
    if (r.type === 'session_meta' && typeof r.payload?.cwd === 'string' && r.payload.cwd.trim().length > 0) {
      return r.payload.cwd.trim();
    }
  }
  return null;
}

/**
 * Classify a candidate transcript dir against the target repo. PURE (no I/O) so the
 * worktree/deleted-worktree/wrong-repo cases are exhaustively unit-testable. The
 * caller supplies the dir's embedded cwd, whether that cwd still exists, and (when it
 * exists) the repo its git remote resolves to.
 */
export function classifyDir(args: {
  dirName: string;
  mainSlug: string;
  mainRoot: string;
  embeddedCwd: string | null;
  cwdExists: boolean;
  resolved: RepoHandle | null;
  target: RepoHandle;
}): { include: boolean; mode: DirMode; cwd: string | null } {
  const { dirName, mainSlug, mainRoot, embeddedCwd, cwdExists, resolved, target } = args;

  // Defensive: only family dirs (the caller pre-filters, but never trust the input).
  if (dirName !== mainSlug && !dirName.startsWith(mainSlug + '-')) {
    return { include: false, mode: 'unattributable', cwd: embeddedCwd };
  }

  // No transcript in the dir carried a cwd → we can't confirm its repo.
  if (!embeddedCwd) return { include: false, mode: 'unattributable', cwd: null };

  if (cwdExists) {
    // TIER 1 (authoritative): the working dir still exists — trust its git remote.
    if (resolved && resolved.owner === target.owner && resolved.name === target.name) {
      return { include: true, mode: 'git', cwd: embeddedCwd };
    }
    // Exists but resolves elsewhere (or to nothing) → NOT this repo. Excluded, not a
    // guess: a sibling like `…/clew-lander` resolves to a different repo.
    return { include: false, mode: 'excluded-other-repo', cwd: embeddedCwd };
  }

  // TIER 2 (heuristic): the working dir is GONE (deleted worktree) so git can't speak.
  // Include it iff its path looks like a worktree of the target's main checkout — a
  // nested worktree under the root, or a sibling whose path is `<root>-<suffix>`.
  //
  // KNOWN LIMITATION (caller log()s every heuristic include so it's auditable): a
  // DELETED *ambiguous* sibling whose cwd is gone — e.g. a removed `<root>-lander` that
  // was actually a DIFFERENT repo — also matches `<root>-` and would be attributed to
  // the target (wrong slug). We accept this for v1: a LIVE sibling is correctly excluded
  // by Tier 1 (its cwd resolves to its own repo), so this only bites a sibling that is
  // BOTH a different repo AND already deleted — rare, and the durable fix is the
  // transcript-embedded git remote (Codex carries one; CC does not yet), a Phase-2 item.
  const isNested = embeddedCwd === mainRoot || embeddedCwd.startsWith(mainRoot + '/');
  const isSibling = embeddedCwd.startsWith(mainRoot + '-');
  if (isNested || isSibling) return { include: true, mode: 'heuristic', cwd: embeddedCwd };

  // Gone cwd that doesn't match the target's layout → can't attribute. Log, don't guess.
  return { include: false, mode: 'unattributable', cwd: embeddedCwd };
}

/** Default: list a dir's entries; a missing/unreadable dir yields []. */
async function defaultReadDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Default: does a path exist (file or dir)? */
async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Default: the main-checkout root for a cwd (the dir containing the COMMON `.git`),
 *  so a hook fired from a worktree still anchors the whole family. `--git-common-dir`
 *  is the MAIN repo's `.git` even from a worktree; its parent is the main checkout root.
 *  We deliberately do NOT use `--path-format=absolute` (git >= 2.31 only) — instead we
 *  resolve a relative result (the main checkout reports a bare `.git`) against `cwd`,
 *  so this works on older git too. Returns null on any git error (→ caller uses cwd). */
function defaultMainRoot(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const abs = isAbsolute(out) ? out : join(cwd, out);
    return dirname(abs.replace(/\/+$/, ''));
  } catch {
    return null;
  }
}

/**
 * Run a gap-recovery sweep for the repo containing `cwd`. NEVER throws — every failure
 * resolves into the summary. Steps:
 *   1. Resolve the target repo (no remote → nothing to scope; return).
 *   2. Device-token gate (no token → return; never pop a browser from a silent sweep).
 *   3. Freshness debounce (per repo) unless `force`.
 *   4. Enumerate the transcript-dir FAMILY (main slug + `mainSlug-*`).
 *   5. Attribute each dir (classifyDir) → sweep only the target's dirs.
 *   6. Per session: SKIP-BEFORE-INFERENCE (durable ledger ∪ caller-known) else delegate
 *      to runCapture with the remote pinned to the target (so deleted-worktree sessions
 *      still persist correctly) and a NO-OP ensureAuth (never pop a browser).
 *   7. Commit newly-processed sessionIds + the per-repo lastSweptAt to the ledger.
 */
export async function runSweep(input: SweepInput = {}, deps: SweepDeps = {}): Promise<SweepSummary> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((m: string) => console.error(m));
  const debounceMs = deps.debounceMs ?? SWEEP_DEBOUNCE_MS;
  // `home`/`now`/`cwd` call (possibly injected) impls, so resolve them INSIDE the try —
  // a misbehaving seam must degrade to the 'error' summary, never throw into the host.
  // All I/O seams are wrapped to degrade (not throw) even when an INJECTED impl throws —
  // defense-in-depth around the never-throws posture (the real defaults already swallow).
  const baseReadDir = deps.readDirImpl ?? defaultReadDir;
  const doReadDir = async (d: string): Promise<string[]> => {
    try {
      return await baseReadDir(d);
    } catch {
      return [];
    }
  };
  const baseReadFile = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  const doReadFile = async (p: string): Promise<string> => {
    try {
      return await baseReadFile(p);
    } catch {
      return '';
    }
  };
  const basePathExists = deps.pathExistsImpl ?? defaultPathExists;
  const doPathExists = async (p: string): Promise<boolean> => {
    try {
      return await basePathExists(p);
    } catch {
      return false;
    }
  };
  const doMainRoot = (c: string): string | null => {
    try {
      return (deps.mainRootImpl ?? defaultMainRoot)(c);
    } catch {
      return null;
    }
  };
  const readRemote = deps.readRemoteImpl; // undefined → resolveRepo uses its git default
  const doReadConfig = deps.readConfigImpl ?? readConfig;
  const run = deps.runCaptureImpl ?? runCapture;
  const doReadState = deps.readSweepStateImpl ?? readSweepState;
  const doWriteState = deps.writeSweepStateImpl ?? writeSweepState;

  try {
    const home = (deps.homedirImpl ?? homedir)();
    const now = (deps.nowImpl ?? (() => new Date().toISOString()))();
    const cwd = input.cwd ?? process.cwd();

    // (1) Target repo.
    const target = resolveRepo(cwd, readRemote);
    if (!target) {
      const text = `backthread sweep: no git remote for ${cwd} — can't scope a gap-recovery sweep.`;
      log(text);
      return EMPTY('no-repo', null, text);
    }
    const repoSlug = `${target.owner}/${target.name}`;

    // (2) Device-token gate — a silent background sweep must never trigger a login.
    const config = await Promise.resolve()
      .then(() => doReadConfig(env))
      .catch(() => ({}) as BackthreadConfig);
    if (!config.device_token) {
      const text = `backthread sweep: not logged in — skipping gap recovery for ${repoSlug}.`;
      log(text);
      return EMPTY('no-auth', repoSlug, text);
    }

    // (3) Freshness debounce — steady-state overhead ≈ 0 (the ledger already makes a
    // caught-up sweep find nothing; this just avoids re-walking the dirs every session).
    const state = await doReadState(env).catch(() => ({ processed: [], lastSweptAt: {} }) as SweepState);
    if (!input.force) {
      const last = state.lastSweptAt[repoSlug];
      if (last) {
        const age = Date.parse(now) - Date.parse(last);
        if (Number.isFinite(age) && age >= 0 && age < debounceMs) {
          return EMPTY('debounced', repoSlug, `backthread sweep: ${repoSlug} swept recently — skipped.`);
        }
      }
    }

    // (4) Enumerate the transcript-dir family.
    const mainRoot = doMainRoot(cwd) ?? cwd;
    const mainSlug = slugifyCwd(mainRoot);
    const projectsRoot = join(home, '.claude', 'projects');
    const entries = await doReadDir(projectsRoot);
    const candidates = entries.filter((n) => n === mainSlug || n.startsWith(mainSlug + '-')).sort();

    // Skip set (skip-before-inference): the durable ledger — every session this
    // machine has captured (live OR swept) is recorded there by fromHook + this sweep —
    // ∪ caller-supplied known-captured sessionIds (the server-read seam, e.g. the
    // dogfood recovery seeding from decisions.source.sessionId).
    const skip = new Set<string>(state.processed);
    for (const sid of input.knownCapturedSessionIds ?? []) if (sid) skip.add(sid);

    const attributions: DirAttribution[] = [];
    const newlyProcessed: string[] = [];
    let dirsSwept = 0;
    let found = 0;
    let skipped = 0;
    let captured = 0;
    let decisions = 0;

    for (const dirName of candidates) {
      const dir = join(projectsRoot, dirName);
      const files = (await doReadDir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
      if (files.length === 0) continue; // empty family dir — nothing to attribute

      // Probe the dir's embedded cwd from its transcripts (first one that carries it).
      let embeddedCwd: string | null = null;
      for (const file of files) {
        embeddedCwd = extractCwdFromRaw(await doReadFile(join(dir, file)));
        if (embeddedCwd) break;
      }
      const cwdExists = embeddedCwd ? await doPathExists(embeddedCwd) : false;
      const resolved = embeddedCwd && cwdExists ? resolveRepo(embeddedCwd, readRemote) : null;
      const cls = classifyDir({ dirName, mainSlug, mainRoot, embeddedCwd, cwdExists, resolved, target });
      attributions.push({ dir: dirName, mode: cls.mode, cwd: cls.cwd, transcripts: files.length });

      if (!cls.include) {
        if (cls.mode === 'unattributable') {
          log(
            `backthread sweep: ${files.length} transcript(s) in ${dirName} can't be attributed to ${repoSlug}` +
              (cls.cwd ? ` (cwd ${cls.cwd} is gone)` : ' (no cwd recorded)') +
              ' — left for GitHub-derived recovery (ARP-538).',
          );
        }
        continue;
      }
      if (cls.mode === 'heuristic') {
        log(
          `backthread sweep: attributing ${files.length} transcript(s) in deleted-worktree dir ${dirName} ` +
            `to ${repoSlug} by path heuristic (cwd ${cls.cwd} no longer exists).`,
        );
      }

      dirsSwept += 1;
      // Pin the remote to the target so EVERY transcript persists under it — works even
      // when the worktree cwd is gone (git can't read it). cwd is threaded for path
      // relativization only (a pure string op; the dir need not exist).
      const captureDeps: CaptureDeps = {
        ...deps.captureDeps,
        readRemoteImpl: () => syntheticRemote(target),
        // A silent background sweep must NEVER pop a browser login.
        ensureAuthImpl: deps.captureDeps?.ensureAuthImpl ?? (() => {}),
      };

      // Sequential on purpose: no latency budget on a background sweep, gentle on the
      // server-side inference load, readable per-file log.
      for (const file of files) {
        const sid = basename(file, '.jsonl');
        if (skip.has(sid)) {
          skipped += 1;
          continue;
        }
        found += 1;
        let outcome: CaptureOutcome;
        try {
          outcome = await run(
            {
              transcript_path: join(dir, file),
              cwd: cls.cwd ?? mainRoot,
              session_id: sid,
              hook_event_name: 'SessionEnd',
            },
            captureDeps,
          );
        } catch (e) {
          outcome = { status: 'error', detail: `capture threw (swallowed): ${(e as Error).message}` };
        }
        if (outcome.status === 'persisted' || outcome.status === 'persisted-by-server') {
          captured += 1;
          decisions += typeof outcome.count === 'number' ? outcome.count : 0;
        }
        if (isTerminallyProcessed(outcome)) {
          newlyProcessed.push(sid);
          skip.add(sid); // also guard against the same id appearing twice in one sweep
        }
        log(`  ${dirName}/${file}: ${outcome.status}${typeof outcome.count === 'number' ? ` (${outcome.count})` : ''}`);
      }
    }

    // (7) Commit the ledger + the per-repo freshness marker.
    const nextState = addProcessed(state, newlyProcessed);
    nextState.lastSweptAt = { ...nextState.lastSweptAt, [repoSlug]: now };
    await doWriteState(nextState, env).catch(() => {});

    const text =
      `backthread sweep: ${repoSlug} — swept ${dirsSwept} dir(s), ` +
      `recovered ${decisions} decision(s) from ${captured} session(s) ` +
      `(${found} processed, ${skipped} already captured).`;
    log(text);
    return {
      status: 'swept',
      repo: repoSlug,
      dirsSwept,
      found,
      skipped,
      captured,
      decisions,
      attributions,
      text,
    };
  } catch (e) {
    // Ultimate backstop — a sweep must never throw into the host session. Reported as
    // 'error' (NOT 'no-repo') so a mid-sweep throw is distinguishable from "no remote".
    const text = `backthread sweep: failed (swallowed) — ${(e as Error).message}`;
    log(text);
    return EMPTY('error', null, text);
  }
}

/**
 * The hook-path entry: a freshness-gated gap-recovery sweep, fired by the detached
 * CC SessionEnd worker AFTER its normal capture. Thin alias over {@link runSweep}
 * (debounce applies — `force` is off). Kept as a named seam so fromHook can inject it.
 */
export async function runGapRecoverySweep(
  input: SweepInput = {},
  deps: SweepDeps = {},
): Promise<SweepSummary> {
  return runSweep({ ...input, force: input.force ?? false }, deps);
}
