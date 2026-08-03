// editNudge.ts — the PreToolUse pre-edit line.
//
// When Claude Code is about to edit, rewrite or create a file, this hook asks the
// server ONE question — does this person have coverage of the area that file
// belongs to? — and, at most once per session, surfaces ONE line offering the
// context they are missing before they change it. That is the whole feature.
//
// SILENCE IS THE DEFAULT, AND EVERY DOUBT RESOLVES TO IT. This is the exact
// posture of `interpretScopeResponse` in captureScope.ts, with the polarity
// flipped: there the safe default is SEND and only a clean verdict suppresses;
// here the safe default is SAY NOTHING and only a clean, confident `uncovered`
// speaks. A `covered` signal, an `unresolved` signal, any non-200, a network
// error, a timeout, a malformed body, a missing device token, a path that is not
// in a git repo — all of it is silent. A line shown because a lookup hiccuped is a
// false accusation about someone's own codebase, and it is far worse than a line
// never shown.
//
// IT NEVER BLOCKS THE EDIT. A PreToolUse hook is synchronous — the tool waits for
// it — so the request is bounded by a short timeout, every failure path returns an
// empty `{}` (no message, no decision, no permission verdict), and the command
// always exits 0. It never exits 2 and never emits a `permissionDecision`, so
// there is no code path in which this can deny, delay past the timeout, or
// interrupt an edit. Interrupting a coding flow is the fastest way to get
// uninstalled.
//
// THE PER-SESSION BUDGET IS TWO NUMBERS, NOT ONE. The obvious throttle — "one line
// per session" — is not enough on its own, because until the line fires, EVERY
// edit in the session pays for a round-trip; on a repo the person already knows
// well that is a permanent tax that buys nothing. So a session gets at most
// MAX_PREFLIGHTS_PER_SESSION lookups AND at most one line. The first covers the
// realistic case (the person touches a couple of areas early in a session) without
// letting a long editing session pay for it forty times over.
//
// WHY `systemMessage` AND NOT stdout OR stderr. For a PreToolUse hook exiting 0,
// Claude Code shows neither stdout nor stderr to the person — stdout is parsed for
// the hook's JSON fields and nothing more. `systemMessage` is the documented field
// for a short user-visible notice, so it is the only channel that actually reaches
// the human this line is written for. We deliberately do NOT also inject
// `hookSpecificOutput.additionalContext`: that goes into the agent's context, and
// one line offered to the person is the feature — the same sentence delivered
// twice through two channels is a nag.
//
// NO SOURCE LEAVES THE MACHINE. One repo-relative file path and the repo slug go
// out; the file is never opened, let alone read or sent.

import { relative, resolve, isAbsolute, sep } from 'node:path';
import { readConfig, type BackthreadConfig } from './config.js';
import { resolveRepo, type RemoteReader, type RepoHandle } from './repo.js';
import { resolveRepoRoot as defaultResolveRepoRoot } from './localCache.js';
import { buildCoveragePreflightUrl } from './urls.js';
import { versionHeaders } from './version.js';
import { claimSessionOnce, wasSessionClaimed } from './sessionThrottle.js';

/** This hook's own throttle file — never shared with the connect nudge, or
 *  whichever fired first would silence the other. */
export const EDIT_NUDGE_FILE = 'edit-nudge.json';

/** Lookups a single session may spend before it stops asking. See the header. */
export const MAX_PREFLIGHTS_PER_SESSION = 3;

/**
 * The request budget. Measured end to end against the live endpoint, a warm call
 * lands in roughly 0.5-1.3s and a cold one can exceed 1.5s; this sits above the
 * warm tail and well below anything a person registers as a stall on a tool call.
 * A genuinely cold worker simply does not produce a line that once — the correct
 * trade, because silence is already the safe outcome here and a stalled edit is
 * not.
 */
export const COVERAGE_PREFLIGHT_TIMEOUT_MS = 2_000;

/** The PreToolUse hook output. `{}` = say nothing, edit proceeds. */
export interface EditNudgeOutput {
  /** The one user-visible line, when there is one. */
  systemMessage?: string;
}

/** The server's coverage verdict for a path. */
export type CoverageSignal = 'covered' | 'uncovered' | 'unresolved';

/**
 * PURE core: map a preflight HTTP outcome → whether to say anything.
 *
 * The ONLY speaking case is a clean 200 whose body says `signal: 'uncovered'`:
 *   - ok:false (the fetch threw / timed out)  → silent
 *   - any non-200 status                      → silent
 *   - 200 with signal 'covered'/'unresolved'  → silent
 *   - 200 with an absent/unknown signal       → silent
 *   - 200 with signal 'uncovered'             → SPEAK (carrying the subsystem)
 *
 * Exported + unit-tested. `ok` is whether the fetch itself resolved; `status` and
 * `payload` are only meaningful when it did.
 */
export function interpretCoverageResponse(
  ok: boolean,
  status: number,
  payload: unknown,
): { speak: boolean; signal: CoverageSignal; subsystem: string | null } {
  if (!ok || status !== 200) return { speak: false, signal: 'unresolved', subsystem: null };
  const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (rec.signal !== 'uncovered') {
    const known = rec.signal === 'covered' || rec.signal === 'unresolved' ? rec.signal : 'unresolved';
    return { speak: false, signal: known, subsystem: null };
  }
  const subsystem =
    typeof rec.subsystem === 'string' && rec.subsystem.trim().length > 0 ? rec.subsystem.trim() : null;
  return { speak: true, signal: 'uncovered', subsystem };
}

/**
 * The line itself. Plain, short, and an OFFER rather than a verdict on the person:
 * it says what is on record and how to read it, never "you don't understand this".
 * Never says the noun "architectural memory" — the surface is the "How it works"
 * view and its recorded why.
 */
export function editNudgeMessage(subsystem: string | null): string {
  const area = subsystem ? `"${subsystem}"` : 'this part of the codebase';
  const topic = subsystem ?? 'this area';
  return (
    `Backthread: you haven't been through anything on ${area} yet — ` +
    `\`/backthread:how ${topic}\` shows what's already on record before you change it.`
  );
}

// --- payload parsing -------------------------------------------------------------

/**
 * Extract the target file path from an Edit / MultiEdit / Write `tool_input`. All
 * three carry `file_path`; `path` is a defensive extra. NO free-for-all fallback —
 * an unknown shape yields '' and the hook stays silent, which is safer than
 * guessing at some other string field.
 */
export function extractEditPath(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const ti = toolInput as Record<string, unknown>;
  for (const key of ['file_path', 'path']) {
    const v = ti[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return '';
}

/**
 * Make an edited path repo-relative + POSIX, the key convention the server
 * resolves against. Returns null when the path escapes the repo root (a file
 * outside the checkout is not part of any subsystem) — which the caller treats as
 * one more reason to stay silent.
 */
export function toRepoRelativePath(repoRoot: string, cwd: string, filePath: string): string | null {
  try {
    const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    const rel = relative(resolve(repoRoot), abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return sep === '/' ? rel : rel.split(sep).join('/');
  } catch {
    return null;
  }
}

// --- the hook ---------------------------------------------------------------------

export interface EditNudgeDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readConfigImpl?: (env: NodeJS.ProcessEnv) => Promise<BackthreadConfig>;
  readRemoteImpl?: RemoteReader;
  resolveRepoRootImpl?: (cwd: string) => string;
  /** Fallback cwd when the payload omits one. Defaults to process.cwd(). */
  cwd?: string;
}

/** Ask the server whether the caller has coverage of `path`'s area. Never throws. */
export async function checkCoverage(
  repo: RepoHandle,
  path: string,
  token: string,
  deps: EditNudgeDeps = {},
): Promise<{ speak: boolean; signal: CoverageSignal; subsystem: string | null }> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COVERAGE_PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await doFetch(buildCoveragePreflightUrl(env), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, // device token — never logged
        'Content-Type': 'application/json',
        ...versionHeaders(),
      },
      body: JSON.stringify({ repo: { owner: repo.owner, name: repo.name }, path }),
      signal: controller.signal,
    });
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    return interpretCoverageResponse(true, res.status, payload);
  } catch {
    // Network error, timeout abort, anything at all → silence.
    return interpretCoverageResponse(false, 0, null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the PreToolUse output for a raw stdin payload. NEVER throws — every
 * problem yields `{}` (no message; the edit proceeds untouched). Returns the JSON
 * object the bin prints to stdout.
 */
export async function runEditNudge(rawStdin: string, deps: EditNudgeDeps = {}): Promise<EditNudgeOutput> {
  const env = deps.env ?? process.env;
  const doReadConfig = deps.readConfigImpl ?? readConfig;
  const resolveRoot = deps.resolveRepoRootImpl ?? defaultResolveRepoRoot;
  try {
    let payload: unknown;
    try {
      payload = JSON.parse(rawStdin);
    } catch {
      return {}; // unparseable payload → silent
    }
    const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

    // No session id → we cannot throttle, so say NOTHING rather than risk a line on
    // every edit. Same rule the connect nudge applies for the same reason.
    const sessionId = typeof rec.session_id === 'string' ? rec.session_id.trim() : '';
    if (!sessionId) return {};

    const filePath = extractEditPath(rec.tool_input);
    if (!filePath) return {};

    // Already said our piece this session, or already spent the lookup budget →
    // return before touching the network, so the rest of the session pays nothing.
    if (await wasSessionClaimed(EDIT_NUDGE_FILE, sessionId, env)) return {};
    if (!(await claimPreflightSlot(sessionId, env))) return {};

    const cwd = typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : (deps.cwd ?? process.cwd());
    const repo = resolveRepo(cwd, deps.readRemoteImpl);
    if (!repo) return {}; // not a git repo / no origin → nothing to ask about

    const repoRoot = resolveRoot(cwd);
    const relPath = toRepoRelativePath(repoRoot, cwd, filePath);
    if (!relPath) return {};

    const config = await Promise.resolve()
      .then(() => doReadConfig(env))
      .catch(() => ({}) as BackthreadConfig);
    if (!config.device_token) return {}; // not signed in → silent, never a prompt

    const verdict = await checkCoverage(repo, relPath, config.device_token, deps);
    if (!verdict.speak) return {};

    // Claim the ONE line for this session. A losing race (a concurrent hook claimed
    // it first) resolves to silence, not to a second line.
    if (!(await claimSessionOnce(EDIT_NUDGE_FILE, sessionId, env))) return {};
    return { systemMessage: editNudgeMessage(verdict.subsystem) };
  } catch {
    return {}; // belt-and-braces: any failure → no message, the edit proceeds
  }
}

/**
 * Spend one of this session's lookups. Implemented as numbered claim keys in the
 * same ring (`<session>#1`, `#2`, …) so the whole budget reuses one primitive with
 * one file and one set of failure modes, rather than a second counter format that
 * would need its own corrupt-file handling.
 */
async function claimPreflightSlot(sessionId: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (let n = 1; n <= MAX_PREFLIGHTS_PER_SESSION; n++) {
    if (await claimSessionOnce(EDIT_NUDGE_FILE, `${sessionId}#${n}`, env)) return true;
  }
  return false;
}
