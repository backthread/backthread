// sessionStart.ts — the SessionStart hook. TWO jobs (the two-tier grep-hook flip):
//
//   1. REFRESH THE LOCAL CACHE. Fire a DETACHED, fire-and-forget refresh of the
//      repo-local cache — `backthread sync` (the merged decision "why") + `backthread
//      graph` (the structural graph) — so the session's grep hook has fresh local
//      context. Detached because this hook is synchronous (see below) and both
//      refreshes are slow (a network read; the heavy extractor); running them inline
//      would block session start. Best-effort; never blocks, never throws.
//
//   2. INJECT THE DEPTH-TIER POINTER. Inject a one-time instruction that positions
//      the hosted `query` / `/backthread:how` synthesis path as the DEPTH TIER for
//      hard whole-system questions. It no longer tells the agent to "call query FIRST
//      / before grepping / per-question" — that proactive pre-read is now DETERMINISTIC:
//      the PreToolUse grep hook injects the relevant local structure + why on every
//      Grep/Glob (grepContext.ts). What survives here is the pointer to the hosted
//      synthesis the raw local cache CAN'T produce (reconciling the full merged log
//      into a cited answer).
//
// THE HOOK IS SYNCHRONOUS, NOT detached: Claude Code reads this command's STDOUT for
// the `hookSpecificOutput.additionalContext`, so we print it here. It does only a FAST
// LOCAL read (~/.backthread/config.json) + a detached spawn — never an inline network
// call — so it can't slow session start. It ALWAYS exits 0 with valid JSON.
//
// PLUGIN-ONLY (by design): registered in the plugin manifest (cli/hooks/hooks.json),
// which runs the shipped self-contained bundle. The bare-npx `backthread install`
// fallback does NOT register it (a synchronous `npx backthread session-start` would
// block every session start on npm's resolve).
//
// GATED ON SET-UP: we refresh + inject ONLY when a device token is present (the user
// is logged in, so `sync` can authenticate and `query` can answer). A not-set-up
// session gets neither — we never sync without auth or point at a tool that would
// just return "not logged in".

import { readConfig as defaultReadConfig, type BackthreadConfig } from './config.js';
import { recordRoutingInjected as defaultRecordRoutingInjected } from './routingStats.js';
import { spawnCacheRefresh as defaultSpawnCacheRefresh } from './localRefresh.js';

/** The instruction injected into the session context when Backthread is set up.
 * FLIPPED for the two-tier grep hook: the per-grep local pre-read is now automatic
 * (the PreToolUse grep hook), so this no longer says "call query FIRST" — it points
 * at the hosted `query` / `/backthread:how` SYNTHESIS tier for the hard whole-system
 * questions the raw local cache can't answer. Shipped verbatim. */
export const SESSION_START_CONTEXT =
  'This repo has a Backthread decision log — the captured *why* behind its changes. ' +
  'When you Grep or Glob, the relevant local structure + the recorded why are injected ' +
  'automatically, so a plain search already carries the on-record context (trade-offs ' +
  'knowingly accepted, standing assumptions, known limitations, rejected approaches) — no ' +
  'action needed. For a hard whole-system question that needs reconciled SYNTHESIS across ' +
  'the full history — "how does the whole X work", how a design evolved, or a deliberate ' +
  'blindspot pass — use the `query` MCP tool (or `/backthread:how`): the hosted depth tier ' +
  'that reconciles the merged decision log into a short, cited answer the raw local context ' +
  "can't produce. For what a single function or file does right now, just read the source.";

/** A Claude Code SessionStart hook result. An empty object = no injection. */
export interface SessionStartHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SessionStart';
    additionalContext: string;
  };
}

/**
 * Decide the hook output from set-up state. Pure. Set up → inject the depth-tier
 * pointer; not set up → `{}` (no injection). Exported for unit testing the decision
 * apart from the config read + the refresh spawn.
 */
export function buildSessionStartOutput(isSetUp: boolean): SessionStartHookOutput {
  if (!isSetUp) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: SESSION_START_CONTEXT,
    },
  };
}

export interface RunSessionStartInput {
  /** The session cwd (from the SessionStart payload) — the repo to refresh. */
  cwd?: string;
}

export interface RunSessionStartDeps {
  readConfig?: () => Promise<BackthreadConfig>;
  recordRoutingInjected?: () => Promise<void>;
  /** The detached cache-refresh spawner. Injectable so tests don't fork processes. */
  spawnCacheRefresh?: (cwd: string) => boolean;
}

/**
 * Run the SessionStart hook: read the local config (fast, no network); when set up,
 * fire a DETACHED cache refresh (sync + graph — best-effort, non-blocking) and inject
 * the depth-tier pointer + record the injection. NEVER throws — any hiccup degrades to
 * "no injection" rather than breaking session start.
 */
export async function runSessionStart(
  input: RunSessionStartInput = {},
  deps: RunSessionStartDeps = {},
): Promise<SessionStartHookOutput> {
  const readConfig = deps.readConfig ?? defaultReadConfig;
  const record = deps.recordRoutingInjected ?? defaultRecordRoutingInjected;
  const spawnRefresh = deps.spawnCacheRefresh ?? defaultSpawnCacheRefresh;

  let isSetUp = false;
  try {
    const cfg = await readConfig();
    isSetUp = !!cfg.device_token;
  } catch {
    isSetUp = false; // unreadable config → treat as not set up (no injection, no refresh)
  }

  if (isSetUp) {
    // Kick the background cache refresh (detached; never blocks / throws) so this
    // session's grep hook has fresh local context.
    try {
      spawnRefresh(input.cwd ?? process.cwd());
    } catch {
      /* a spawn hiccup must never affect the injection */
    }
    // Record the injection opportunity (best-effort).
    try {
      await record();
    } catch {
      /* a stats hiccup must never affect the injection */
    }
  }

  return buildSessionStartOutput(isSetUp);
}
