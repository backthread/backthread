// localDecisions.test.ts — the merged-decision-log sync: repo resolution, TTL
// freshness, defensive response mapping, and the full fetch→cache flow with a
// mocked fetch + config (no network, no real auth).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  syncDecisions,
  resolveSyncRepo,
  isFresh,
  mapDecisions,
  DEFAULT_TTL_HOURS,
} from './localDecisions.js';
import { readCache } from './localCache.js';
import type { BackthreadConfig } from './config.js';
import type { DecisionsSection } from './localCache.js';

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), 'bt-dec-'));
}

// --- pure helpers ------------------------------------------------------------

test('resolveSyncRepo prefers config.repo, falls back to the git remote', () => {
  assert.deepEqual(resolveSyncRepo({ repo: 'o/r' }, '/x', () => null), { owner: 'o', name: 'r' });
  assert.deepEqual(
    resolveSyncRepo({}, '/x', () => 'git@github.com:acme/widgets.git'),
    { owner: 'acme', name: 'widgets' },
  );
  assert.equal(resolveSyncRepo({}, '/x', () => null), null);
});

test('isFresh honors the TTL window and repo scope', () => {
  const now = new Date('2026-07-11T12:00:00Z');
  const within: DecisionsSection = { syncedAt: '2026-07-11T10:00:00Z', ttlHours: 6, repo: 'o/r', items: [] };
  const stale: DecisionsSection = { syncedAt: '2026-07-11T00:00:00Z', ttlHours: 6, repo: 'o/r', items: [] };
  assert.equal(isFresh(within, 'o/r', 6, now), true);
  assert.equal(isFresh(stale, 'o/r', 6, now), false, '12h old > 6h TTL');
  assert.equal(isFresh(within, 'other/repo', 6, now), false, 'different repo → not fresh');
  assert.equal(isFresh(null, 'o/r', 6, now), false);
});

test('mapDecisions keeps only redacted derived fields + resolves flow names, dropping malformed rows', () => {
  const flows = [{ id: 'f1', name: 'Invoicing' }, { id: 'f2', name: 'Auth' }];
  const decisions = [
    {
      id: 'd1', title: 'Batch invoices', why: 'fewer webhooks', problem: 'race', decidedAt: '2026-01-01',
      significance: 5, moduleIds: ['m1'], flowIds: ['f1', 'nope'], tradeoffs: ['delay'], assumptions: [], limitations: ['x'],
    },
    { title: 'no id — dropped' },
    { id: 'd2', title: 'ok', flowIds: ['f2'] },
  ];
  const out = mapDecisions(flows as any, decisions as any);
  assert.equal(out.length, 2, 'the id-less row is dropped');
  assert.deepEqual(out[0].flowNames, ['Invoicing'], 'unknown flow id filtered out');
  assert.equal(out[0].why, 'fewer webhooks');
  assert.deepEqual(out[0].tradeoffs, ['delay']);
  assert.equal(out[1].why, null);
  assert.deepEqual(out[1].flowNames, ['Auth']);
});

// --- full flow (mocked fetch + config) ---------------------------------------

const authedConfig: BackthreadConfig = { device_token: 'backthread_pat_x', repo: 'o/r', account: 'acc' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('syncDecisions returns no-auth when not logged in (nothing written)', async () => {
  const repo = tmpRepo();
  const out = await syncDecisions(
    { cwd: repo },
    { readConfigImpl: async () => ({}), resolveRepoRootImpl: () => repo, fetchImpl: async () => { throw new Error('should not fetch'); } },
  );
  assert.equal(out.status, 'no-auth');
  assert.equal(await readCache(repo), null);
  rmSync(repo, { recursive: true, force: true });
});

test('syncDecisions fetches, maps, and writes the decisions section', async () => {
  const repo = tmpRepo();
  let fetchedUrl = '';
  let authHeader = '';
  let sentBody: any = null;
  const out = await syncDecisions(
    { cwd: repo },
    {
      readConfigImpl: async () => authedConfig,
      resolveRepoRootImpl: () => repo,
      now: () => new Date('2026-07-11T12:00:00Z'),
      fetchImpl: async (url, init) => {
        fetchedUrl = String(url);
        authHeader = String((init?.headers as Record<string, string>)?.Authorization ?? '');
        sentBody = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          ok: true,
          repo: { owner: 'o', name: 'r' },
          flows: [{ id: 'f1', name: 'Invoicing' }],
          decisions: [{ id: 'd1', title: 'Batch', why: 'fewer webhooks', flowIds: ['f1'], moduleIds: ['m1'] }],
        });
      },
    },
  );
  assert.equal(out.status, 'synced');
  assert.equal(out.count, 1);
  assert.match(fetchedUrl, /\/read-decisions$/);
  assert.equal(authHeader, 'Bearer backthread_pat_x');
  // read-decisions requires `{ repo: { owner, name } }` (an object, not a slug).
  assert.deepEqual(sentBody, { repo: { owner: 'o', name: 'r' } });
  const cache = await readCache(repo);
  assert.equal(cache!.decisions!.repo, 'o/r');
  assert.equal(cache!.decisions!.ttlHours, DEFAULT_TTL_HOURS);
  assert.equal(cache!.decisions!.items[0].title, 'Batch');
  assert.deepEqual(cache!.decisions!.items[0].flowNames, ['Invoicing']);
  assert.equal(cache!.repo, 'o/r');
  rmSync(repo, { recursive: true, force: true });
});

test('syncDecisions skips a fresh cache (no fetch)', async () => {
  const repo = tmpRepo();
  // seed a fresh cache
  await syncDecisions(
    { cwd: repo },
    {
      readConfigImpl: async () => authedConfig,
      resolveRepoRootImpl: () => repo,
      now: () => new Date('2026-07-11T12:00:00Z'),
      fetchImpl: async () => jsonResponse({ ok: true, flows: [], decisions: [] }),
    },
  );
  let fetched = false;
  const out = await syncDecisions(
    { cwd: repo },
    {
      readConfigImpl: async () => authedConfig,
      resolveRepoRootImpl: () => repo,
      now: () => new Date('2026-07-11T13:00:00Z'), // 1h later, < 6h TTL
      fetchImpl: async () => { fetched = true; return jsonResponse({ ok: true, flows: [], decisions: [] }); },
    },
  );
  assert.equal(out.status, 'fresh');
  assert.equal(fetched, false, 'a fresh cache is not re-fetched');
  rmSync(repo, { recursive: true, force: true });
});

test('syncDecisions --force re-fetches even when fresh', async () => {
  const repo = tmpRepo();
  await syncDecisions(
    { cwd: repo },
    { readConfigImpl: async () => authedConfig, resolveRepoRootImpl: () => repo, now: () => new Date('2026-07-11T12:00:00Z'), fetchImpl: async () => jsonResponse({ ok: true, flows: [], decisions: [] }) },
  );
  let fetched = false;
  const out = await syncDecisions(
    { cwd: repo, force: true },
    {
      readConfigImpl: async () => authedConfig,
      resolveRepoRootImpl: () => repo,
      now: () => new Date('2026-07-11T12:30:00Z'),
      fetchImpl: async () => { fetched = true; return jsonResponse({ ok: true, flows: [], decisions: [{ id: 'd9', title: 'new' }] }); },
    },
  );
  assert.equal(out.status, 'synced');
  assert.equal(fetched, true);
  rmSync(repo, { recursive: true, force: true });
});

test('syncDecisions surfaces a rejected read as read-failed (cache untouched)', async () => {
  const repo = tmpRepo();
  const out = await syncDecisions(
    { cwd: repo },
    {
      readConfigImpl: async () => authedConfig,
      resolveRepoRootImpl: () => repo,
      fetchImpl: async () => jsonResponse({ error: 'forbidden' }, 403),
    },
  );
  assert.equal(out.status, 'read-failed');
  assert.match(out.detail, /403/);
  assert.equal(await readCache(repo), null, 'nothing written on a rejected read');
  rmSync(repo, { recursive: true, force: true });
});
