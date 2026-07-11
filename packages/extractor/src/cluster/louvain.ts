// Module clustering + god-node detection (/326).
//
// Turns the file-level NormalizedGraph into the diagram's MODULES. Boundaries
// come from Louvain community detection on the import/call graph — the
// deterministic, content-derived source. Explicitly NOT folders (a bad graph
// for the messy-repo ICP) and NOT commit co-change (dies under coarse AI-agent
// commits). The LLM names clusters later; it never sets boundaries.
//
// Externals are NOT clustered — each external dependency is its own leaf module
// (kind 'external'); only internal files participate in community detection.
//
// Stage C (decides manifest-first, Louvain fallback): when a
// WorkspaceLayout with ≥2 packages is supplied, declared package boundaries
// become first-class — Louvain runs only WITHIN each package (small graphs,
// stable partitions, optionally warm-reused via PackagePartitionCache), the
// boundary BETWEEN packages is the manifest's word and never statistical, and
// cross-package edges aggregate to module edges at full confidence. A bare
// `import x from '@org/pkg-b'` that the install-free extractor classified as
// EXTERNAL is remapped back onto pkg-b's entry module when pkg-b is a
// workspace sibling. `stabilizeModuleIds` warm-starts module identity from
// the prior extraction so the changelog join key + the LLM set-diff
// (enrich/diff.ts) survive re-clusters — id stability directly cuts LLM spend.
// With no options (or a single-package layout) behavior is byte-identical to
// pre-Stage-C.

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { EdgeKind, GraphEdge, NormalizedGraph } from '../graph/types.js';
import { externalIdFor } from '../graph/types.js';
import type { OverrideMap } from './overrides.js';
import { compileMatchers, slugify } from './overrides.js';
import type { WorkspaceLayout, WorkspacePackage } from './workspaces.js';

// God-node detection ( / , fixes ). The old fixed-degree
// threshold fired on ~half the modules of a small dense repo (4/8 on backthread),
// which makes the signal meaningless. Replaced with a statistical-outlier rule
// that scales with graph size: a module is a god-node iff it is BOTH an
// internal-degree outlier (z-score > 1.5σ above the mean) AND a routing
// chokepoint (betweenness centrality in the top quartile). AND, not OR —
// precision over recall, because a false "scary to refactor" flag destroys
// trust in the signal. Below MIN_MODULES the statistics are noise, so we never
// flag.
const GOD_NODE_Z_THRESHOLD = 1.5;
const GOD_NODE_MIN_MODULES = 5;

// Seeded PRNG (mulberry32). Louvain defaults to Math.random for node ordering,
// so a fixed seed makes communities — and the module ids derived from them —
// stable across runs. Required for idempotent re-sync and P4 snapshot diffing.
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ClusteredModule {
  id: string;
  kind: 'internal' | 'external';
  fileIds: string[];
  externalSpecifier?: string;
  fileCount: number;
  loc: number;
  degree: number; // distinct neighbour modules
  godNode: boolean;
  /**
   * Workspace package slug this module belongs to ( Stage C). Set only
   * for non-root packages under per-package clustering; additive — absent in
   * single-package runs and on external/forced modules.
   */
  packageId?: string;
  /**
   * the owning workspace package's name + role, carried so the
   * subsystem partition (cluster/subsystem.ts) can build ONE subsystem box per
   * package, labeled app/lib/tooling. Set together with `packageId`; absent on
   * root-scope / external / forced modules.
   */
  packageName?: string | null;
  packageRole?: WorkspacePackage['role'];
}

export interface ModuleEdge {
  source: string;
  target: string;
  weight: number;
  kinds: EdgeKind[]; // structural kinds present; LLM maps to semantic kind later
}

export interface ClusterResult {
  modules: ClusteredModule[];
  /** fileId → moduleId — the join key the changelog uses (per PR × touched module). */
  fileModuleMap: Record<string, string>;
  moduleEdges: ModuleEdge[];
}

// Derive the dominant path segment of a community's files: the most common
// segment after an optional leading `src/` (single-segment paths fall back to
// the extension-less basename). Pure naming heuristic — the LLM relabels for
// display; the id built from this is the stable join key + override target.
function deriveSegment(fileIds: string[]): string {
  const counts = new Map<string, number>();
  for (const f of fileIds) {
    const parts = f.replace(/^src\//, '').split('/');
    const seg = parts.length > 1 ? parts[0] : (parts[0].replace(/\.[^.]+$/, '') || 'root');
    counts.set(seg, (counts.get(seg) ?? 0) + 1);
  }
  let best = 'module';
  let bestN = -1;
  for (const [seg, n] of counts) {
    if (n > bestN) {
      best = seg;
      bestN = n;
    }
  }
  return best;
}

// Reserve a unique module id from a base: `-2`, `-3`, … suffixes on collision.
// The ONE dedup gate every id-producing path goes through (derived, slug-
// prefixed, stabilization reroutes), so ids are unique by construction.
function reserveId(base: string, used: Set<string>): string {
  let id = base;
  let i = 2;
  while (used.has(id)) id = `${base}-${i++}`;
  used.add(id);
  return id;
}

// Derive a provisional module id from a community's files (pre-Stage-C form,
// used for the whole-graph path + root-scope communities).
function deriveModuleId(fileIds: string[], used: Set<string>): string {
  return reserveId(slugify(deriveSegment(fileIds)) || 'module', used);
}

// ---------------------------------------------------------------------------
// Stage C — per-package partition cache (in-boot Merkle-style
// changed-package detection).
//
// WHY: an unchanged package ⇒ identical member set + identical within-package
// edges (any content change inside it arrives as a diff path → the package is
// marked dirty) ⇒ an identical partition. Re-running Louvain on it per
// checkpoint is wasted work AND a stability risk (it re-derives what we
// already know). The member-set equality check on lookup is the BELT to the
// diff-driven BRACES: even if a caller forgets an invalidatePaths call, a
// membership change can never reuse a stale partition.
//
// In-boot only (lives for one container run, across the merge-walk's
// checkpoints) — it is NOT persisted; the extraction_cache carries modules,
// not raw partitions.

interface PartitionEntry {
  /** Sorted '\n'-join of the package's member fileIds at store time. */
  memberKey: string;
  /** The Louvain (or cache-seeded) community assignment for those members. */
  communities: Record<string, number>;
}

export class PackagePartitionCache {
  private entries = new Map<string, PartitionEntry>();
  private dirty = new Set<string>();

  /**
   * Mark the packages owning these paths dirty — call with each checkpoint's
   * diff paths BEFORE clustering that checkpoint. Conservative on purpose:
   * any touched path (source or not) dirties its owning package; a non-source
   * path costs at most one redundant re-cluster of a small subgraph.
   */
  invalidatePaths(paths: readonly string[], layout: WorkspaceLayout): void {
    for (const p of paths) this.dirty.add(layout.packageOf(p).slug);
  }

  /**
   * Drop everything — call on a full re-extract, a workspace-layout change
   * (a diff touching isWorkspaceManifestPath), or an overrides change (slugs
   * and forced membership both feed the stored partitions).
   */
  invalidateAll(): void {
    this.entries.clear();
    this.dirty.clear();
  }

  /**
   * The cluster-layer read: a stored partition is reusable ONLY when the
   * package is clean AND its member set is unchanged (`memberKey` = sorted
   * '\n'-join of member fileIds — the same key clusterGraph computes).
   */
  lookup(slug: string, memberKey: string): Record<string, number> | null {
    if (this.dirty.has(slug)) return null;
    const e = this.entries.get(slug);
    return e !== undefined && e.memberKey === memberKey ? e.communities : null;
  }

  /** The cluster-layer write after a (re-)cluster; clears the dirty mark. */
  store(slug: string, memberKey: string, communities: Record<string, number>): void {
    this.entries.set(slug, { memberKey, communities });
    this.dirty.delete(slug);
  }
}

// ---------------------------------------------------------------------------
// Stage C — cluster options.

export interface ClusterOptions {
  /**
   * Workspace layout (detectWorkspaceLayout). ≥2 packages ⇒ per-package
   * clustering: Louvain within packages only, manifest boundaries between
   * them, workspace-name externals remapped to entry modules.
   */
  layout?: WorkspaceLayout;
  /**
   * The prior extraction's cluster modules (ExtractionCache.modules) →
   * module-id stabilization: fresh modules that substantially overlap a prior
   * module (Jaccard ≥ 0.5 on file sets) adopt its id, so the changelog join
   * key survives re-clusters and the enrich set-diff reuses prior labels.
   */
  priorModules?: ReadonlyArray<Pick<ClusteredModule, 'id' | 'kind' | 'fileIds'>>;
  /** In-boot warm partition reuse across the merge-walk's checkpoints. */
  partitionCache?: PackagePartitionCache;
}

export function clusterGraph(
  graph: NormalizedGraph,
  overrides?: OverrideMap,
  opts?: ClusterOptions,
): ClusterResult {
  const drop = compileMatchers(overrides?.drop ?? []);
  const assign = (overrides?.assign ?? []).map((rule) => ({
    match: compileMatchers([rule.pattern]),
    moduleId: rule.moduleId,
  }));

  // Internal files minus dropped noise.
  const files = graph.files.filter((f) => !drop(f.id));
  const fileSet = new Set(files.map((f) => f.id));
  const locById = new Map(files.map((f) => [f.id, f.loc]));

  // `resolution` (override-tunable, default 1) trades coarse↔fine modules —
  // raise it to split a too-coarse clustering (the backthread dogfood uses >1).
  const resolution = overrides?.resolution ?? 1;

  // `assign` overrides (forced membership) win over ANY community detection,
  // on both the whole-graph and per-package paths. Forced files still sit in
  // the Louvain graph as nodes (their edges shape the partition around them,
  // exactly as pre-Stage-C) — only their module ASSIGNMENT is overridden.
  const forced = new Map<string, string>(); // fileId → overridden moduleId
  for (const f of files) {
    const override = assign.find((a) => a.match(f.id));
    if (override) forced.set(f.id, override.moduleId);
  }

  // A community group awaiting materialization. `pkg` is null on the
  // whole-graph path; `sole` marks a non-root package that yielded exactly
  // one community (it gets the bare package slug as its id).
  interface CommunityGroup {
    pkg: WorkspacePackage | null;
    fileIds: string[];
    sole: boolean;
  }
  const groups: CommunityGroup[] = [];

  const layout = opts?.layout;
  const multiPackage = layout !== undefined && layout.packages.length > 1;

  if (!multiPackage) {
    // ── Whole-graph path (pre-Stage-C, byte-identical) ─────────────────────
    // Build the undirected weighted graph for Louvain (internal↔internal edges).
    const g = new Graph({ type: 'undirected' });
    for (const f of files) g.addNode(f.id);
    for (const e of graph.edges) {
      if (e.external) continue;
      if (!fileSet.has(e.from) || !fileSet.has(e.to)) continue;
      if (g.hasEdge(e.from, e.to)) {
        g.updateEdgeAttribute(e.from, e.to, 'weight', (w: number) => (w ?? 1) + e.weight);
      } else {
        g.addEdge(e.from, e.to, { weight: e.weight });
      }
    }

    // Community detection → fileId → community index. Seeded RNG for stable ids.
    const communities: Record<string, number> =
      g.order > 0
        ? louvain(g, { getEdgeWeight: 'weight', resolution, rng: mulberry32(42) })
        : {};

    const byCommunity = new Map<number, string[]>();
    for (const f of files) {
      if (forced.has(f.id)) continue;
      const c = communities[f.id] ?? -1;
      const arr = byCommunity.get(c) ?? [];
      arr.push(f.id);
      byCommunity.set(c, arr);
    }
    for (const fileIds of byCommunity.values()) groups.push({ pkg: null, fileIds, sole: false });
  } else {
    // ── Per-package path ( Stage C) ─────────────────────────────────
    // Louvain runs on the subgraph induced by edges with BOTH endpoints in the
    // same package. Cross-package edges are EXCLUDED from community detection
    // — the boundary is declared by the manifest, not discovered statistically
    // — but they still aggregate to module edges below, at full
    // confidence like any other edge.
    const ownerRoot = new Map<string, string>(); // fileId → owning package root
    const membersByRoot = new Map<string, string[]>();
    for (const f of files) {
      const r = layout.packageOf(f.id).root;
      ownerRoot.set(f.id, r);
      const arr = membersByRoot.get(r) ?? [];
      arr.push(f.id);
      membersByRoot.set(r, arr);
    }
    const intraEdgesByRoot = new Map<string, GraphEdge[]>();
    for (const e of graph.edges) {
      if (e.external) continue;
      if (!fileSet.has(e.from) || !fileSet.has(e.to)) continue;
      const r = ownerRoot.get(e.from)!;
      if (r !== ownerRoot.get(e.to)) continue; // cross-package: not detection input
      const arr = intraEdgesByRoot.get(r) ?? [];
      arr.push(e);
      intraEdgesByRoot.set(r, arr);
    }

    // Packages in root-sorted order — module materialization order (and the
    // id-dedup order downstream of it) must not depend on layout insertion
    // order. Determinism is load-bearing everywhere in this file.
    const sortedPkgs = [...layout.packages].sort((a, b) =>
      a.root < b.root ? -1 : a.root > b.root ? 1 : 0,
    );
    for (const pkg of sortedPkgs) {
      const members = membersByRoot.get(pkg.root) ?? [];
      if (members.length === 0) continue;

      // Warm reuse: clean package + identical member set ⇒ the stored
      // partition is the partition (see PackagePartitionCache for why).
      const memberKey = [...members].sort().join('\n');
      let communities = opts?.partitionCache?.lookup(pkg.slug, memberKey) ?? null;
      if (communities === null) {
        const sub = new Graph({ type: 'undirected' });
        for (const id of members) sub.addNode(id);
        for (const e of intraEdgesByRoot.get(pkg.root) ?? []) {
          if (sub.hasEdge(e.from, e.to)) {
            sub.updateEdgeAttribute(e.from, e.to, 'weight', (w: number) => (w ?? 1) + e.weight);
          } else {
            sub.addEdge(e.from, e.to, { weight: e.weight });
          }
        }
        // Same seeded RNG per package: a package's partition depends only on
        // its own subgraph, never on sibling packages — that's the stability
        // win over whole-graph Louvain. (Edgeless subgraphs are handled by the
        // library: every node becomes its own community, in insertion order.)
        communities = louvain(sub, { getEdgeWeight: 'weight', resolution, rng: mulberry32(42) });
        opts?.partitionCache?.store(pkg.slug, memberKey, communities);
      }

      const byCommunity = new Map<number, string[]>();
      for (const id of members) {
        if (forced.has(id)) continue;
        const c = communities[id] ?? -1;
        const arr = byCommunity.get(c) ?? [];
        arr.push(id);
        byCommunity.set(c, arr);
      }
      const sole = byCommunity.size === 1;
      for (const fileIds of byCommunity.values()) groups.push({ pkg, fileIds, sole });
    }
  }

  // Materialise internal modules.
  const fileModuleMap: Record<string, string> = {};
  const modules: ClusteredModule[] = [];
  const usedIds = new Set<string>();

  // Forced-assignment modules first (so their ids are reserved).
  const forcedGroups = new Map<string, string[]>();
  for (const [fileId, moduleId] of forced) {
    const arr = forcedGroups.get(moduleId) ?? [];
    arr.push(fileId);
    forcedGroups.set(moduleId, arr);
  }
  for (const [moduleId, fileIds] of forcedGroups) {
    usedIds.add(moduleId);
    for (const f of fileIds) fileModuleMap[f] = moduleId;
    modules.push(makeInternalModule(moduleId, fileIds, locById));
  }

  // Community modules. Ids: root-scope communities keep the bare derived id
  // (pre-Stage-C behavior); a non-root package that is ONE community gets the
  // package slug itself (the package IS the module); a multi-community package
  // gets `<slug>-<derived>` with the derivation on PACKAGE-RELATIVE paths (so
  // `worker/container/src/foo.ts` derives from `src/foo.ts`, not `worker`).
  for (const grp of groups) {
    const { pkg, fileIds } = grp;
    let id: string;
    if (pkg === null || pkg.root === '') {
      id = deriveModuleId(fileIds, usedIds);
    } else if (grp.sole) {
      id = reserveId(pkg.slug, usedIds);
    } else {
      const rel = fileIds.map((f) =>
        f.startsWith(`${pkg.root}/`) ? f.slice(pkg.root.length + 1) : f,
      );
      const seg = slugify(deriveSegment(rel)) || 'module';
      id = reserveId(`${pkg.slug}-${seg}`, usedIds);
    }
    for (const f of fileIds) fileModuleMap[f] = id;
    const mod = makeInternalModule(id, fileIds, locById);
    if (pkg !== null && pkg.root !== '') {
      mod.packageId = pkg.slug;
      mod.packageName = pkg.name; // humanized for the subsystem box label
      mod.packageRole = pkg.role; // app / lib / tooling
    }
    modules.push(mod);
  }

  // Module-id stabilization ( Stage C warm-start) — AFTER modules are
  // materialized, BEFORE edge aggregation + god-node detection (both read the
  // FINAL ids) and before the workspace remap below (entry-module resolution
  // must see stabilized ids).
  if (opts?.priorModules !== undefined && opts.priorModules.length > 0) {
    stabilizeModuleIds(modules, fileModuleMap, opts.priorModules, {
      forcedIds: new Set(forcedGroups.keys()),
    });
  }

  // Workspace-name external remap ( Stage C — the cross-package edge
  // win). The install-free extractor sees `import x from '@org/pkg-b'` as a
  // bare specifier → an EXTERNAL node, even when pkg-b is a workspace sibling
  // sitting right there in the repo. With a layout we know better: map each
  // named non-root package's external id to its ENTRY module (first entry
  // candidate present in the file→module map). Unresolvable entry → no remap,
  // the external stays (fail-soft — never guess a target).
  const workspaceEntryByExtId = new Map<string, string>();
  if (layout !== undefined) {
    for (const pkg of layout.nameToPackage.values()) {
      const extId = externalIdFor(pkg.name!).id;
      const entry = pkg.entryFileIds.find((f) => fileModuleMap[f] !== undefined);
      if (entry !== undefined) workspaceEntryByExtId.set(extId, fileModuleMap[entry]);
    }
  }

  // External modules — only those still referenced by a SURVIVING (non-dropped)
  // file. An external introduced solely by a dropped file (e.g. eslint via
  // eslint.config.js, vitest via a *.test.ts) must not leak onto the diagram.
  // A workspace-remapped external must NOT materialize either — its edges now
  // point at the sibling package's entry module, so an external box for it
  // would be a phantom duplicate of an internal module.
  const referencedExternals = new Set(
    graph.edges.filter((e) => e.external && fileSet.has(e.from)).map((e) => e.to),
  );
  for (const ext of graph.externals) {
    if (!referencedExternals.has(ext.id)) continue;
    if (workspaceEntryByExtId.has(ext.id)) continue;
    modules.push({
      id: ext.id,
      kind: 'external',
      fileIds: [],
      externalSpecifier: ext.specifier,
      fileCount: 0,
      loc: 0,
      degree: 0,
      godNode: false,
    });
  }

  // Aggregate file edges → module edges (preserve direction). Cross-package
  // edges aggregate here like any other edge — full confidence, no penalty for
  // having been excluded from community detection.
  const moduleEdges = aggregateModuleEdges(graph, fileModuleMap, fileSet, workspaceEntryByExtId);

  // declared cross-package dependency edges. The import graph only sees
  // a package→package dependency when there's a resolved import; package.json
  // sibling-workspace deps (collected as pkg.declaredDeps in workspaces.ts)
  // declare the relation even when no import resolved. Materialize
  // each as a structural `import` edge between the two packages' ENTRY modules
  // (→ semantic `calls` downstream; assemble defaults the verb to `calls`). Only
  // FILLS GAPS: a pair already joined by an aggregated import edge is left alone
  // (no weight inflation). A self-edge is skipped silently; an UNRESOLVED entry
  // module is skipped fail-soft but LOGGED (no silent caps — a missing edge must
  // be distinguishable from "no dependency"). Deterministic: packages
  // root-sorted, declaredDeps pre-sorted.
  if (multiPackage && layout !== undefined) {
    const pkgByRoot = new Map(layout.packages.map((p) => [p.root, p] as const));
    const entryModuleOf = (pkg: WorkspacePackage): string | undefined => {
      const entry = pkg.entryFileIds.find((f) => fileModuleMap[f] !== undefined);
      return entry !== undefined ? fileModuleMap[entry] : undefined;
    };
    const existing = new Set(moduleEdges.map((e) => `${e.source} ${e.target}`));
    const unresolved: string[] = []; // declared deps that couldn't anchor to an entry module
    const sortedPkgs = [...layout.packages].sort((a, b) =>
      a.root < b.root ? -1 : a.root > b.root ? 1 : 0,
    );
    for (const pkg of sortedPkgs) {
      if (pkg.root === '' || pkg.declaredDeps.length === 0) continue;
      const src = entryModuleOf(pkg);
      if (src === undefined) {
        // pkg's own entry is unresolved → none of its declared deps can anchor.
        for (const depRoot of pkg.declaredDeps) unresolved.push(`${pkg.root}→${depRoot}`);
        continue;
      }
      for (const depRoot of pkg.declaredDeps) {
        const depPkg = pkgByRoot.get(depRoot);
        if (depPkg === undefined) continue; // structurally impossible (sibling root)
        const tgt = entryModuleOf(depPkg);
        if (tgt === undefined) {
          unresolved.push(`${pkg.root}→${depRoot}`);
          continue;
        }
        if (tgt === src) continue; // legitimate self-edge, not an unresolved entry
        const key = `${src} ${tgt}`;
        if (existing.has(key)) continue;
        existing.add(key);
        moduleEdges.push({ source: src, target: tgt, weight: 1, kinds: ['import'] });
      }
    }
    if (unresolved.length > 0) {
      console.warn(
        `  [workspaces] ${unresolved.length} declared cross-package dep(s) skipped — entry module unresolved: ${unresolved.join(', ')}`,
      );
    }
  }

  // Module-level degree + god-node flag. Degree counts distinct INTERNAL
  // neighbours only — coupling to other internal modules is the scary-to-refactor
  // signal. Counting external deps would flag any module that imports several
  // libraries (a false positive that swamped the first dogfood run).
  const internalIds = new Set(modules.filter((m) => m.kind === 'internal').map((m) => m.id));
  const internalNodes = [...internalIds];
  const neighbours = new Map<string, Set<string>>();
  for (const id of internalNodes) setInto(neighbours, id);
  for (const me of moduleEdges) {
    if (!internalIds.has(me.source) || !internalIds.has(me.target)) continue;
    neighbours.get(me.source)!.add(me.target);
    neighbours.get(me.target)!.add(me.source);
  }
  for (const m of modules) m.degree = neighbours.get(m.id)?.size ?? 0;

  // Statistical god-node flag. Two conditions, ANDed:
  //   1. internal-degree z-score > 1.5σ above the mean (an outlier in coupling)
  //   2. betweenness centrality in the top quartile (a routing chokepoint)
  // Only over the internal-module subgraph, and only when there are enough
  // modules for the statistics to mean anything.
  const godNodes = detectGodNodes(internalNodes, neighbours);
  for (const m of modules) m.godNode = m.kind === 'internal' && godNodes.has(m.id);

  return { modules, fileModuleMap, moduleEdges };
}

// ---------------------------------------------------------------------------
// Module-id stabilization ( Stage C).
//
// WHY: module ids are the stable join key for the changelog AND the identity
// the enrich set-diff (enrich/diff.ts) reuses prior LLM labels by — a fresh
// cluster that produces the same community under a different derived id reads
// as "new module" downstream, which re-spends LLM tokens on a label we already
// have and churns the rendered topology for no real change. Stabilization
// greedily matches fresh internal modules to the prior extraction's internal
// modules by file-set overlap and adopts the prior ids.
//
// Rules (locked by the Stage C design):
//   - candidate pairs (fresh internal × prior internal) scored by Jaccard
//     overlap of fileId sets; sorted desc; accepted at ≥ 0.5, each fresh
//     module and each prior id consumed at most once (greedy best-match);
//   - override-FORCED modules are never renamed (their ids are user-authored)
//     and their ids are never stolen by a match;
//   - a module already bearing its matched prior id is not renamed (but the
//     pair still consumes the id, so no other module can steal it);
//   - on collision (a matched module adopts a prior id that ANOTHER fresh
//     module derived naturally), the matched module wins; the other reroutes
//     through the same `-2` dedup scheme deriveModuleId uses.
//
// Mutates `modules` (ids) and `fileModuleMap` in place, consistently —
// `packageId` and every other field are left intact. Callers must run this
// BEFORE aggregating module edges (clusterGraph does).
export function stabilizeModuleIds(
  modules: ClusteredModule[],
  fileModuleMap: Record<string, string>,
  priorModules: ReadonlyArray<Pick<ClusteredModule, 'id' | 'kind' | 'fileIds'>>,
  opts?: { forcedIds?: ReadonlySet<string> },
): void {
  const forcedIds = opts?.forcedIds ?? new Set<string>();
  const priorInternal = priorModules.filter((m) => m.kind === 'internal');
  if (priorInternal.length === 0) return;

  // Ids that can neither be renamed nor adopted: forced modules (user-
  // authored) and any non-internal module a caller happens to pass. NOTE
  // (REVIEWER PR #150): at clusterGraph's call site externals are appended to
  // `modules` AFTER this runs, so they are NOT in this set there — external
  // collisions are instead impossible by namespace (`ext:`-prefixed ids can
  // never equal a slugified internal id; slugify strips ':'), and the guard
  // below makes that invariant local rather than two files away.
  const immovableIds = new Set<string>();
  for (const m of modules) {
    if (m.kind !== 'internal' || forcedIds.has(m.id)) immovableIds.add(m.id);
  }

  const candidates = modules.filter((m) => m.kind === 'internal' && !forcedIds.has(m.id));

  // Score all qualifying pairs. The module graph is small (tens of modules),
  // so the quadratic pairing is negligible.
  interface Pair {
    mod: ClusteredModule;
    priorId: string;
    score: number;
  }
  const pairs: Pair[] = [];
  for (const mod of candidates) {
    const fresh = new Set(mod.fileIds);
    for (const prior of priorInternal) {
      if (immovableIds.has(prior.id)) continue;
      // Defense-in-depth (see immovableIds note): a namespaced id (`ext:…`)
      // must never be adopted as an internal module id, regardless of what a
      // caller put in priorModules or when externals join the modules array.
      if (prior.id.includes(':')) continue;
      let inter = 0;
      for (const f of prior.fileIds) if (fresh.has(f)) inter++;
      const union = fresh.size + prior.fileIds.length - inter;
      const score = union === 0 ? 0 : inter / union;
      if (score >= 0.5) pairs.push({ mod, priorId: prior.id, score });
    }
  }
  // Desc by score; ties broken by prior id then current id — fully
  // deterministic regardless of input ordering (current ids are unique).
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      (a.priorId < b.priorId ? -1 : a.priorId > b.priorId ? 1 : 0) ||
      (a.mod.id < b.mod.id ? -1 : a.mod.id > b.mod.id ? 1 : 0),
  );

  const usedPriorIds = new Set<string>();
  const matched = new Map<ClusteredModule, string>(); // fresh module → adopted prior id
  for (const p of pairs) {
    if (usedPriorIds.has(p.priorId) || matched.has(p.mod)) continue;
    usedPriorIds.add(p.priorId);
    matched.set(p.mod, p.priorId);
  }
  if (matched.size === 0) return;

  // Compute final ids. Matched modules claim their prior ids first; immovable
  // modules keep theirs; every remaining module keeps its current id unless a
  // matched module claimed it — then it reroutes through the dedup suffix.
  // Processing order is `modules` array order: deterministic.
  const finalIds = new Map<ClusteredModule, string>();
  const used = new Set<string>();
  for (const m of modules) {
    if (m.kind !== 'internal' || forcedIds.has(m.id)) {
      finalIds.set(m, m.id);
      used.add(m.id);
    }
  }
  for (const [mod, priorId] of matched) {
    finalIds.set(mod, priorId);
    used.add(priorId);
  }
  for (const m of modules) {
    if (finalIds.has(m)) continue;
    finalIds.set(m, reserveId(m.id, used));
  }

  // Apply: rewrite module ids, then remap fileModuleMap by ORIGINAL value in
  // one pass (original ids are unique, so a swap — A takes B's id while B
  // reroutes — resolves correctly).
  const idRemap = new Map<string, string>();
  for (const m of modules) {
    const next = finalIds.get(m)!;
    if (next !== m.id) idRemap.set(m.id, next);
    m.id = next;
  }
  if (idRemap.size === 0) return;
  for (const [fileId, moduleId] of Object.entries(fileModuleMap)) {
    const next = idRemap.get(moduleId);
    if (next !== undefined) fileModuleMap[fileId] = next;
  }
}

// Returns the set of internal module ids that are statistical god-nodes.
// Exported for unit testing (pure: adjacency in, flagged-set out).
export function detectGodNodes(
  nodes: string[],
  adjacency: Map<string, Set<string>>,
): Set<string> {
  const flagged = new Set<string>();
  const n = nodes.length;
  if (n < GOD_NODE_MIN_MODULES) return flagged;

  // (1) degree z-scores. Population std; if everyone has the same degree there
  // is no outlier (std 0 → no flags).
  const degrees = nodes.map((id) => adjacency.get(id)?.size ?? 0);
  const mean = degrees.reduce((a, b) => a + b, 0) / n;
  const variance = degrees.reduce((a, d) => a + (d - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return flagged;

  // (2) betweenness centrality (Brandes, unweighted undirected). The module
  // graph is tiny (modules, not files), so the O(n·m) cost is negligible and an
  // inline impl avoids pulling in graphology-metrics for ~25 lines.
  const between = betweenness(nodes, adjacency);
  const sorted = [...between.values()].sort((a, b) => a - b);
  // Top-quartile cutoff = the 75th-percentile value. A node qualifies only if
  // it's at/above the cutoff AND actually routes something (>0) — in a sparse
  // graph many nodes have 0 betweenness and must not count as chokepoints.
  const p75 = sorted[Math.floor(0.75 * (sorted.length - 1))];

  for (const id of nodes) {
    const z = ((adjacency.get(id)?.size ?? 0) - mean) / std;
    const c = between.get(id) ?? 0;
    if (z > GOD_NODE_Z_THRESHOLD && c > 0 && c >= p75) flagged.add(id);
  }
  return flagged;
}

// Brandes' betweenness centrality for an unweighted, undirected graph.
// Deterministic (the centrality sums are independent of traversal order).
// Undirected → halve the final scores (each shortest path counted twice).
// Exported for unit testing.
export function betweenness(nodes: string[], adjacency: Map<string, Set<string>>): Map<string, number> {
  const cb = new Map<string, number>(nodes.map((id) => [id, 0]));

  for (const s of nodes) {
    const stack: string[] = [];
    const pred = new Map<string, string[]>(nodes.map((id) => [id, []]));
    const sigma = new Map<string, number>(nodes.map((id) => [id, 0]));
    const dist = new Map<string, number>(nodes.map((id) => [id, -1]));
    sigma.set(s, 1);
    dist.set(s, 0);
    const queue: string[] = [s];

    while (queue.length > 0) {
      const v = queue.shift()!;
      stack.push(v);
      for (const w of adjacency.get(v) ?? []) {
        if (dist.get(w)! < 0) {
          dist.set(w, dist.get(v)! + 1);
          queue.push(w);
        }
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          pred.get(w)!.push(v);
        }
      }
    }

    const delta = new Map<string, number>(nodes.map((id) => [id, 0]));
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred.get(w)!) {
        delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!));
      }
      if (w !== s) cb.set(w, cb.get(w)! + delta.get(w)!);
    }
  }

  for (const id of nodes) cb.set(id, cb.get(id)! / 2);
  return cb;
}

function setInto(map: Map<string, Set<string>>, key: string): Set<string> {
  const s = new Set<string>();
  map.set(key, s);
  return s;
}

function makeInternalModule(
  id: string,
  fileIds: string[],
  locById: Map<string, number>,
): ClusteredModule {
  return {
    id,
    kind: 'internal',
    fileIds,
    fileCount: fileIds.length,
    loc: fileIds.reduce((sum, f) => sum + (locById.get(f) ?? 0), 0),
    degree: 0,
    godNode: false,
  };
}

function aggregateModuleEdges(
  graph: NormalizedGraph,
  fileModuleMap: Record<string, string>,
  fileSet: Set<string>,
  // Stage C: external id → workspace sibling's entry module id. A
  // matching external edge becomes an INTERNAL module edge (kinds preserved,
  // merged with any existing edge to the same pair). Self-edges (a package
  // importing its own name) fall out via the src === tgt guard.
  externalRemap?: ReadonlyMap<string, string>,
): ModuleEdge[] {
  const edges = new Map<string, ModuleEdge>();
  for (const e of graph.edges) {
    const src = fileModuleMap[e.from];
    if (!src || !fileSet.has(e.from)) continue;
    const tgt = e.external ? (externalRemap?.get(e.to) ?? e.to) : fileModuleMap[e.to];
    if (!tgt || src === tgt) continue;
    const key = `${src} ${tgt}`;
    const existing = edges.get(key);
    if (existing) {
      existing.weight += e.weight;
      if (!existing.kinds.includes(e.kind)) existing.kinds.push(e.kind);
    } else {
      edges.set(key, { source: src, target: tgt, weight: e.weight, kinds: [e.kind] });
    }
  }
  return [...edges.values()];
}
