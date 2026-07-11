// The infra extraction step: the assemble-join seam.
//
// Sequence (mirrors the externals step):
//
//   registerBuiltinInfraAdapters()           — CF / Supabase / Terraform / …
//     → runInfraAdapters(repoDir)            — detect + extract + merge
//       → classifyResourceTypes(refs)?       — OPTIONAL, injected: label open-ended IaC
//         → patch each node's kind in place  — declared → llm-classified
//
// The deterministic adapters (CF, Supabase) emit no `classificationsNeeded`, so
// the injected classifier only fires when an IaC repo carried an unrecognised
// `resource "x" "y"` block. When no classifier is injected (the default, e.g.
// local / offline extraction) the classification-pending nodes keep their
// adapter-emitted placeholder kind. The result feeds the host's assemble step as
// a MergedInfraGraph alongside the code graph + externals.
//
// Dependency inversion: the LLM classifier lives in the host application (it
// needs network + a model). This package stays pure — the host injects a
// `classifyResourceTypes` callback (which owns its own token accounting).

import { runInfraAdapters } from './registry.js';
import { registerBuiltinInfraAdapters } from './register.js';
import type { MergedInfraGraph } from './types.js';
import type { InfraModuleKind } from '../types.js';

/** A (provider, resourceType) pair an injected classifier must resolve. */
export interface ResourceTypeRef {
  provider: string;
  resourceType: string;
}

/** The classifier's verdict for one ref. */
export interface ResourceTypeResult {
  provider: string;
  resourceType: string;
  nodeKind: InfraModuleKind;
}

/**
 * Host-injected resolver for open-ended IaC resource types. Pure packages never
 * ship one; the container/CLI passes a closure that calls the LLM classifier and
 * accumulates cost in its own ledger. Deterministic dedupe happens here, before
 * the callback, so the closure sees unique refs only.
 */
export type ResourceTypeClassifier = (
  refs: ResourceTypeRef[],
) => Promise<ResourceTypeResult[]>;

export interface InfraStepResult {
  graph: MergedInfraGraph;
  counts: { nodes: number; edges: number; classified: number };
}

export async function extractInfra(args: {
  repoDir: string;
  /**
   * Optional host-injected classifier for open-ended IaC resource types. Omit
   * (e.g. offline / --no-llm) to skip classification: deterministic adapter
   * nodes still land; any classification-pending node keeps its adapter-emitted
   * placeholder kind.
   */
  classifyResourceTypes?: ResourceTypeClassifier;
}): Promise<InfraStepResult> {
  registerBuiltinInfraAdapters();
  const graph = await runInfraAdapters(args.repoDir);

  let classified = 0;
  if (args.classifyResourceTypes && graph.classificationsNeeded.length > 0) {
    // Dedupe to unique (provider, resourceType) pairs — a single label can fan
    // out to many forNodeIds.
    const key = (p: string, rt: string) => `${p}\x1f${rt}`;
    const uniqueRefs = new Map<string, ResourceTypeRef>();
    for (const c of graph.classificationsNeeded) {
      uniqueRefs.set(key(c.provider, c.resourceType), {
        provider: c.provider,
        resourceType: c.resourceType,
      });
    }
    const refs = [...uniqueRefs.values()];
    const results = await args.classifyResourceTypes(refs);
    const byKey = new Map<string, ResourceTypeResult>();
    results.forEach((r) => byKey.set(key(r.provider, r.resourceType), r));

    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const c of graph.classificationsNeeded) {
      const r = byKey.get(key(c.provider, c.resourceType));
      const node = nodeById.get(c.forNodeId);
      if (!r || !node) continue;
      node.kind = r.nodeKind;
      node.provenance = 'llm-classified';
      classified++;
    }
  }

  return {
    graph,
    counts: { nodes: graph.nodes.length, edges: graph.edges.length, classified },
  };
}
