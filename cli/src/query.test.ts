import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryDecisions, resolveQueryRepo, type QueryDeps } from './query.js';
import type { BackthreadConfig } from './config.js';

// GUARDRAIL: every test injects a config WITH a device_token + a mocked fetch +
// (where relevant) a git-remote reader, so NOTHING here hits real auth, network,
// or a browser. There is no ensureAuth/login seam in the query path at all — query
// is an explicit user action that simply reports "run `backthread login`" when unauthed.

const ENV: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;
const CONFIG: BackthreadConfig = { account: 'acc-1', repo: 'acme/app', device_token: 'backthread_pat_secret' };

// A fetch stub that asserts it only ever hits /read-decisions and records the call.
function stubFetch(resp: { status: number; body: unknown }): {
  fetch: typeof fetch;
  calls: Array<{ url: string; body: unknown; auth: string | undefined; version: string | undefined }>;
} {
  const calls: Array<{ url: string; body: unknown; auth: string | undefined; version: string | undefined }> =
    [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, body, auth: headers.Authorization, version: headers['x-backthread-version'] });
    if (!url.includes('/read-decisions')) {
      throw new Error(`unexpected url: ${url}`);
    }
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => resp.body,
    } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function deps(over: Partial<QueryDeps> = {}): QueryDeps {
  return {
    env: ENV,
    readConfigImpl: async () => CONFIG,
    readRemoteImpl: () => 'git@github.com:acme/app.git',
    ...over,
  };
}

const OK_BODY = {
  ok: true,
  repo: { owner: 'acme', name: 'app' },
  flows: [
    { id: 'f1', name: 'Checkout', lifecycle: 'active', salience: 9, canonicalFlowId: null },
    { id: 'f2', name: 'Auth', lifecycle: 'active', salience: 5, canonicalFlowId: 'f1' },
  ],
  decisions: [
    {
      id: 'd1',
      title: 'Use a queue',
      why: 'decouple ingestion',
      significance: 8,
      domainRisk: 'high',
      decidedAt: '2026-06-01T00:00:00Z',
      flowIds: ['f1'],
      moduleIds: ['m1'],
    },
  ],
};

// --- resolveQueryRepo (pure precedence) --------------------------------------

test('resolveQueryRepo: explicit string slug wins over config + cwd', () => {
  const r = resolveQueryRepo({ repo: 'foo/bar', cwd: '/x' }, CONFIG, () => 'git@github.com:zzz/yyy.git');
  assert.deepEqual(r, { owner: 'foo', name: 'bar' });
});

test('resolveQueryRepo: explicit {owner,name} wins', () => {
  const r = resolveQueryRepo({ repo: { owner: 'o', name: 'n' } }, CONFIG);
  assert.deepEqual(r, { owner: 'o', name: 'n' });
});

test('resolveQueryRepo: falls back to config.repo', () => {
  const r = resolveQueryRepo({ cwd: '/x' }, CONFIG, () => null);
  assert.deepEqual(r, { owner: 'acme', name: 'app' });
});

test('resolveQueryRepo: falls back to cwd git remote when no config repo', () => {
  const r = resolveQueryRepo({ cwd: '/x' }, { device_token: 't' }, () => 'git@github.com:zzz/yyy.git');
  assert.deepEqual(r, { owner: 'zzz', name: 'yyy' });
});

test('resolveQueryRepo: malformed slug ignored, falls through', () => {
  const r = resolveQueryRepo({ repo: 'no-slash' }, CONFIG, () => null);
  assert.deepEqual(r, { owner: 'acme', name: 'app' }); // config.repo
});

test('resolveQueryRepo: returns null when nothing resolves', () => {
  const r = resolveQueryRepo({ cwd: '/x' }, { device_token: 't' }, () => null);
  assert.equal(r, null);
});

// --- queryDecisions ----------------------------------------------------------

test('queryDecisions: happy path returns ranked flows/decisions + deep-link', async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: OK_BODY });
  const out = await queryDecisions({ repo: 'acme/app' }, deps({ fetchImpl: fetch }));

  assert.equal(out.status, 'ok');
  assert.deepEqual(out.repo, { owner: 'acme', name: 'app' });
  assert.equal(out.flows?.length, 2);
  assert.equal(out.decisions?.length, 1);
  assert.equal(out.flows?.[0].name, 'Checkout');
  assert.equal(out.decisions?.[0].why, 'decouple ingestion');
  assert.equal(out.deepLink, 'https://app.backthread.dev/acme/app');

  // exactly one call, to read-decisions, bearer the device token, repo in body.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/read-decisions$/);
  assert.equal(calls[0].auth, 'Bearer backthread_pat_secret');
  assert.deepEqual(calls[0].body, { repo: { owner: 'acme', name: 'app' } });
  // The cli stamps its version so the server can run the compat guard.
  assert.match(calls[0].version ?? '', /^\d+\.\d+\.\d+/);
});

test('queryDecisions: surfaces a non-fatal server upgrade nudge in the detail', async () => {
  const { fetch } = stubFetch({
    status: 200,
    body: { ...OK_BODY, upgrade: 'A newer `backthread` is available — run `npm i -g backthread@latest`.' },
  });
  const out = await queryDecisions({ repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'ok');
  assert.match(out.detail, /newer `backthread` is available/);
});

test('queryDecisions: a 426 too-old soft-block prefers the friendly message', async () => {
  const { fetch } = stubFetch({
    status: 426,
    body: { error: 'client_too_old', message: 'Your `backthread` is too old — run `npm i -g backthread@latest`.' },
  });
  const out = await queryDecisions({ repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'read-failed');
  assert.match(out.detail, /too old/);
  assert.match(out.detail, /npm i -g backthread@latest/);
});

test('queryDecisions: no device token → no-auth, NO fetch, NO login triggered', async () => {
  let fetched = false;
  const out = await queryDecisions(
    { repo: 'acme/app' },
    deps({
      readConfigImpl: async () => ({ account: 'a' }), // no device_token
      fetchImpl: (async () => {
        fetched = true;
        throw new Error('must not fetch');
      }) as typeof fetch,
    }),
  );
  assert.equal(out.status, 'no-auth');
  assert.equal(fetched, false);
  assert.match(out.detail, /backthread login/);
});

test('queryDecisions: no resolvable repo → no-repo, NO fetch', async () => {
  let fetched = false;
  const out = await queryDecisions(
    {}, // no repo arg, no cwd
    deps({
      readConfigImpl: async () => ({ device_token: 't' }), // no config.repo
      readRemoteImpl: () => null,
      fetchImpl: (async () => {
        fetched = true;
        throw new Error('must not fetch');
      }) as typeof fetch,
    }),
  );
  assert.equal(out.status, 'no-repo');
  assert.equal(fetched, false);
});

test('queryDecisions: server rejection surfaces read-failed with detail + deep-link', async () => {
  const { fetch } = stubFetch({ status: 403, body: { error: 'not a member' } });
  const out = await queryDecisions({ repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'read-failed');
  assert.match(out.detail, /403/);
  assert.match(out.detail, /not a member/);
  // deep-link is still returned (repo was resolvable) so the agent can offer it.
  assert.equal(out.deepLink, 'https://app.backthread.dev/acme/app');
});

test('queryDecisions: network throw surfaces read-failed (never throws)', async () => {
  const out = await queryDecisions(
    { repo: 'acme/app' },
    deps({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    }),
  );
  assert.equal(out.status, 'read-failed');
  assert.match(out.detail, /ECONNREFUSED/);
});

test('queryDecisions: malformed payload coerces to empty lists, still ok', async () => {
  const { fetch } = stubFetch({ status: 200, body: { ok: true, flows: 'nope', decisions: null } });
  const out = await queryDecisions({ repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.flows, []);
  assert.deepEqual(out.decisions, []);
});

test('queryDecisions: token never appears in the outcome detail', async () => {
  const { fetch } = stubFetch({ status: 500, body: { error: 'boom' } });
  const out = await queryDecisions({ repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'read-failed');
  assert.ok(!JSON.stringify(out).includes('backthread_pat_secret'), 'device token leaked into outcome');
});

test('queryDecisions: BACKTHREAD_APP_URL override flows into the deep-link', async () => {
  const { fetch } = stubFetch({ status: 200, body: OK_BODY });
  const out = await queryDecisions(
    { repo: 'acme/app' },
    deps({ fetchImpl: fetch, env: { BACKTHREAD_APP_URL: 'http://localhost:5173' } as NodeJS.ProcessEnv }),
  );
  assert.equal(out.deepLink, 'http://localhost:5173/acme/app');
});
