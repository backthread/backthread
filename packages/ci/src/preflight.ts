/**
 * THE INGRESS'S OWN CHECKS, RUN ON THE RUNNER, IN A MODULE A TEST CAN IMPORT.
 *
 * ⚠ THIS FILE EXISTS BECAUSE OF WHERE ITS CONTENTS USED TO LIVE. Every one of these
 * four checks sat inline in `action.ts`, which calls `main()` on import — so no test
 * could execute any of them, and what guarded them instead was a search of the SOURCE
 * TEXT for the shape they were expected to have. An independent verifier measured what
 * that buys: rewriting the payload gate's condition to
 * `if (rejection && rejection.error === '__never_matches__')` — compute the refusal,
 * then upload anyway — passed `tsc` and passed all 325 tests. `if (false && rejection)`
 * did too. The guard proved the call was PRESENT and ORDERED. It could not prove the
 * answer was ACTED ON, which is the only property that matters.
 *
 * A text guard is the right tool for "is this call still here". It is the wrong tool
 * for "does this still refuse", and the difference is invisible until someone mutates
 * it. So the deciding happens here, where it is ordinary code with ordinary tests, and
 * `action.ts` keeps only the calls — which have no condition left in them to neuter.
 *
 * ⚠ WHY RUN THE INGRESS'S CHECKS AT ALL, GIVEN THE INGRESS RUNS THEM. Not as a second
 * opinion — these are the SAME functions, so the two cannot disagree. A payload refused
 * for shape AFTER a full extract has already cost the customer their CI minutes and
 * told them nothing they could have learned earlier. Failing on the runner puts the
 * reason next to the extract that produced it.
 *
 * ⚠ AND "REJECT, DON'T TRUNCATE" IS WHY EVERY ONE OF THESE THROWS. Dropping the
 * offending node, service or contribution would render a topology that is wrong in a
 * way nothing downstream can detect — a plausible architecture with the wrong shape,
 * which is worse than no architecture. That rule is the ingress's, and it has to be
 * the runner's too.
 */
import type { NormalizedGraph, RawFrameworkContributions } from '@backthread/extractor';
import { narrowEnvForWire, narrowInfraForWire, type CiInfraPayload } from './narrow.js';
import type { MergedInfraGraph } from '@backthread/extractor';
import type { EnvServiceCandidate } from './envVars.js';
import type { CiSnapshotPayload } from './payload.js';
import {
  validateCiPayload,
  validateEnvServices,
  validateFrameworkContributions,
  validateInfraGraph,
  type CiRejection,
} from './validate.js';

/** One wording for every refusal, so a reader learns the shape once. */
function refuse(what: string, rejection: CiRejection, consequence: string): never {
  throw new Error(
    `[backthread] the ${what} was refused by the shared ingress check: ${rejection.error}` +
      `${rejection.detail ? ` (${rejection.detail})` : ''}. ${consequence}`,
  );
}

/**
 * Narrow the locally-extracted infra graph and refuse it whole if the shared check
 * says no.
 *
 * ⚠ THE NARROWING IS PART OF THIS, NOT A STEP BEFORE IT. Shipping the adapters' nodes
 * verbatim is what put a Cloudflare account id on the wire; keeping the reduction and
 * the check in one function is what stops a future caller doing one without the other.
 */
export function preparedInfra(graph: MergedInfraGraph): CiInfraPayload {
  const infra = narrowInfraForWire(graph);
  const rejection = validateInfraGraph(infra);
  if (rejection) {
    refuse(
      'derived infra graph',
      rejection,
      'Shipping a partial one would render a false deployment topology.',
    );
  }
  return infra;
}

/** Narrow the env-derived service candidates and refuse the list whole if it fails. */
export function preparedEnvServices(candidates: readonly EnvServiceCandidate[]): string[] {
  const services = narrowEnvForWire(candidates);
  const rejection = validateEnvServices(services);
  if (rejection) {
    refuse(
      'derived env-service list',
      rejection,
      'Shipping a partial one would render a false set of external services.',
    );
  }
  return services;
}

/** Refuse the framework contributions whole if the shared check says no. */
export function preparedFramework(raw: RawFrameworkContributions): RawFrameworkContributions {
  const rejection = validateFrameworkContributions(raw);
  if (rejection) {
    refuse(
      'framework contributions',
      rejection,
      'Shipping a partial set would render a false framework topology.',
    );
  }
  return raw;
}

/**
 * The WHOLE gate, over the assembled payload, before a byte is uploaded.
 *
 * ⚠ THE THREE CHECKS ABOVE ARE A FRACTION OF WHAT THE INGRESS APPLIES, WHICH IS WHY
 * THIS EXISTS. The file ceiling, the edge caps, every string bound, path safety, the
 * unknown-field rule and the manifest count were all server-side only, so most refusals
 * still arrived after a full extract — the exact late refusal this whole pattern is for.
 *
 * ⚠ `prior: null` IS NOT A WEAKENING. The one tier this cannot reproduce is the collapse
 * check against the repo's own recorded history, which is database-resident; the runner
 * has no history and inventing one would be worse than omitting it. Everything else is
 * the identical function over the identical object, so this is a strict SUBSET of the
 * ingress's answer and can never refuse something the server would admit.
 */
export function assertPayloadIsAcceptable(
  payload: CiSnapshotPayload,
  identity: { owner: string; name: string; sha: string },
  now: number,
): void {
  const { rejection } = validateCiPayload({ value: payload, identity, now, prior: null });
  if (rejection) {
    refuse(
      'payload',
      rejection,
      'Refusing here rather than spending the upload, so the reason arrives with the ' +
        'extract that produced it.',
    );
  }
}

/** Re-exported so `action.ts` needs one import for the whole preflight. */
export type { NormalizedGraph };
