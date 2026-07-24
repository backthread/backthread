// End-to-end proof of the JVM grouping fix at the clustering seam:
// a Java-shaped repo (`src/main/java/<reverse-dns>/<feature>/…`) must produce
// FEATURE module ids + feature subsystem boxes, and a repo with no grouping paths
// (every other language) must be byte-identical to before.

import { describe, it, expect } from '../testkit.js';
import { clusterGraph } from './louvain.js';
import { computeSubsystems } from './subsystem.js';
import type { NormalizedGraph } from '../graph/types.js';
import type { WorkspaceLayout, WorkspacePackage } from './workspaces.js';
import { evaluateGroupingGate } from './grouping-gate.js';

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

describe('JVM namespace grouping', () => {
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
    expect(partition.get('slack')!.id).toBe('ns:adapter');
    expect(partition.get('database')!.id).toBe('ns:adapter');
    expect(partition.get('alert')!.id).toBe('ns:domain');
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
  it('lets a stray outlier package root strip only its OWN bucket', () => {
    // REVIEWER (PR #145): a repo-wide common prefix meant ONE generated/vendored
    // file under a different reverse-DNS root emptied the prefix, so nothing
    // stripped and every box collapsed onto `Com`/`Org` — the same mega-box this
    // fixes, and a stability break (adding that one file renames every box).
    const files: Array<[string, string?]> = [
      ['src/main/java/com/acme/orders/OrderApi.java', 'com/acme/orders'],
      ['src/main/java/com/acme/orders/OrderDto.java', 'com/acme/orders'],
      ['src/main/java/com/acme/billing/Invoice.java', 'com/acme/billing'],
      ['src/main/java/com/acme/billing/Tax.java', 'com/acme/billing'],
      ['src/gen/java/org/other/gen/Proto.java', 'org/other/gen'],
      ['src/gen/java/org/other/gen/Stub.java', 'org/other/gen'],
    ];
    const { modules } = clusterGraph(
      graphOf(files, [
        ['src/main/java/com/acme/orders/OrderApi.java', 'src/main/java/com/acme/orders/OrderDto.java'],
        ['src/main/java/com/acme/billing/Invoice.java', 'src/main/java/com/acme/billing/Tax.java'],
        ['src/gen/java/org/other/gen/Proto.java', 'src/gen/java/org/other/gen/Stub.java'],
      ]),
    );
    const ids = modules.filter((m) => m.kind === 'internal').map((m) => m.id).sort();
    expect(ids).toEqual(['billing', 'gen', 'orders']);
    const boxes = [...new Set([...computeSubsystems(modules).values()].map((s) => s.id))].sort();
    expect(boxes).toEqual(['ns:billing', 'ns:gen', 'ns:orders']);
    expect(boxes).not.toContain('dir:com');
    expect(boxes).not.toContain('dir:org');
  });

  it('keeps the physical derivation when namespaced files are a MINORITY', () => {
    // REVIEWER (PR #145): mergeGraphs concatenates a polyglot repo's languages into
    // one graph, so a community can be 5 TS files plus one generated .java. Deriving
    // from "any namespaced file" named the whole module after the lone Java file.
    const files: Array<[string, string?]> = [
      ['src/web/a.ts'],
      ['src/web/b.ts'],
      ['src/web/c.ts'],
      ['src/web/gen/Client.java', 'com/acme/tooling/gen'],
      ['src/api/x.ts'],
      ['src/api/y.ts'],
      ['src/api/z.java', 'com/acme/tooling/api'],
    ];
    const { modules } = clusterGraph(
      graphOf(files, [
        ['src/web/a.ts', 'src/web/b.ts'],
        ['src/web/b.ts', 'src/web/c.ts'],
        ['src/web/c.ts', 'src/web/gen/Client.java'],
        ['src/api/x.ts', 'src/api/y.ts'],
        ['src/api/y.ts', 'src/api/z.java'],
      ]),
    );
    const ids = modules.filter((m) => m.kind === 'internal').map((m) => m.id).sort();
    // Both communities are TS-majority ⇒ physical names, not `gen`/`api` packages.
    expect(ids).toEqual(['api', 'web']);
    expect(ids).not.toContain('gen');
  });

  it('does not let a JVM repo trip the gate on its build source root', () => {
    // Post-fix the boxes are real packages, so the gate must measure THOSE. Measuring
    // paths would report one 100% god-bucket named `main` for every JVM repo.
    const P = 'src/main/java/com/acme/app';
    const files: Array<[string, string?]> = ['orders', 'billing', 'catalog', 'shipping'].flatMap(
      (pkg) =>
        ['A', 'B', 'C'].map(
          (n) => [`${P}/${pkg}/${n}.java`, `com/acme/app/${pkg}`] as [string, string],
        ),
    );
    const edges: Array<[string, string]> = ['orders', 'billing', 'catalog', 'shipping'].map((p) => [
      `${P}/${p}/A.java`,
      `${P}/${p}/B.java`,
    ]);
    const { modules } = clusterGraph(graphOf(files, edges));
    const partition = computeSubsystems(modules);
    const internal = modules.filter((m) => m.kind === 'internal');
    const gate = evaluateGroupingGate(
      internal.map((m) => ({ id: m.id, fileIds: m.fileIds, subsystemId: partition.get(m.id)?.id })),
    );
    expect(gate.godBucketRatio).toBeLessThan(1);
    // …and the same modules WITHOUT ids fall back to paths: one `main` mega-box.
    const byPath = evaluateGroupingGate(internal.map((m) => ({ id: m.id, fileIds: m.fileIds })));
    expect(byPath.godBucketRatio).toBe(1);
    expect(byPath.trips).toBe(true);
  });
});
