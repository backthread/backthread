// the deterministic subsystem partition. Pure: builds ClusteredModule
// lists by hand and asserts the path-derived id, humanized naming, totality
// (every module → exactly one), stability, and the flat-repo Louvain-refine
// fallback. No DB / LLM — subsystem only imports cluster types + slugify.

import { test, expect } from '../testkit.js';
import {
  computeSubsystems,
  distinctSubsystems,
  humanizeDir,
  bareSubsystemSlug,
  EXTERNAL_SUBSYSTEM_ID,
  DIR_SUBSYSTEM_PREFIX,
  PKG_SUBSYSTEM_PREFIX,
  DOMAIN_SUBSYSTEM_PREFIX,
  RESERVED_SUBSYSTEM_PREFIXES,
  type Subsystem,
} from './subsystem.js';
import type { ClusteredModule } from './louvain.js';

function mod(id: string, fileIds: string[], over: Partial<ClusteredModule> = {}): ClusteredModule {
  return {
    id,
    kind: 'internal',
    fileIds,
    fileCount: fileIds.length,
    loc: fileIds.length * 10,
    degree: 0,
    godNode: false,
    ...over,
  };
}
function ext(id: string, specifier: string): ClusteredModule {
  return { id, kind: 'external', fileIds: [], externalSpecifier: specifier, fileCount: 0, loc: 0, degree: 0, godNode: false };
}

// --- path-derived id + humanized naming -------------------------------------

test('subsystem id is the slugified top-level directory; name is humanized', () => {
  const modules = [
    mod('login', ['src/auth/login.ts', 'src/auth/session.ts']),
    mod('checkout', ['src/billing/checkout.ts']),
  ];
  const p = computeSubsystems(modules);
  // the id is the `dir:`-namespaced slug (so it can never equal a module
  // id); the humanized NAME is unchanged.
  expect(p.get('login')).toEqual({ id: 'dir:auth', name: 'Auth' });
  expect(p.get('checkout')).toEqual({ id: 'dir:billing', name: 'Billing' });
});

test('top-level dir is taken one level UP — files under the same top dir share a subsystem', () => {
  // Two DIFFERENT modules (different Louvain clusters) under the same top-level
  // `auth/` directory must land in ONE subsystem (the neighbourhood). A SECOND
  // top-level dir (`billing/`) keeps the repo non-flat so the directory grouping
  // (not the per-module refine) is what's exercised.
  const modules = [
    mod('login', ['src/auth/login.ts']),
    mod('session', ['src/auth/session.ts']),
    mod('checkout', ['src/billing/checkout.ts']),
  ];
  const p = computeSubsystems(modules);
  expect(p.get('login')!.id).toBe('dir:auth');
  expect(p.get('session')!.id).toBe('dir:auth');
  expect(p.get('login')!.id).toBe(p.get('session')!.id);
  expect(p.get('checkout')!.id).toBe('dir:billing');
});

test('leading src/ is stripped so src/auth and auth group together', () => {
  // A second top-level dir (`web/`) keeps the repo non-flat so the dir grouping
  // is exercised (not the flat-refine).
  const modules = [mod('a', ['src/auth/x.ts']), mod('b', ['auth/y.ts']), mod('c', ['web/page.ts'])];
  const p = computeSubsystems(modules);
  expect(p.get('a')!.id).toBe('dir:auth');
  expect(p.get('b')!.id).toBe('dir:auth');
  expect(p.get('c')!.id).toBe('dir:web');
});

test('dominant top-level dir wins when a module straddles directories', () => {
  // 3 files under api/, 1 under shared/ → the module belongs to `api`.
  const modules = [
    mod('m', ['src/api/a.ts', 'src/api/b.ts', 'src/api/c.ts', 'src/shared/d.ts']),
    mod('other', ['src/web/page.ts']),
  ];
  const p = computeSubsystems(modules);
  expect(p.get('m')!.id).toBe('dir:api');
});

test('humanizeDir expands conventional names + title-cases the rest', () => {
  expect(humanizeDir('auth')).toBe('Auth');
  expect(humanizeDir('ingest')).toBe('Ingestion');
  expect(humanizeDir('api')).toBe('API');
  expect(humanizeDir('user-profile')).toBe('User Profile');
  expect(humanizeDir('paymentGateway')).toBe('Payment Gateway');
});

test('short ordinary dir names are Title-cased, NOT blanket upper-cased', () => {
  // review nit: a "≤3 chars ⇒ UPPER" rule produced ugly user-facing
  // names (web→WEB, app→APP, log→LOG, bin→BIN). On the deterministic path the
  // Flash-Lite fallback never corrects these, so the casing must be right here.
  expect(humanizeDir('web')).toBe('Web');
  expect(humanizeDir('app')).toBe('App');
  expect(humanizeDir('log')).toBe('Log');
  expect(humanizeDir('bin')).toBe('Bin');
});

test('known acronyms stay upper (allow-list, not length)', () => {
  expect(humanizeDir('api')).toBe('API');
  expect(humanizeDir('db')).toBe('Database'); // full-segment override wins
  expect(humanizeDir('ui')).toBe('UI');
  expect(humanizeDir('cli')).toBe('CLI');
  // as a WORD inside a multi-word segment, the acronym still upper-cases
  expect(humanizeDir('payment-api')).toBe('Payment API');
  expect(humanizeDir('user-db')).toBe('User DB');
  // a non-acronym short word next to one stays Title-cased
  expect(humanizeDir('web-api')).toBe('Web API');
});

// --- totality: every module gets exactly one --------------------------------

test('every module is assigned exactly one subsystem (complete partition)', () => {
  const modules = [
    mod('login', ['src/auth/login.ts']),
    mod('checkout', ['src/billing/checkout.ts']),
    ext('ext:stripe', 'stripe'),
  ];
  const p = computeSubsystems(modules);
  for (const m of modules) {
    const s = p.get(m.id);
    expect(s).toBeDefined();
    expect(typeof s!.id).toBe('string');
    expect(s!.id.length).toBeGreaterThan(0);
  }
  expect(p.size).toBe(modules.length);
});

test('external + namespaced (infra) modules land in the fixed external subsystem', () => {
  const modules = [
    mod('login', ['src/auth/login.ts']),
    mod('checkout', ['src/billing/checkout.ts']), // 2nd dir → non-flat
    ext('ext:stripe', 'stripe'),
    // an infra node passed as a (namespaced) cluster module — defensive
    mod('cloudflare:worker:ingest', [], { kind: 'internal' }),
  ];
  const p = computeSubsystems(modules);
  expect(p.get('ext:stripe')!.id).toBe(EXTERNAL_SUBSYSTEM_ID);
  expect(p.get('cloudflare:worker:ingest')!.id).toBe(EXTERNAL_SUBSYSTEM_ID);
  expect(p.get('login')!.id).toBe('dir:auth');
  expect(p.get('checkout')!.id).toBe('dir:billing');
});

// --- stability across snapshots ---------------------------------------------

test('subsystem id is stable across snapshots (path-derived, not a Louvain index)', () => {
  // The SAME module-set at two snapshots, but the SECOND adds a new module and
  // re-orders the list (as a re-cluster would). The path-derived ids must NOT
  // reshuffle — `auth` stays `auth` regardless of position.
  const snap1 = [mod('login', ['src/auth/login.ts']), mod('pay', ['src/billing/pay.ts'])];
  const snap2 = [mod('pay', ['src/billing/pay.ts']), mod('refund', ['src/billing/refund.ts']), mod('login', ['src/auth/login.ts'])];
  const p1 = computeSubsystems(snap1);
  const p2 = computeSubsystems(snap2);
  expect(p1.get('login')!.id).toBe('dir:auth');
  expect(p2.get('login')!.id).toBe('dir:auth');
  expect(p1.get('pay')!.id).toBe('dir:billing');
  expect(p2.get('pay')!.id).toBe('dir:billing');
  expect(p2.get('refund')!.id).toBe('dir:billing');
});

// --- flat-repo Louvain-refine fallback --------------------------------------

test('flat repo (single top-level dir) refines to per-module subsystems', () => {
  // Every module under ONE top dir `src/` collapsing to root → the directory
  // heuristic yields ≤1 subsystem, useless as a single super-node. The fallback
  // gives each module its OWN subsystem keyed by the (stable, Louvain-derived)
  // module id.
  const modules = [
    mod('parser', ['index.ts', 'parser.ts']),
    mod('runtime', ['runtime.ts']),
    mod('emit', ['emit.ts']),
  ];
  const p = computeSubsystems(modules);
  // Distinct subsystems, one per module — NOT all collapsed into one. the
  // refinement id is `dir:<moduleId>`, so it can't equal the module's own node id.
  expect(p.get('parser')!.id).toBe('dir:parser');
  expect(p.get('runtime')!.id).toBe('dir:runtime');
  expect(p.get('emit')!.id).toBe('dir:emit');
  expect(new Set([...p.values()].map((s) => s.id)).size).toBe(3);
});

test('root-level modules in an otherwise structured repo still get exactly one subsystem', () => {
  // Mixed: most modules under real dirs (so NOT flat), but one module is all
  // root files. It must still land in exactly one subsystem (its own id) rather
  // than be dropped from the partition.
  const modules = [
    mod('auth', ['src/auth/a.ts']),
    mod('billing', ['src/billing/b.ts']),
    mod('root', ['README.md', 'index.ts']),
  ];
  const p = computeSubsystems(modules);
  expect(p.get('auth')!.id).toBe('dir:auth');
  expect(p.get('billing')!.id).toBe('dir:billing');
  // Not flat (auth + billing are distinct), so `root` keeps its own (namespaced)
  // id rather than being forced into a single super-node.
  const rootSub = p.get('root');
  expect(rootSub).toBeDefined();
  expect(rootSub!.id).toBe('dir:root');
});

// --: one subsystem box per workspace package -----------------------

test('package modules collapse to ONE subsystem per package, labeled by role', () => {
  // Two DIFFERENT modules in the same `web` package must land in ONE subsystem
  // (the package box) — a shared lib is not shredded into the app importing it.
  const modules = [
    mod('web', ['apps/web/src/index.ts'], { packageId: 'web', packageName: '@m/web', packageRole: 'app' }),
    mod('web-admin', ['apps/web/src/admin.ts'], { packageId: 'web', packageName: '@m/web', packageRole: 'app' }),
    mod('ui', ['packages/ui/src/index.ts'], { packageId: 'ui', packageName: '@m/ui', packageRole: 'lib' }),
    mod('worker', ['worker/index.ts'], { packageId: 'worker', packageName: null, packageRole: 'app' }), // unnamed → slug name
    ext('ext:react', 'react'),
  ];
  const p = computeSubsystems(modules);
  // a workspace-package box id is `pkg:<slug>` (so a single-module
  // package's entry module can't collide with its box); the name/role are unchanged.
  expect(p.get('web')).toEqual({ id: 'pkg:web', name: 'Web', role: 'app' });
  expect(p.get('web-admin')).toEqual({ id: 'pkg:web', name: 'Web', role: 'app' });
  expect(p.get('web')!.id).toBe(p.get('web-admin')!.id); // ONE box, not two
  expect(p.get('ui')).toEqual({ id: 'pkg:ui', name: 'UI', role: 'lib' }); // acronym preserved
  expect(p.get('worker')).toEqual({ id: 'pkg:worker', name: 'Worker', role: 'app' }); // name from slug
  expect(p.get('ext:react')!.id).toBe(EXTERNAL_SUBSYSTEM_ID);
  // Three distinct package boxes (+ external), regardless of within-package modules.
  expect(distinctSubsystems(p).map((s) => s.id)).toEqual(['external', 'pkg:ui', 'pkg:web', 'pkg:worker']);
});

// --- distinctSubsystems helper ----------------------------------------------

test('distinctSubsystems dedupes by id and sorts deterministically', () => {
  const modules = [
    mod('a', ['src/auth/a.ts']),
    mod('b', ['src/auth/b.ts']),
    mod('c', ['src/billing/c.ts']),
  ];
  const p = computeSubsystems(modules);
  const distinct = distinctSubsystems(p);
  expect(distinct.map((s) => s.id)).toEqual(['dir:auth', 'dir:billing']);
});

// --: subsystem ids are namespaced + disjoint from module ids ---------
// React Flow keys both module nodes and subsystem super-nodes by id; a subsystem
// id that equals a module id corrupts its node store (the  camera bug). So
// EVERY subsystem id must be disjoint from EVERY module id.

test('a directory named the same as a module no longer collides', () => {
  // The reported case: a `components/` (and `e2e/`) directory whose dominant module
  // is ALSO id `components` (`e2e`). Pre-fix the directory box id == the module id
  // → a duplicate React Flow key. Post-fix the box is `dir:components`, disjoint.
  const modules = [
    mod('components', ['components/Button.tsx', 'components/Modal.tsx']),
    mod('e2e', ['e2e/login.spec.ts']),
  ];
  const p = computeSubsystems(modules);
  expect(p.get('components')!.id).toBe('dir:components');
  expect(p.get('e2e')!.id).toBe('dir:e2e');
  // The id changed; the human label is still the directory name.
  expect(p.get('components')!.name).toBe('Components');
  // No subsystem id equals any module id.
  for (const m of modules) expect(p.get(m.id)!.id).not.toBe(m.id);
});

test('every subsystem id is disjoint from every module id (dir + flat + package + external)', () => {
  const modules = [
    // directory-grouped (two top-level dirs → non-flat)
    mod('auth', ['src/auth/a.ts']),
    mod('billing', ['src/billing/b.ts']),
    // workspace package whose single module shares the package slug (the collision)
    mod('web', ['apps/web/src/index.ts'], { packageId: 'web', packageName: '@m/web', packageRole: 'app' }),
    // external + infra → the fixed `external` sentinel
    ext('ext:stripe', 'stripe'),
    mod('cloudflare:worker:ingest', [], { kind: 'internal' }),
  ];
  const p = computeSubsystems(modules);
  const moduleIds = new Set(modules.map((m) => m.id));
  for (const m of modules) {
    const subId = p.get(m.id)!.id;
    // Every subsystem id is either reserved-namespaced or the `external` sentinel.
    const namespaced =
      subId.startsWith(DIR_SUBSYSTEM_PREFIX) ||
      subId.startsWith(PKG_SUBSYSTEM_PREFIX) ||
      subId === EXTERNAL_SUBSYSTEM_ID;
    expect(namespaced).toBe(true);
    // And it never equals ANY module id in the snapshot.
    expect(moduleIds.has(subId)).toBe(false);
  }
});

test('framework-namespaced package ids are NOT double-prefixed', () => {
  // A framework adapter rides packageId with an already-namespaced id;
  // packageSubsystem must keep it verbatim, never `pkg:nest:auth`.
  const modules = [
    mod('a', ['controllers/users.controller.ts'], { packageId: 'nest:users', packageName: 'UsersModule' }),
  ];
  const p = computeSubsystems(modules);
  expect(p.get('a')!.id).toBe('nest:users');
});

test('bareSubsystemSlug strips reserved prefixes, leaves framework/external', () => {
  expect(bareSubsystemSlug('dir:auth')).toBe('auth');
  expect(bareSubsystemSlug('dir:module-2')).toBe('module-2');
  expect(bareSubsystemSlug('pkg:web')).toBe('web');
  expect(bareSubsystemSlug('domain:billing-money')).toBe('billing-money'); // domain-pass id
  expect(bareSubsystemSlug('nest:auth')).toBe('nest:auth'); // framework id untouched
  expect(bareSubsystemSlug('external')).toBe('external'); // sentinel untouched
});

test('domain: is a RESERVED (non-framework) subsystem namespace', () => {
  // The LLM domain-pass mints `domain:<slug>` group ids; they must be recognized as
  // reserved (so grouping-gate treats them as non-framework, never pinning them).
  expect(DOMAIN_SUBSYSTEM_PREFIX).toBe('domain:');
  expect(RESERVED_SUBSYSTEM_PREFIXES).toContain(DIR_SUBSYSTEM_PREFIX);
  expect(RESERVED_SUBSYSTEM_PREFIXES).toContain(PKG_SUBSYSTEM_PREFIX);
  expect(RESERVED_SUBSYSTEM_PREFIXES).toContain(DOMAIN_SUBSYSTEM_PREFIX);
});
