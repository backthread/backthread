// the InfraAdapter contract.
//
// Mirrors the GraphExtractor seam (/325) on the code-extraction side:
// every infra-discovery surface targets this normalized shape, and every
// downstream layer ( salience scoring,  ELK layout, the diagram
// renderer) consumes the merged InfraGraph + code NormalizedGraph as one.
// New providers (Vercel, Fly, Render, OpenTofu, AWS-native, GCP-native;
// tracked under ) are an ADDITIVE adapter, never a reshape.
//
// Why interface-only here:  /  /  implement the three v0
// adapters (CF, Supabase, Terraform); 's 10 expansion children
// implement everything else. Freezing this contract before those land
// keeps the parallel-agent fan-out safe.

import type {
  EdgeKind,
  InfraModuleKind,
  NodeProvenance,
} from '../types.js';

// ---------------------------------------------------------------------------
// Adapter contract.

/**
 * A discovery surface for one infra provider. Implementations live next to
 * their parser (e.g. scripts/ingest/infra/cf/, scripts/ingest/infra/supabase/).
 *
 * `detect()` is cheap — a file-existence check (does `wrangler.toml` exist?
 * does `supabase/config.toml` exist?). It runs first against every registered
 * adapter, and only `detect()`-positive adapters get `extract()`-ed.
 *
 * `extract()` is deterministic parsing — read the config, walk its
 * declarations, emit nodes/edges. The LLM never enters this path; the only
 * LLM-touched layer is `classificationsNeeded` (queued for  to label).
 */
export interface InfraAdapter {
  readonly name: string; // 'cloudflare' | 'supabase' | 'terraform' | …
  detect(repoDir: string): Promise<boolean>;
  extract(repoDir: string): Promise<InfraGraph>;
  /**
   * does this adapter read application SOURCE (not just config/IaC)?
   *
   * Most adapters parse only config/IaC files (wrangler.toml, .tf), so the
   * diff-driven hosted walk (container.ts) can safely CARRY their graph across
   * a checkpoint whose diff touched no infra-config path. But a source-grep
   * adapter (Supabase greps `.from(`/`.auth`/… in `.ts`/`.tsx`/…; Vercel reads
   * App-Router route handlers, `pages/api` files, and `middleware.ts`) derives
   * nodes/edges from ordinary source — so a `supabase.from(...)` added in plain
   * `src` MUST force an infra re-extract, or the carried graph goes stale.
   *
   * An adapter that scans source declares `scansSourcePath(p)` returning true
   * for any repo-relative path whose CONTENT it greps/reads. The relevance
   * gate (relevance.ts) ORs these predicates (for the adapters whose detect()
   * is positive on the current tree) into its carry/re-extract decision.
   * Config-only adapters omit it and keep the carry optimization untouched.
   *
   * Returns true ⇒ "a change to this path could change my output" → re-extract.
   */
  scansSourcePath?(path: string): boolean;
}

// ---------------------------------------------------------------------------
// What an adapter emits.

/**
 * An infra node. Mirrors the code-side Module from src/types but lives in
 * its own namespace until the merge step joins them — keeps the contracts
 * decoupled while /8/9 land in parallel.
 *
 * `id` is unique WITHIN the emitting adapter's output. The registry's merge
 * step uses (adapter, id) as the natural key, then prefixes external-facing
 * ids with the adapter name (e.g. `cloudflare:queues_consumer:ingest-jobs`)
 * so cross-adapter merges don't collide on common short names like 'main'.
 */
export interface InfraNode {
  id: string;
  label: string;
  kind: InfraModuleKind;
  /**
   * Where this classification came from. The merge step uses this to resolve
   * conflicts: `declared` wins over `inferred` wins over `llm-classified`.
   * If two adapters both `declared` the same node, the first-registered
   * adapter (= more-specific provider, see registry.ts) wins.
   */
  provenance: NodeProvenance;
  /**
   * Adapter-specific shape — what config file declared this node, what
   * binding name it carries inside wrangler.toml, the Terraform module
   * path, etc. Not consumed by the renderer; useful for `view source`
   * tooltips and debug dumps. Keep small (< ~500 bytes) so JSONB-tax stays
   * negligible.
   */
  metadata?: Record<string, unknown>;
  /**
   * repo-relative directory prefixes whose code THIS artifact deploys
   * — the deployment-target signal read from IaaC config (a worker's config dir,
   * a container's Dockerfile build context, a Pages/Vite SPA's source dir, a
   * Supabase function's dir). Only DEPLOYABLE artifacts that run your own code
   * set this (worker / static-site / container); datastores, queues, and
   * external-apis don't run your code and leave it absent. The assemble step
   * attributes each code module to the unit whose source root is the longest
   * prefix of its files (`scripts/ingest/assemble/zones.ts`). Repo-relative,
   * normalized (no leading `./`, no trailing `/`); survives the registry merge
   * unprefixed (only ids are namespaced).
   */
  sourceRoots?: string[];
}

/**
 * An infra-to-infra edge. Uses the same 8-verb EdgeKind taxonomy as the
 * code graph — there is no separate "infra edge kind." A CF Worker
 * `writes` to a D1 Datastore the same way an internal `users` service
 * `writes` to a `db` module. The merge step zips these into the unified
 * graph the renderer reads.
 *
 * `source`/`target` may also reference CODE modules (post-merge), so the
 * type stays string rather than InfraNode['id']. `mergeInfraGraphs` does NOT
 * reject unresolved endpoints — an endpoint that isn't a known infra node is
 * left untouched as a cross-graph-join hint (a Terraform `depends_on` may
 * legitimately point at a code module the join step binds later). Once the
 * full id space is known, `validateMergedGraph` (registry.ts) flags any
 * endpoint that still doesn't resolve — that's the validation gate, not merge.
 */
export interface InfraEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  metadata?: Record<string, unknown>;
}

/**
 * Resource-types the adapter found but does NOT know how to classify into
 * an InfraModuleKind on its own. The registry collects these from every
 * adapter, dedupes, and runs them through 's classifyResourceTypes()
 * before merging — so the final InfraGraph has every node's `kind`
 * decided by either the adapter (declared) or the LLM cache
 * (llm-classified).
 *
 * Adapters with a tight static mapping (CF: `wrangler.toml` `[[queues]]`
 * → `queue`) emit nothing here. Adapters parsing open-ended IaC (Terraform
 * HCL with arbitrary `resource "aws_*"` blocks) emit one entry per unique
 * unclassified `(provider, resource_type)` pair.
 */
export interface ClassificationRef {
  provider: string;
  resourceType: string;
  /**
   * The InfraNode.id this classification will populate once resolved. The
   * registry rewrites the corresponding node's `kind` + `provenance` after
   * returns.
   */
  forNodeId: string;
}

/**
 * One adapter's view of the repo's infrastructure. The registry's
 * `mergeInfraGraphs` consumes an array of these.
 */
export interface InfraGraph {
  /** Absolute repo dir the graph was extracted from (provenance). */
  root: string;
  /** Mirror of the producing adapter's `name`. */
  adapter: string;
  nodes: InfraNode[];
  edges: InfraEdge[];
  classificationsNeeded: ClassificationRef[];
}

/**
 * The output of merging every adapter's InfraGraph into one. Same shape as
 * InfraGraph minus the per-adapter `adapter` field; nodes/edges carry their
 * adapter-prefixed ids.
 */
export interface MergedInfraGraph {
  root: string;
  nodes: InfraNode[];
  edges: InfraEdge[];
  /** Pass-through to the  classifier; populated nodes update in-place. */
  classificationsNeeded: ClassificationRef[];
}
