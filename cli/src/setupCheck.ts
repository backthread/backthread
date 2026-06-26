// setupCheck.ts — the plugin SessionStart "finish setup" nudge.
//
// When Backthread is installed as a Claude Code plugin but the user never ran
// `/backthread:start` (so this device isn't authed / no repo is connected), capture
// silently no-ops and the user gets nothing — they may not even remember they need to
// finish setup. This is the gentle reminder: on session START, if setup is incomplete,
// we hand Claude a one-line `additionalContext` it can relay ("run /backthread:start to
// finish setup"). Once set up, we say NOTHING (silent forever) — a nag is worse than a
// missed nudge.
//
// POSTURE — non-blocking, exit 0 (NEVER exit 2). A SessionStart hook that exited 2 (or
// printed to stderr) would BLOCK / disrupt session startup; this nudge must never get
// in the user's way. So it emits `additionalContext` on STDOUT and the bin exits 0. It's
// two cheap file reads (first-run state + config) and NEVER throws — any error degrades
// to silence. Vocabulary discipline: it must never say "architectural memory" (house style).

import { readFirstRunState, type FirstRunState } from './firstRun.js';
import { readConfig, type BackthreadConfig } from './config.js';

/**
 * The nudge copy, phrased for the MODEL to relay to the user (not shown verbatim). Names
 * the exact command + what it does, so the user understands the ask. House style: never
 * "architectural memory".
 */
export const SETUP_NUDGE =
  'Backthread is installed but not set up on this machine yet. Let the user know they can ' +
  'run /backthread:start to finish setup (authorize this device and connect a repo) so ' +
  'Backthread can capture the why behind each coding session.';

export interface SetupCheckDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: the onboarded-state reader. Defaults to readFirstRunState. */
  readStateImpl?: (env: NodeJS.ProcessEnv) => Promise<FirstRunState>;
  /** Test seam: the on-disk config reader (for the device token). Defaults to readConfig. */
  readConfigImpl?: (env: NodeJS.ProcessEnv) => Promise<BackthreadConfig>;
}

/**
 * Decide whether to nudge an installed-but-not-set-up user toward `/backthread:start`.
 * Returns the EXACT stdout line — the SessionStart `additionalContext` JSON — when setup
 * is incomplete, or null to stay SILENT (fully set up, OR any error). "Set up" ⇔
 * onboarded flag set AND a device token present (same pair the front door's
 * already-onboarded short-circuit checks). NEVER throws.
 */
export async function runSetupCheck(deps: SetupCheckDeps = {}): Promise<string | null> {
  try {
    const env = deps.env ?? process.env;
    const readState = deps.readStateImpl ?? readFirstRunState;
    const readCfg = deps.readConfigImpl ?? readConfig;
    const [state, cfg] = await Promise.all([readState(env), readCfg(env)]);

    // Fully set up → say nothing (silent forever; a nag is worse than a missed nudge).
    if (state.onboarded === true && !!cfg.device_token) return null;

    // Otherwise nudge. additionalContext + exit 0 (the bin's job) is NON-BLOCKING — a
    // setup reminder must never block session startup the way an exit-2 hook would.
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: SETUP_NUDGE,
      },
    });
  } catch {
    // A nudge must never disrupt session start — any read hiccup degrades to silence.
    return null;
  }
}
