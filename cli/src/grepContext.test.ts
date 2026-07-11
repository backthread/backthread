// grepContext.test.ts — the PreToolUse grep hook: term extraction from a
// Grep/Glob payload, the inject-context happy path, and fail-open on every
// degenerate input (no cache / no match / bad payload).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGrepContext, extractTerm } from './grepContext.js';
import type { LocalCache } from './localCache.js';

function cacheWith(): LocalCache {
  return {
    schemaVersion: 1,
    repo: 'o/r',
    structure: {
      refreshedAt: '2026-07-11T00:00:00Z',
      root: '/repo',
      extractorVersion: '0.1.0',
      fileHashes: {},
      fileGraph: {},
      modules: [
        { id: 'invoicing', kind: 'internal', godNode: false, loc: 100, fileCount: 2, fileIds: ['src/invoicing/service.ts'], subsystem: { id: 's', name: 'Billing' } },
      ],
      edges: [],
    },
    decisions: {
      syncedAt: '2026-07-11T00:00:00Z',
      ttlHours: 6,
      repo: 'o/r',
      items: [
        { id: 'd1', title: 'Batch invoices', why: 'fewer webhooks', problem: null, moduleIds: ['invoicing'], flowNames: ['Invoicing'], decidedAt: '2026-01-01', significance: 5, tradeoffs: [], assumptions: [], limitations: [] },
      ],
    },
  };
}

test('extractTerm reads only the known term keys (pattern/glob/query), else empty', () => {
  assert.equal(extractTerm({ pattern: 'invoice' }), 'invoice');
  assert.equal(extractTerm({ glob: '**/*.ts' }), '**/*.ts');
  assert.equal(extractTerm({ query: 'auth' }), 'auth');
  // No free-for-all fallback: a non-term field (path/output_mode) must NOT become the term.
  assert.equal(extractTerm({ path: '/x', output_mode: 'content' }), '');
  assert.equal(extractTerm({}), '');
  assert.equal(extractTerm(null), '');
});

test('injects additionalContext for a matching Grep pattern', async () => {
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'invoice' }, cwd: '/repo' });
  const out = await runGrepContext(payload, { resolveRepoRootImpl: () => '/repo', readCacheImpl: async () => cacheWith() });
  assert.ok(out.hookSpecificOutput, 'injected');
  assert.equal(out.hookSpecificOutput!.hookEventName, 'PreToolUse');
  assert.match(out.hookSpecificOutput!.additionalContext, /invoicing/);
  assert.match(out.hookSpecificOutput!.additionalContext, /Batch invoices/);
});

test('fail-open: no cache → {} (no injection)', async () => {
  const payload = JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'invoice' }, cwd: '/repo' });
  const out = await runGrepContext(payload, { resolveRepoRootImpl: () => '/repo', readCacheImpl: async () => null });
  assert.deepEqual(out, {});
});

test('fail-open: a term that matches nothing → {}', async () => {
  const payload = JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'kubernetes' }, cwd: '/repo' });
  const out = await runGrepContext(payload, { resolveRepoRootImpl: () => '/repo', readCacheImpl: async () => cacheWith() });
  assert.deepEqual(out, {});
});

test('fail-open: unparseable / empty / termless payloads → {}', async () => {
  const deps = { resolveRepoRootImpl: () => '/repo', readCacheImpl: async () => cacheWith() };
  assert.deepEqual(await runGrepContext('{ not json', deps), {});
  assert.deepEqual(await runGrepContext('', deps), {});
  assert.deepEqual(await runGrepContext(JSON.stringify({ tool_name: 'Grep', tool_input: {} }), deps), {});
});

test('fail-open: a throwing cache read → {} (never propagates)', async () => {
  const payload = JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'invoice' }, cwd: '/repo' });
  const out = await runGrepContext(payload, {
    resolveRepoRootImpl: () => '/repo',
    readCacheImpl: async () => { throw new Error('disk error'); },
  });
  assert.deepEqual(out, {});
});

test('Glob payloads resolve their term too', async () => {
  const payload = JSON.stringify({ tool_name: 'Glob', tool_input: { glob: '**/invoicing/**' }, cwd: '/repo' });
  const out = await runGrepContext(payload, { resolveRepoRootImpl: () => '/repo', readCacheImpl: async () => cacheWith() });
  assert.ok(out.hookSpecificOutput, 'glob term matches the invoicing module');
});
