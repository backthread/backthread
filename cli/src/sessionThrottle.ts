// sessionThrottle.ts — "say this at most once per session", on disk.
//
// Several courtesy lines in this CLI share one rule: a session may see them ONCE.
// The hooks that emit them fire many times per session (`Stop` runs every turn, a
// `PreToolUse` hook runs on every matching tool call), so without a throttle a
// one-line courtesy becomes a per-turn nag — which is how a helpful tool gets
// uninstalled.
//
// The state is a tiny, owner-only (0600) JSON file next to config.json holding a
// BOUNDED RING of the most-recently-seen session ids, so several concurrent
// sessions each get exactly one line while the file stays small and old ids fall
// off. Each caller passes its OWN filename: a connect nudge and a pre-edit line
// are different messages, and sharing one ring would let whichever fired first
// silence the other.
//
// BEST-EFFORT, NEVER THROWS (load-bearing). Every caller is wired into an
// always-exit-0 hook. A missing, corrupt or unwritable state file degrades to the
// SAFE side for a courtesy feature — a corrupt read means "nothing seen yet" (the
// line may re-show, harmless), and a failed write means a later same-session fire
// might repeat it once. Neither may ever crash the host agent's session.
//
// Concurrent same-session fires may RARELY double-emit (a read-modify-write race
// on the file). Accepted deliberately: the blast radius is one duplicate line, and
// locking a courtesy feature is not worth the failure modes a lock introduces.

import { join } from 'node:path';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { configDir, CONFIG_MODE, DIR_MODE } from './config.js';

/**
 * How many KEYS to remember before the oldest fall off the ring — keys, not
 * sessions. A caller that claims one key per session (the connect nudge) therefore
 * remembers fifty sessions; one that claims several per session (the pre-edit line,
 * which numbers its round-trip budget) remembers proportionally fewer. Eviction is
 * safe either way for both of today's callers: a forgotten key costs at most one
 * repeated line or one extra lookup, never a crash and never a wrong answer.
 */
export const MAX_REMEMBERED_SESSIONS = 50;

export interface SessionRing {
  /** Session ids already seen (most-recent last). */
  nudged: string[];
}

/** The absolute path of a named throttle file in the config dir. */
export function throttleStatePath(fileName: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), fileName);
}

/**
 * Parse a throttle blob defensively → an empty ring on anything unexpected. A
 * hand-corrupted (or partially-written) file must never break the hook that reads
 * it, so any malformed shape just means "nothing seen yet".
 */
export function parseSessionRing(raw: string): SessionRing {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && Array.isArray((obj as SessionRing).nudged)) {
      return { nudged: (obj as SessionRing).nudged.filter((s): s is string => typeof s === 'string') };
    }
  } catch {
    // fall through to empty
  }
  return { nudged: [] };
}

async function readRing(fileName: string, env: NodeJS.ProcessEnv): Promise<SessionRing> {
  try {
    return parseSessionRing(await readFile(throttleStatePath(fileName, env), 'utf8'));
  } catch {
    return { nudged: [] }; // missing (first run) or unreadable → empty
  }
}

async function writeRing(fileName: string, ring: SessionRing, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const dir = configDir(env);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE).catch(() => {});
    const path = throttleStatePath(fileName, env);
    await writeFile(path, JSON.stringify(ring) + '\n', { mode: CONFIG_MODE });
    await chmod(path, CONFIG_MODE).catch(() => {});
  } catch {
    // A write failure just means the NEXT same-session fire might repeat the line
    // once — a mild over-nudge, never a crash.
  }
}

/**
 * Has `key` already been claimed in `fileName`? A READ-ONLY peek, so a caller can
 * skip expensive work (a network round-trip) without spending a claim it may still
 * need. NEVER throws — an unreadable file reads as "not claimed", which only ever
 * costs one extra attempt.
 */
export async function wasSessionClaimed(
  fileName: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    if (!key || key.trim().length === 0) return false;
    const ring = await readRing(fileName, env);
    return ring.nudged.includes(key);
  } catch {
    return false;
  }
}

/**
 * Claim this session for `fileName`. Returns true the FIRST time a given session
 * id is seen (and records it), false every time after. NEVER throws — a
 * read/write hiccup degrades to the behaviour described in the header.
 */
export async function claimSessionOnce(
  fileName: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    if (!sessionId || sessionId.trim().length === 0) return false;
    const ring = await readRing(fileName, env);
    if (ring.nudged.includes(sessionId)) return false;
    const nudged = [...ring.nudged, sessionId];
    if (nudged.length > MAX_REMEMBERED_SESSIONS) {
      nudged.splice(0, nudged.length - MAX_REMEMBERED_SESSIONS);
    }
    await writeRing(fileName, { nudged }, env);
    return true;
  } catch {
    return false; // ultimate backstop — a throttle failure suppresses, never crashes
  }
}
