/**
 * NARROWING — what a locally-extracted graph is reduced to before it may cross the
 * wire.
 *
 * Both functions here exist for the same reason and are shared by every producer and
 * every instrument that measures one, so that what the instruments compare is exactly
 * what the runner sends. A narrowing applied only by the runner would leave the
 * comparison measuring a graph production never emits.
 */
import type { MergedInfraGraph } from '@backthread/extractor';
import type { EnvServiceCandidate } from './envVars.js';


/**
 * The derived deployment graph as the wire carries it — a
 * `MergedInfraGraph` minus `root`.
 *
 * ⚠ `root` IS ABSENT ON PURPOSE AND THE CONTAINER SUPPLIES ITS OWN. On the wire it
 * would be an absolute path inside the customer's runner (`/home/runner/work/…`):
 * provenance for a local extract, and nothing we should receive. The ingress
 * REFUSES the key (`unknown_field`), so this type and that gate agree — the failure
 * an earlier change recorded was a wire type promising a field the wire refused,
 * which is worse than an absent feature because it is a documented lie.
 */
export interface CiInfraPayload {
  nodes: Array<{
    id: string;
    label: string;
    kind: MergedInfraGraph['nodes'][number]['kind'];
    provenance: MergedInfraGraph['nodes'][number]['provenance'];
    /** `{ type }` only — see `narrowInfraForWire`. */
    metadata?: { type?: string };
    sourceRoots?: string[];
  }>;
  edges: Array<{
    source: string;
    target: string;
    kind: MergedInfraGraph['edges'][number]['kind'];
  }>;
  classificationsNeeded?: MergedInfraGraph['classificationsNeeded'];
}

/**
 * Reduce a locally-extracted `MergedInfraGraph` to exactly what may cross the wire.
 *
 * ⚠ THIS EXISTS BECAUSE THE FIRST CUT SHIPPED THE GRAPH WHOLE AND A VERIFIER
 * FALSIFIED ITS OWN SECURITY ARGUMENT WITH IT. The boundary is justified by
 * "`wrangler.toml` carries account identifiers and credential references" — and the
 * derived graph carried them too. Measured on this repo: `metadata.image` is
 * `registry.cloudflare.com/a1b2c3d4e5f6…/…`, the Cloudflare ACCOUNT ID. Elsewhere the
 * same key holds a GCP project id and an ECR host containing an AWS account id, and
 * Railway's adapter puts the literal `${{Postgres.DATABASE_URL}}` credential
 * reference in `metadata.ref`. `metadata.tables` held 50 table names read out of
 * migration SQL.
 *
 * ⚠ AND NONE OF IT WAS EVER READ. `metadata.type` is the only key any consumer
 * touches (`assemble.ts` → `infraSummary`), infra EDGE metadata has no consumer at
 * all, and `Module` has no `metadata` field, so none of it reached `snapshots.data`.
 * We were receiving a customer's account id in order to throw it away, on the exact
 * boundary the endpoint exists to defend. Dropping it costs NOTHING and the hash is
 * unmoved — which the convergence test asserts rather than assumes.
 *
 * ⚠ ONE FUNCTION, THREE CALL SITES: the runner, `ci-replay.ts --compare`, and the
 * convergence test. A narrowing applied only by the runner would leave both
 * instruments comparing a graph production never sends — the exact drift the shared
 * `graphFromPayload` exists to prevent, one field along.
 */
export function narrowInfraForWire(graph: MergedInfraGraph): CiInfraPayload {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      provenance: n.provenance,
      // Spread-if-present rather than `metadata: {}`: an absent bag and an empty one
      // both mean "no product tag", and only one of them costs bytes on every node.
      ...(typeof n.metadata?.type === 'string' ? { metadata: { type: n.metadata.type } } : {}),
      ...(n.sourceRoots && n.sourceRoots.length > 0 ? { sourceRoots: n.sourceRoots } : {}),
    })),
    edges: graph.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind })),
    classificationsNeeded: graph.classificationsNeeded,
  };
}

/**
 * Reduce the env-derived service candidates to exactly what may cross the wire.
 *
 * ⚠ ONLY THE SERVICE NAME CROSSES, AND `vars` IS THE REASON THIS FUNCTION EXISTS.
 * `EnvServiceCandidate` carries `vars` — the ENV VAR KEYS the candidate was derived
 * from (`STRIPE_SECRET_KEY`, `ACME_API_TOKEN`). They are provenance for a local
 * extract, nothing downstream reads them (`classifyEnvVarPatterns` maps `c.service`
 * and nothing else), and they are the names a customer's credentials are stored
 * under. The infra narrowing was written after a verifier found our own Cloudflare
 * account id in a derived graph; the same rule is applied here BEFORE anyone has to
 * find something.
 *
 * ⚠ AND WHAT DOES CROSS IS TIGHTER THAN IT LOOKS. `parseEnvServiceCandidates` only
 * ever accepts a key matching `^[A-Z][A-Z0-9_]*$`, takes the segment before the
 * first `_`, and lowercases it — so a service name is `^[a-z][a-z0-9]*$` by
 * construction. It is a vendor name, never a value: the parser splits on `=` and
 * discards the right-hand side without looking at it.
 */
export function narrowEnvForWire(candidates: readonly EnvServiceCandidate[]): string[] {
  return candidates.map((c) => c.service);
}
