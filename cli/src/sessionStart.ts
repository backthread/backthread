// sessionStart.ts — the SessionStart hook (ARP-763): AMBIENT ROUTING.
//
// The `query` tool answers from the captured decision log, but Claude Code routes to
// it only PROBABILISTICALLY from the tool description. This SessionStart hook injects
// a one-time instruction into the session context that ROUTES BY QUESTION-TYPE
// (ARP-854): reach for `query` on why/evolution/topology (and whole-system data-flow)
// questions, read the source for single-module current-code mechanics, do both for a
// whole-feature "how does X work" — so the log's real add lands without misrouting the
// questions the code answers better.
//
// THE HOOK IS SYNCHRONOUS, NOT detached: Claude Code reads this command's STDOUT for
// the `hookSpecificOutput.additionalContext`, so we must print it here (a detached
// re-spawn — the capture hook's pattern — would print an ack instead, and CC would
// inject that). It does only a FAST LOCAL read (~/.backthread/config.json), never a
// network call, so it can't slow session start. It ALWAYS exits 0 with valid JSON.
//
// PLUGIN-ONLY (by design): registered in the plugin manifest (cli/hooks/hooks.json),
// which runs the shipped self-contained bundle — fast, offline, no npm resolve. The
// bare-npx `backthread install` fallback does NOT register it: a synchronous
// `npx backthread session-start` would block every session start on npm's resolve
// (the capture hook only gets away with `@latest` because it's `--detach`ed). Those
// users still get the `query` tool's imperative description. Ambient routing rides
// the plugin — the recommended Claude Code path — and reaches the fleet on publish.
//
// GATED ON SET-UP: we inject the routing instruction ONLY when a device token is
// present (the user is logged in, so `query` can actually answer). A not-set-up
// session gets no injection — we never tell Claude to call a tool that would just
// return "not logged in". Onboarding nudges already handle setup on the capture path.

import { readConfig as defaultReadConfig, type BackthreadConfig } from './config.js';
import { recordRoutingInjected as defaultRecordRoutingInjected } from './routingStats.js';

/** The instruction injected into the session context when Backthread is set up.
 * ARP-854 — ROUTES BY QUESTION-TYPE (no longer "call FIRST for any how/why"): the
 * log owns why/evolution/topology; single-module current-code mechanics is read
 * straight from source; a whole-feature "how" pairs both. Shipped verbatim. */
export const ROUTING_CONTEXT =
  'This repo has a Backthread decision log — the captured *why* behind its changes. ' +
  'Use the `query` MCP tool (or `/backthread:how`) when the user asks **why** something ' +
  'is the way it is, what was tried and rejected, how a design evolved, or how data flows ' +
  'across the whole system — it returns a short cited answer the source code can\'t give ' +
  'you. For what a single function or file does right now, just read the source. For a ' +
  'whole-feature "how does X work", do both: `query` for the why/architecture, read the ' +
  'code for the local mechanics.';

/** A Claude Code SessionStart hook result. An empty object = no injection. */
export interface SessionStartHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SessionStart';
    additionalContext: string;
  };
}

/**
 * Decide the hook output from set-up state. Pure. Set up → inject the routing
 * instruction; not set up → `{}` (no injection). Exported for unit testing the
 * decision apart from the config read.
 */
export function buildSessionStartOutput(isSetUp: boolean): SessionStartHookOutput {
  if (!isSetUp) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: ROUTING_CONTEXT,
    },
  };
}

export interface RunSessionStartDeps {
  readConfig?: () => Promise<BackthreadConfig>;
  recordRoutingInjected?: () => Promise<void>;
}

/**
 * Run the SessionStart hook: read the local config (fast, no network), inject the
 * routing instruction when set up, and record the injection for the hit-rate
 * measurement (best-effort). NEVER throws — a read/record hiccup degrades to "no
 * injection" rather than breaking session start.
 */
export async function runSessionStart(deps: RunSessionStartDeps = {}): Promise<SessionStartHookOutput> {
  const readConfig = deps.readConfig ?? defaultReadConfig;
  const record = deps.recordRoutingInjected ?? defaultRecordRoutingInjected;

  let isSetUp = false;
  try {
    const cfg = await readConfig();
    isSetUp = !!cfg.device_token;
  } catch {
    isSetUp = false; // unreadable config → treat as not set up (no injection)
  }

  const output = buildSessionStartOutput(isSetUp);
  if (output.hookSpecificOutput) {
    // The "opportunity" half of the routing hit-rate (the "conversion" half is the
    // server-side grounded_ask_logs row each query writes). Best-effort.
    try {
      await record();
    } catch {
      /* a stats hiccup must never affect the injection */
    }
  }
  return output;
}
