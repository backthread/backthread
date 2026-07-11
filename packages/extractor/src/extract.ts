// The composed one-shot structural extraction entry point.
//
// Runs the full deterministic pipeline on a working-tree path and returns the
// structural graph — modules (with kinds, god-node flags, path-derived
// subsystems), edges, communities, framework roles, and infra — with ZERO LLM /
// DB / network. This is the convenience surface for local extraction (the CLI's
// `graph` command); the hosted container composes the same granular stages
// itself, interleaving its DB warm-start + LLM enrichment between them.

import { extractGraph } from './graph/extract.js';
import type { NormalizedGraph } from './graph/types.js';
import { clusterGraph, type ClusterResult, type ClusteredModule } from './cluster/louvain.js';
import { detectWorkspaceLayout, type WorkspaceLayout } from './cluster/workspaces.js';
import type { OverrideMap } from './cluster/overrides.js';
import { detectFrameworkStack } from './framework/detect-step.js';
import {
  contributeFrameworkGraph,
  type FrameworkContributions,
} from './framework/contribute-step.js';
import type { FrameworkManifest } from './framework/types.js';
import { extractInfra, type ResourceTypeClassifier } from './infra/infra-step.js';
import type { MergedInfraGraph } from './infra/types.js';
import { EXTRACTOR_PACKAGE_VERSION } from './version.js';

export interface ExtractOptions {
  /**
   * Per-repo hand-correction overrides (drop/assign/label/resolution). The host
   * loads this from its own curated source; defaults to none.
   */
  overrides?: OverrideMap;
  /**
   * Prior extraction's cluster modules → module-id stabilization across
   * re-extractions (Jaccard-overlap id adoption). Omit on a first run.
   */
  priorModules?: ReadonlyArray<Pick<ClusteredModule, 'id' | 'kind' | 'fileIds'>>;
  /**
   * Optional host-injected classifier for open-ended IaC resource types. Omit
   * for a pure/offline run (classification-pending infra nodes keep their
   * adapter-emitted placeholder kind).
   */
  classifyResourceTypes?: ResourceTypeClassifier;
}

export interface ExtractResult {
  /** Absolute repo dir the graph was extracted from (provenance). */
  root: string;
  /** The raw normalized code graph (files + import/call edges + externals). */
  graph: NormalizedGraph;
  /** Louvain communities → modules, the fileId→moduleId join, module edges. */
  cluster: ClusterResult;
  /** Deterministic infra graph (CF / Supabase / Terraform / … config reads). */
  infra: MergedInfraGraph;
  /** Detected framework stacks (empty ⇒ generic TS/Python). */
  frameworks: FrameworkManifest;
  /** Framework-derived edges, role tags, and subsystem grouping. */
  contributions: FrameworkContributions;
  /** Detected workspace/monorepo layout. */
  layout: WorkspaceLayout;
  /** The extractor package version that produced this graph. */
  version: string;
}

/**
 * Extract the structural graph of a repository from its working tree.
 * * Deterministic and side-effect-free (no LLM, DB, or network unless a
 * `classifyResourceTypes` callback is injected). Given the same tree + options,
 * the output is stable.
 */
export async function extract(repoDir: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const frameworks = await detectFrameworkStack(repoDir);
  const graph = await extractGraph(repoDir);
  const layout = detectWorkspaceLayout(repoDir);
  const cluster = clusterGraph(graph, opts.overrides ?? {}, {
    layout,
    priorModules: opts.priorModules,
  });
  // Folds framework edges/roles in AND mutates cluster.modules' package grouping
  // in place — so it runs after clusterGraph and before we read `cluster`.
  const contributions = await contributeFrameworkGraph({ repoDir, graph, cluster });
  const { graph: infra } = await extractInfra({
    repoDir,
    classifyResourceTypes: opts.classifyResourceTypes,
  });

  return {
    root: graph.root,
    graph,
    cluster,
    infra,
    frameworks,
    contributions,
    layout,
    version: EXTRACTOR_PACKAGE_VERSION,
  };
}
