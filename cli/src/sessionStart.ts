// sessionStart.ts — the SessionStart hook (ARP-763): AMBIENT ROUTING.
//
// The `query` tool answers "how does X work?" from the captured decision log, but
// Claude Code routes to it only PROBABILISTICALLY from the tool description. This
// SessionStart hook injects a one-time instruction into the session context that
// tells Claude to reach for `query` FIRST on how/why questions, before grepping —
// turning a plain "how does X work?" into a grounded answer with no new user habit.
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

/** The instruction injected into the session context when Backthread is set up. */
export const ROUTING_CONTEXT = [
  'This repository is set up with Backthread, which has captured the "why" behind its',
  'changes into a decision log. The backthread `query` MCP tool (and the',
  '`/backthread:how` slash command) answer "how does X work?" and "why was Y decided?"',
  'with a short, CITED answer synthesized from that log — the real reasons, trade-offs,',
  'and superseded approaches the source code itself does not contain.',
  '',
  'When the user asks how or why any part of THIS codebase works, is structured, or was',
  'decided, call the backthread `query` tool FIRST — before grepping or reading source',
  'files. Pass the user\'s question and relay the cited answer it returns; only read',
  'source afterwards if it didn\'t cover what you need.',
].join('\n');

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
