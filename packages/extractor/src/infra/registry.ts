// Adapter registry + merge.
//
// One ingest = run every detect()-positive InfraAdapter against the repo
// dir, collect their InfraGraphs, dedupe + reconcile via mergeInfraGraphs,
// then run any open ClassificationRef through  before handing the
// MergedInfraGraph to the assemble step.
//
// Adapters run in REGISTRATION ORDER, and registration order is the
// conflict-resolution priority for `declared` vs `declared` ties: the
// first-registered adapter wins. Today that's CF → Supabase → Terraform.
// Rationale (per the  ticket): wrangler.toml is more specific
// about Cloudflare resources than a Terraform `cloudflare_*` resource is;
// Terraform is the universal fallback. Same logic applies to Supabase
// (config.toml beats Terraform).
//
// `declared > inferred > llm-classified` is the inverse priority on
// provenance — a higher-priority provenance always wins regardless of
// adapter order. Two adapters both `declared` a node → adapter-order tie
// break (above). One `declared`, one `llm-classified` → declared wins.

import type {
  ClassificationRef,
  InfraAdapter,
  InfraGraph,
  InfraNode,
  MergedInfraGraph,
} from './types.js';
import type { NodeProvenance } from '../types.js';

// ---------------------------------------------------------------------------
// Adapter registration.

const REGISTERED: InfraAdapter[] = [];

/**
 * Register an adapter. Idempotent on `name` — re-registering replaces the
 * existing entry (useful for tests that swap a mock implementation).
 * Insertion order is the conflict-priority order for the merge step.
 */
export function registerInfraAdapter(adapter: InfraAdapter): void {
  const existing = REGISTERED.findIndex((a) => a.name === adapter.name);
  if (existing >= 0) REGISTERED[existing] = adapter;
  else REGISTERED.push(adapter);
}

/** Read-only view of registered adapters in registration order. */
export function listInfraAdapters(): readonly InfraAdapter[] {
  return REGISTERED;
}

/**
 * the `scansSourcePath` predicates of every registered adapter that
 * (a) declares one AND (b) `detect()`-positive on `repoDir` — i.e. the
 * source-grep adapters ACTIVE for this repo. The diff-driven hosted walk
 * (container.ts) ORs these into its carry/re-extract decision so a source-only
 * change a source-scanner would read forces an infra re-extract instead of
 * reusing the stale carried graph.
 *
 * Detection runs in parallel (cheap file-exists checks), exactly like
 * runInfraAdapters. Computed ONCE per re-extract (not per checkpoint): a diff
 * that would flip an adapter's detect() necessarily touches its config/IaC
 * trigger (supabase/**, package.json, next.config.*, vercel.json), all of which
 * already force a re-extract (diffTouchesInfra / config-invalidator) — after
 * which the walk recomputes this set. So a config-only adapter never starts
 * scanning source mid-walk without us noticing.
 */
export async function activeSourceScanners(
  repoDir: string,
): Promise<Array<(path: string) => boolean>> {
  const scanners = REGISTERED.filter((a) => typeof a.scansSourcePath === 'function');
  const detections = await Promise.all(
    scanners.map(async (a) => ({ adapter: a, detected: await a.detect(repoDir) })),
  );
  return detections
    .filter((d) => d.detected)
    .map((d) => (path: string) => d.adapter.scansSourcePath!(path));
}

/** Test helper — wipe the registry between specs. Never call from production. */
export function clearInfraAdapters(): void {
  REGISTERED.length = 0;
}

// ---------------------------------------------------------------------------
// Run + merge.

/**
 * Run every `detect()`-positive adapter against `repoDir` and merge the
 * outputs. Detection runs in parallel (cheap file-exists checks),
 * extraction runs serially (cheap IO + parsing, but several adapters
 * touching the same files saturates the kernel cache faster serially
 * than in parallel — and serial keeps log output legible).
 *
 * If no adapter detects the repo, returns an empty MergedInfraGraph anchored
 * at `repoDir` — the caller (assemble.ts) should still produce a snapshot;
 * the infra layer just contributes nothing.
 */
export async function runInfraAdapters(repoDir: string): Promise<MergedInfraGraph> {
  const detections = await Promise.all(
    REGISTERED.map(async (a) => ({ adapter: a, detected: await a.detect(repoDir) })),
  );
  const matched = detections.filter((d) => d.detected).map((d) => d.adapter);

  const graphs: InfraGraph[] = [];
  for (const adapter of matched) {
    graphs.push(await adapter.extract(repoDir));
  }
  return mergeInfraGraphs(graphs, repoDir);
}

// ---------------------------------------------------------------------------
// Pure merge — exported separately for tests + for callers that already
// have the per-adapter outputs in hand.

const PROVENANCE_PRIORITY: Record<NodeProvenance, number> = {
  declared: 3,
  inferred: 2,
  'llm-classified': 1,
};

/**
 * Merge per-adapter InfraGraphs into one. Conflict policy:
 *
 *   * Node id collisions resolve in favor of the higher-provenance node
 *     (declared > inferred > llm-classified). Ties on provenance resolve in
 *     favor of the earlier-listed graph (= earlier-registered adapter).
 *
 *   * Edges dedupe on (source, target, kind) — two adapters describing the
 *     same Worker → Queue write produce one edge. Adapter-specific metadata
 *     from the LOSING duplicate is dropped.
 *
 *   * ClassificationRef refs deduped on (provider, resourceType, forNodeId).
 *
 * Node ids are NAMESPACED by adapter (`<adapter>:<node.id>`) before merging,
 * which means raw id collisions only happen if the same adapter emits the
 * same id twice — that's an adapter bug, not a merge concern, and we throw.
 */
export function mergeInfraGraphs(
  graphs: InfraGraph[],
  root: string,
): MergedInfraGraph {
  // 1. Namespace + collect every node, tracking origin order for tie breaks.
  type Tagged = { node: InfraNode; graphOrder: number };
  const byId = new Map<string, Tagged>();
  for (let g = 0; g < graphs.length; g++) {
    const graph = graphs[g];
    const seenLocal = new Set<string>();
    for (const raw of graph.nodes) {
      if (seenLocal.has(raw.id)) {
        throw new Error(
          `infra adapter '${graph.adapter}' emitted duplicate node id '${raw.id}'`,
        );
      }
      seenLocal.add(raw.id);

      const namespaced: InfraNode = { ...raw, id: `${graph.adapter}:${raw.id}` };
      const existing = byId.get(namespaced.id);
      if (!existing) {
        byId.set(namespaced.id, { node: namespaced, graphOrder: g });
        continue;
      }
      const incoming = PROVENANCE_PRIORITY[namespaced.provenance];
      const incumbent = PROVENANCE_PRIORITY[existing.node.provenance];
      if (incoming > incumbent) {
        byId.set(namespaced.id, { node: namespaced, graphOrder: g });
      } else if (incoming === incumbent && g < existing.graphOrder) {
        // Higher-priority adapter (earlier-registered) wins on ties.
        byId.set(namespaced.id, { node: namespaced, graphOrder: g });
      }
      // Otherwise existing wins; nothing to do.
    }
  }

  // 2. Edges — namespace endpoints, dedupe on (source, target, kind).
  //
  // Endpoints can be either an adapter-local infra node id, or a code-side
  // module id (set during later cross-graph join). We prefix infra-local
  // refs; anything that doesn't match a known infra node id is left
  // untouched so the cross-graph join can bind it.
  //
  // PR #7 review #7: pre-compute the local-id set once per graph instead
  // of `.some()`-scanning the nodes array per edge. The naive form is
  // O(edges × nodes); at 's 10-adapter fan-out with one Terraform
  // graph carrying thousands of resources, that compounded every ingest.
  const edgeKey = (s: string, t: string, k: string) => `${s}→${t}:${k}`;
  const edges = new Map<string, MergedInfraGraph['edges'][number]>();
  for (const graph of graphs) {
    const localIds = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      const src = localIds.has(e.source) ? `${graph.adapter}:${e.source}` : e.source;
      const tgt = localIds.has(e.target) ? `${graph.adapter}:${e.target}` : e.target;
      const key = edgeKey(src, tgt, e.kind);
      if (!edges.has(key)) edges.set(key, { ...e, source: src, target: tgt });
    }
  }

  // 3. ClassificationRefs — same namespacing for `forNodeId`, dedupe on
  //    the (provider, resourceType, forNodeId) triple.
  const classKey = (p: string, rt: string, f: string) => `${p}/${rt}/${f}`;
  const classRefs = new Map<string, ClassificationRef>();
  for (const graph of graphs) {
    for (const c of graph.classificationsNeeded) {
      const forNs = `${graph.adapter}:${c.forNodeId}`;
      const key = classKey(c.provider, c.resourceType, forNs);
      if (!classRefs.has(key)) {
        classRefs.set(key, { ...c, forNodeId: forNs });
      }
    }
  }

  return {
    root,
    nodes: [...byId.values()].map((t) => t.node),
    edges: [...edges.values()],
    classificationsNeeded: [...classRefs.values()],
  };
}

// ---------------------------------------------------------------------------
// Post-merge validation gate.
//
// `mergeInfraGraphs` deliberately leaves unresolved edge endpoints untouched
// (a Terraform `depends_on` may point at a code module the cross-graph join
// binds later). It is NOT the validation gate — this is (PR #7 review #8).
// Once the full id space is known (post-join, /12), the caller passes the
// code-module ids in `knownIds`; any edge endpoint that still doesn't resolve
// is an adapter bug (a typo'd `depends_on`, a dangling ref) rather than a
// pending join. Returns those offending edges so tests can assert on an empty
// result and the join step can fail loud instead of rendering a phantom node.

/**
 * Edges whose `source` or `target` resolves to neither a merged infra node nor
 * a member of `knownIds`. Empty result = every endpoint is accounted for.
 */
export function validateMergedGraph(
  merged: MergedInfraGraph,
  knownIds: ReadonlySet<string> = new Set(),
): MergedInfraGraph['edges'] {
  const ids = new Set(merged.nodes.map((n) => n.id));
  for (const id of knownIds) ids.add(id);
  return merged.edges.filter((e) => !ids.has(e.source) || !ids.has(e.target));
}
