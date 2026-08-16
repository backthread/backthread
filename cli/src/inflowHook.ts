// inflowHook.ts — the dead-time trigger: one question, while the agent is working
// and the person is waiting.
//
// ═══ WHY `PostToolUse`, AND WHY THAT IS THE WHOLE ARGUMENT ═══
//
// The moment we are after is the one where the engineer has nothing to do: their
// agent is a few steps into a task, it just finished running a command or a search,
// and they are watching. `PostToolUse` is exactly that moment and — structurally —
// nothing else. It fires AFTER the tool has already run, so there is no code path in
// which this can stop, delay past its own short timeout, or veto anything.
//
// ⚠️ THIS IS NEVER A `PreToolUse` HOOK, AND NEVER FIRES ON AN EDIT. Founder-directed:
// *"we shouldn't block engineers before they want to touch anything."* A question
// that lands the instant somebody reaches for a file is a toll gate, whatever it says
// in its text. So the trigger is held on both sides — `DEAD_TIME_TOOLS` is a closed
// allowlist checked here at runtime, and the manifest registers this under
// `PostToolUse` only. `inflowGuards.test.ts` fails if either moves.
//
// ═══ AT MOST ONE ASK PER SESSION, AND THE CLAIM IS SPENT BEFORE THE REQUEST ═══
//
// A `PostToolUse` hook fires many times per turn. Without a throttle, "one question
// while you wait" becomes a per-tool-call interrogation, which is how a tolerable
// feature gets uninstalled. So a session claims once and is then finished with this
// hook entirely — no second ask, no second round-trip, no second local read.
//
// The claim is spent BEFORE the request, not after a question comes back, and the
// distinction is load-bearing rather than an optimisation:
//
//   * it bounds a session to ONE round-trip, so a repo with nothing recorded pays
//     for this once rather than on every Bash call for an hour; and
//   * it makes the local state IDENTICAL in the case where a question was served,
//     the case where the record was empty, and the case where the request failed.
//     Claiming afterwards would have written down, in effect, "this person was
//     asked something" — which is one query away from "and did not answer". The
//     server was built so that an ignored ask and an ask that never happened are
//     byte-identical in the database; a client that quietly distinguishes them on
//     disk gives that back. A guard diffs the config directory across all three
//     cases and fails on any difference.
//
// The ring itself holds opaque session ids and nothing else — no question, no token,
// no material, no answer, and no number. It can only ever SUPPRESS an ask; there is
// no code path in which anything in it produces one.
//
// ═══ SILENCE IS THE DEFAULT AND EVERY DOUBT RESOLVES TO IT ═══
//
// Not signed in, not a git repo, no session id, a non-200, a timeout, a malformed
// body, an empty record — all of it returns `{}` and says nothing. This is
// `interpretScopeResponse`'s posture with the polarity flipped, the same as the
// grep and coverage hooks: an unrequested question shown because a lookup hiccuped
// is worse than one never shown. The endpoint's own common answer is "nothing here",
// and that is a first-class outcome, not a degraded one.
//
// ═══ THE ASK GOES TO THE AGENT, ONCE, THROUGH ONE CHANNEL ═══
//
// `hookSpecificOutput.additionalContext` and NOT `systemMessage`. The person has to
// be able to answer in the words they would use out loud, and the only thing in the
// room that can carry a spoken reply back to `/inflow/answer` is the agent. So the
// agent is handed the question, the submit command, and — just as importantly — the
// instruction to drop it entirely and never mention it again if it is ignored.
// Emitting the same question on both channels would be one question delivered twice,
// which is the nag this feature is not allowed to be.
//
// NOTHING IS WRITTEN ABOUT THE ASK. The token is rendered into the injected text and
// forgotten. It is never stored, never re-sent, never collected.

import { readConfig, type BackthreadConfig } from './config.js';
import { resolveRepo, type RemoteReader } from './repo.js';
import { claimSessionOnce, wasSessionClaimed } from './sessionThrottle.js';
import {
  requestAsk,
  formatAskBlock,
  askInvocation,
  INFLOW_DEAD_TIME_TIMEOUT_MS,
  type InflowDeps,
} from './inflow.js';

/**
 * This hook's own throttle file. Never shared with another nudge's ring, or whichever
 * fired first would silence the other.
 */
export const INFLOW_SESSION_FILE = 'inflow-ask.json';

/**
 * The tools after which somebody is genuinely waiting — a closed allowlist, checked
 * at runtime and not merely declared in the manifest's matcher.
 *
 * ⚠️ NO EDITING TOOL APPEARS HERE AND NONE MAY BE ADDED. `Edit`, `MultiEdit`,
 * `Write` and `NotebookEdit` are absent on purpose: an ask that arrives around the
 * moment somebody changes a file reads as a toll on changing files, which is the one
 * shape this trigger was forbidden to take. A guard fails if this list grows one.
 */
export const DEAD_TIME_TOOLS: readonly string[] = ['Bash', 'Task', 'WebFetch', 'WebSearch'];

/** The PostToolUse output. `{}` = say nothing at all. */
export interface InflowHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext: string;
  };
}

/** Is this a moment where the person is waiting on their agent rather than working? */
export function isDeadTimeTool(toolName: unknown): boolean {
  return typeof toolName === 'string' && DEAD_TIME_TOOLS.includes(toolName);
}

/**
 * What the agent is told, wrapped around the shared question block.
 *
 * The rules are as much about NOT following up as about relaying: the ask has to
 * cost nothing to ignore, and an agent that helpfully circles back to an unanswered
 * question is the nag the server went to some trouble to make impossible.
 */
export function inflowHookContext(block: string): string {
  return [
    'Backthread — one optional question for the person you are working with. It arrived',
    'while you were mid-task and they were waiting on you. It is NOT part of their request',
    'and it is not a check on your work.',
    '',
    block,
    '',
    'How to handle it:',
    '  - Relay it verbatim at your next natural break — after the step you are on, never',
    '    in the middle of one. It must not change what you were asked to do, and it must',
    '    not delay it.',
    '  - Do not answer it yourself, and do not hint at the answer.',
    '  - If they reply, submit their exact words with the command above and relay the',
    '    result verbatim. Never soften a verdict and never add a score, a tally, or a',
    '    note about anything they were asked before.',
    '  - If they ignore it, or say no, drop it completely. Do not repeat it, do not remind',
    '    them, and do not mention it again in this session. It expires on its own and',
    '    nothing about it is recorded either way.',
  ].join('\n');
}

export interface InflowHookDeps extends InflowDeps {
  requestAskImpl?: typeof requestAsk;
  /** Fallback cwd when the payload omits one. Defaults to process.cwd(). */
  cwd?: string;
  /** The argv the submit command is derived from. Defaults to process.argv. */
  argv?: string[];
  readRemoteImpl?: RemoteReader;
}

/**
 * Build the PostToolUse output for a raw stdin payload. NEVER throws — every problem
 * yields `{}` (no injection; the session continues untouched).
 */
export async function runInflowDeadTime(
  rawStdin: string,
  deps: InflowHookDeps = {},
): Promise<InflowHookOutput> {
  const env = deps.env ?? process.env;
  const doReadConfig = deps.readConfigImpl ?? readConfig;
  try {
    let payload: unknown;
    try {
      payload = JSON.parse(rawStdin);
    } catch {
      return {}; // unparseable payload → silent
    }
    const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

    // No session id → we cannot hold "at most once", so say NOTHING rather than risk
    // a question after every tool call. Same rule the other courtesy hooks apply.
    const sessionId = typeof rec.session_id === 'string' ? rec.session_id.trim() : '';
    if (!sessionId) return {};

    // The runtime half of "no pre-edit trigger". Even wired to a matcher we did not
    // write, this hook refuses to fire around an edit.
    if (!isDeadTimeTool(rec.tool_name)) return {};

    // This session is done with this hook — return before any local or network work.
    if (await wasSessionClaimed(INFLOW_SESSION_FILE, sessionId, env)) return {};

    const cwd = typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : (deps.cwd ?? process.cwd());
    const repo = resolveRepo(cwd, deps.readRemoteImpl);
    if (!repo) return {}; // not a git repo / no origin → nothing to ask about

    const config = await Promise.resolve()
      .then(() => doReadConfig(env))
      .catch(() => ({}) as BackthreadConfig);
    if (!config.device_token) return {}; // not signed in → silent, never a prompt

    // Spend the session's one claim NOW, before the request — see the header.
    //
    // ⚠️ THE RETURN VALUE IS DELIBERATELY NOT CONSULTED, and that is the opposite of
    // belt-and-braces. `claimSessionOnce` can only answer false for a session id we
    // already rejected above (empty) or one already in the ring (the peek caught it),
    // and it swallows a failed WRITE and answers true anyway. So gating on it would
    // be a branch that cannot be reached, cannot be tested, and would quietly make
    // the peek above look optional — two mechanisms holding one property is one
    // mechanism plus a comment. The WRITE is what stops the next fire; the peek is
    // what reads it. Delete either and `inflowHook.test.ts` goes red.
    await claimSessionOnce(INFLOW_SESSION_FILE, sessionId, env);

    const outcome = await (deps.requestAskImpl ?? requestAsk)(
      {
        trigger: 'dead-time',
        repo: { owner: repo.owner, name: repo.name },
        cwd,
        timeoutMs: INFLOW_DEAD_TIME_TIMEOUT_MS,
      },
      deps,
    );
    // Anything but a clean reply carrying an actual question is silence. `ask: null`
    // is the COMMON case and is not a failure of any kind — there is simply nothing
    // on record here worth asking about, and the person hears nothing about it.
    if (outcome.status !== 'ok' || !outcome.ask) return {};

    const block = formatAskBlock(
      outcome.ask,
      outcome.promise ?? null,
      askInvocation(deps.argv ?? process.argv),
    );
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: inflowHookContext(block),
      },
    };
  } catch {
    // Belt-and-braces: any failure at all → no injection, the session continues.
    return {};
  }
}
