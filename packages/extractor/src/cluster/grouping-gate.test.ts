// the directory quality gate. Pure: builds GateModule lists by hand
// and asserts each of the three OR-ratios trips on its target failure shape
// (layer-flat / god-bucket / singleton-tail) and that a tidy domain-organized
// repo trips none. No DB / LLM.

import { test, expect } from '../testkit.js';
import {
  evaluateGroupingGate,
  isFrameworkSubsystemId,
  GATE_THRESHOLDS,
  type GateModule,
} from './grouping-gate.js';

function mod(id: string, fileIds: string[], subsystemId?: string): GateModule {
  return subsystemId === undefined ? { id, fileIds } : { id, fileIds, subsystemId };
}

// n modules each alone under a distinct DOMAIN directory (dir name = `${prefix}${i}`).
function domainDirs(prefix: string, n: number, perBox = 1): GateModule[] {
  const out: GateModule[] = [];
  let box = 0;
  for (let i = 0; i < n; i++) {
    if (i % perBox === 0) box++;
    out.push(mod(`${prefix}-${i}`, [`${prefix}${box}/file${i}.ts`]));
  }
  return out;
}

test('empty input never trips', () => {
  const g = evaluateGroupingGate([]);
  expect(g.trips).toBe(false);
  expect(g.internalCount).toBe(0);
});

test('tidy repo (clean per-domain folders, ~3 modules each) trips nothing', () => {
  // 12 modules in 4 domain dirs of 3 — godBucket 3/12=0.25, no singletons, no
  // layer names. The directory-primary default is correct here; gate stays shut.
  const modules = [
    ...domainDirs('auth', 3, 3).map((m, i) => mod(`auth-${i}`, [`auth/f${i}.ts`])),
    ...[0, 1, 2].map((i) => mod(`billing-${i}`, [`billing/f${i}.ts`])),
    ...[0, 1, 2].map((i) => mod(`orders-${i}`, [`orders/f${i}.ts`])),
    ...[0, 1, 2].map((i) => mod(`catalog-${i}`, [`catalog/f${i}.ts`])),
  ];
  const g = evaluateGroupingGate(modules);
  expect(g.internalCount).toBe(12);
  expect(g.godBucketRatio).toBeCloseTo(0.25, 5);
  expect(g.singletonBoxRatio).toBe(0);
  expect(g.layerNamedFraction).toBe(0);
  expect(g.trips).toBe(false);
});

test('GOD-BUCKET (marola shape: one giant services/ dir) trips via godBucketRatio', () => {
  // 8 modules under services/ + 10 in 5 paired domain dirs → godBucket 8/18≈0.44,
  // zero singletons, zero layer names — godBucket is the SOLE tripper.
  const services = Array.from({ length: 8 }, (_, i) => mod(`svc-${i}`, [`services/sub${i}/index.ts`]));
  const others: GateModule[] = [];
  for (let d = 0; d < 5; d++) {
    others.push(mod(`dom${d}-a`, [`domain${d}/a.ts`]));
    others.push(mod(`dom${d}-b`, [`domain${d}/b.ts`]));
  }
  const g = evaluateGroupingGate([...services, ...others]);
  expect(g.internalCount).toBe(18);
  expect(g.godBucketRatio).toBeCloseTo(8 / 18, 5);
  expect(g.godBucketRatio).toBeGreaterThanOrEqual(GATE_THRESHOLDS.godBucketRatio);
  expect(g.singletonBoxRatio).toBe(0);
  expect(g.layerNamedFraction).toBe(0);
  expect(g.trips).toBe(true);
  expect(g.reasons.join()).toMatch(/godBucketRatio/);
});

test('LAYER-FLAT trips via layerNamedFraction (spread across lib/utils/components)', () => {
  // 6 layer-named modules over 12 → 0.5; spread across 3 layer dirs (2 each) so
  // no single box is a god-bucket and there are no singletons → layer is the
  // sole tripper.
  const layer = [
    mod('l1', ['lib/a.ts']), mod('l2', ['lib/b.ts']),
    mod('u1', ['utils/a.ts']), mod('u2', ['utils/b.ts']),
    mod('c1', ['components/a.ts']), mod('c2', ['components/b.ts']),
  ];
  const domain: GateModule[] = [];
  for (let d = 0; d < 3; d++) {
    domain.push(mod(`d${d}a`, [`feat${d}/a.ts`]));
    domain.push(mod(`d${d}b`, [`feat${d}/b.ts`]));
  }
  const g = evaluateGroupingGate([...layer, ...domain]);
  expect(g.internalCount).toBe(12);
  expect(g.layerNamedFraction).toBeCloseTo(0.5, 5);
  expect(g.layerNamedFraction).toBeGreaterThanOrEqual(GATE_THRESHOLDS.layerNamedFraction);
  expect(g.godBucketRatio).toBeLessThan(GATE_THRESHOLDS.godBucketRatio);
  expect(g.singletonBoxRatio).toBe(0);
  expect(g.trips).toBe(true);
  expect(g.reasons.join()).toMatch(/layerNamedFraction/);
});

test('SINGLETON-TAIL trips via singletonBoxRatio (many one-module dirs)', () => {
  // 4 singleton boxes + 2 boxes of 3 → 6 boxes, 4 singletons → singletonBoxRatio
  // 4/6≈0.667 trips; godBucket 3/10=0.3 stays under; no layer names.
  const singles = [0, 1, 2, 3].map((i) => mod(`s${i}`, [`solo${i}/x.ts`]));
  const grouped: GateModule[] = [];
  for (let i = 0; i < 3; i++) grouped.push(mod(`p${i}`, ['paira/x.ts']));
  for (let i = 0; i < 3; i++) grouped.push(mod(`q${i}`, ['pairb/x.ts']));
  const g = evaluateGroupingGate([...singles, ...grouped]);
  expect(g.internalCount).toBe(10);
  expect(g.singletonBoxRatio).toBeCloseTo(4 / 6, 5); // BOX denominator
  expect(g.singletonBoxRatio).toBeGreaterThanOrEqual(GATE_THRESHOLDS.singletonBoxRatio);
  expect(g.godBucketRatio).toBeLessThan(GATE_THRESHOLDS.godBucketRatio);
  expect(g.layerNamedFraction).toBe(0);
  expect(g.trips).toBe(true);
});

test('root-level modules (no top-level dir) each count as their own singleton box', () => {
  const modules = [
    mod('a', ['index.ts', 'main.ts']),
    mod('b', ['server.ts']),
    mod('c', ['worker.ts']),
  ];
  const g = evaluateGroupingGate(modules);
  expect(g.singletonBoxRatio).toBe(1); // 3 distinct root boxes / 3 modules
  expect(g.godBucketRatio).toBeCloseTo(1 / 3, 5);
  expect(g.trips).toBe(true);
});

// ---------------------------------------------------------------------------
// framework-grouped modules (adapter-namespaced subsystem id) are
// EXCLUDED from the directory-quality measurement: the framework already owns
// their grouping, so the gate must not fire the LLM domain-pass to "fix" them.

test('isFrameworkSubsystemId: adapter-namespaced yes; directory / package / external / undefined no', () => {
  expect(isFrameworkSubsystemId('nest:auth')).toBe(true);
  expect(isFrameworkSubsystemId('next:dashboard')).toBe(true);
  expect(isFrameworkSubsystemId('auth')).toBe(false); // legacy bare directory slug (old snapshots)
  expect(isFrameworkSubsystemId('billing-money')).toBe(false);
  expect(isFrameworkSubsystemId('external')).toBe(false); // the fixed externals box
  expect(isFrameworkSubsystemId(undefined)).toBe(false);
  // directory/package ids are NOW colon-namespaced (`dir:`/`pkg:`) but are
  // NOT framework adapter ids — the reserved prefixes must be excluded, else they'd
  // be wrongly pinned out of the directory-quality gate + the LLM domain-pass.
  expect(isFrameworkSubsystemId('dir:auth')).toBe(false);
  expect(isFrameworkSubsystemId('dir:components')).toBe(false);
  expect(isFrameworkSubsystemId('pkg:web')).toBe(false);
  // (domain-pass): the LLM's OWN group ids are `domain:`-namespaced and are
  // NOT framework-authoritative — they MUST be excluded so the domain-pass can re-
  // group its own modules on the next run (pinning them would freeze them forever).
  expect(isFrameworkSubsystemId('domain:billing-money')).toBe(false);
  expect(isFrameworkSubsystemId('domain:auth')).toBe(false);
});

test('a fully framework-grouped layer-flat repo does NOT trip the gate', () => {
  // The exact bug shape: controllers/ + services/ + providers/ folders (layer-flat
  // → singleton/layer smell) but every module is authoritatively @Module-grouped
  // (nest:*). With them excluded there are no directory modules left to measure →
  // the gate stays shut → the LLM domain-pass is never invoked.
  const modules = [
    mod('a', ['controllers/users.controller.ts'], 'nest:users-module'),
    mod('b', ['services/users.service.ts'], 'nest:users-module'),
    mod('c', ['controllers/orders.controller.ts'], 'nest:orders-module'),
    mod('d', ['services/orders.service.ts'], 'nest:orders-module'),
    mod('e', ['providers/config.provider.ts'], 'nest:app-module'),
  ];
  const g = evaluateGroupingGate(modules);
  expect(g.frameworkExcluded).toBe(5);
  expect(g.internalCount).toBe(0); // nothing directory-derived to measure
  expect(g.trips).toBe(false);
  expect(g.reasons).toEqual([]);
});

test('framework-grouped modules do not contribute to a trip; directory remainder does', () => {
  // 6 layer-flat modules under lib/ + utils/ would normally trip layerNamedFraction,
  // but they're all framework-grouped (excluded). The 8 directory modules that
  // remain sit in 4 clean domain dirs of 2 → trip nothing (godBucket 2/8 = 0.25).
  const framework = [
    mod('f1', ['lib/a.ts'], 'nest:m1'), mod('f2', ['lib/b.ts'], 'nest:m1'),
    mod('f3', ['utils/a.ts'], 'nest:m2'), mod('f4', ['utils/b.ts'], 'nest:m2'),
    mod('f5', ['lib/c.ts'], 'nest:m1'), mod('f6', ['utils/c.ts'], 'nest:m2'),
  ];
  const directory = [
    mod('d1', ['auth/a.ts']), mod('d2', ['auth/b.ts']),
    mod('d3', ['billing/a.ts']), mod('d4', ['billing/b.ts']),
    mod('d5', ['orders/a.ts']), mod('d6', ['orders/b.ts']),
    mod('d7', ['catalog/a.ts']), mod('d8', ['catalog/b.ts']),
  ];
  const g = evaluateGroupingGate([...framework, ...directory]);
  expect(g.frameworkExcluded).toBe(6);
  expect(g.internalCount).toBe(8); // only the directory remainder
  expect(g.layerNamedFraction).toBe(0); // lib/utils were excluded
  expect(g.singletonBoxRatio).toBe(0);
  expect(g.godBucketRatio).toBeCloseTo(0.25); // 2 of 8, well under 0.35
  expect(g.trips).toBe(false);
});

test('leading src/ is stripped so src/services and services share a god-bucket', () => {
  const modules = [
    mod('a', ['src/services/a.ts']),
    mod('b', ['services/b.ts']),
    mod('c', ['src/services/c.ts']),
    mod('d', ['other/d.ts']),
  ];
  const g = evaluateGroupingGate(modules);
  // a,b,c all → top dir `services` (one box of 3); d → `other`.
  expect(g.godBucketRatio).toBeCloseTo(3 / 4, 5);
});
