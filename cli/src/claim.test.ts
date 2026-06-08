// — tests for the claim-code exchange client (the CLI half of the
// /device/claim pair). node:test + tsx, like the rest of cli/ (NOT vitest).
//
// No live network (fetch is injected), no real $HOME (BACKTHREAD_CONFIG_DIR
// points at a temp dir, same pattern as config.test.ts). The invariant under
// test everywhere: the token lands ONLY in the 0600 config file — never in a
// message, never in the request URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exchangeClaim, isClaimCode, buildExchangeClaimUrl, CLAIM_PREFIX } from './claim.js';
import { configPath, parseConfig, writeConfig, CONFIG_MODE } from './config.js';

const TOKEN = 'backthread_pat_test-token-value';
const CODE = 'backthread_claim_test-code';

async function withTempEnv(fn: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'backthread-claim-'));
  const env = { ...process.env, BACKTHREAD_CONFIG_DIR: join(dir, '.backthread') } as NodeJS.ProcessEnv;
  try {
    await fn(env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A fetch stub that records calls and returns the given response. */
function fetchStub(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

test('isClaimCode accepts prefix+body, rejects tokens / bare prefix / junk', () => {
  assert.equal(isClaimCode('backthread_claim_abc'), true);
  assert.equal(isClaimCode(CLAIM_PREFIX), false);
  assert.equal(isClaimCode('backthread_pat_abc'), false);
  assert.equal(isClaimCode('whatever'), false);
});

test('buildExchangeClaimUrl targets the Functions origin and honors the override', () => {
  assert.equal(
    buildExchangeClaimUrl({} as NodeJS.ProcessEnv),
    'https://yempemohevgpctkpstuf.supabase.co/functions/v1/exchange-claim',
  );
  assert.equal(
    buildExchangeClaimUrl({ BACKTHREAD_FUNCTIONS_URL: 'http://localhost:54321/functions/v1/' } as NodeJS.ProcessEnv),
    'http://localhost:54321/functions/v1/exchange-claim',
  );
});

test('a malformed code fails fast with zero network', async () => {
  await withTempEnv(async (env) => {
    const { impl, calls } = fetchStub(201, {});
    const result = await exchangeClaim('not-a-code', { env, fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.match(result.message, /claim code/);
    assert.equal(calls.length, 0, 'must not hit the network for a shape-invalid code');
  });
});

test('happy path: token + account written 0600; never in URL or message', async () => {
  await withTempEnv(async (env) => {
    const { impl, calls } = fetchStub(201, { ok: true, token: TOKEN, account: 'acc-1', scopes: ['capture'] });
    const result = await exchangeClaim(`  ${CODE}  `, { env, fetchImpl: impl, label: 'test-host' });

    assert.equal(result.ok, true);
    assert.ok(!result.message.includes(TOKEN), 'message must never contain the token');

    // One POST; the code travels in the BODY (trimmed), never the URL.
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].url.includes(CODE), 'code must not be in the URL');
    const sent = JSON.parse(String(calls[0].init.body));
    assert.equal(sent.code, CODE);
    assert.equal(sent.label, 'test-host');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.ok(headers['x-backthread-version'], 'must stamp the version header');

    // Token + account persisted at 0600.
    const path = configPath(env);
    const st = await stat(path);
    assert.equal(st.mode & 0o777, CONFIG_MODE, 'config.json must be 0600');
    const cfg = parseConfig(await readFile(path, 'utf8'));
    assert.equal(cfg.device_token, TOKEN);
    assert.equal(cfg.account, 'acc-1');
  });
});

test('read-modify-write: an existing repo slug survives the exchange', async () => {
  await withTempEnv(async (env) => {
    await writeConfig({ repo: 'owner/name' }, env);
    const { impl } = fetchStub(201, { ok: true, token: TOKEN, account: 'acc-1' });
    const result = await exchangeClaim(CODE, { env, fetchImpl: impl });
    assert.equal(result.ok, true);
    const cfg = parseConfig(await readFile(configPath(env), 'utf8'));
    assert.deepEqual(cfg, { account: 'acc-1', repo: 'owner/name', device_token: TOKEN });
  });
});

test('a 2xx without a token is a failure (no config write)', async () => {
  await withTempEnv(async (env) => {
    const { impl } = fetchStub(201, { ok: true });
    const result = await exchangeClaim(CODE, { env, fetchImpl: impl });
    assert.equal(result.ok, false);
    const cfg = parseConfig(await readFile(configPath(env), 'utf8').catch(() => '{}'));
    assert.equal(cfg.device_token, undefined);
  });
});

test('server error slugs map to actionable messages', async () => {
  await withTempEnv(async (env) => {
    const cases: Array<[number, string, RegExp]> = [
      [404, 'invalid_code', /Unknown claim code/],
      [400, 'code_expired', /expired/],
      [400, 'code_used', /already used/],
      [429, 'rate_limited', /wait a few minutes/],
    ];
    for (const [status, slug, expected] of cases) {
      const { impl } = fetchStub(status, { error: slug });
      const result = await exchangeClaim(CODE, { env, fetchImpl: impl });
      assert.equal(result.ok, false, slug);
      assert.match(result.message, expected, slug);
    }
  });
});

test('an unknown error slug falls back to the HTTP status + server message', async () => {
  await withTempEnv(async (env) => {
    const { impl } = fetchStub(500, { error: 'mint_failed', message: 'boom' });
    const result = await exchangeClaim(CODE, { env, fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.match(result.message, /HTTP 500/);
    assert.match(result.message, /boom/);
  });
});

test('a network failure is reported, not thrown', async () => {
  await withTempEnv(async (env) => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await exchangeClaim(CODE, { env, fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.match(result.message, /ECONNREFUSED/);
  });
});

test('a non-JSON error response still yields a clean failure', async () => {
  await withTempEnv(async (env) => {
    const impl = (async () =>
      new Response('<html>gateway error</html>', { status: 502 })) as unknown as typeof fetch;
    const result = await exchangeClaim(CODE, { env, fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.match(result.message, /HTTP 502/);
  });
});
