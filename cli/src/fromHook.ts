// fromHook.ts — the SHARED hook entrypoint: `backthread capture --from-hook`.
//
// THE ONE seam every non-CC agent (Codex / Cursor / Gemini CLI) wires its
// session-end / stop hook to. The spike found that ALL four agents
// pass the same three things to a hook on STDIN — `transcript_path`, a session id,
// and `cwd` — just under DIFFERENT FIELD NAMES. So instead of per-agent transcript
// dir-walking + cwd-filtering at capture time, the hook hands us the EXACT transcript
// file; we normalize the payload into the existing `HookInput` shape and feed it
// straight through the redact→infer→persist fence (`runCapture` — reused
// VERBATIM, never reimplemented). The provider dir-walkers stay, but only for
// BACKFILL (mining history); live hook capture no longer needs them.
//
// WHY a thin normalizer over a parallel pipeline: `runCapture` already consumes a
// `HookInput` ({transcript_path, cwd, session_id}) and already enforces the
// local-redaction trust boundary + the best-effort/never-throws posture. The ONLY
// gap between agents is the field names on stdin. So this module is purely
//   (1) payload normalization (per-agent aliases → HookInput),
//   (2) idempotence (one session = one capture — Codex/Cursor `stop` fire per turn),
//   (3) a detached/fire-and-forget seam (Gemini's SessionEnd is best-effort: the CLI
//       does not await the hook, so a synchronous capture would be silently killed),
//   (4) optional JSON-on-stdout (Codex consumes hook stdout when the hook exits 0).
// Everything load-bearing (redaction, inference, persistence) lives in runCapture.
//
// NON-NEGOTIABLE POSTURE (same contract as the CC hook): `--from-hook` ALWAYS exits
// 0. A capture hiccup must NEVER disrupt or delay the host agent's session. Every
// step here is wrapped; any failure degrades to a swallowed structured outcome.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { configDir, CONFIG_MODE, DIR_MODE } from './config.js';
import {
  parseHookInput,
  runCapture,
  type CaptureDeps,
  type CaptureOutcome,
  type HookInput,
} from './capture.js';
import { markSweepProcessed } from './sweepLedger.js';
import { runGapRecoverySweep, isTerminallyProcessed, type SweepDeps, type SweepSummary } from './sweep.js';

// The agents this entrypoint normalizes payloads for. `claude-code` is included so
// the SAME entrypoint can subsume the existing CC SessionEnd hook later (the bare
// `capture` command still works unchanged); `unknown` is the safe default — we read
// the canonical CC/Gemini field names, which most agents already use.
export type Agent = 'claude-code' | 'codex' | 'cursor' | 'gemini-cli' | 'unknown';

const KNOWN_AGENTS: ReadonlySet<string> = new Set([
  'claude-code',
  'codex',
  'cursor',
  'gemini-cli',
  // Tolerate the bare "gemini" alias the spike's snippet used in one place.
  'gemini',
]);

/** Map a `--agent <x>` flag value to a known Agent, defaulting to 'unknown'. */
export function parseAgent(value: string | undefined): Agent {
  if (!value) return 'unknown';
  const v = value.trim().toLowerCase();
  if (v === 'gemini') return 'gemini-cli';
  return (KNOWN_AGENTS.has(v) ? v : 'unknown') as Agent;
}

/**
 * Pull a string field off a loosely-typed payload record, trimming + treating an
 * empty string as absent. The hook contract is owned by the agent, not us, so we
 * read defensively: any field may be missing, null, or wrong-typed.
 */
function str(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  if (typeof v === 'string' && v.trim().length > 0) return v;
  return undefined;
}

/**
 * Normalize ANY agent's hook stdin payload into the canonical `HookInput` shape that
 * `runCapture` consumes. This is the heart of the "one shared entrypoint": the four
 * agents differ ONLY in field names (verified payload shapes from the spike).
 *
 *   Claude Code (SessionEnd/Stop):
 *     { session_id, transcript_path, cwd, hook_event_name }              ← canonical
 *   Codex (Stop):
 *     { session_id, transcript_path, cwd, hook_event_name, turn_id, … }  ← canonical names
 *   Gemini CLI (SessionEnd):
 *     { session_id, transcript_path, cwd, hook_event_name, reason }      ← canonical names
 *   Cursor (stop / sessionEnd):
 *     { conversation_id, generation_id, transcript_path (NULLABLE), workspace_roots[], … }
 *
 * So Codex/Gemini/CC all already use the canonical keys; only CURSOR aliases them
 * (`conversation_id` → session, `workspace_roots[0]` → cwd). The aliases are read as a
 * generic fallback for ANY agent (not gated on `agent`), so an agent that sends both
 * (or an unexpected mix) still resolves and the `agent` param stays a documentation/
 * future seam. Returns a `HookInput` with whatever resolved — `runCapture`
 * degrades gracefully on any absent field (no transcript_path → `no-transcript`,
 * no cwd → repo-less landing, no session_id → falls back to the transcript's own id).
 *
 * CURSOR `transcript_path` IS DOCUMENTED NULLABLE ("null if disabled"; cause TBD).
 * We do NOT invent a path here: a null/absent transcript_path flows
 * through as undefined and `runCapture` returns `no-transcript` (the live hook path
 * degrades to a no-op; backfill's dir-walker remains the fallback for Cursor). That's
 * the "degrade gracefully" the spike + call for.
 */
export function normalizeHookInput(payload: HookInput | Record<string, unknown>, _agent: Agent): HookInput {
  const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

  // transcript_path: every agent that exposes it uses this exact key (Cursor too,
  // when present). No alias needed.
  const transcript_path = str(rec, 'transcript_path');

  // session id: canonical `session_id` for CC/Codex/Gemini; Cursor uses
  // `conversation_id` (its turn-stable id) — prefer the canonical, fall back to it.
  // We deliberately do NOT use Cursor's `generation_id` (that's PER-TURN, which would
  // defeat the once-per-session dedupe).
  const session_id = str(rec, 'session_id') ?? str(rec, 'conversation_id');

  // cwd: canonical for CC/Codex/Gemini; Cursor sends `workspace_roots: string[]` —
  // take the first root as the working directory for repo resolution.
  let cwd = str(rec, 'cwd');
  if (cwd === undefined) {
    const roots = rec['workspace_roots'];
    if (Array.isArray(roots)) {
      const first = roots.find((r): r is string => typeof r === 'string' && r.trim().length > 0);
      if (first) cwd = first;
    }
  }

  // hook_event_name: informational; carried through unchanged when present.
  const hook_event_name = str(rec, 'hook_event_name');

  const out: HookInput = {};
  if (transcript_path !== undefined) out.transcript_path = transcript_path;
  if (cwd !== undefined) out.cwd = cwd;
  if (session_id !== undefined) out.session_id = session_id;
  if (hook_event_name !== undefined) out.hook_event_name = hook_event_name;
  return out;
}

// ---------------------------------------------------------------------------------
// Idempotence — one session = one capture.
//
// Codex's `Stop` and Cursor's `stop` hooks fire at TURN scope (once per assistant
// turn), not once per session. Without a guard, a 20-turn Codex session would run
// the full redact→infer→persist pipeline 20 times. So we persist a tiny throttle
// keyed by session id in ~/.backthread/ — the SAME bounded-ring / 0600 pattern as
// connectNudge.ts — and skip a session we've already captured.
//
// This is a SEPARATE state file from connect-nudge.json on purpose: the nudge throttle
// records "already nudged this session" (a courtesy), while this records "already
// CAPTURED this session" (correctness — it gates real work + network). Different
// lifecycles, different files; both tiny + best-effort.
//
// BEST-EFFORT (load-bearing): a missing/corrupt/unwritable state file must NEVER block
// a capture. We FAIL OPEN — on any read error we treat the session as not-yet-captured
// (so we'd rather double-capture than silently drop). The persist layer's own dedupe
// (ingest-decisions derives a stable dedupeKey from sessionId+decidedAt+title) is the
// server-side backstop, so a rare double-capture is de-duped there anyway.
// ---------------------------------------------------------------------------------

export function captureStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'capture-sessions.json');
}

// Bounded ring of recently-captured session ids (most-recent last). Older ids fall
// off the front so the file stays tiny. A session that scrolls off the ring can be
// re-captured — accepted: the server-side dedupeKey catches the duplicate, and the
// ring is generous enough that turn-bursts within one live session stay covered.
const MAX_REMEMBERED = 200;

interface CaptureState {
  /** Session ids already captured by a --from-hook run (most-recent last). */
  captured: string[];
}

/** Parse the throttle blob defensively → empty state on anything unexpected. */
function parseState(raw: string): CaptureState {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && Array.isArray((obj as CaptureState).captured)) {
      const captured = (obj as CaptureState).captured.filter((s): s is string => typeof s === 'string');
      return { captured };
    }
  } catch {
    // fall through to empty (fail open — re-capture rather than silently drop)
  }
  return { captured: [] };
}

async function readState(env: NodeJS.ProcessEnv): Promise<CaptureState> {
  try {
    return parseState(await readFile(captureStatePath(env), 'utf8'));
  } catch {
    // Missing file (first run) or unreadable → empty state. Never throw.
    return { captured: [] };
  }
}

async function writeState(state: CaptureState, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const dir = configDir(env);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE).catch(() => {});
    const path = captureStatePath(env);
    await writeFile(path, JSON.stringify(state) + '\n', { mode: CONFIG_MODE });
    await chmod(path, CONFIG_MODE).catch(() => {});
  } catch {
    // A write failure just means the NEXT turn-fire might re-capture (server dedupe
    // catches it). Swallow it — best-effort posture.
  }
}

/** True if this session id has already been captured this install (idempotence). */
export async function wasSessionCaptured(
  sessionId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!sessionId || sessionId.trim().length === 0) return false; // unknown id → can't dedupe
  const state = await readState(env);
  return state.captured.includes(sessionId);
}

/** Record a session id as captured (bounded ring; oldest fall off). Never throws. */
export async function markSessionCaptured(
  sessionId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!sessionId || sessionId.trim().length === 0) return; // nothing to key on
  const state = await readState(env);
  if (state.captured.includes(sessionId)) return; // already recorded
  const captured = [...state.captured, sessionId];
  if (captured.length > MAX_REMEMBERED) captured.splice(0, captured.length - MAX_REMEMBERED);
  await writeState({ captured }, env);
}

// ---------------------------------------------------------------------------------
// Detached / fire-and-forget mode.
//
// Gemini CLI's `SessionEnd` hook is BEST-EFFORT: the spike found the CLI does NOT
// await the hook, so a slow synchronous capture (network round-trips to infer +
// ingest) would be silently killed mid-flight. The fix: re-spawn `backthread capture
// --from-hook` as a DETACHED child that outlives the parent, hand it the
// already-buffered stdin via an env var, then exit 0 immediately. The detached child
// runs the real capture after the host CLI has moved on.
//
// We pass the payload through `BACKTHREAD_HOOK_INPUT` (the env fallback `readHookInput`
// already honors) rather than re-piping stdin, because a detached child's stdin is
// 'ignore'd — there's no parent process to keep the pipe open. Mirrors browser.ts:
// spawn detached + unref + never-throw.
// ---------------------------------------------------------------------------------

export interface SpawnDetachedDeps {
  /** Test seam: the spawner. Defaults to child_process.spawn. */
  spawnImpl?: typeof spawn;
  /** Test seam: argv[0] (the node executable). Defaults to process.execPath. */
  execPath?: string;
  /** Test seam: argv[1] (this script / bin). Defaults to process.argv[1]. */
  scriptPath?: string;
  /** Env to seed the child with (we inject BACKTHREAD_HOOK_INPUT). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn a detached `backthread capture --from-hook --agent <agent>` child that
 * re-reads the payload from `BACKTHREAD_HOOK_INPUT`, runs the capture after we exit,
 * and is fully decoupled from this process (own session, stdio ignored, unref'd).
 * NEVER throws — a failed spawn degrades to "no capture this time" (the next session
 * end retries). Returns whether the spawn was launched (for tests/logs).
 *
 * NOTE: the child runs WITHOUT `--detach` (it IS the detached worker) — otherwise it
 * would recursively re-spawn. The `--no-detach` guard in `runFromHook` enforces this.
 */
export function spawnDetached(rawPayload: string, agent: Agent, deps: SpawnDetachedDeps = {}): boolean {
  const doSpawn = deps.spawnImpl ?? spawn;
  const execPath = deps.execPath ?? process.execPath;
  const scriptPath = deps.scriptPath ?? process.argv[1];
  const baseEnv = deps.env ?? process.env;
  if (!scriptPath) return false; // can't locate the bin to re-exec; degrade to no-op

  try {
    const child = doSpawn(
      execPath,
      [scriptPath, 'capture', '--from-hook', '--no-detach', '--agent', agent],
      {
        // Detach from the parent's process group so it survives the host CLI exiting.
        detached: true,
        // No stdin (child reads BACKTHREAD_HOOK_INPUT); stdout/stderr discarded — the
        // host already moved on, and the capture is best-effort + silent by contract.
        stdio: 'ignore',
        env: { ...baseEnv, BACKTHREAD_HOOK_INPUT: rawPayload },
      },
    );
    // Don't keep the parent's event loop alive waiting on the child.
    child.unref();
    // Swallow a late spawn error (e.g. ENOENT on execPath) — best-effort.
    child.on?.('error', () => {});
    return true;
  } catch {
    // Synchronous spawn failure (bad path, EAGAIN, …) — degrade to no-op.
    return false;
  }
}

// ---------------------------------------------------------------------------------
// The orchestrator.
// ---------------------------------------------------------------------------------

export interface FromHookResult {
  /** ALWAYS 0 — `--from-hook` must never disrupt the host agent. (Field exists for the bin + tests.) */
  exitCode: 0;
  /**
   * A terse machine status describing what the entrypoint DID (distinct from the
   * inner CaptureOutcome.status):
   *   - 'detached'           re-spawned a detached worker; this process exits now.
   *   - 'duplicate-session'  session already captured → skipped (idempotence).
   *   - 'captured'           ran the capture pipeline (see `outcome` for its result).
   *   - 'no-input'           stdin/env payload was empty/garbage → nothing to do.
   *   - 'error'              the entrypoint itself threw and was swallowed (see `outcome`).
   */
  status: 'detached' | 'duplicate-session' | 'captured' | 'no-input' | 'error';
  /** The inner runCapture outcome, when we ran the pipeline (else null). */
  outcome: CaptureOutcome | null;
  /** The normalized hook input we derived (for tests/logs; never carries source). */
  input: HookInput;
  /**
   * The JSON object to print on STDOUT, or null to print nothing. Codex consumes a
   * hook's stdout when it exits 0; the other agents ignore it. We emit a minimal,
   * source-free ack so a Codex hook has a well-formed response. (The bin decides
   * whether to actually print, gated on whether stdout is the hook channel.)
   */
  stdout: Record<string, unknown> | null;
}

export interface FromHookDeps {
  /** Env override seam. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * The raw stdin payload, already buffered by the caller (the bin reads stdin once;
   * detached mode needs the raw bytes to re-hand to the child). When omitted we fall
   * back to the `BACKTHREAD_HOOK_INPUT` env var (the detached child's path).
   */
  rawPayload?: string;
  /** Which agent's payload this is (`--agent <x>`). Defaults to 'unknown' (canonical fields). */
  agent?: Agent;
  /**
   * Detached mode (`--detach`, set by Gemini's hook). When true we re-spawn a detached
   * worker and return immediately. `--no-detach` (the child's own invocation) forces
   * this false so the worker actually runs the capture instead of re-spawning forever.
   */
  detach?: boolean;
  /** Test seam: the capture pipeline. Defaults to runCapture. */
  runCaptureImpl?: (input: HookInput, deps?: CaptureDeps) => Promise<CaptureOutcome>;
  /** CaptureDeps threaded into runCapture (env, fetch, readers) — for tests. */
  captureDeps?: CaptureDeps;
  /** Test seam: the detached spawner. Defaults to spawnDetached. */
  spawnDetachedImpl?: (raw: string, agent: Agent, deps?: SpawnDetachedDeps) => boolean;
  /** Test seam: the idempotence check. Defaults to wasSessionCaptured. */
  wasCapturedImpl?: (sessionId: string | null | undefined, env: NodeJS.ProcessEnv) => Promise<boolean>;
  /** Test seam: the idempotence recorder. Defaults to markSessionCaptured. */
  markCapturedImpl?: (sessionId: string | null | undefined, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Test seam: the DURABLE sweep-ledger recorder. Defaults to markSweepProcessed. */
  markSweepProcessedImpl?: (sessionId: string | null | undefined, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Test seam: the gap-recovery sweep. Defaults to runGapRecoverySweep. */
  runSweepImpl?: (input: { cwd?: string }, deps?: SweepDeps) => Promise<SweepSummary>;
}

/**
 * Run the shared hook entrypoint. NEVER throws — every path resolves to a
 * `FromHookResult` with `exitCode: 0`. Order of operations:
 *
 *   1. Resolve the raw payload (caller-buffered stdin, else BACKTHREAD_HOOK_INPUT).
 *   2. DETACHED short-circuit: if `detach` is set, re-spawn a detached worker with the
 *      raw payload and return immediately (status 'detached'). The worker re-enters
 *      this function WITHOUT detach and does the real work.
 *   3. Parse + normalize the payload into HookInput (per-agent field aliases).
 *   4. IDEMPOTENCE: if this session id was already captured, skip (status
 *      'duplicate-session'). Codex/Cursor `stop` fire per-turn; one session = one capture.
 *   5. Run the SHARED runCapture fence VERBATIM (local redact → infer → persist).
 *   6. On a real capture (something landed or was deliberately skipped, but not a
 *      transient error), RECORD the session id so later turn-fires are idempotent.
 */
export async function runFromHook(deps: FromHookDeps = {}): Promise<FromHookResult> {
  const env = deps.env ?? process.env;
  const agent = deps.agent ?? 'unknown';

  try {
    // (1) Raw payload: caller-buffered stdin wins; else the env fallback (detached child).
    const raw =
      deps.rawPayload !== undefined && deps.rawPayload.length > 0
        ? deps.rawPayload
        : (env.BACKTHREAD_HOOK_INPUT ?? '');

    // (2) Detached short-circuit (Gemini's best-effort SessionEnd). Re-spawn + bail.
    if (deps.detach) {
      const spawnImpl = deps.spawnDetachedImpl ?? spawnDetached;
      const launched = spawnImpl(raw, agent, { env });
      return {
        exitCode: 0,
        status: 'detached',
        outcome: null,
        input: {},
        stdout: codexStdout(agent, launched ? 'detached' : 'detach-failed'),
      };
    }

    // (3) Parse + normalize.
    const payload = parseHookInput(raw);
    const input = normalizeHookInput(payload, agent);

    // Empty payload (no transcript, no session, no cwd) → nothing to do. We still
    // exit 0; this just avoids a pointless pipeline run + a misleading "captured".
    if (!input.transcript_path && !input.session_id && !input.cwd) {
      return {
        exitCode: 0,
        status: 'no-input',
        outcome: null,
        input,
        stdout: codexStdout(agent, 'no-input'),
      };
    }

    // (4) Idempotence — one session = one capture (per-turn hooks fire repeatedly).
    // FAIL OPEN: a broken/throwing check degrades to "not captured" so the capture
    // still proceeds (same posture as the state layer above). A rare double-capture is
    // de-duped server-side; silently aborting the run on a check failure would not be.
    const wasCaptured = deps.wasCapturedImpl ?? wasSessionCaptured;
    const dup = await wasCaptured(input.session_id, env).catch(() => false);
    if (dup) {
      return {
        exitCode: 0,
        status: 'duplicate-session',
        outcome: null,
        input,
        stdout: codexStdout(agent, 'duplicate-session'),
      };
    }

    // (5) Run the SHARED fence (reused verbatim — redaction + trust boundary intact).
    const run = deps.runCaptureImpl ?? runCapture;
    const outcome = await run(input, deps.captureDeps);

    // (6) Record the session as captured so later turn-fires of the SAME session are
    // idempotent — but ONLY when we actually got a terminal result for this session.
    // We mark on every NON-transient outcome, including 'nothing-to-capture' AND
    // 'no-auth'. We do NOT mark on a transient failure ('infer-failed' /
    // 'persist-failed' / 'error' / 'no-transcript') so a later turn-fire (or the next
    // session-end) can retry. session_id may be null when the transcript carried its
    // own id — prefer the outcome-independent input id, which is what the per-turn hook
    // re-sends.
    //
    // WHY mark 'no-auth' (this is load-bearing — do NOT "fix" it to leave no-auth
    // unmarked): auth state CAN change mid-session — runCapture's no-auth path
    // fire-and-forgets ensureAuth (which opens a browser login), so a later turn could
    // succeed once the user signs in. Marking it anyway is deliberate POPUP-STORM
    // PREVENTION: leaving no-auth unmarked would re-fire ensureAuth on EVERY turn-fire
    // of an unauthenticated per-turn session, opening a browser tab each turn. The cost
    // of marking is that this one session is permanently skipped for LIVE capture even
    // if the user authenticates mid-session — but BACKFILL recovers it at install (it
    // mines history regardless of the live ring), so nothing is actually lost.
    if (!isTransient(outcome)) {
      const mark = deps.markCapturedImpl ?? markSessionCaptured;
      await mark(input.session_id, env).catch(() => {});
      // ARP-688: ALSO record in the DURABLE sweep ledger — but ONLY when the session was
      // genuinely captured/decided (NOT no-auth, which the ring marks for popup-storm
      // prevention but which a later sweep must still recover once authed). This makes
      // the live-capture path the source of truth for "already captured", so the
      // gap-recovery sweep below (and every future one) skips it BEFORE inference.
      if (isTerminallyProcessed(outcome)) {
        await (deps.markSweepProcessedImpl ?? markSweepProcessed)(input.session_id, env).catch(() => {});
      }
    }

    // ARP-688: GAP-RECOVERY SWEEP. After the normal forward capture, silently heal any
    // EARLIER un-captured sessions for this repo (a lapsed-then-restored connection
    // otherwise only resumes forward). Gated to the detached CC worker — it rides the
    // already-detached SessionEnd hook (ARP-682) so a multi-transcript sweep never
    // blocks the host session; other agents' enumeration is the Phase-2 port. The
    // current session is already in the durable ledger (marked just above), so the
    // sweep skips it. Best-effort + freshness-debounced; NEVER throws (await-and-swallow).
    if (agent === 'claude-code') {
      const sweep = deps.runSweepImpl ?? runGapRecoverySweep;
      await sweep({ cwd: input.cwd }, { env, captureDeps: deps.captureDeps }).catch(() => {});
    }

    return {
      exitCode: 0,
      status: 'captured',
      outcome,
      input,
      stdout: codexStdout(agent, 'captured', outcome),
    };
  } catch (e) {
    // Ultimate backstop — the entrypoint must never throw into the host agent.
    return {
      exitCode: 0,
      status: 'error',
      outcome: { status: 'error', detail: `from-hook failed (swallowed): ${(e as Error).message}` },
      input: {},
      stdout: codexStdout(agent, 'error'),
    };
  }
}

/**
 * A transient outcome is one a later retry could improve (network/auth-in-flight/
 * unreadable-yet). We do NOT mark these as captured, so a subsequent turn-fire or the
 * next session-end gets another chance. Everything else is stable for the session.
 */
function isTransient(outcome: CaptureOutcome): boolean {
  return (
    outcome.status === 'infer-failed' ||
    outcome.status === 'persist-failed' ||
    outcome.status === 'error' ||
    outcome.status === 'no-transcript'
  );
}

/**
 * Build the JSON object to print on STDOUT, but ONLY for Codex (the spike found Codex
 * consumes a hook's stdout when it exits 0; the other agents ignore stdout). For any
 * other agent we return null → the bin prints nothing (and crucially, when the same
 * `capture --from-hook` is wired as the CC/Gemini/Cursor hook, stdout stays clean).
 *
 * The ack is deliberately MINIMAL and SOURCE-FREE: a status string + a `continue: true`
 * (Codex's "don't block the turn" signal). No transcript content, no decision text, no
 * device token — nothing that could leak through a stdout channel an agent might log.
 */
function codexStdout(
  agent: Agent,
  status: string,
  outcome?: CaptureOutcome,
): Record<string, unknown> | null {
  if (agent !== 'codex') return null;
  const ack: Record<string, unknown> = {
    continue: true, // Codex hook contract: don't block the turn.
    backthread: { status },
  };
  // Surface the inner capture status (NOT its detail — detail is human prose for
  // stderr; we keep stdout terse + structured) so a Codex debugger can see the result.
  if (outcome) (ack.backthread as Record<string, unknown>).capture = outcome.status;
  return ack;
}
