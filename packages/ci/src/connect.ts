/**
 * What the runner reads from its environment to CONNECT a repository, as functions a
 * test can call.
 *
 * ⚠ THIS FILE EXISTS FOR THE REASON `preflight.ts` DOES. `action.ts` runs `main()` on
 * import, so nothing in it can be executed by a test — three separate defects have
 * already hidden behind exactly that, and the guard that stood in for coverage was a
 * search of the source text, which proves a call is PRESENT and cannot prove its
 * answer is ACTED ON. So the deciding happens here and `action.ts` keeps only the
 * calls.
 *
 * Both functions are pure: they take the environment (and, for the branch, the event
 * file's CONTENTS) rather than reading `process.env` or `node:fs` themselves. That is
 * also what keeps this module on the main barrel, which an edge runtime imports.
 */

import { isWellFormedClaimCode } from './validate.js';

/**
 * The one-time claim code, from `BACKTHREAD_CLAIM`.
 *
 * ⚠ A STALE CODE MUST BE IGNORED, NEVER AN ERROR, AND THAT DECISION LIVES ON BOTH
 * SIDES. The claim is consumed by the ingress on first use, and the variable then
 * sits in the customer's workflow forever. Nothing here can tell a live code from a
 * spent one — only the lookup can — so the client's whole job is to carry it and let
 * the ingress shrug.
 *
 * ⚠ A MALFORMED VALUE IS DROPPED RATHER THAN SENT, WHICH IS THE OPPOSITE OF WHAT
 * "NEVER TRUST THE CLIENT" WOULD SUGGEST, AND IS RIGHT HERE. The payload gate runs on
 * the runner too, so a typo'd `BACKTHREAD_CLAIM` would throw `invalid_claim` AFTER a
 * full extract and fail a build that was otherwise fine — over a variable whose only
 * effect is on the very first run. Dropping it degrades to "no claim", which the
 * ingress answers with a readable `repo_not_connected`, and the warning says which
 * variable to look at. The value is still validated by the ingress; this only decides
 * whether it is worth sending.
 *
 * Whitespace is trimmed because a value pasted into a YAML `env:` block routinely
 * carries a trailing newline, and refusing that would be refusing a correct code for
 * a reason no user could see.
 */
export function claimFromEnv(env: Record<string, string | undefined>): {
  claim?: string;
  warning?: string;
} {
  const raw = env.BACKTHREAD_CLAIM;
  if (raw === undefined || raw.trim() === '') return {};
  const code = raw.trim();
  if (!isWellFormedClaimCode(code)) {
    return {
      warning:
        'BACKTHREAD_CLAIM is set but is not a well-formed claim code, so it is being ignored. ' +
        'Copy it again from the connect screen; a claim code has no spaces or quotes.',
    };
  }
  return { claim: code };
}

/**
 * The repository's DEFAULT branch — the branch Backthread tracks — not the branch this
 * run happens to be on.
 *
 * ⚠ THE WIRE FIELD IS NAMED `defaultBranch` AND USED TO CARRY `GITHUB_REF_NAME`,
 * WHICH IS THE RUNNING REF. Harmless while nothing read it: the ingress compared the
 * SIGNED ref against the branch on the repo row and ignored the payload's copy
 * entirely. It stopped being harmless when connecting a repository began to SEED that
 * row — a `workflow_dispatch` on a feature branch would have pinned tracking to that
 * branch forever, with no surface in the product to change it, and every later run on
 * the real default branch would have failed `ref_not_tracked_branch`.
 *
 * GitHub states the default branch in the event payload for every trigger this client
 * supports (`push`, `schedule`, `workflow_dispatch`, `pull_request`), so it is read
 * from there. The ref name remains the fallback for anything that does not — which is
 * exactly the previous behaviour, so nothing that works today stops working.
 *
 * ⚠ IT IS STILL AN UNTRUSTED SELF-REPORT. The ingress cross-checks it against the
 * SIGNED ref before it seeds anything, so the strongest lie available is naming the
 * branch the run is already on.
 */
export function defaultBranchFrom(input: {
  /** Contents of `$GITHUB_EVENT_PATH`, or null when unreadable. */
  eventJson: string | null;
  /** `GITHUB_REF_NAME`. */
  refName: string | undefined;
}): string {
  const fallback = (input.refName ?? 'main').trim() || 'main';
  if (!input.eventJson) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.eventJson);
  } catch {
    // A malformed event file is GitHub's problem, not a reason to fail the build.
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  const repo = (parsed as { repository?: unknown }).repository;
  if (!repo || typeof repo !== 'object' || Array.isArray(repo)) return fallback;
  const branch = (repo as { default_branch?: unknown }).default_branch;
  if (typeof branch !== 'string') return fallback;
  const trimmed = branch.trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * The extra sentence a failed upload needs when a claim was thrown away.
 *
 * ⚠ REVIEW FINDING, AND THE GAP IS PURELY ONE OF DISTANCE. A typo'd
 * `BACKTHREAD_CLAIM` warns near the TOP of the log, then the extract runs, and
 * hundreds of lines later the build dies on `repo_not_connected` — which is the line
 * a reader actually looks at, and it names the wrong cause. It says the repository is
 * not connected; the truth is that the code meant to connect it was discarded.
 *
 * Returns `''` when there is nothing to add, so the caller can concatenate
 * unconditionally rather than branch.
 */
export function connectFailureHint(input: { claimWarning?: string; status: number }): string {
  if (!input.claimWarning) return '';
  if (input.status !== 404 && input.status !== 403) return '';
  return (
    ' — note: BACKTHREAD_CLAIM was set but ignored because it is not a well-formed' +
    ' claim code, which is very likely why this repository is still not connected.'
  );
}

/**
 * The header the ingress reads the claim from.
 *
 * ⚠ THE PAYLOAD FIELD IS NOT ENOUGH, AND THE REASON IS ORDERING RATHER THAN
 * SECRECY. The ingress cannot read the body until after it has authenticated,
 * checked for a replay, and decompressed up to 16 MiB — so a claim that lives only
 * in the payload puts every refusal that depends on it below that read. Anyone with
 * a GitHub account could then mint a token for a repository they own and post a
 * small gzip that inflates to 16 MiB, over and over, to be told the same thing one
 * indexed lookup already knew. In the header, the ingress decides before it inflates
 * anything.
 *
 * The payload still carries `claim`, because that is the published contract and it
 * is the auditable record of what was sent. The ingress cross-checks the two and
 * refuses a disagreement, so the body can only ever AGREE with what authorised the
 * request and never steer it. Sending both is therefore required, not belt-and-braces.
 */
export const CLAIM_HEADER = 'x-backthread-claim';
