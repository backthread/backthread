// ARP-1423 — end-to-end proof of the JVM grouping fix at the clustering seam:
// a Java-shaped repo (`src/main/java/<reverse-dns>/<feature>/…`) must produce
// FEATURE module ids + feature subsystem boxes, and a repo with no grouping paths
// (every other language) must be byte-identical to before.

import { describe, it, expect } from '../testkit.js';
import { clusterGraph } from './louvain.js';
import { computeSubsystems } from './subsystem.js';
import type { NormalizedGraph } from '../graph/types.js';
import type { WorkspaceLayout, WorkspacePackage } from './workspaces.js';

/**
 * A graph whose files carry both a physical path and (optionally) a namespace.
 * `[physicalPath, packageDirs]` — omit the second to model a non-JVM file.
 */
function graphOf(
  files: Array<[string, string?]>,
  edges: Array<[string, string]> = [],
): NormalizedGraph {
  return {
    root: '/tmp/fixture',
    files: files.map(([id, groupingPath]) => ({
      id,
      loc: 10,
      language: 'java',
      ...(groupingPath !== undefined ? { groupingPath } : {}),
    })),
    edges: edges.map(([from, to]) => ({
      from,
      to,
      kind: 'import' as const,
      external: false,
      weight: 1,
    })),
    externals: [],
  };
}

/** The Maven Standard Directory Layout the bug lived under. */
const JVM_FILES: Array<[string, string?]> = [
  ['src/main/java/ai/luun/inv/adapter/slack/SlackClient.java', 'ai/luun/inv/adapter/slack'],
  ['src/main/java/ai/luun/inv/adapter/slack/SlackMessage.java', 'ai/luun/inv/adapter/slack'],
  ['src/main/java/ai/luun/inv/adapter/database/CustomerEntity.java', 'ai/luun/inv/adapter/database'],
  ['src/main/java/ai/luun/inv/adapter/database/CustomerRepo.java', 'ai/luun/inv/adapter/database'],
  ['src/main/java/ai/luun/inv/domain/alert/Alert.java', 'ai/luun/inv/domain/alert'],
  ['src/main/java/ai/luun/inv/domain/alert/AlertRule.java', 'ai/luun/inv/domain/alert'],
];

// Edges only WITHIN each feature, so Louvain yields one community per feature and
// the assertions are about naming, not about community detection.
const JVM_EDGES: Array<[string, string]> = [
  [
    'src/main/java/ai/luun/inv/adapter/slack/SlackClient.java',
    'src/main/java/ai/luun/inv/adapter/slack/SlackMessage.java',
  ],
  [
    'src/main/java/ai/luun/inv/adapter/database/CustomerEntity.java',
    'src/main/java/ai/luun/inv/adapter/database/CustomerRepo.java',
  ],
  [
    'src/main/java/ai/luun/inv/domain/alert/Alert.java',
    'src/main/java/ai/luun/inv/domain/alert/AlertRule.java',
  ],
];

function layoutOf(
  pkgs: Array<Partial<WorkspacePackage> & { root: string; slug: string }>,
): WorkspaceLayout {
  const packages: WorkspacePackage[] = pkgs.map((p) => ({
    name: null,
    entryFileIds: [],
    role: 'app',
    declaredDeps: [],
    ...p,
  })) as WorkspacePackage[];
  const byRoot = new Map(packages.map((p) => [p.root, p]));
  const root = byRoot.get('') ?? packages[packages.length - 1];
  return {
    packages,
    packageOf: (fileId: string) => {
      let best = root;
      for (const p of packages) {
        if (p.root !== '' && fileId.startsWith(`${p.root}/`) && p.root.length > best.root.length) {
          best = p;
        }
      }
      return best;
    },
    nameToPackage: new Map(),
  };
}

describe('JVM namespace grouping (ARP-1423)', () => {
  it('names modules after the FEATURE package, never the build source root', () => {
    const { modules } = clusterGraph(graphOf(JVM_FILES, JVM_EDGES));
    const ids = modules.filter((m) => m.kind === 'internal').map((m) => m.id).sort();
    expect(ids).toEqual(['alert', 'database', 'slack']);
    // The regression this fixes: every id used to collapse onto `main`/`main-N`.
    expect(ids.some((id) => /^main(-\d+)*$/.test(id))).toBe(false);
  });

  it('groups subsystems by the top-level package, not "Main"', () => {
    const { modules } = clusterGraph(graphOf(JVM_FILES, JVM_EDGES));
    const partition = computeSubsystems(modules);
    const boxes = [...new Set([...partition.values()].map((s) => s.name))].sort();
    expect(boxes).toEqual(['Adapter', 'Domain']);
    expect(partition.get('slack')!.id).toBe('dir:adapter');
    expect(partition.get('database')!.id).toBe('dir:adapter');
    expect(partition.get('alert')!.id).toBe('dir:domain');
  });

  it('is deterministic across a re-run and across input order', () => {
    const a = clusterGraph(graphOf(JVM_FILES, JVM_EDGES));
    const b = clusterGraph(graphOf(JVM_FILES, JVM_EDGES));
    const c = clusterGraph(graphOf([...JVM_FILES].reverse(), JVM_EDGES));
    const idsOf = (r: typeof a): string[] =>
      r.modules.filter((m) => m.kind === 'internal').map((m) => m.id).sort();
    expect(idsOf(b)).toEqual(idsOf(a));
    expect(idsOf(c)).toEqual(idsOf(a));
  });

  it('survives a module-id stabilization round-trip (the time-slider join key)', () => {
    const first = clusterGraph(graphOf(JVM_FILES, JVM_EDGES));
    const second = clusterGraph(graphOf(JVM_FILES, JVM_EDGES), undefined, {
      priorModules: first.modules,
    });
    expect(second.modules.map((m) => m.id).sort()).toEqual(first.modules.map((m) => m.id).sort());
    expect(second.fileModuleMap).toEqual(first.fileModuleMap);
  });

  it('falls back to the physical path when every file shares ONE package', () => {
    // Nothing survives the common-prefix strip, so there is no namespace signal —
    // the module must keep its pre-existing path-derived id rather than become ''.
    const files: Array<[string, string?]> = [
      ['src/main/java/com/acme/app/A.java', 'com/acme/app'],
      ['src/main/java/com/acme/app/B.java', 'com/acme/app'],
    ];
    const { modules } = clusterGraph(
      graphOf(files, [['src/main/java/com/acme/app/A.java', 'src/main/java/com/acme/app/B.java']]),
    );
    expect(modules.filter((m) => m.kind === 'internal').map((m) => m.id)).toEqual(['main']);
  });

  it('strips each Gradle module\'s OWN prefix under a multi-package layout', () => {
    // Two modules under DIFFERENT org prefixes share no global prefix; scoping the
    // strip per package is what keeps both readable.
    const files: Array<[string, string?]> = [
      ['orders/src/main/java/com/acme/orders/api/OrderApi.java', 'com/acme/orders/api'],
      ['orders/src/main/java/com/acme/orders/api/OrderDto.java', 'com/acme/orders/api'],
      ['orders/src/main/java/com/acme/orders/store/OrderStore.java', 'com/acme/orders/store'],
      ['billing/src/main/kotlin/io/other/billing/tax/TaxRules.kt', 'io/other/billing/tax'],
      ['billing/src/main/kotlin/io/other/billing/tax/TaxTable.kt', 'io/other/billing/tax'],
    ];
    const layout = layoutOf([
      { root: '', slug: 'root' },
      { root: 'orders', slug: 'orders' },
      { root: 'billing', slug: 'billing' },
    ]);
    const { modules } = clusterGraph(
      graphOf(files, [
        [
          'orders/src/main/java/com/acme/orders/api/OrderApi.java',
          'orders/src/main/java/com/acme/orders/api/OrderDto.java',
        ],
        [
          'billing/src/main/kotlin/io/other/billing/tax/TaxRules.kt',
          'billing/src/main/kotlin/io/other/billing/tax/TaxTable.kt',
        ],
      ]),
      undefined,
      { layout },
    );
    const ids = modules.filter((m) => m.kind === 'internal').map((m) => m.id).sort();
    // `billing` is one community ⇒ it takes the bare package slug (pre-existing
    // rule); `orders` splits, so its communities get feature-suffixed ids.
    expect(ids).toEqual(['billing', 'orders-api', 'orders-store']);
  });

  it('leaves a repo with NO grouping paths byte-identical', () => {
    const plain: Array<[string, string?]> = [
      ['src/auth/login.ts'],
      ['src/auth/session.ts'],
      ['src/billing/invoice.ts'],
      ['src/billing/plan.ts'],
    ];
    const { modules } = clusterGraph(
      graphOf(plain, [
        ['src/auth/login.ts', 'src/auth/session.ts'],
        ['src/billing/invoice.ts', 'src/billing/plan.ts'],
      ]),
    );
    expect(modules.map((m) => m.id).sort()).toEqual(['auth', 'billing']);
    expect(modules.every((m) => m.groupingDir === undefined)).toBe(true);
    const partition = computeSubsystems(modules);
    expect([...new Set([...partition.values()].map((s) => s.id))].sort()).toEqual([
      'dir:auth',
      'dir:billing',
    ]);
  });

  it('ignores a default-package file instead of letting it veto the strip', () => {
    const files: Array<[string, string?]> = [
      ['src/main/java/Bootstrap.java', ''],
      ['src/main/java/com/acme/orders/OrderApi.java', 'com/acme/orders'],
      ['src/main/java/com/acme/orders/OrderDto.java', 'com/acme/orders'],
      ['src/main/java/com/acme/billing/Invoice.java', 'com/acme/billing'],
    ];
    const { modules } = clusterGraph(
      graphOf(files, [
        [
          'src/main/java/com/acme/orders/OrderApi.java',
          'src/main/java/com/acme/orders/OrderDto.java',
        ],
      ]),
    );
    const ids = modules.filter((m) => m.kind === 'internal').map((m) => m.id).sort();
    expect(ids).toContain('orders');
    expect(ids).toContain('billing');
  });
});
