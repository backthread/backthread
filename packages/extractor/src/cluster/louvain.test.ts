// statistical god-node detection tests. Pure: the detector
// and the Brandes betweenness helper take an adjacency map and return values,
// so no clustering / DB / LLM is exercised here.
//
// Stage C additions below: per-package clustering on a WorkspaceLayout
// (boundaries from manifests, never crossed by Louvain), workspace-name
// external remap, module-id stabilization against a prior extraction, and the
// PackagePartitionCache warm-reuse semantics.

import { test, expect, vi } from '../testkit.js';
import {
  detectGodNodes,
  betweenness,
  clusterGraph,
  stabilizeModuleIds,
  PackagePartitionCache,
  type ClusteredModule,
} from './louvain.js';
import type { WorkspaceLayout, WorkspacePackage } from './workspaces.js';
import type { NormalizedGraph } from '../graph/types.js';

function adjacency(nodes: string[], edges: Array<[string, string]>): Map<string, Set<string>> {
  const m = new Map(nodes.map((n) => [n, new Set<string>()]));
  for (const [a, b] of edges) {
    m.get(a)!.add(b);
    m.get(b)!.add(a);
  }
  return m;
}

// The  regression: a small, uniformly dense repo must NOT flag half the
// graph. K5 (complete, every degree == 4) has zero degree variance → no outlier.
test('does not over-fire on a small dense graph (K5 → 0 god-nodes)', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'];
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) edges.push([nodes[i], nodes[j]]);
  expect(detectGodNodes(nodes, adjacency(nodes, edges)).size).toBe(0);
});

// A real god-node: a hub every leaf routes through. High degree z-score AND
// top-quartile betweenness — both conditions met for the hub alone.
test('flags the hub in a star graph, and only the hub', () => {
  const nodes = ['hub', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6'];
  const edges = nodes.slice(1).map((l) => ['hub', l] as [string, string]);
  const flagged = detectGodNodes(nodes, adjacency(nodes, edges));
  expect([...flagged]).toEqual(['hub']);
});

// Below the module minimum, statistics are noise — never flag.
test('returns empty below GOD_NODE_MIN_MODULES (n=4)', () => {
  const nodes = ['hub', 'l1', 'l2', 'l3'];
  const edges = nodes.slice(1).map((l) => ['hub', l] as [string, string]);
  expect(detectGodNodes(nodes, adjacency(nodes, edges)).size).toBe(0);
});

// Brandes sanity: on the path A–B–C, only B sits on a shortest path (A↔C).
test('betweenness: middle of a path carries all the flow', () => {
  const nodes = ['a', 'b', 'c'];
  const bc = betweenness(nodes, adjacency(nodes, [['a', 'b'], ['b', 'c']]));
  expect(bc.get('b')).toBe(1);
  expect(bc.get('a')).toBe(0);
  expect(bc.get('c')).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage C — fixtures + helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Hand-build a NormalizedGraph: internal import edges + external imports. */
function graphOf(args: {
  files: string[];
  edges?: Array<[string, string, number?]>;
  externals?: Array<[string, string, number?]>; // [from file, external specifier]
}): NormalizedGraph {
  const externals = new Map<string, string>();
  const edges = (args.edges ?? []).map(([from, to, weight]) => ({
    from,
    to,
    kind: 'import' as const,
    external: false,
    weight: weight ?? 1,
  }));
  for (const [from, spec, weight] of args.externals ?? []) {
    const id = `ext:${spec}`;
    externals.set(id, spec);
    edges.push({ from, to: id, kind: 'import', external: true, weight: weight ?? 1 });
  }
  return {
    root: '/tmp/fixture',
    files: args.files.map((id) => ({ id, loc: 10, language: 'ts' })),
    edges,
    externals: [...externals.entries()].map(([id, specifier]) => ({ id, specifier })),
  };
}

/** Hand-build a WorkspaceLayout (mirrors detectWorkspaceLayout's semantics). */
function layoutOf(pkgs: Array<Partial<WorkspacePackage> & { root: string; slug: string }>): WorkspaceLayout {
  const packages: WorkspacePackage[] = pkgs.map((p) => ({
    name: null,
    entryFileIds: [],
    declared: true,
    role: 'lib',
    declaredDeps: [],
    ...p,
  }));
  const byRoot = new Map(packages.map((p) => [p.root, p] as const));
  const rootScope = byRoot.get('')!;
  return {
    packages,
    packageOf: (fileId: string) => {
      let prefix = fileId;
      for (;;) {
        const cut = prefix.lastIndexOf('/');
        if (cut < 0) return rootScope;
        prefix = prefix.slice(0, cut);
        const hit = byRoot.get(prefix);
        if (hit) return hit;
      }
    },
    nameToPackage: new Map(
      packages.filter((p) => p.root !== '' && p.name !== null).map((p) => [p.name!, p]),
    ),
  };
}

function internalModules(result: ReturnType<typeof clusterGraph>) {
  return result.modules.filter((m) => m.kind === 'internal');
}

function mod(id: string, fileIds: string[]): ClusteredModule {
  return { id, kind: 'internal', fileIds, fileCount: fileIds.length, loc: 0, degree: 0, godNode: false };
}

// ── per-package clustering ──────────────────────────────────────────────────

// Boundaries are DECLARED, not statistical: even an overwhelming cross-package
// edge (weight 50 vs 5 within) must not pull two packages into one module.
test('per-package clustering never crosses a package boundary', () => {
  const graph = graphOf({
    files: ['pa/a.ts', 'pa/b.ts', 'pb/a.ts', 'pb/b.ts'],
    edges: [
      ['pa/a.ts', 'pa/b.ts', 5],
      ['pb/a.ts', 'pb/b.ts', 5],
      ['pa/a.ts', 'pb/a.ts', 50], // heavy cross-package edge — excluded from detection
    ],
  });
  const layout = layoutOf([
    { root: '', slug: 'root' },
    { root: 'pa', slug: 'pa', name: '@x/pa' },
    { root: 'pb', slug: 'pb', name: '@x/pb' },
  ]);
  const result = clusterGraph(graph, undefined, { layout });

  for (const m of internalModules(result)) {
    const owners = new Set(m.fileIds.map((f) => layout.packageOf(f).root));
    expect(owners.size).toBe(1); // no module spans packages
  }
  // Single-community packages get the bare slug + packageId.
  const pa = result.modules.find((m) => m.id === 'pa')!;
  const pb = result.modules.find((m) => m.id === 'pb')!;
  expect(pa.packageId).toBe('pa');
  expect(pb.packageId).toBe('pb');
  // The cross-package edge still aggregates, at full confidence.
  expect(result.moduleEdges).toContainEqual({ source: 'pa', target: 'pb', weight: 50, kinds: ['import'] });
});

test('root-scope communities keep bare derived ids and no packageId', () => {
  const graph = graphOf({
    files: ['src/auth/a.ts', 'src/auth/b.ts', 'w/x.ts', 'w/y.ts'],
    edges: [
      ['src/auth/a.ts', 'src/auth/b.ts', 3],
      ['w/x.ts', 'w/y.ts', 3],
    ],
  });
  const layout = layoutOf([
    { root: '', slug: 'root' },
    { root: 'w', slug: 'w', name: 'w-pkg' },
  ]);
  const result = clusterGraph(graph, undefined, { layout });
  const auth = result.modules.find((m) => m.id === 'auth')!; // exactly today's derivation
  expect(auth.packageId).toBeUndefined();
  expect(auth.fileIds.sort()).toEqual(['src/auth/a.ts', 'src/auth/b.ts']);
  expect(result.modules.find((m) => m.id === 'w')!.packageId).toBe('w');
});

test('multi-community packages get slug-prefixed ids derived from package-relative paths', () => {
  const graph = graphOf({
    // Two disconnected clusters inside `lib` → two communities → prefixed ids.
    files: ['lib/api/a.ts', 'lib/api/b.ts', 'lib/db/a.ts', 'lib/db/b.ts'],
    edges: [
      ['lib/api/a.ts', 'lib/api/b.ts', 3],
      ['lib/db/a.ts', 'lib/db/b.ts', 3],
    ],
  });
  const layout = layoutOf([
    { root: '', slug: 'root' },
    { root: 'lib', slug: 'lib', name: 'lib' },
  ]);
  const result = clusterGraph(graph, undefined, { layout });
  const ids = internalModules(result).map((m) => m.id).sort();
  expect(ids).toEqual(['lib-api', 'lib-db']);
  for (const m of internalModules(result)) expect(m.packageId).toBe('lib');
});

test('single-package layout behaves exactly like no layout at all', () => {
  const graph = graphOf({
    files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    edges: [
      ['src/a.ts', 'src/b.ts', 2],
      ['src/b.ts', 'src/c.ts', 2],
    ],
    externals: [['src/a.ts', 'stripe']],
  });
  const bare = clusterGraph(graph);
  const withLayout = clusterGraph(graph, undefined, {
    layout: layoutOf([{ root: '', slug: 'root' }]),
  });
  expect(withLayout).toEqual(bare);
});

// ── declared cross-package edges + package metadata threading ───────

test('a declared cross-package dep with NO resolved import becomes an entry-module edge', () => {
  // web depends on ui via package.json (declaredDeps), but there is NO import
  // from web → ui in the graph. The declared edge must still appear.
  const graph = graphOf({
    files: ['apps/web/src/index.ts', 'apps/web/src/page.ts', 'packages/ui/src/index.ts'],
    edges: [['apps/web/src/index.ts', 'apps/web/src/page.ts', 2]],
  });
  const layout = layoutOf([
    { root: '', slug: 'root' },
    {
      root: 'apps/web',
      slug: 'web',
      name: '@m/web',
      role: 'app',
      entryFileIds: ['apps/web/src/index.ts'],
      declaredDeps: ['packages/ui'],
    },
    {
      root: 'packages/ui',
      slug: 'ui',
      name: '@m/ui',
      role: 'lib',
      entryFileIds: ['packages/ui/src/index.ts'],
    },
  ]);
  const result = clusterGraph(graph, undefined, { layout });

  // Default `import` edge between the two packages' entry modules (→ `calls`
  // downstream once assemble defaults the verb).
  expect(result.moduleEdges).toContainEqual({ source: 'web', target: 'ui', weight: 1, kinds: ['import'] });
  // Package metadata threaded onto the module for the subsystem box.
  const web = result.modules.find((m) => m.id === 'web')!;
  expect(web).toMatchObject({ packageId: 'web', packageName: '@m/web', packageRole: 'app' });
  const ui = result.modules.find((m) => m.id === 'ui')!;
  expect(ui).toMatchObject({ packageId: 'ui', packageName: '@m/ui', packageRole: 'lib' });
});

test('declared edges only fill gaps (no inflation) and fail soft on unresolvable entries', () => {
  const graph = graphOf({
    files: ['apps/web/src/index.ts', 'packages/ui/src/index.ts'],
    // a REAL import already connects web → ui, weight 4.
    edges: [['apps/web/src/index.ts', 'packages/ui/src/index.ts', 4]],
  });
  const layout = layoutOf([
    { root: '', slug: 'root' },
    {
      root: 'apps/web',
      slug: 'web',
      name: '@m/web',
      role: 'app',
      entryFileIds: ['apps/web/src/index.ts'],
      declaredDeps: ['packages/ui', 'packages/ghost'], // ghost has no file in the graph
    },
    { root: 'packages/ui', slug: 'ui', name: '@m/ui', role: 'lib', entryFileIds: ['packages/ui/src/index.ts'] },
    { root: 'packages/ghost', slug: 'ghost', name: '@m/ghost', role: 'lib', entryFileIds: ['packages/ghost/src/index.ts'] },
  ]);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const result = clusterGraph(graph, undefined, { layout });

  // The pre-existing import edge is NOT duplicated nor re-weighted by the declared dep.
  const webUi = result.moduleEdges.filter((e) => e.source === 'web' && e.target === 'ui');
  expect(webUi).toEqual([{ source: 'web', target: 'ui', weight: 4, kinds: ['import'] }]);
  // ghost's entry is absent from the graph → no edge (fail-soft)…
  expect(result.moduleEdges.some((e) => e.target === 'ghost')).toBe(false);
  // …but the skip is LOGGED, not silent (no silent caps).
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('apps/web→packages/ghost'));
  warn.mockRestore();
});

// ── workspace-name external remap ───────────────────────────────────────────

test('workspace external remap: bare-specifier sibling import becomes an internal edge', () => {
  const graph = graphOf({
    files: ['src/app.ts', 'packages/util/src/index.ts', 'packages/util/src/helpers.ts'],
    edges: [['packages/util/src/index.ts', 'packages/util/src/helpers.ts', 2]],
    externals: [
      ['src/app.ts', '@acme/util', 3], // workspace sibling → remapped
      ['src/app.ts', 'stripe'], // genuine external → untouched
      ['src/app.ts', '@acme/ghost'], // workspace name, entry unresolvable → kept external
    ],
  });
  const layout = layoutOf([
    { root: '', slug: 'root' },
    {
      root: 'packages/util',
      slug: 'util',
      name: '@acme/util',
      entryFileIds: ['packages/util/dist/index.js', 'packages/util/src/index.ts'],
    },
    {
      root: 'packages/ghost',
      slug: 'ghost',
      name: '@acme/ghost',
      entryFileIds: ['packages/ghost/src/index.ts'], // no such file in the graph
    },
  ]);
  const result = clusterGraph(graph, undefined, { layout });

  const ids = result.modules.map((m) => m.id);
  expect(ids).not.toContain('ext:@acme/util'); // remapped → no external module
  expect(ids).toContain('ext:@acme/ghost'); // unresolvable entry → fail-soft, kept
  expect(ids).toContain('ext:stripe'); // non-workspace external untouched

  // The external edge became an INTERNAL module edge to the entry module,
  // kinds + weight preserved.
  expect(result.moduleEdges).toContainEqual({ source: 'app', target: 'util', weight: 3, kinds: ['import'] });
  expect(result.moduleEdges.find((e) => e.target === 'ext:@acme/util')).toBeUndefined();
  expect(result.moduleEdges).toContainEqual({ source: 'app', target: 'ext:@acme/ghost', weight: 1, kinds: ['import'] });
  expect(result.moduleEdges).toContainEqual({ source: 'app', target: 'ext:stripe', weight: 1, kinds: ['import'] });
});

// ── module-id stabilization ─────────────────────────────────────────────────

test('stabilizeModuleIds: overlap ≥ 0.5 adopts the prior id and rewrites the file map', () => {
  const modules = [mod('newid', ['a.ts', 'b.ts', 'c.ts'])];
  const map: Record<string, string> = { 'a.ts': 'newid', 'b.ts': 'newid', 'c.ts': 'newid' };
  // Jaccard {a,b,c}∩{a,b,d} = 2 / 4 = 0.5 — exactly at the acceptance floor.
  stabilizeModuleIds(modules, map, [mod('oldid', ['a.ts', 'b.ts', 'd.ts'])]);
  expect(modules[0].id).toBe('oldid');
  expect(map).toEqual({ 'a.ts': 'oldid', 'b.ts': 'oldid', 'c.ts': 'oldid' });
});

test('stabilizeModuleIds: overlap < 0.5 keeps the derived id', () => {
  const modules = [mod('newid', ['a.ts', 'x.ts', 'y.ts'])];
  const map: Record<string, string> = { 'a.ts': 'newid', 'x.ts': 'newid', 'y.ts': 'newid' };
  // Jaccard = 1 / 5 = 0.2 < 0.5.
  stabilizeModuleIds(modules, map, [mod('oldid', ['a.ts', 'b.ts', 'c.ts'])]);
  expect(modules[0].id).toBe('newid');
  expect(map['a.ts']).toBe('newid');
});

test('stabilizeModuleIds: override-forced ids are never renamed nor stolen', () => {
  const modules = [mod('pinned', ['a.ts', 'b.ts']), mod('other', ['z.ts'])];
  const map: Record<string, string> = { 'a.ts': 'pinned', 'b.ts': 'pinned', 'z.ts': 'other' };
  stabilizeModuleIds(
    modules,
    map,
    [
      mod('legacy', ['a.ts', 'b.ts']), // perfect overlap with the FORCED module → ignored
      mod('pinned', ['z.ts']), // a prior id equal to a forced id → may not be adopted
    ],
    { forcedIds: new Set(['pinned']) },
  );
  expect(modules[0].id).toBe('pinned'); // user-authored, untouched
  expect(modules[1].id).toBe('other'); // adopting 'pinned' would duplicate a forced id
});

test('stabilizeModuleIds: collision reroutes the natural holder through the dedup suffix', () => {
  // M1 matches prior 'core' perfectly; M2 happens to have derived 'core'
  // naturally (zero overlap with the prior). The matched module WINS the id;
  // M2 reroutes to 'core-2'.
  const modules = [mod('core', ['z.ts']), mod('core-x', ['a.ts', 'b.ts'])];
  const map: Record<string, string> = { 'z.ts': 'core', 'a.ts': 'core-x', 'b.ts': 'core-x' };
  stabilizeModuleIds(modules, map, [mod('core', ['a.ts', 'b.ts'])]);
  expect(modules[1].id).toBe('core'); // matched → adopted
  expect(modules[0].id).toBe('core-2'); // rerouted
  expect(map).toEqual({ 'z.ts': 'core-2', 'a.ts': 'core', 'b.ts': 'core' });
});

test('clusterGraph + priorModules: edges and file map reference stabilized ids', () => {
  const graph = graphOf({
    files: ['src/auth/a.ts', 'src/auth/b.ts', 'billing/x.ts', 'billing/y.ts'],
    edges: [
      ['src/auth/a.ts', 'src/auth/b.ts', 3],
      ['billing/x.ts', 'billing/y.ts', 3],
      ['src/auth/a.ts', 'billing/x.ts', 1], // cross-package → module edge
    ],
  });
  const layout = layoutOf([
    { root: '', slug: 'root' },
    { root: 'billing', slug: 'billing', name: 'billing' },
  ]);
  // Prior run had the auth community under the id 'identity' (2/3 overlap).
  const prior = [mod('identity', ['src/auth/a.ts', 'src/auth/b.ts', 'src/auth/c.ts'])];
  const result = clusterGraph(graph, undefined, { layout, priorModules: prior });

  expect(result.modules.map((m) => m.id).sort()).toEqual(['billing', 'identity']);
  expect(result.fileModuleMap['src/auth/a.ts']).toBe('identity');
  expect(result.moduleEdges).toContainEqual({ source: 'identity', target: 'billing', weight: 1, kinds: ['import'] });
  // packageId survives the rename machinery.
  expect(result.modules.find((m) => m.id === 'billing')!.packageId).toBe('billing');
});

// ── PackagePartitionCache ───────────────────────────────────────────────────

const cacheLayout = () =>
  layoutOf([
    { root: '', slug: 'root' },
    { root: 'p', slug: 'p', name: 'p' },
  ]);

test('PackagePartitionCache: lookup honors dirty marks, member changes, and invalidateAll', () => {
  const cache = new PackagePartitionCache();
  const layout = cacheLayout();
  const key = ['p/a.ts', 'p/b.ts'].join('\n');
  const partition = { 'p/a.ts': 0, 'p/b.ts': 0 };

  cache.store('p', key, partition);
  expect(cache.lookup('p', key)).toBe(partition); // clean + same members → reuse
  expect(cache.lookup('p', `${key}\np/c.ts`)).toBeNull(); // member change → no reuse (the belt)

  cache.invalidatePaths(['p/a.ts'], layout);
  expect(cache.lookup('p', key)).toBeNull(); // dirty → recluster (the braces)
  cache.store('p', key, partition); // recluster stores → clean again
  expect(cache.lookup('p', key)).toBe(partition);

  cache.invalidatePaths(['src/other.ts'], layout); // touches the ROOT scope only
  expect(cache.lookup('p', key)).toBe(partition); // unrelated package stays warm

  cache.invalidateAll();
  expect(cache.lookup('p', key)).toBeNull();
});

test('clusterGraph consults the cache: a clean stored partition is REUSED, a dirty one re-clustered', () => {
  // Triangle inside package `p` — Louvain alone yields ONE community. Seed the
  // cache with a DIFFERENT partition ({a,b} | {c}); if clusterGraph reuses it,
  // the seeded split shows up in the output, proving the skip happened.
  const graph = graphOf({
    files: ['p/a.ts', 'p/b.ts', 'p/c.ts'],
    edges: [
      ['p/a.ts', 'p/b.ts', 5],
      ['p/b.ts', 'p/c.ts', 5],
      ['p/a.ts', 'p/c.ts', 5],
    ],
  });
  const layout = cacheLayout();
  const cache = new PackagePartitionCache();
  const memberKey = ['p/a.ts', 'p/b.ts', 'p/c.ts'].join('\n');
  cache.store('p', memberKey, { 'p/a.ts': 0, 'p/b.ts': 0, 'p/c.ts': 1 });

  const warm = clusterGraph(graph, undefined, { layout, partitionCache: cache });
  expect(internalModules(warm)).toHaveLength(2); // the seeded split was reused
  expect(internalModules(warm).map((m) => m.fileIds.length).sort()).toEqual([1, 2]);

  // Dirty the package → Louvain reruns → the triangle collapses to ONE module,
  // and the recluster REPLACES the seeded cache entry.
  cache.invalidatePaths(['p/a.ts'], layout);
  const fresh = clusterGraph(graph, undefined, { layout, partitionCache: cache });
  expect(internalModules(fresh)).toHaveLength(1);
  expect(internalModules(fresh)[0].id).toBe('p'); // sole community → bare slug
  expect(cache.lookup('p', memberKey)).toEqual({ 'p/a.ts': 0, 'p/b.ts': 0, 'p/c.ts': 0 });
});

