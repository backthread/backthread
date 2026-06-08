// connectNudge.ts — the "your repo isn't connected" nudge.
//
// The capture response carries a piggybacked `repoStatus` health signal
// (connected | not_connected | disconnected — see ingest-decisions/route.ts). When
// it says the repo isn't connected (the agent is installed but the GitHub repo isn't
// linked to Backthread yet) — or it was disconnected (the App was uninstalled) — we
// surface a one-line nudge to stderr pointing the user at the connect page. Capture
// itself ALWAYS succeeds first (repo-less landing); the nudge only drives the
// connect so reconciliation can later fill in the module links.
//
// THROTTLE — "once per session, not per capture": the SessionEnd hook fires once per
// session, but manual `/backthread:capture` + MCP captures can fire MANY times within
// one session. So we persist a tiny throttle keyed by session id in ~/.backthread/ —
// a session that's already been nudged is suppressed; a new session re-shows.
// Concurrent same-session captures may RARELY double-nudge (read-modify-write race
// on the state file) — accepted: the blast radius is one duplicate stderr line, and
// locking a courtesy feature isn't worth it.
//
// BEST-EFFORT (load-bearing): this is wired into the always-exit-0 capture hook, so
// NOTHING here may throw. A missing/corrupt/unwritable throttle file degrades to
// suppressing the nudge (never spamming, never crashing). When the session id is
// unknown we likewise suppress rather than risk nudging every capture.

import { join } from 'node:path';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { configDir, CONFIG_MODE, DIR_MODE } from './config.js';
import { buildRepoDeepLink } from './urls.js';

// The piggybacked repo-health signal off the capture (ingest-decisions) response.
export type RepoStatus = 'connected' | 'not_connected' | 'disconnected';

// Parse the `repoStatus` field off an arbitrary ingest-response record. Unknown /
// absent → null (no nudge). Kept permissive: an older server that doesn't send the
// field simply yields null, and capture proceeds unchanged.
export function parseRepoStatus(value: unknown): RepoStatus | null {
  return value === 'connected' || value === 'not_connected' || value === 'disconnected'
    ? value
    : null;
}

// — the UNIFIED canonical next step the SERVER attaches to the
// capture response (ingest-decisions). When present it is authoritative: the
// cell→next-step decision lives once server-side and the CLI just renders the copy
// the server chose, instead of re-deriving it from `repoStatus`. We model only what
// the nudge needs (slug + display copy); the full contract lives in the
// onboarding-state module.
export interface ServerNextStep {
  slug: string;
  title: string;
  body: string;
}

// Tri-state parse of the `nextStep` field, distinguishing the three cases the nudge
// must treat differently:
//   * a valid {slug,title,body} object → the server's canonical next step (render it).
//   * explicit `null`                  → a TERMINAL state (fully onboarded): SUPPRESS.
//   * anything else / absent           → 'absent': an older server that doesn't send
//     the field → fall back to the legacy `repoStatus` path (backward compat).
export function parseNextStep(value: unknown): ServerNextStep | null | 'absent' {
  if (value === null) return null; // explicit terminal — no nudge
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as ServerNextStep).slug === 'string' &&
    typeof (value as ServerNextStep).title === 'string' &&
    typeof (value as ServerNextStep).body === 'string'
  ) {
    const v = value as ServerNextStep;
    return { slug: v.slug, title: v.title, body: v.body };
  }
  return 'absent';
}

// The throttle file: tiny, owner-only (0600), in the same dir as config.json.
export function nudgeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'connect-nudge.json');
}

// We keep a bounded ring of the most-recently-nudged session ids so concurrent
// sessions each get exactly one nudge while the file stays tiny. Older ids fall off.
const MAX_REMEMBERED = 50;

interface NudgeState {
  /** Session ids already nudged this install (most-recent last). */
  nudged: string[];
}

// Parse the throttle blob defensively → empty state on anything unexpected. A
// hand-corrupted (or partially-written) file must never break capture, so any
// malformed shape just means "nothing nudged yet" (we'll re-show, harmless).
function parseState(raw: string): NudgeState {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && Array.isArray((obj as NudgeState).nudged)) {
      const nudged = (obj as NudgeState).nudged.filter((s): s is string => typeof s === 'string');
      return { nudged };
    }
  } catch {
    // fall through to empty
  }
  return { nudged: [] };
}

async function readState(env: NodeJS.ProcessEnv): Promise<NudgeState> {
  try {
    return parseState(await readFile(nudgeStatePath(env), 'utf8'));
  } catch {
    // Missing file (first run) or unreadable → empty state. Never throw.
    return { nudged: [] };
  }
}

async function writeState(state: NudgeState, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const dir = configDir(env);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE).catch(() => {});
    const path = nudgeStatePath(env);
    await writeFile(path, JSON.stringify(state) + '\n', { mode: CONFIG_MODE });
    await chmod(path, CONFIG_MODE).catch(() => {});
  } catch {
    // A write failure just means the NEXT same-session capture might re-nudge — a
    // mild over-nudge, never a crash. Swallow it (best-effort posture).
  }
}

// Build the user-facing nudge copy. Tone: plain + lightly self-aware, matching the
// existing capture stderr lines (never the noun "architectural memory"; the product
// surface is the "How it works" diagram). The connect destination is the app's
// repo page, built via the shared helper (never hardcoded).
export function nudgeMessage(
  status: 'not_connected' | 'disconnected',
  repo: { owner: string; name: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const link = buildRepoDeepLink(repo.owner, repo.name, env);
  if (status === 'disconnected') {
    return (
      `backthread: captured — but ${repo.owner}/${repo.name} is disconnected (the GitHub App was removed), ` +
      `so your "How it works" diagram won't refresh. Reconnect it: ${link}`
    );
  }
  return (
    `backthread: captured — but ${repo.owner}/${repo.name} isn't connected to Backthread yet, ` +
    `so these decisions are held as pending. Connect it to see your "How it works" diagram: ${link}`
  );
}

// Slugs that warrant appending the CLI's repo deep-link to the server's copy: the
// connect-driven next steps point the user at the app's repo page. (The server copy
// already carries the "why"; the CLI owns the URL — built from its repo config, not
// hardcoded.) Other slugs render the server copy verbatim.
const LINKED_SLUGS = new Set(['connect_repo', 'cold_start']);

// Render the line for a SERVER-provided next step. The server owns the
// copy (so it's identical across surfaces); the CLI prefixes "backthread:" to match
// its other stderr lines and appends its repo deep-link for connect-driven slugs.
// Never says "architectural memory" — the server copy is vocabulary-disciplined and
// we don't add any.
export function nextStepMessage(
  step: ServerNextStep,
  repo: { owner: string; name: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = `backthread: ${step.body}`;
  if (LINKED_SLUGS.has(step.slug)) {
    return `${base} ${buildRepoDeepLink(repo.owner, repo.name, env)}`;
  }
  return base;
}

export interface NudgeDeps {
  env?: NodeJS.ProcessEnv;
  /** Where the nudge line goes. Defaults to console.error (stderr). */
  log?: (msg: string) => void;
  /**
   * The UNIFIED next step the server attached to the capture response.
   * When present it is AUTHORITATIVE and overrides the legacy `repoStatus`
   * path so the cell→next-step decision lives once server-side:
   *   * a {slug,title,body} object → render the server's copy (throttled as usual).
   *   * `null`                     → an explicit TERMINAL state (fully onboarded):
   *                                  SUPPRESS the nudge.
   *   * `'absent'` / omitted       → an older server that doesn't send the field →
   *                                  fall back to the `repoStatus` branch.
   */
  nextStep?: ServerNextStep | null | 'absent';
}

/**
 * Maybe surface the connect-nudge for one capture. Reads the throttle state, and if
 * this session id hasn't been nudged yet (and the signal warrants it), logs the nudge
 * and records the session id. Returns whether a nudge was emitted (for tests/logs).
 *
 * Decision source: if the server sent a unified `nextStep` it WINS — the
 * CLI renders the server's copy (or suppresses on the terminal `null`). Only when the
 * field is absent ('absent', e.g. an older server) do we fall back to the legacy
 * `repoStatus` mapping below. Either way the THROTTLE (once per session) and the
 * NEVER-THROWS contract are intact.
 *
 * Suppressed (returns false) when: the server says terminal (`nextStep: null`); the
 * legacy status is `connected`/null; there's no repo; the session id is unknown (we
 * won't nudge every capture); or this session was already nudged. NEVER throws.
 */
export async function maybeNudge(
  status: RepoStatus | null,
  repo: { owner: string; name: string } | null,
  sessionId: string | null,
  deps: NudgeDeps = {},
): Promise<boolean> {
  try {
    if (!repo) return false;
    // No session id → we can't throttle, so SUPPRESS rather than risk nudging every
    // capture (the ticket's "degrade to suppressing" rule).
    if (!sessionId || sessionId.trim().length === 0) return false;

    // Distinguish an explicit `null` (a terminal state → suppress) from an omitted /
    // undefined field (older server → legacy path). `??` would wrongly fold `null`
    // into 'absent', so only an `undefined` value maps to 'absent'.
    const rawNext = deps.nextStep;
    const nextStep: ServerNextStep | null | 'absent' = rawNext === undefined ? 'absent' : rawNext;
    const env = deps.env ?? process.env;

    // Build the line. Prefer the server's unified next step; fall back to the legacy
    // repoStatus path when the server didn't send one. A terminal (`null`) or a
    // not-warranted legacy status → no line → suppress.
    let line: string | null = null;
    if (nextStep === null) {
      // Explicit terminal (fully onboarded) — the server says "no nudge".
      return false;
    } else if (nextStep !== 'absent') {
      line = nextStepMessage(nextStep, repo, env);
    } else {
      // Legacy path: derive from repoStatus (older server without the unified next step).
      if (status !== 'not_connected' && status !== 'disconnected') return false;
      line = nudgeMessage(status, repo, env);
    }
    if (line === null) return false;

    const log = deps.log ?? ((m: string) => console.error(m));
    const state = await readState(env);
    if (state.nudged.includes(sessionId)) return false; // already nudged this session

    log(line);

    // Record this session id (bounded ring; oldest fall off the front).
    const nudged = [...state.nudged, sessionId];
    if (nudged.length > MAX_REMEMBERED) nudged.splice(0, nudged.length - MAX_REMEMBERED);
    await writeState({ nudged }, env);
    return true;
  } catch {
    // Ultimate backstop — the nudge is a courtesy, never a failure mode.
    return false;
  }
}
