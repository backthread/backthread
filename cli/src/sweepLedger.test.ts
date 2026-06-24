import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_PROCESSED,
  addProcessed,
  markSweepProcessed,
  parseSweepState,
  readSweepState,
  serializeSweepState,
  sweepStatePath,
  writeSweepState,
  type SweepState,
} from './sweepLedger.js';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-sweep-'));
  return { BACKTHREAD_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
}

// --- parse (defensive) -------------------------------------------------------

test('parseSweepState: empty/garbage → empty state (fail open)', () => {
  for (const raw of ['', '{', 'null', '[]', '"x"', '42']) {
    assert.deepEqual(parseSweepState(raw), { processed: [], lastSweptAt: {} });
  }
});

test('parseSweepState: keeps string processed ids + string lastSweptAt entries only', () => {
  const raw = JSON.stringify({
    processed: ['a', 1, 'b', null, 'c'],
    lastSweptAt: { 'o/r': '2026-06-24T00:00:00Z', bad: 5, also: '' },
  });
  assert.deepEqual(parseSweepState(raw), {
    processed: ['a', 'b', 'c'],
    lastSweptAt: { 'o/r': '2026-06-24T00:00:00Z' },
  });
});

test('serialize → parse round-trips', () => {
  const state: SweepState = { processed: ['s1', 's2'], lastSweptAt: { 'o/r': '2026-06-24T10:00:00Z' } };
  assert.deepEqual(parseSweepState(serializeSweepState(state)), state);
});

// --- addProcessed (pure) -----------------------------------------------------

test('addProcessed appends new ids, de-dupes, ignores empties', () => {
  const s0: SweepState = { processed: ['a'], lastSweptAt: {} };
  const s1 = addProcessed(s0, ['b', 'a', '', 'c', 'b']);
  assert.deepEqual(s1.processed, ['a', 'b', 'c']);
  // pure — original untouched
  assert.deepEqual(s0.processed, ['a']);
});

test('addProcessed bounds the ring to MAX_PROCESSED (oldest fall off)', () => {
  const seed = Array.from({ length: MAX_PROCESSED }, (_, i) => `s${i}`);
  const s1 = addProcessed({ processed: seed, lastSweptAt: {} }, ['NEW1', 'NEW2']);
  assert.equal(s1.processed.length, MAX_PROCESSED);
  assert.equal(s1.processed.at(-1), 'NEW2');
  assert.equal(s1.processed.at(-2), 'NEW1');
  assert.equal(s1.processed[0], 's2'); // s0, s1 fell off the front
});

// --- read/write round-trip (real fs, temp dir) -------------------------------

test('write → read round-trips through disk; file is 0600', async () => {
  const env = await tempEnv();
  const state: SweepState = { processed: ['x', 'y'], lastSweptAt: { 'o/r': '2026-06-24T00:00:00Z' } };
  await writeSweepState(state, env);
  assert.deepEqual(await readSweepState(env), state);
  const mode = (await stat(sweepStatePath(env))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('readSweepState: missing file → empty state (never throws)', async () => {
  const env = await tempEnv();
  assert.deepEqual(await readSweepState(env), { processed: [], lastSweptAt: {} });
});

test('readSweepState: corrupt file → empty state (fail open)', async () => {
  const env = await tempEnv();
  await writeFile(sweepStatePath(env), 'not json{', { mode: 0o600 });
  assert.deepEqual(await readSweepState(env), { processed: [], lastSweptAt: {} });
});

// --- markSweepProcessed (live-capture path) ----------------------------------

test('markSweepProcessed records one id; idempotent; no-op for empty', async () => {
  const env = await tempEnv();
  await markSweepProcessed('s1', env);
  await markSweepProcessed('s1', env); // already present — no duplicate
  await markSweepProcessed('  ', env); // whitespace → ignored
  await markSweepProcessed(null, env);
  assert.deepEqual((await readSweepState(env)).processed, ['s1']);
});

test('markSweepProcessed preserves existing lastSweptAt + prior ids', async () => {
  const env = await tempEnv();
  await writeSweepState({ processed: ['old'], lastSweptAt: { 'o/r': '2026-06-24T00:00:00Z' } }, env);
  await markSweepProcessed('new', env);
  assert.deepEqual(await readSweepState(env), {
    processed: ['old', 'new'],
    lastSweptAt: { 'o/r': '2026-06-24T00:00:00Z' },
  });
});

test('readSweepState tolerates a hand-written partial file', async () => {
  const env = await tempEnv();
  await writeFile(sweepStatePath(env), JSON.stringify({ processed: ['a'] }), { mode: 0o600 });
  assert.deepEqual(await readSweepState(env), { processed: ['a'], lastSweptAt: {} });
});
