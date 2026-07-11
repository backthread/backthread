// pure merge tests.
//
// The merge logic gates /8/9 + every  expansion adapter; bugs
// here corrupt every snapshot downstream. Tests target the documented
// conflict policy from registry.ts, not implementation detail.

import { describe, it, expect, beforeEach } from '../testkit.js';
import {
  clearInfraAdapters,
  mergeInfraGraphs,
  registerInfraAdapter,
  listInfraAdapters,
  validateMergedGraph,
  activeSourceScanners,
} from './registry.js';
import type { InfraAdapter, InfraGraph, InfraNode } from './types.js';

function node(
  id: string,
  overrides: Partial<InfraNode> = {},
): InfraNode {
  return {
    id,
    label: id,
    kind: 'worker',
    provenance: 'declared',
    ...overrides,
  };
}

function graph(
  adapter: string,
  nodes: InfraNode[],
  rest: Partial<Omit<InfraGraph, 'adapter' | 'nodes' | 'root'>> = {},
): InfraGraph {
  return {
    root: '/repo',
    adapter,
    nodes,
    edges: rest.edges ?? [],
    classificationsNeeded: rest.classificationsNeeded ?? [],
  };
}

describe('mergeInfraGraphs', () => {
  it('namespaces node ids by adapter so common names don’t collide', () => {
    const merged = mergeInfraGraphs(
      [
        graph('cloudflare', [node('main')]),
        graph('supabase', [node('main')]),
      ],
      '/repo',
    );
    expect(merged.nodes.map((n) => n.id).sort()).toEqual([
      'cloudflare:main',
      'supabase:main',
    ]);
  });

  it('throws when an adapter emits the same id twice', () => {
    expect(() =>
      mergeInfraGraphs(
        [graph('cloudflare', [node('main'), node('main')])],
        '/repo',
      ),
    ).toThrow(/duplicate node id/);
  });

  it('resolves provenance conflicts by priority (declared > llm-classified)', () => {
    // Two adapters happen to land on the same namespaced id (`tf:db`) —
    // simulate by giving them the same adapter name on different graphs.
    const merged = mergeInfraGraphs(
      [
        graph('cloudflare', [node('db', { provenance: 'llm-classified', kind: 'queue' })]),
        graph('cloudflare', [node('db', { provenance: 'declared', kind: 'datastore' })]),
      ],
      '/repo',
    );
    const db = merged.nodes.find((n) => n.id === 'cloudflare:db')!;
    expect(db.provenance).toBe('declared');
    expect(db.kind).toBe('datastore');
  });

  it('resolves provenance ties by adapter registration order (first wins)', () => {
    // Same adapter name on both — collision after namespacing. First in the
    // array represents the higher-priority adapter.
    const merged = mergeInfraGraphs(
      [
        graph('cloudflare', [node('worker', { provenance: 'declared', kind: 'worker' })]),
        graph('cloudflare', [node('worker', { provenance: 'declared', kind: 'queue' })]),
      ],
      '/repo',
    );
    const w = merged.nodes.find((n) => n.id === 'cloudflare:worker')!;
    expect(w.kind).toBe('worker'); // earlier graph wins
  });

  it('dedupes edges on (source, target, kind)', () => {
    const merged = mergeInfraGraphs(
      [
        graph('cloudflare', [node('a'), node('b')], {
          edges: [
            { source: 'a', target: 'b', kind: 'writes' },
            { source: 'a', target: 'b', kind: 'writes' }, // dupe
            { source: 'a', target: 'b', kind: 'reads' }, // distinct kind
          ],
        }),
      ],
      '/repo',
    );
    expect(merged.edges.length).toBe(2);
    expect(merged.edges.map((e) => e.kind).sort()).toEqual(['reads', 'writes']);
  });

  it('namespaces edge endpoints when they reference adapter-local nodes', () => {
    const merged = mergeInfraGraphs(
      [
        graph('cloudflare', [node('worker'), node('queue')], {
          edges: [{ source: 'worker', target: 'queue', kind: 'publishes' }],
        }),
      ],
      '/repo',
    );
    expect(merged.edges[0]).toMatchObject({
      source: 'cloudflare:worker',
      target: 'cloudflare:queue',
      kind: 'publishes',
    });
  });

  it('leaves edge endpoints untouched when they don’t match a local node id (cross-graph bind)', () => {
    const merged = mergeInfraGraphs(
      [
        graph('cloudflare', [node('worker')], {
          edges: [{ source: 'worker', target: 'auth-module', kind: 'calls' }],
        }),
      ],
      '/repo',
    );
    expect(merged.edges[0]).toMatchObject({
      source: 'cloudflare:worker',
      target: 'auth-module', // left as-is — cross-graph join binds later
    });
  });

  it('dedupes classification refs and namespaces forNodeId', () => {
    const merged = mergeInfraGraphs(
      [
        graph('terraform', [node('db_1')], {
          classificationsNeeded: [
            { provider: 'terraform/aws', resourceType: 'aws_rds_cluster', forNodeId: 'db_1' },
            { provider: 'terraform/aws', resourceType: 'aws_rds_cluster', forNodeId: 'db_1' }, // dupe
          ],
        }),
      ],
      '/repo',
    );
    expect(merged.classificationsNeeded).toEqual([
      {
        provider: 'terraform/aws',
        resourceType: 'aws_rds_cluster',
        forNodeId: 'terraform:db_1',
      },
    ]);
  });
});

describe('validateMergedGraph', () => {
  it('reports nothing when every endpoint resolves to a merged node', () => {
    const merged = mergeInfraGraphs(
      [
        graph('cloudflare', [node('worker'), node('queue')], {
          edges: [{ source: 'worker', target: 'queue', kind: 'publishes' }],
        }),
      ],
      '/repo',
    );
    expect(validateMergedGraph(merged)).toEqual([]);
  });

  it('flags an edge whose endpoint resolves to neither a node nor a known id', () => {
    // A typo'd cross-graph ref: merge leaves it untouched, the gate catches it.
    const merged = mergeInfraGraphs(
      [
        graph('cloudflare', [node('worker')], {
          edges: [{ source: 'worker', target: 'typoed-module', kind: 'calls' }],
        }),
      ],
      '/repo',
    );
    expect(validateMergedGraph(merged)).toHaveLength(1);
    expect(validateMergedGraph(merged)[0]).toMatchObject({ target: 'typoed-module' });
  });

  it('treats knownIds (e.g. post-join code modules) as resolvable', () => {
    const merged = mergeInfraGraphs(
      [
        graph('cloudflare', [node('worker')], {
          edges: [{ source: 'worker', target: 'auth-module', kind: 'calls' }],
        }),
      ],
      '/repo',
    );
    expect(validateMergedGraph(merged)).toHaveLength(1); // unresolved on its own
    expect(validateMergedGraph(merged, new Set(['auth-module']))).toEqual([]); // bound by join
  });
});

describe('adapter registry', () => {
  beforeEach(() => clearInfraAdapters());

  it('preserves registration order', () => {
    const a: InfraAdapter = { name: 'a', detect: async () => false, extract: async () => graph('a', []) };
    const b: InfraAdapter = { name: 'b', detect: async () => false, extract: async () => graph('b', []) };
    registerInfraAdapter(a);
    registerInfraAdapter(b);
    expect(listInfraAdapters().map((a) => a.name)).toEqual(['a', 'b']);
  });

  it('replaces by name on re-registration (mock-swap pattern)', () => {
    const v1: InfraAdapter = { name: 'cf', detect: async () => true, extract: async () => graph('cf', [node('v1')]) };
    const v2: InfraAdapter = { name: 'cf', detect: async () => true, extract: async () => graph('cf', [node('v2')]) };
    registerInfraAdapter(v1);
    registerInfraAdapter(v2);
    expect(listInfraAdapters()).toHaveLength(1);
    expect(listInfraAdapters()[0]).toBe(v2);
  });
});

// the carry/re-extract gate consults the ACTIVE source-grep adapters'
// predicates. Returns one predicate per adapter that (a) declares scansSourcePath
// AND (b) detect()-positive — config-only adapters and inactive scanners drop.
describe('activeSourceScanners', () => {
  beforeEach(() => clearInfraAdapters());

  const configOnly: InfraAdapter = {
    name: 'config-only',
    detect: async () => true, // active, but reads only config → not a source scanner
    extract: async () => graph('config-only', []),
  };
  const activeScanner: InfraAdapter = {
    name: 'active-scanner',
    detect: async () => true,
    extract: async () => graph('active-scanner', []),
    scansSourcePath: (p) => p.endsWith('.ts'),
  };
  const inactiveScanner: InfraAdapter = {
    name: 'inactive-scanner',
    detect: async () => false, // declares a predicate but isn't present in this repo
    extract: async () => graph('inactive-scanner', []),
    scansSourcePath: () => true,
  };

  it('returns only the predicates of ACTIVE source-scanning adapters', async () => {
    registerInfraAdapter(configOnly);
    registerInfraAdapter(activeScanner);
    registerInfraAdapter(inactiveScanner);
    const scanners = await activeSourceScanners('/repo');
    // config-only (no predicate) and inactive (detect=false) both drop.
    expect(scanners).toHaveLength(1);
    expect(scanners[0]('src/a.ts')).toBe(true);
    expect(scanners[0]('src/a.md')).toBe(false);
  });

  it('returns [] when no source-scanning adapter is active (config-only stack keeps carry)', async () => {
    registerInfraAdapter(configOnly);
    registerInfraAdapter(inactiveScanner);
    expect(await activeSourceScanners('/repo')).toEqual([]);
  });
});
