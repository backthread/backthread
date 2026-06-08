import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchOnboardingState,
  resolveOnboardingRepo,
  normalizeState,
  type OnboardingDeps,
} from './onboardingState.js';
import type { BackthreadConfig } from './config.js';

// GUARDRAIL (mirrors query.test.ts): every test injects a config + a mocked fetch +
// a git-remote reader, so NOTHING here hits real auth, network, or a browser. The
// future plugin first-run reads this module; we test its outcomes exhaustively.

const ENV: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;
const CONFIG: BackthreadConfig = {
  account: 'acc-1',
  repo: 'acme/app',
  device_token: 'backthread_pat_secret',
};

// A fetch stub that asserts it only ever hits /onboarding-state and records the call.
function stubFetch(resp: { status: number; body: unknown }): {
  fetch: typeof fetch;
  calls: Array<{ url: string; body: unknown; auth: string | undefined; version: string | undefined }>;
} {
  const calls: Array<{ url: string; body: unknown; auth: string | undefined; version: string | undefined }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, body, auth: headers.Authorization, version: headers['x-backthread-version'] });
    if (!url.includes('/onboarding-state')) throw new Error(`unexpected url: ${url}`);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => resp.body,
    } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function deps(over: Partial<OnboardingDeps> = {}): OnboardingDeps {
  return {
    env: ENV,
    readConfigImpl: async () => CONFIG,
    readRemoteImpl: () => 'git@github.com:acme/app.git',
    ...over,
  };
}

const COLD_START_BODY = {
  ok: true,
  repo: null,
  signals: { repoConnected: false, agentCapturing: false, anythingCaptured: false },
  cell: '000',
  nextStep: { slug: 'cold_start', title: 'Pick a door', body: 'Connect a repo or install the plugin.' },
  terminal: null,
  repoSyncStatus: null,
};

const DONE_BODY = {
  ok: true,
  repo: { owner: 'acme', name: 'app' },
  signals: { repoConnected: true, agentCapturing: true, anythingCaptured: true },
  cell: '111',
  nextStep: null,
  terminal: 'fully_onboarded',
  repoSyncStatus: 'ready',
};

// --- resolveOnboardingRepo ---------------------------------------------------

test('resolveOnboardingRepo: explicit slug > config > cwd remote', () => {
  assert.deepEqual(resolveOnboardingRepo({ repo: 'x/y' }, CONFIG), { owner: 'x', name: 'y' });
  assert.deepEqual(resolveOnboardingRepo({ repo: { owner: 'a', name: 'b' } }, CONFIG), { owner: 'a', name: 'b' });
  assert.deepEqual(resolveOnboardingRepo({}, CONFIG), { owner: 'acme', name: 'app' }); // config.repo
});

test('resolveOnboardingRepo returns null when nothing resolves (cold-start, NOT an error)', () => {
  assert.equal(resolveOnboardingRepo({}, {} as BackthreadConfig), null);
});

// --- fetchOnboardingState: auth gate ----------------------------------------

test('no device token → no-auth (tells the user to log in; no network)', async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: COLD_START_BODY });
  const out = await fetchOnboardingState({}, deps({ readConfigImpl: async () => ({}), fetchImpl: fetch }));
  assert.equal(out.status, 'no-auth');
  assert.match(out.detail, /backthread login/);
  assert.equal(calls.length, 0, 'never hits the network when unauthed');
});

// --- fetchOnboardingState: the repo-less (cold start) call -------------------

test('no repo resolvable → posts an EMPTY body (account-level cold-start view)', async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: COLD_START_BODY });
  const out = await fetchOnboardingState(
    {},
    deps({ fetchImpl: fetch, readConfigImpl: async () => ({ device_token: 'backthread_pat_x' }), readRemoteImpl: () => null }),
  );
  assert.equal(out.status, 'ok');
  assert.deepEqual(calls[0].body, {}, 'no repo_slug when none resolved');
  assert.equal(out.state?.nextStep?.slug, 'cold_start');
  assert.equal(out.state?.terminal, null);
});

// --- fetchOnboardingState: the repo-scoped call ------------------------------

test('a resolved repo → posts repo_slug, sends bearer token + version header', async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: DONE_BODY });
  const out = await fetchOnboardingState({}, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'ok');
  assert.deepEqual(calls[0].body, { repo_slug: 'acme/app' });
  assert.equal(calls[0].auth, 'Bearer backthread_pat_secret');
  assert.ok(calls[0].version, 'sends the x-backthread-version header');
  // Terminal state surfaces cleanly: no next step.
  assert.equal(out.state?.nextStep, null);
  assert.equal(out.state?.terminal, 'fully_onboarded');
  assert.equal(out.state?.repoSyncStatus, 'ready');
});

// --- fetchOnboardingState: failures are SWALLOWED into outcomes --------------

test('a non-2xx response → fetch-failed (never throws)', async () => {
  const { fetch } = stubFetch({ status: 401, body: { error: 'invalid token' } });
  const out = await fetchOnboardingState({}, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'fetch-failed');
  assert.match(out.detail, /401/);
});

test('a thrown fetch → fetch-failed (never throws)', async () => {
  const fetchImpl = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  const out = await fetchOnboardingState({}, deps({ fetchImpl }));
  assert.equal(out.status, 'fetch-failed');
  assert.match(out.detail, /network down/);
});

// --- normalizeState: defensive against a malformed payload -------------------

test('normalizeState coerces a garbage payload to a safe default (no crash)', () => {
  const s = normalizeState({ signals: 'nope', nextStep: 42, terminal: 'bogus' });
  assert.deepEqual(s.signals, { repoConnected: false, agentCapturing: false, anythingCaptured: false });
  assert.equal(s.nextStep, null, 'a non-object nextStep → null');
  assert.equal(s.terminal, null, 'an unknown terminal is dropped to null');
  assert.equal(s.cell, '');
});

test('normalizeState KEEPS an unknown slug (forward-compat: a newer server may ship a fifth step)', () => {
  // (PR #75): unknown slugs are renderable copy, NOT terminal. They must be
  // kept (consistent with connectNudge.parseNextStep), distinguishable from null.
  const s = normalizeState({
    nextStep: { slug: 'a_future_step', title: 'Do the new thing', body: 'Some new guidance.' },
  });
  assert.equal(s.nextStep?.slug, 'a_future_step');
  assert.equal(s.nextStep?.title, 'Do the new thing');
  assert.equal(s.nextStep?.body, 'Some new guidance.');
});

test('normalizeState still drops a malformed nextStep object with no string slug', () => {
  const s = normalizeState({ nextStep: { title: 'no slug' } });
  assert.equal(s.nextStep, null);
});

test('normalizeState keeps a well-formed next step + terminal', () => {
  const s = normalizeState(COLD_START_BODY);
  assert.equal(s.nextStep?.slug, 'cold_start');
  assert.equal(s.signals.repoConnected, false);
  const done = normalizeState(DONE_BODY);
  assert.equal(done.nextStep, null);
  assert.equal(done.terminal, 'fully_onboarded');
  assert.deepEqual(done.repo, { owner: 'acme', name: 'app' });
});
