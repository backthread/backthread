// sweepLedger.ts — the DURABLE local state for gap-recovery sweeps.
//
// The capture-resume sweep (sweep.ts) needs two pieces of persistent local state,
// both living in ~/.backthread/ alongside config.json + capture-sessions.json:
//
//   1. A PROCESSED-SESSION LEDGER — the sessionIds the sweep has already run through
//      the redact→infer→persist pipeline (with a terminal, non-transient outcome).
//      This is the SKIP-BEFORE-INFERENCE signal: a session in the ledger is never
//      re-derived, so a re-sweep costs 0 inference and writes 0 new decisions
//      (the idempotence acceptance criterion). It is DURABLE + generously bounded —
//      distinct from fromHook's tiny 200-entry `capture-sessions.json` RING (which
//      exists to de-dupe per-TURN hook fires within a live session). The ring would
//      scroll a long history off the front; this ledger must remember every session
//      a sweep ever processed, so it is bounded far higher (MAX_PROCESSED).
//
//   2. A PER-REPO `lastSweptAt` MARKER — the cheap freshness gate. The sweep is a
//      no-op once the gap is closed (the ledger makes enumeration find nothing), but
//      we still don't want to re-walk ~/.claude/projects on EVERY SessionEnd. A
//      short debounce keyed by repo slug keeps steady-state overhead ≈ 0. It only
//      ever DELAYS a sweep to the next eligible SessionEnd — it can never prevent a
//      gap from eventually healing (sessions are minutes-to-hours apart; the debounce
//      is short). v1 uses this LOCAL marker; ARP-683's server-side
//      `repo_capture_freshness` is the future cross-machine signal.
//
// BEST-EFFORT, FAIL-OPEN (load-bearing — same posture as fromHook's state layer):
// a missing/corrupt/unwritable state file must NEVER block a sweep or a capture. On
// any read error we return empty state (so the sweep treats everything as not-yet-
// processed — we'd rather re-process, which the server-side dedupeKey de-dupes, than
// silently drop). Writes swallow every error. The file is written 0600 (the dir
// 0700) — it carries no credential, but we keep ~/.backthread uniformly private.

import { join } from 'node:path';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { configDir, CONFIG_MODE, DIR_MODE } from './config.js';

/** Durable sweep state: processed sessionIds + per-repo last-swept timestamps. */
export interface SweepState {
  /** SessionIds a sweep has processed to a terminal outcome (most-recent last). */
  processed: string[];
  /** Per-repo (`owner/name`) ISO timestamp of the last completed sweep. */
  lastSweptAt: Record<string, string>;
}

/**
 * Upper bound on remembered processed sessionIds. Far larger than the live ring
 * (200) because this is the durable idempotence ledger — it must outlast a long
 * history. At ~36 bytes/id this caps the file near ~720KB; oldest ids fall off the
 * front. A session that scrolls off can be re-processed on a future sweep — the
 * server-side dedupeKey catches the duplicate, so correctness holds; only a little
 * inference is re-paid (the same trade the live ring already accepts).
 */
export const MAX_PROCESSED = 20000;

/** The durable sweep-state file: ~/.backthread/sweep-state.json. */
export function sweepStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'sweep-state.json');
}

/** Parse a sweep-state blob defensively → empty state on anything unexpected. */
export function parseSweepState(raw: string): SweepState {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const rec = obj as Record<string, unknown>;
      const processed = Array.isArray(rec.processed)
        ? rec.processed.filter((s): s is string => typeof s === 'string')
        : [];
      const lastSweptAt: Record<string, string> = {};
      if (rec.lastSweptAt && typeof rec.lastSweptAt === 'object' && !Array.isArray(rec.lastSweptAt)) {
        for (const [k, v] of Object.entries(rec.lastSweptAt as Record<string, unknown>)) {
          if (typeof v === 'string' && v.length > 0) lastSweptAt[k] = v;
        }
      }
      return { processed, lastSweptAt };
    }
  } catch {
    // fall through to empty (fail open — re-process rather than silently drop)
  }
  return { processed: [], lastSweptAt: {} };
}

/** Serialize sweep state to disk form (stable key order, trailing newline). */
export function serializeSweepState(state: SweepState): string {
  return JSON.stringify({ processed: state.processed, lastSweptAt: state.lastSweptAt }) + '\n';
}

/** Read the durable sweep state. Missing/unreadable file → empty state (never throws). */
export async function readSweepState(env: NodeJS.ProcessEnv = process.env): Promise<SweepState> {
  try {
    return parseSweepState(await readFile(sweepStatePath(env), 'utf8'));
  } catch {
    return { processed: [], lastSweptAt: {} };
  }
}

/** Write the durable sweep state at 0600 (dir 0700). Swallows every error (best-effort). */
export async function writeSweepState(
  state: SweepState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const dir = configDir(env);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE).catch(() => {});
    const path = sweepStatePath(env);
    await writeFile(path, serializeSweepState(state), { mode: CONFIG_MODE });
    await chmod(path, CONFIG_MODE).catch(() => {});
  } catch {
    // A write failure just means the next sweep might re-process (server dedupe
    // catches it) or re-walk sooner. Swallow it — best-effort posture.
  }
}

/**
 * Fold a batch of newly-processed sessionIds into the `processed` ledger, bounding it
 * to {@link MAX_PROCESSED} (oldest fall off the front). De-dupes against what's
 * already there. Pure → unit-testable; the caller persists the result.
 */
export function addProcessed(state: SweepState, sessionIds: readonly string[]): SweepState {
  const seen = new Set(state.processed);
  const next = [...state.processed];
  for (const sid of sessionIds) {
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    next.push(sid);
  }
  if (next.length > MAX_PROCESSED) next.splice(0, next.length - MAX_PROCESSED);
  return { ...state, processed: next };
}

/**
 * Record ONE session as processed in the durable ledger (read-modify-write). Called
 * by the LIVE capture path (fromHook) when a session is captured to a terminal
 * outcome, so a later gap-recovery sweep never re-derives it (skip-before-inference).
 * Best-effort + fail-open: a missing id or any I/O error is swallowed. Never throws.
 */
export async function markSweepProcessed(
  sessionId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!sessionId || sessionId.trim().length === 0) return;
  try {
    const state = await readSweepState(env);
    if (state.processed.includes(sessionId)) return; // already recorded — no rewrite
    await writeSweepState(addProcessed(state, [sessionId]), env);
  } catch {
    // best-effort — a later sweep re-processing this session is de-duped server-side.
  }
}
