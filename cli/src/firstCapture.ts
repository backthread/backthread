// firstCapture.ts — the once-only "captured N decisions — view them
// at <deep-link>" confirmation.
//
// The first-run AC: "after the first capture, confirmation + deep-link to the rendered
// decisions." This is distinct from BOTH the per-capture stderr line (capture.ts) AND
// the connect nudge (connectNudge.ts):
//   • the connect nudge fires when the repo ISN'T connected (drives the connect).
//   • THIS fires when a capture actually LANDED decisions against a connected repo —
//     the aha confirmation that points the user at the rendered "How it works"
//     diagram. It is shown EXACTLY ONCE per install (the first successful capture),
//     then never again — a returning user is not re-onboarded (idempotence AC).
//
// WHERE IT LIVES: in the capture path itself (wired into capture.ts's persist legs),
// like the connect nudge — NOT in `/backthread:start`, because the confirmation can
// only fire AFTER a real capture lands, which the wizard doesn't do. It's a once-per-
// install throttled stderr line keyed off the `firstCaptureShown` flag in
// ~/.backthread/first-run.json (shared with firstRun.ts).
//
// BEST-EFFORT (load-bearing): wired into the always-exit-0 capture hook, so NOTHING
// here may throw or block. A missing/unwritable flag file degrades to suppressing the
// confirmation (or, worst case, showing it once more) — never crashing, never blocking.

import {
  readFirstRunState,
  updateFirstRunState,
  type FirstRunState,
} from './firstRun.js';
import { buildRepoDeepLink } from './urls.js';

export interface FirstCaptureDeps {
  env?: NodeJS.ProcessEnv;
  /** Where the confirmation goes. Defaults to console.error (stderr — capture's channel). */
  log?: (msg: string) => void;
  /** Test seam: the first-run state reader. Defaults to readFirstRunState. */
  readStateImpl?: (env: NodeJS.ProcessEnv) => Promise<FirstRunState>;
  /** Test seam: the first-run state writer. Defaults to updateFirstRunState. */
  writeStateImpl?: (patch: Partial<FirstRunState>, env: NodeJS.ProcessEnv) => Promise<void>;
}

/**
 * Build the once-only confirmation copy. Tone: plain + celebratory, matching the
 * other capture stderr lines. Uses the customer's noun ("How it works") for the
 * diagram and NEVER "architectural memory". The deep-link is built from the shared
 * helper (never hardcoded).
 */
export function firstCaptureMessage(
  count: number,
  repo: { owner: string; name: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const link = buildRepoDeepLink(repo.owner, repo.name, env);
  const n = count === 1 ? '1 decision' : `${count} decisions`;
  return `backthread: captured ${n} — view them in your "How it works" diagram: ${link}`;
}

/**
 * Maybe emit the once-only first-capture confirmation. Fires the FIRST time a capture
 * lands decisions against a CONNECTED repo, then records the `firstCaptureShown` flag
 * so it never fires again (idempotence). Returns whether it was emitted.
 *
 * Suppressed (returns false) when: it's already been shown; the repo isn't connected
 * (the connect nudge owns that case); no repo resolved; or nothing was captured
 * (count <= 0). NEVER throws — it's wired into the always-exit-0 capture path.
 */
export async function maybeFirstCaptureConfirm(
  count: number,
  repoConnected: boolean,
  repo: { owner: string; name: string } | null,
  deps: FirstCaptureDeps = {},
): Promise<boolean> {
  try {
    // Only confirm a real landing against a connected repo. A repo-less / pending
    // capture is the connect-nudge's job (it tells the user to connect first).
    if (!repoConnected || !repo) return false;
    if (!(count > 0)) return false;

    const env = deps.env ?? process.env;
    const readState = deps.readStateImpl ?? readFirstRunState;
    const state = await readState(env);
    if (state.firstCaptureShown === true) return false; // already shown once — never again

    const log = deps.log ?? ((m: string) => console.error(m));
    log(firstCaptureMessage(count, repo, env));

    const writeState = deps.writeStateImpl ?? updateFirstRunState;
    await writeState({ firstCaptureShown: true }, env);
    return true;
  } catch {
    // Ultimate backstop — the confirmation is a courtesy, never a failure mode.
    return false;
  }
}
