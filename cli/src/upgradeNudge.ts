// upgradeNudge.ts — the once-per-day throttle for the server-driven upgrade nudge.
//
// The server (worker/src/versionGuard.ts) can return a non-fatal `upgrade` string on
// any response when the client is below MIN_RECOMMENDED_VERSION (and the friendly
// `message` on a 426 hard-block). The client surfaces it — but ONLY on the INTERACTIVE
// surfaces a human actually reads: manual `backthread capture` output + the MCP `query`
// tool response. The detached SessionEnd hook discards its stdout, so a nudge there is
// invisible by construction; we never route the nudge through it.
//
// THROTTLE — "a whisper, not a nag": at most ONCE per 24h per machine, across ALL
// surfaces. A `lastUpgradeNudgeAt` epoch-ms timestamp lives in ~/.backthread/ (the
// existing config/state dir, owner-only 0600). A nudge within the window is suppressed;
// the timestamp is recorded ONLY when a nudge is actually shown (so suppression doesn't
// slide the window forward). Concurrent surfaces could RARELY double-show on a read-
// modify-write race — accepted, the blast radius is one extra line.
//
// BEST-EFFORT (load-bearing): wired into capture/query, which must never fail over a
// courtesy. NOTHING here throws — a missing/corrupt/unwritable state file degrades to
// suppressing the nudge (or, worst case, showing it once more), never crashing.

import { join } from 'node:path';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { configDir, CONFIG_MODE, DIR_MODE } from './config.js';

// The throttle file: tiny, owner-only (0600), in the same dir as config.json.
export function upgradeNudgeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'upgrade-nudge.json');
}

/** Once per 24h per machine. */
export const UPGRADE_NUDGE_THROTTLE_MS = 24 * 60 * 60 * 1000;

interface NudgeState {
  /** Epoch ms of the last time we actually SHOWED an upgrade nudge. */
  lastUpgradeNudgeAt?: number;
}

// Parse the throttle blob defensively → empty state on anything unexpected. A hand-
// corrupted (or partially-written) file must never break capture/query, so any
// malformed shape just means "never nudged" (we'll show once, harmless).
function parseState(raw: string): NudgeState {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const at = (obj as NudgeState).lastUpgradeNudgeAt;
      if (typeof at === 'number' && Number.isFinite(at)) return { lastUpgradeNudgeAt: at };
    }
  } catch {
    // fall through to empty
  }
  return {};
}

async function readState(env: NodeJS.ProcessEnv): Promise<NudgeState> {
  try {
    return parseState(await readFile(upgradeNudgeStatePath(env), 'utf8'));
  } catch {
    // Missing file (first run) or unreadable → empty state. Never throw.
    return {};
  }
}

async function writeState(state: NudgeState, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const dir = configDir(env);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE).catch(() => {});
    const path = upgradeNudgeStatePath(env);
    await writeFile(path, JSON.stringify(state) + '\n', { mode: CONFIG_MODE });
    await chmod(path, CONFIG_MODE).catch(() => {});
  } catch {
    // A write failure just means the NEXT nudge isn't throttled — a mild over-nudge,
    // never a crash. Swallow it (best-effort posture).
  }
}

export interface UpgradeNudgeDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: the clock. Defaults to Date.now (fine in the CLI runtime). */
  now?: () => number;
}

/**
 * Decide whether to SHOW the server's upgrade nudge now, honoring the 24h-per-machine
 * throttle. Returns the trimmed message to show (and records the timestamp), or `null`
 * to suppress (no message, or within the throttle window). NEVER throws — wired into
 * the always-best-effort capture/query surfaces.
 *
 * Call this ONLY from interactive presenters (manual capture / MCP query); the detached
 * hook must stay silent, so it simply never calls this.
 */
export async function maybeUpgradeNudge(
  upgrade: string | null | undefined,
  deps: UpgradeNudgeDeps = {},
): Promise<string | null> {
  try {
    if (typeof upgrade !== 'string' || upgrade.trim().length === 0) return null;
    const env = deps.env ?? process.env;
    const now = deps.now ? deps.now() : Date.now();

    const state = await readState(env);
    if (
      typeof state.lastUpgradeNudgeAt === 'number' &&
      now - state.lastUpgradeNudgeAt < UPGRADE_NUDGE_THROTTLE_MS
    ) {
      return null; // shown within the last 24h — suppress (don't slide the window)
    }

    await writeState({ lastUpgradeNudgeAt: now }, env);
    return upgrade.trim();
  } catch {
    // Ultimate backstop — the nudge is a courtesy, never a failure mode.
    return null;
  }
}
