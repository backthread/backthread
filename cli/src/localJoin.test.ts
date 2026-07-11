// localJoin.test.ts — the pure, zero-LLM term-keyed join: tokenization, module +
// decision matching/ranking, neighborhood, divergence-robustness, and the bounded
// rendered output. No I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalContext, tokenize } from './localJoin.js';
import type { LocalCache } from './localCache.js';

function cache(): Pick<LocalCache, 'structure' | 'decisions'> {
  return {
    structure: {
      refreshedAt: '2026-07-11T00:00:00Z',
      root: '/x',
      extractorVersion: '0.1.0',
      fileHashes: {},
      fileGraph: {},
      modules: [
        { id: 'invoicing', kind: 'internal', godNode: false, loc: 200, fileCount: 3, fileIds: ['src/invoicing/service.ts', 'src/invoicing/pdf.ts'], subsystem: { id: 's1', name: 'Billing' } },
        { id: 'billing', kind: 'internal', godNode: true, loc: 400, fileCount: 5, fileIds: ['src/billing/index.ts'], subsystem: { id: 's1', name: 'Billing' } },
        { id: 'auth', kind: 'internal', godNode: false, loc: 100, fileCount: 2, fileIds: ['src/auth/token.ts'], subsystem: { id: 's2', name: 'Auth' } },
        { id: 'stripe', kind: 'external', godNode: false, loc: 0, fileCount: 0, fileIds: [], subsystem: null, externalSpecifier: 'stripe' },
      ],
      edges: [
        { source: 'invoicing', target: 'billing', kinds: ['calls'] },
        { source: 'invoicing', target: 'stripe', kinds: ['calls'] },
        { source: 'billing', target: 'auth', kinds: ['calls'] },
      ],
    },
    decisions: {
      syncedAt: '2026-07-11T00:00:00Z',
      ttlHours: 6,
      repo: 'o/r',
      items: [
        { id: 'd1', title: 'Batch invoices before webhook dispatch', why: 'fewer webhooks; avoids Stripe rate limits', problem: null, moduleIds: ['invoicing'], flowNames: ['Invoicing'], decidedAt: '2026-01-03', significance: 8, tradeoffs: ['adds latency'], assumptions: [], limitations: [] },
        { id: 'd2', title: 'RS256 for auth tokens', why: 'asymmetric verification', problem: null, moduleIds: ['auth'], flowNames: ['Auth'], decidedAt: '2026-02-01', significance: 6, tradeoffs: [], assumptions: [], limitations: [] },
        { id: 'd3', title: 'Idempotency keys on mutating endpoints', why: 'prevent double-charge on retry via the invoice path', problem: null, moduleIds: ['billing'], flowNames: [], decidedAt: '2026-01-10', significance: 7, tradeoffs: [], assumptions: [], limitations: [] },
      ],
    },
  };
}

test('tokenize splits words + camelCase, drops <3-char fragments, lowercases', () => {
  assert.deepEqual(tokenize('invoice').sort(), ['invoice']);
  assert.deepEqual(tokenize('getUserAuth').sort(), ['auth', 'get', 'getuserauth', 'user']);
  assert.deepEqual(tokenize('a-b').sort(), []); // both fragments < 3 chars
  assert.deepEqual(tokenize('   ').sort(), []);
});

test('a term surfaces the matching modules + term-matched decisions, ranked', () => {
  const ctx = buildLocalContext('invoice', cache());
  assert.equal(ctx.empty, false);
  // invoicing module matches (id + paths); billing matches via the decision, not structure.
  assert.equal(ctx.modules[0].id, 'invoicing');
  assert.ok(ctx.modules[0].pathHint?.includes('invoicing'));
  // decisions mentioning "invoice"/"invoices" rank above the auth one (which doesn't match at all).
  const titles = ctx.decisions.map((d) => d.title);
  assert.ok(titles.includes('Batch invoices before webhook dispatch'));
  assert.ok(titles.some((t) => t.includes('Idempotency')), 'the "invoice path" why matches too');
  assert.ok(!titles.includes('RS256 for auth tokens'), 'a non-matching decision is excluded');
});

test('matched modules carry their 1-hop structural neighborhood', () => {
  const ctx = buildLocalContext('invoicing', cache());
  const inv = ctx.modules.find((m) => m.id === 'invoicing')!;
  assert.deepEqual(inv.neighbors.sort(), ['billing', 'stripe']);
});

test('subsystem-name and external-specifier terms match', () => {
  const bySub = buildLocalContext('billing', cache());
  // "billing" matches the billing module id AND the Billing subsystem on invoicing.
  assert.ok(bySub.modules.some((m) => m.id === 'billing'));
  assert.ok(bySub.modules.some((m) => m.subsystem === 'Billing'));

  const byExt = buildLocalContext('stripe', cache());
  assert.ok(byExt.modules.some((m) => m.id === 'stripe'), 'external specifier matches');
  assert.ok(byExt.decisions.some((d) => d.why?.includes('Stripe')), 'why text matches "stripe"');
});

test('divergence-robust: a decision matches by its own text even with no local module', () => {
  const c = cache();
  // Simulate divergence: drop ALL local structure; the decision text still matches.
  const ctx = buildLocalContext('invoice', { structure: null, decisions: c.decisions });
  assert.equal(ctx.empty, false);
  assert.equal(ctx.modules.length, 0);
  assert.ok(ctx.decisions.some((d) => d.title.includes('invoices')));
});

test('a term containing a common word as a substring does NOT spuriously match', () => {
  // "zzznotathing" contains "not"/"thing"; a substring-based stem would wrongly
  // surface every decision that says "not". A shared-PREFIX stem must not.
  const ctx = buildLocalContext('zzznotathing', cache());
  assert.equal(ctx.empty, true, 'no field shares a strong prefix with the term');
});

test('stem still matches real morphological kin (invoice↔invoicing, auth↔authenticate)', () => {
  // invoicing module id vs the term "invoice" (not a substring of "invoicing").
  const inv = buildLocalContext('invoice', cache());
  assert.ok(inv.modules.some((m) => m.id === 'invoicing'), 'invoice → invoicing (shared stem)');
  const c = cache();
  c.decisions!.items.push({ id: 'da', title: 'Authenticate partner callbacks', why: null, problem: null, moduleIds: [], flowNames: [], decidedAt: null, significance: null, tradeoffs: [], assumptions: [], limitations: [] });
  const au = buildLocalContext('auth', c);
  assert.ok(au.decisions.some((d) => d.title.includes('Authenticate')), 'auth → Authenticate (shared stem)');
});

test('no match → empty (the hook injects nothing)', () => {
  const ctx = buildLocalContext('kubernetes', cache());
  assert.equal(ctx.empty, true);
  assert.equal(ctx.text, '');
  assert.equal(buildLocalContext('', cache()).empty, true);
  assert.equal(buildLocalContext('invoice', null).empty, true);
});

test('rendered text is bounded and includes both tiers', () => {
  const ctx = buildLocalContext('invoice', cache(), { charBudget: 600 });
  assert.ok(ctx.text.length <= 600, 'respects the char budget');
  assert.match(ctx.text, /Structure:/);
  assert.match(ctx.text, /Why \(from the decision log\):/);
  assert.match(ctx.text, /local context for "invoice"/);
});

test('deterministic: same cache + term ⇒ identical output', () => {
  const a = buildLocalContext('invoice', cache());
  const b = buildLocalContext('invoice', cache());
  assert.deepEqual(a, b);
});

test('caps: at most maxModules / maxDecisions surfaced', () => {
  const ctx = buildLocalContext('src', cache(), { maxModules: 2, maxDecisions: 1 });
  assert.ok(ctx.modules.length <= 2);
  assert.ok(ctx.decisions.length <= 1);
});
