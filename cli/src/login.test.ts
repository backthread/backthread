import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { login, ensureAuth, deviceLabel } from './login.js';
import { writeConfig, readConfig } from './config.js';

async function withTempEnv(fn: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'backthread-login-'));
  const env = { ...process.env, BACKTHREAD_CONFIG_DIR: join(dir, '.backthread') } as NodeJS.ProcessEnv;
  try {
    await fn(env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('login --device returns a clear not-implemented stub (no throw, no token)', async () => {
  await withTempEnv(async (env) => {
    const logs: string[] = [];
    const result = await login({ device: true, env, log: (m) => logs.push(m) });
    assert.equal(result.ok, false);
    assert.match(result.message, /not implemented/i);
    // Nothing was written to config.
    assert.deepEqual(await readConfig(env), {});
    // The guidance mentions the manual fallback.
    assert.ok(logs.join('\n').includes('Connected devices'));
  });
});

test('ensureAuth short-circuits when a token already exists (no browser flow)', async () => {
  await withTempEnv(async (env) => {
    await writeConfig({ device_token: 'backthread_pat_existing', account: 'acc' }, env);
    const cfg = await ensureAuth({ env });
    assert.equal(cfg.device_token, 'backthread_pat_existing');
    assert.equal(cfg.account, 'acc');
  });
});

test('ensureAuth re-running with a token + NO claim never re-mints (idempotent)', async () => {
  // The re-run safety AC: a second run with an already-stored
  // token must reuse it, never start the loopback or a claim exchange. We prove
  // the short-circuit by passing noBrowser:false — if ensureAuth fell through to
  // login() it would try to open a browser + start the loopback server; instead
  // it returns the cached config untouched and the token is unchanged.
  await withTempEnv(async (env) => {
    await writeConfig({ device_token: 'backthread_pat_existing', repo: 'o/r' }, env);
    const cfg = await ensureAuth({ env, noBrowser: false });
    assert.equal(cfg.device_token, 'backthread_pat_existing');
    // The on-disk config is unchanged (no fresh mint overwrote it).
    assert.deepEqual(await readConfig(env), { device_token: 'backthread_pat_existing', repo: 'o/r' });
  });
});

test('ensureAuth WITH an explicit --claim re-exchanges even when a token exists', async () => {
  // The complementary case: a deliberate `--claim` is a re-bind, so it must NOT
  // short-circuit. With an unreachable functions origin the exchange fails — but
  // crucially it was ATTEMPTED (ensureAuth threw rather than returning the cached
  // token), which is what distinguishes claim-present from claim-absent.
  await withTempEnv(async (env) => {
    await writeConfig({ device_token: 'backthread_pat_existing' }, env);
    const claimEnv = { ...env, BACKTHREAD_FUNCTIONS_URL: 'http://127.0.0.1:1/functions/v1/' } as NodeJS.ProcessEnv;
    await assert.rejects(
      ensureAuth({ env: claimEnv, claim: 'backthread_claim_abc', log: () => {} }),
      /reach the exchange endpoint|Exchange failed|claim code/i,
    );
  });
});

test('deviceLabel returns a non-empty string', () => {
  assert.ok(deviceLabel().length > 0);
});
