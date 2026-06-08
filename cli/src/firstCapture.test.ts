import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstCaptureMessage, maybeFirstCaptureConfirm } from './firstCapture.js';
import { readFirstRunState, updateFirstRunState } from './firstRun.js';

// Isolate the shared first-run state file under a temp BACKTHREAD_CONFIG_DIR — no real
// ~/.backthread is touched (mirrors connectNudge.test.ts).
async function withTempEnv(fn: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'backthread-firstcap-'));
  const env = { ...process.env, BACKTHREAD_CONFIG_DIR: join(dir, '.backthread') } as NodeJS.ProcessEnv;
  try {
    await fn(env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REPO = { owner: 'acme', name: 'app' };

// --- firstCaptureMessage -----------------------------------------------------

test('firstCaptureMessage uses the deep-link helper + the customer noun, never "architectural memory"', () => {
  const env = { BACKTHREAD_APP_URL: 'http://localhost:5173' } as unknown as NodeJS.ProcessEnv;
  const m = firstCaptureMessage(3, REPO, env);
  assert.match(m, /captured 3 decisions/);
  assert.match(m, /http:\/\/localhost:5173\/acme\/app/);
  assert.match(m, /How it works/);
  assert.doesNotMatch(m, /architectural memory/i);
});

test('firstCaptureMessage singularizes a count of 1', () => {
  const m = firstCaptureMessage(1, REPO);
  assert.match(m, /captured 1 decision\b/);
  assert.doesNotMatch(m, /1 decisions/);
});

// --- maybeFirstCaptureConfirm: once-only -------------------------------------

test('confirm shown ONCE for a connected landing, then suppressed forever (idempotent)', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const first = await maybeFirstCaptureConfirm(2, true, REPO, { env, log: (m) => lines.push(m) });
    assert.equal(first, true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /view them in your "How it works" diagram/);
    // Flag persisted.
    assert.equal((await readFirstRunState(env)).firstCaptureShown, true);

    const second = await maybeFirstCaptureConfirm(5, true, REPO, { env, log: (m) => lines.push(m) });
    assert.equal(second, false, 'never shown again');
    assert.equal(lines.length, 1);
  });
});

// --- maybeFirstCaptureConfirm: suppression cases -----------------------------

test('confirm suppressed when the repo is NOT connected (connect nudge owns that case)', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const shown = await maybeFirstCaptureConfirm(3, false, REPO, { env, log: (m) => lines.push(m) });
    assert.equal(shown, false);
    assert.equal(lines.length, 0);
    // No flag set — so a LATER connected capture still gets the confirmation.
    assert.equal((await readFirstRunState(env)).firstCaptureShown, undefined);
  });
});

test('confirm suppressed when no repo / nothing captured', async () => {
  await withTempEnv(async (env) => {
    assert.equal(await maybeFirstCaptureConfirm(3, true, null, { env, log: () => {} }), false);
    assert.equal(await maybeFirstCaptureConfirm(0, true, REPO, { env, log: () => {} }), false);
    assert.equal(await maybeFirstCaptureConfirm(-1, true, REPO, { env, log: () => {} }), false);
  });
});

test('confirm suppressed when already shown (flag pre-set)', async () => {
  await withTempEnv(async (env) => {
    await updateFirstRunState({ firstCaptureShown: true }, env);
    const lines: string[] = [];
    const shown = await maybeFirstCaptureConfirm(3, true, REPO, { env, log: (m) => lines.push(m) });
    assert.equal(shown, false);
    assert.equal(lines.length, 0);
  });
});

// --- never throws ------------------------------------------------------------

test('maybeFirstCaptureConfirm NEVER throws (write failure swallowed)', async () => {
  const lines: string[] = [];
  let returned: boolean | undefined;
  await assert.doesNotReject(async () => {
    returned = await maybeFirstCaptureConfirm(2, true, REPO, {
      env: {} as NodeJS.ProcessEnv,
      log: (m) => lines.push(m),
      readStateImpl: async () => ({}),
      writeStateImpl: async () => {
        throw new Error('disk full');
      },
    });
  });
  assert.equal(lines.length, 1, 'the confirmation was still printed before the failed write');
  assert.equal(returned, false, 'a failed persist degrades to false');
});
