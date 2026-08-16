// The framework contribution step, split into its two separately-callable
// phases: the TREE phase (`collectFrameworkContributions` — detection + every
// adapter hook, needs only a checkout) and the CLUSTER phase
// (`applyFrameworkContributions` — resolution, validation, arbitration, the
// cluster mutation).
//
// What these tests pin, and why each one exists:
//   1. COMPOSITION — `contributeFrameworkGraph` is exactly the two phases run
//      back to back, including the in-place cluster mutation. If it ever grows a
//      third implementation the two paths drift, which is the whole failure mode
//      the split exists to prevent.
//   2. SERIALISATION — the raw value survives a JSON round-trip unchanged in
//      effect. CI-mode extraction puts the two phases on different machines, so
//      this is the property that path depends on; it is asserted, never assumed.
//      (It also catches the cluster phase aliasing into the caller's raw arrays.)
//   3. ORDER — adapter edges fold BEFORE the cross-language seam, and dedupe is
//      first-wins, so a seam edge never displaces an adapter edge.
//   4. TRUST BOUNDARY — `parseEdgeKind` runs in the CLUSTER phase. The producer
//      may be a machine we don't own, so a forbidden verb must survive collection
//      and be rejected on apply, not the other way round.
//   5. DROPS — self-edges and unresolved endpoints are measured through the split
//      path, not only through the composed one.

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from '../testkit.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyFrameworkContributions,
  collectFrameworkContributions,
  contributeFrameworkGraph,
  type RawFrameworkContributions,
} from './contribute-step.js';
import { clearFrameworkAdapters, registerFrameworkAdapter } from './registry.js';
import type { FrameworkAdapter, RoleTag } from './types.js';
import type { ClusterResult } from '../cluster/louvain.js';
import type { NormalizedGraph } from '../graph/types.js';
import type { EdgeKind } from '../types.js';

// ---------------------------------------------------------------------------
// Fixture: a repo dir no builtin adapter claims (so the ONLY match is the fake
// below), a hand-built graph, and a 3-module cluster.

let repoDir: string;

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'backthread-fw-contrib-'));
  // lodash-only deps: genuinely framework-less, so the builtin fleet that
  // `collectFrameworkContributions` registers on top detects nothing.
  writeFileSync(
    join(repoDir, 'package.json'),
    JSON.stringify({ name: 'plain', dependencies: { lodash: '4.17.21' } }),
  );
});

afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

const FILES = ['a.ts', 'a2.ts', 'b.ts', 'c.ts'];

function graph(): NormalizedGraph {
  return {
    root: repoDir,
    files: FILES.map((id) => ({ id, loc: 10, language: 'ts' })),
    edges: [],
    externals: [],
  };
}

// m1 = { a.ts, a2.ts }, m2 = { b.ts }, m3 = { c.ts }.
function cluster(): ClusterResult {
  const mod = (id: string, fileIds: string[]) => ({
    id,
    kind: 'internal' as const,
    fileIds,
    fileCount: fileIds.length,
    loc: fileIds.length * 10,
    degree: 1,
    godNode: false,
  });
  return {
    modules: [mod('m1', ['a.ts', 'a2.ts']), mod('m2', ['b.ts']), mod('m3', ['c.ts'])],
    fileModuleMap: { 'a.ts': 'm1', 'a2.ts': 'm1', 'b.ts': 'm2', 'c.ts': 'm3' },
    moduleEdges: [],
  };
}

/**
 * One adapter exercising all three hooks, in FILE-ID space, and covering every
 * drop the cluster phase performs:
 *   edges — one good, one self-edge (a.ts + a2.ts share m1), one unresolved
 *           endpoint, one FORBIDDEN verb;
 *   roles — two on the same module (collapse by priority), one on another,
 *           one unresolved;
 *   groups — the same group id emitted TWICE (the "repeat appends" contract),
 *            the second carrying a file that resolves to nothing.
 */
const fake: FrameworkAdapter = {
  name: 'fake',
  async detect() {
    return { adapter: 'fake', confidence: 1, rootPath: '' };
  },
  async syntheticEdges() {
    return [
      { source: 'a.ts', target: 'b.ts', kind: 'calls' as EdgeKind },
      { source: 'a.ts', target: 'a2.ts', kind: 'calls' as EdgeKind }, // → m1→m1, self
      { source: 'a.ts', target: 'nope.ts', kind: 'calls' as EdgeKind }, // → unresolved
      // A substrate-only verb. The adapter type says EdgeKind, so a real producer
      // bug needs this cast to reproduce — which is exactly the bug the CLUSTER
      // phase is the boundary for.
      { source: 'b.ts', target: 'c.ts', kind: 'imports' as EdgeKind },
    ];
  },
  async roleTags() {
    return new Map<string, RoleTag>([
      ['a.ts', { role: 'screen', kind: 'frontend', priority: 1 }],
      ['a2.ts', { role: 'navigator', kind: 'frontend', priority: 5 }], // beats 'screen'
      ['b.ts', { role: 'route-handler', kind: 'gateway' }],
      ['nope.ts', { role: 'ghost', kind: 'service' }], // → unresolved
    ]);
  },
  async groupingPrior() {
    return {
      groups: [
        { id: 'feature-x', label: 'Feature X', fileIds: ['a.ts'] },
        { id: 'feature-x', label: 'Feature X', fileIds: ['b.ts', 'nope.ts'] },
      ],
    };
  },
};

/** The step logs freely; keep the suite's output readable. */
function muteConsole() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return () => {
    log.mockRestore();
    warn.mockRestore();
  };
}

/** The parts of a cluster this step is allowed to change. */
const grouping = (c: ClusterResult) =>
  c.modules.map((m) => ({
    id: m.id,
    packageId: m.packageId,
    packageName: m.packageName,
    packageRole: m.packageRole,
  }));

describe('framework contribution — the two phases compose', () => {
  beforeEach(() => {
    clearFrameworkAdapters();
    registerFrameworkAdapter(fake);
  });

  it('contributeFrameworkGraph === collect → apply, output AND cluster mutation', async () => {
    const restore = muteConsole();
    try {
      const composed = cluster();
      const split = cluster();

      const viaComposition = await contributeFrameworkGraph({
        repoDir,
        graph: graph(),
        cluster: composed,
      });
      const raw = await collectFrameworkContributions({ repoDir, graph: graph() });
      const viaSplit = applyFrameworkContributions({ raw, cluster: split });

      expect(viaSplit.edges).toEqual(viaComposition.edges);
      expect(viaSplit.roles).toEqual(viaComposition.roles);
      expect(viaSplit.subsystems).toEqual(viaComposition.subsystems);
      expect(viaSplit.counts).toEqual(viaComposition.counts);
      // The grouping override MUTATES the cluster — the two runs used separate
      // clusters, so this asserts the mutation is identical, not merely present.
      expect(grouping(split)).toEqual(grouping(composed));
      expect(grouping(split)).toEqual([
        { id: 'm1', packageId: 'fake:feature-x', packageName: 'Feature X', packageRole: undefined },
        { id: 'm2', packageId: 'fake:feature-x', packageName: 'Feature X', packageRole: undefined },
        { id: 'm3', packageId: undefined, packageName: undefined, packageRole: undefined },
      ]);
    } finally {
      restore();
    }
  });

  it('reports the measured counts (the fixture, end to end)', async () => {
    const restore = muteConsole();
    try {
      const raw = await collectFrameworkContributions({ repoDir, graph: graph() });
      const out = applyFrameworkContributions({ raw, cluster: cluster() });
      expect(out.counts).toEqual({
        adapters: 1,
        rawEdges: 4,
        edges: 1,
        droppedSelf: 1,
        droppedUnresolved: 1,
        droppedBadKind: 1,
        roles: 2,
        groups: 2,
        groupedModules: 2,
        droppedGroupUnresolved: 1,
      });
      expect(out.edges).toEqual([{ source: 'm1', target: 'm2', kind: 'calls' }]);
      // Highest priority wins per module (a2.ts's 'navigator' beats a.ts's 'screen').
      expect(out.roles.get('m1')?.role).toBe('navigator');
      expect(out.roles.get('m2')?.role).toBe('route-handler');
    } finally {
      restore();
    }
  });

  // The property CI-mode extraction rests on: the raw value is the wire format,
  // so a JSON round-trip must change nothing. Also catches the cluster phase
  // aliasing into (and so corrupting) the caller's raw arrays — `direct` runs
  // FIRST, so a mutating apply would leave a polluted `raw` for the copy.
  it('survives a JSON round-trip — raw is a wire format, not a live object', async () => {
    const restore = muteConsole();
    try {
      const raw = await collectFrameworkContributions({ repoDir, graph: graph() });
      const direct = applyFrameworkContributions({ raw, cluster: cluster() });
      const wire: RawFrameworkContributions = JSON.parse(JSON.stringify(raw));
      const roundTripped = applyFrameworkContributions({ raw: wire, cluster: cluster() });
      expect(roundTripped.edges).toEqual(direct.edges);
      expect(roundTripped.roles).toEqual(direct.roles);
      expect(roundTripped.subsystems).toEqual(direct.subsystems);
      expect(roundTripped.counts).toEqual(direct.counts);
    } finally {
      restore();
    }
  });

  // parseEdgeKind is the trust boundary and it belongs to the CLUSTER phase: the
  // producer may run on a machine we don't own, so its output is validated on
  // arrival, not on emission.
  it('a forbidden verb survives collection and is rejected on apply', async () => {
    const restore = muteConsole();
    try {
      const raw = await collectFrameworkContributions({ repoDir, graph: graph() });
      // The producer passes it through, unvalidated, naming its author.
      expect(raw.edges).toContainEqual({
        adapter: 'fake',
        source: 'b.ts',
        target: 'c.ts',
        kind: 'imports',
      });
      const out = applyFrameworkContributions({ raw, cluster: cluster() });
      expect(out.counts.droppedBadKind).toBe(1);
      expect(out.edges.some((e) => e.source === 'm2' && e.target === 'm3')).toBe(false);
    } finally {
      restore();
    }
  });

  it('names the rejecting producer in the warning', async () => {
    const warned: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warned.push(a.join(' '));
    });
    try {
      const raw = await collectFrameworkContributions({ repoDir, graph: graph() });
      applyFrameworkContributions({ raw, cluster: cluster() });
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
    expect(warned.some((w) => w.includes("framework adapter 'fake' emitted"))).toBe(true);
  });

  it('drops a self-edge and an unresolved endpoint, through the split path', async () => {
    const restore = muteConsole();
    try {
      const raw = await collectFrameworkContributions({ repoDir, graph: graph() });
      // Both are still present in file-id space — the producer resolves nothing.
      expect(raw.edges.map((e) => `${e.source}→${e.target}`)).toEqual([
        'a.ts→b.ts',
        'a.ts→a2.ts',
        'a.ts→nope.ts',
        'b.ts→c.ts',
      ]);
      const out = applyFrameworkContributions({ raw, cluster: cluster() });
      // a.ts + a2.ts both live in m1 → the edge collapses to m1→m1 and is dropped.
      expect(out.counts.droppedSelf).toBe(1);
      expect(out.edges.some((e) => e.source === e.target)).toBe(false);
      // 'nope.ts' is in no module → the edge is dropped, and so is its role tag.
      expect(out.counts.droppedUnresolved).toBe(1);
      expect(out.counts.roles).toBe(2);
      // A group file that resolves to nothing is counted, never silently ignored.
      expect(out.counts.droppedGroupUnresolved).toBe(1);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// The cluster phase alone, on a hand-built raw value — the shape a runner would
// hand us. No adapters involved.

describe('applyFrameworkContributions — the cluster phase alone', () => {
  beforeEach(() => clearFrameworkAdapters());

  const rawWith = (over: Partial<RawFrameworkContributions>): RawFrameworkContributions => ({
    adapters: 1,
    edges: [],
    crossLanguageEdges: [],
    roles: [],
    groups: [],
    ...over,
  });

  // Order is load-bearing: adapter edges fold FIRST, the cross-language seam
  // LAST, and dedupe is first-wins — so a seam edge can never displace the
  // adapter edge between the same two modules.
  it('the cross-language seam folds AFTER the adapter edges', () => {
    const restore = muteConsole();
    try {
      const out = applyFrameworkContributions({
        raw: rawWith({
          edges: [{ adapter: 'fake', source: 'a.ts', target: 'b.ts', kind: 'calls' }],
          crossLanguageEdges: [
            { adapter: 'cross-language', source: 'a.ts', target: 'b.ts', kind: 'publishes' },
          ],
        }),
        cluster: cluster(),
      });
      expect(out.edges).toEqual([
        { source: 'm1', target: 'm2', kind: 'calls' },
        { source: 'm1', target: 'm2', kind: 'publishes' },
      ]);
    } finally {
      restore();
    }
  });

  it('dedupes identically-keyed edges, first-wins', () => {
    const restore = muteConsole();
    try {
      const out = applyFrameworkContributions({
        raw: rawWith({
          edges: [
            { adapter: 'fake', source: 'a.ts', target: 'b.ts', kind: 'calls' },
            { adapter: 'other', source: 'a2.ts', target: 'b.ts', kind: 'calls' }, // same m1→m2
          ],
        }),
        cluster: cluster(),
      });
      expect(out.counts.rawEdges).toBe(2);
      expect(out.edges).toEqual([{ source: 'm1', target: 'm2', kind: 'calls' }]);
    } finally {
      restore();
    }
  });

  it('a cross-language bad verb blames the seam, not an adapter', () => {
    const warned: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warned.push(a.join(' '));
    });
    try {
      const out = applyFrameworkContributions({
        raw: rawWith({
          crossLanguageEdges: [
            { adapter: 'cross-language', source: 'a.ts', target: 'b.ts', kind: 'uses' },
          ],
        }),
        cluster: cluster(),
      });
      expect(out.counts.droppedBadKind).toBe(1);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
    expect(warned.some((w) => w.includes('cross-language edge emitted'))).toBe(true);
  });

  it('an empty raw value is the untouched-cluster no-op', () => {
    const restore = muteConsole();
    try {
      const c = cluster();
      const out = applyFrameworkContributions({
        raw: { adapters: 0, edges: [], crossLanguageEdges: [], roles: [], groups: [] },
        cluster: c,
      });
      expect(out.counts.adapters).toBe(0);
      expect(out.edges).toEqual([]);
      expect(out.subsystems.size).toBe(0);
      expect(grouping(c)).toEqual([
        { id: 'm1', packageId: undefined, packageName: undefined, packageRole: undefined },
        { id: 'm2', packageId: undefined, packageName: undefined, packageRole: undefined },
        { id: 'm3', packageId: undefined, packageName: undefined, packageRole: undefined },
      ]);
    } finally {
      restore();
    }
  });

  // A detected adapter that contributed nothing is NOT the empty case — it still
  // reports its adapter count (the composed path's `matches.length`).
  it('a detected-but-silent adapter still reports its count', () => {
    const restore = muteConsole();
    try {
      const out = applyFrameworkContributions({ raw: rawWith({}), cluster: cluster() });
      expect(out.counts.adapters).toBe(1);
    } finally {
      restore();
    }
  });
});
