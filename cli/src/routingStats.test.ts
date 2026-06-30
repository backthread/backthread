// ARP-763 — routing-stats local counter tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRoutingStats, recordRoutingInjected } from './routingStats.js';

const ENV = { HOME: '/home/test' } as unknown as NodeJS.ProcessEnv;

test('readRoutingStats: parses a stored file', async () => {
  const stats = await readRoutingStats({
    env: ENV,
    readFileImpl: async () => JSON.stringify({ injected: 7, lastInjectedAt: '2026-07-01T00:00:00.000Z' }),
  });
  assert.deepEqual(stats, { injected: 7, lastInjectedAt: '2026-07-01T00:00:00.000Z' });
});

test('readRoutingStats: absent/corrupt file → zeroed default (never throws)', async () => {
  const absent = await readRoutingStats({ env: ENV, readFileImpl: async () => { throw new Error('ENOENT'); } });
  assert.deepEqual(absent, { injected: 0 });
  const corrupt = await readRoutingStats({ env: ENV, readFileImpl: async () => 'not json' });
  assert.deepEqual(corrupt, { injected: 0 });
});

test('recordRoutingInjected: increments and writes with a fresh timestamp', async () => {
  let written = '';
  await recordRoutingInjected({
    env: ENV,
    now: () => new Date('2026-07-01T12:00:00.000Z'),
    readFileImpl: async () => JSON.stringify({ injected: 4 }),
    writeFileImpl: async (_p, data) => { written = data; },
    mkdirImpl: async () => undefined,
    chmodImpl: async () => undefined,
  });
  const parsed = JSON.parse(written);
  assert.equal(parsed.injected, 5); // 4 → 5
  assert.equal(parsed.lastInjectedAt, '2026-07-01T12:00:00.000Z');
});

test('recordRoutingInjected: first-ever record starts at 1', async () => {
  let written = '';
  await recordRoutingInjected({
    env: ENV,
    now: () => new Date('2026-07-01T12:00:00.000Z'),
    readFileImpl: async () => { throw new Error('ENOENT'); },
    writeFileImpl: async (_p, data) => { written = data; },
    mkdirImpl: async () => undefined,
    chmodImpl: async () => undefined,
  });
  assert.equal(JSON.parse(written).injected, 1);
});

test('recordRoutingInjected: a write failure is swallowed (best-effort, never throws)', async () => {
  await assert.doesNotReject(
    recordRoutingInjected({
      env: ENV,
      readFileImpl: async () => JSON.stringify({ injected: 0 }),
      writeFileImpl: async () => { throw new Error('EACCES'); },
      mkdirImpl: async () => undefined,
      chmodImpl: async () => undefined,
    }),
  );
});
