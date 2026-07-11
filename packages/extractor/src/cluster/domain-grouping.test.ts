// the pure grouping-model helpers: signatures, id minting, warm-start
// partition, full/incremental build, overlap reconciliation, and the 
// totality finalize. No DB / LLM.

import { test, expect } from '../testkit.js';
import {
  moduleSignature,
  mintGroupId,
  namespaceModelIds,
  selectPending,
  buildFullModel,
  buildIncrementalModel,
  reconcileGroupIds,
  finalizeModel,
  type GroupingModel,
} from './domain-grouping.js';

// --- signatures --------------------------------------------------------------

test('moduleSignature is stable + order-independent, but moves on a real change', () => {
  const a = moduleSignature({ summary: 'auth', decisionIds: ['d1', 'd2'], changelogIds: ['c1'] });
  const b = moduleSignature({ summary: 'auth', decisionIds: ['d2', 'd1'], changelogIds: ['c1'] });
  expect(a).toBe(b); // decision id order doesn't matter
  expect(moduleSignature({ summary: 'auth', decisionIds: ['d1'], changelogIds: ['c1'] })).not.toBe(a);
  expect(moduleSignature({ summary: 'AUTH', decisionIds: ['d1', 'd2'], changelogIds: ['c1'] })).not.toBe(a);
});

// --- id minting --------------------------------------------------------------

test('mintGroupId slugifies + de-collides, ALWAYS under the domain: namespace', () => {
  const taken = new Set<string>();
  expect(mintGroupId('Billing & Payments', taken)).toBe('domain:billing-payments');
  expect(mintGroupId('Billing & Payments', taken)).toBe('domain:billing-payments-2');
  expect(mintGroupId('!!!', taken)).toBe('domain:group');
});

test('a minted id can NEVER equal a bare module-id slug', () => {
  // A module id is a bare path-derived slug (slugify strips ':'); a domain group id
  // is always namespaced → the two id spaces are disjoint, so a domain super-node
  // can't collide with a module node in React Flow's id-keyed store.
  const id = mintGroupId('Auth', new Set());
  expect(id.startsWith('domain:')).toBe(true);
  expect(id).not.toBe('auth'); // the bare slug a module named "auth" would carry
});

// --- legacy-id migration -------------------------------------------

test('namespaceModelIds migrates legacy BARE ids to domain:, rewrites assignments, carries metadata', () => {
  const legacy: GroupingModel = {
    groups: [
      { id: 'auth', name: 'Auth' },
      { id: 'billing-money', name: 'Billing & Money', description: 'money stuff' },
    ],
    assignments: {
      a: { groupId: 'auth', signature: 's' },
      b: { groupId: 'billing-money', signature: 't' },
    },
  };
  const out = namespaceModelIds(legacy);
  expect(out.groups.map((g) => g.id)).toEqual(['domain:auth', 'domain:billing-money']);
  expect(out.groups[1].description).toBe('money stuff'); // name/description carried
  expect(out.assignments.a.groupId).toBe('domain:auth');
  expect(out.assignments.b.groupId).toBe('domain:billing-money');
  // The migrated id no longer equals the module id a group named `auth` collided with.
  expect(out.groups[0].id).not.toBe('auth');
});

test('namespaceModelIds is idempotent on an already-namespaced model (same reference)', () => {
  const already: GroupingModel = {
    groups: [{ id: 'domain:auth', name: 'Auth' }],
    assignments: { a: { groupId: 'domain:auth', signature: 's' } },
  };
  expect(namespaceModelIds(already)).toBe(already); // untouched, no churn
});

test('namespaceModelIds de-collides a bare id against an already-namespaced one', () => {
  // A partially-migrated model: `domain:auth` already exists, and a stale bare `auth`
  // would map onto it — it must be re-id'd, never silently merged.
  const mixed: GroupingModel = {
    groups: [
      { id: 'domain:auth', name: 'Auth' },
      { id: 'auth', name: 'Auth (legacy)' },
    ],
    assignments: {
      a: { groupId: 'domain:auth', signature: 's' },
      b: { groupId: 'auth', signature: 't' },
    },
  };
  const out = namespaceModelIds(mixed);
  const ids = out.groups.map((g) => g.id);
  expect(ids).toEqual(['domain:auth', 'domain:auth-2']);
  expect(out.assignments.a.groupId).toBe('domain:auth');
  expect(out.assignments.b.groupId).toBe('domain:auth-2');
  expect(new Set(ids).size).toBe(2); // still unique
});

// --- warm-start partition ----------------------------------------------------

test('selectPending keeps unchanged-signature modules, queues new/changed/orphaned', () => {
  const cached: GroupingModel = {
    groups: [{ id: 'auth', name: 'Auth' }],
    assignments: {
      a: { groupId: 'auth', signature: 's-a' },
      b: { groupId: 'auth', signature: 's-b-old' },
      d: { groupId: 'gone', signature: 's-d' }, // group no longer exists
    },
  };
  const signatures = { a: 's-a', b: 's-b-new', c: 's-c', d: 's-d' };
  const { kept, pendingIds } = selectPending(['a', 'b', 'c', 'd'], signatures, cached);
  expect(Object.keys(kept)).toEqual(['a']); // only a is unchanged + group still exists
  expect(pendingIds.sort()).toEqual(['b', 'c', 'd']); // changed (b), new (c), orphaned-group (d)
});

test('selectPending with no cache queues everything', () => {
  const { kept, pendingIds } = selectPending(['a', 'b'], { a: '1', b: '2' }, null);
  expect(kept).toEqual({});
  expect(pendingIds).toEqual(['a', 'b']);
});

// --- full build --------------------------------------------------------------

test('buildFullModel mints ids + resolves every assignment to one', () => {
  const model = buildFullModel(
    {
      groups: [
        { name: 'Auth', description: 'Login' },
        { name: 'Billing' },
      ],
      assignments: { a: 'Auth', b: 'Billing', c: 'Auth' },
    },
    { a: 's1', b: 's2', c: 's3' },
  );
  expect(model.groups.map((g) => g.id)).toEqual(['domain:auth', 'domain:billing']);
  expect(model.groups[0].description).toBe('Login');
  expect(model.assignments.a).toEqual({ groupId: 'domain:auth', signature: 's1' });
  expect(model.assignments.c.groupId).toBe('domain:auth');
});

// --- incremental build -------------------------------------------------------

test('buildIncrementalModel keeps prior groups + kept assignments, folds in new', () => {
  // Prior groups always come from mintGroupId (or the load-time migration) → already
  // `domain:`-namespaced; a newly-proposed group is minted under the same namespace.
  const prior = [{ id: 'domain:auth', name: 'Auth' }];
  const kept = { a: { groupId: 'domain:auth', signature: 's-a' } };
  const model = buildIncrementalModel(
    prior,
    kept,
    { groups: [{ name: 'Billing' }], assignments: { b: 'Billing', c: 'Auth' } },
    { a: 's-a', b: 's-b', c: 's-c' },
  );
  expect(model.groups.map((g) => g.id).sort()).toEqual(['domain:auth', 'domain:billing']);
  expect(model.assignments.a).toEqual({ groupId: 'domain:auth', signature: 's-a' }); // untouched
  expect(model.assignments.b.groupId).toBe('domain:billing'); // new group
  expect(model.assignments.c.groupId).toBe('domain:auth'); // assigned to an EXISTING group by name
});

test('buildIncrementalModel reuses an existing id when the LLM re-proposes its name', () => {
  const model = buildIncrementalModel(
    [{ id: 'domain:auth', name: 'Auth' }],
    {},
    { groups: [{ name: 'Auth' }], assignments: { x: 'Auth' } }, // re-proposed existing name
    { x: 's' },
  );
  expect(model.groups.map((g) => g.id)).toEqual(['domain:auth']); // not duplicated
  expect(model.assignments.x.groupId).toBe('domain:auth');
});

// --- overlap reconciliation (full re-cluster anti-drift) ---------------------

test('reconcileGroupIds carries the prior id to the best-overlapping new group', () => {
  const prior: GroupingModel = {
    groups: [{ id: 'domain:auth', name: 'Auth' }],
    assignments: { a: { groupId: 'domain:auth', signature: '1' }, b: { groupId: 'domain:auth', signature: '1' } },
  };
  const next: GroupingModel = {
    groups: [{ id: 'domain:authentication', name: 'Authentication' }],
    assignments: {
      a: { groupId: 'domain:authentication', signature: '2' },
      b: { groupId: 'domain:authentication', signature: '2' },
      c: { groupId: 'domain:authentication', signature: '2' },
    },
  };
  const out = reconcileGroupIds(next, prior);
  expect(out.groups[0].id).toBe('domain:auth'); // carried prior id (a,b overlap)
  expect(out.groups[0].name).toBe('Auth'); // carried prior label too
  expect(out.assignments.c.groupId).toBe('domain:auth');
});

test('reconcileGroupIds mints a fresh id for a genuinely-new group', () => {
  const prior: GroupingModel = {
    groups: [{ id: 'domain:auth', name: 'Auth' }],
    assignments: { a: { groupId: 'domain:auth', signature: '1' } },
  };
  const next: GroupingModel = {
    groups: [
      { id: 'domain:auth', name: 'Auth' },
      { id: 'domain:billing', name: 'Billing' },
    ],
    assignments: {
      a: { groupId: 'domain:auth', signature: '2' },
      z: { groupId: 'domain:billing', signature: '2' }, // new domain, no prior overlap
    },
  };
  const out = reconcileGroupIds(next, prior);
  expect(new Set(out.groups.map((g) => g.id))).toEqual(new Set(['domain:auth', 'domain:billing']));
  expect(out.assignments.z.groupId).toBe('domain:billing');
});

// --- totality finalize -------------------------------------------------------

test('finalizeModel drops empty groups but keeps the partition total', () => {
  const model: GroupingModel = {
    groups: [
      { id: 'auth', name: 'Auth' },
      { id: 'ghost', name: 'Ghost' }, // nobody assigned here
    ],
    assignments: { a: { groupId: 'auth', signature: 's' } },
  };
  const out = finalizeModel(model, ['a']);
  expect(out.groups.map((g) => g.id)).toEqual(['auth']); // ghost dropped
});

test('finalizeModel throws when a module is unassigned ( partition gap)', () => {
  const model: GroupingModel = {
    groups: [{ id: 'auth', name: 'Auth' }],
    assignments: { a: { groupId: 'auth', signature: 's' } },
  };
  expect(() => finalizeModel(model, ['a', 'b'])).toThrow(/complete partition/);
});

test('finalizeModel throws when an assignment points at an undeclared group', () => {
  // `b` references `nope`, which is not in `groups` at all → not a live group →
  // b dangles → not a complete partition.
  const danglingModel: GroupingModel = {
    groups: [{ id: 'auth', name: 'Auth' }],
    assignments: {
      a: { groupId: 'auth', signature: 's' },
      b: { groupId: 'nope', signature: 's' },
    },
  };
  expect(() => finalizeModel(danglingModel, ['a', 'b'])).toThrow(/complete partition/);
});
