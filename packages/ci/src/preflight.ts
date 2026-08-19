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
 * ⚠ `prior: null` IS NOT A WEAKENING. It is consumed by exactly one tier — the
 * plausibility pass — which produces WARNINGS and never a rejection, so passing `null`
 * removes commentary and no refusal. The collapse check against the repo's own recorded
 * history is database-resident; the runner has no history, and inventing one would be
 * worse than omitting it.
 *
 * ⚠ `now` IS THE ONE PLACE THE CLIENT CAN BE STRICTER THAN THE INGRESS, AND AN EARLIER
 * DRAFT OF THIS COMMENT CLAIMED OTHERWISE. It said this "can never refuse something the
 * server would admit" — true of `prior`, and not quite true of `now`. The checkpoint's
 * date is compared against the clock passed in, with a seven-day window; this passes the
 * RUNNER's clock and the ingress passes the server's. A runner more than seven days out
 * would refuse locally what the server would take. The window makes that practically
 * unreachable, and the failure is a loud local error rather than a wrong topology — but
 * an absolute claim that is only nearly true is the kind this file exists to catch.
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

/**
 * The producer's own claim about what it is sending, computed from the SERIALISED
 * STATE — which is what the ingress recomputes it against.
 *
 * ⚠ EVERY FIELD HERE HAS BEEN THE WRONG QUANTITY AT SOME POINT, AND IN THE SAME WAY.
 * The obvious source is the graph `seedFull` returns, and that graph is NOISE-FILTERED
 * while `state` is not. `edges` was written that way, measured (graph 1 658 vs state
 * 2 435 — a 47% gap) and corrected. `externals` was left computing the filtered figure
 * beside the corrected one, and the first run that ever reached body validation was
 * refused: `count_mismatch (externals 14 != 15)`.
 *
 * ⚠ SO IT LIVES HERE RATHER THAN IN `action.ts`, WHERE NOTHING COULD RUN IT. That file
 * calls `main()` on import. The counts were computed inline, three lines from the
 * payload literal, and no test could reach them — which is why a cross-check written
 * specifically to catch a producer disagreeing with itself sat unexercised through
 * every suite while the producer disagreed with itself.
 */
export function payloadCounts(state: {
  files: Record<string, unknown>;
}): { files: number; edges: number; externals: number } {
  let edges = 0;
  const externals = new Set<string>();
  for (const id of Object.keys(state.files)) {
    const r = state.files[id] as {
      imports: unknown[];
      calls: unknown[];
      externals: Array<{ id: string }>;
    };
    edges += r.imports.length + r.calls.length + r.externals.length;
    for (const x of r.externals) externals.add(x.id);
  }
  return { files: Object.keys(state.files).length, edges, externals: externals.size };
}

/** Re-exported so `action.ts` needs one import for the whole preflight. */
export type { NormalizedGraph };
