import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCliAuthUrl,
  appBaseUrl,
  DEFAULT_APP_URL,
  workerBaseUrl,
  DEFAULT_WORKER_URL,
  buildInferDecisionsUrl,
  buildGroundedAskUrl,
  buildReadDecisionsUrl,
  buildOnboardingStateUrl,
  buildRepoDeepLink,
  DEFAULT_FUNCTIONS_URL,
} from './urls.js';
import { browserCommand } from './browser.js';

test('appBaseUrl defaults to production', () => {
  assert.equal(appBaseUrl({} as NodeJS.ProcessEnv), DEFAULT_APP_URL);
});

test('appBaseUrl honors BACKTHREAD_APP_URL and trims trailing slash', () => {
  assert.equal(
    appBaseUrl({ BACKTHREAD_APP_URL: 'http://localhost:5173/' } as NodeJS.ProcessEnv),
    'http://localhost:5173',
  );
});

test('buildCliAuthUrl encodes port + state on the /cli-auth path', () => {
  const url = buildCliAuthUrl(54321, 'nonce-abc', {} as NodeJS.ProcessEnv);
  const u = new URL(url);
  assert.equal(u.origin, DEFAULT_APP_URL);
  assert.equal(u.pathname, '/cli-auth');
  assert.equal(u.searchParams.get('port'), '54321');
  assert.equal(u.searchParams.get('state'), 'nonce-abc');
});

test('workerBaseUrl defaults to the production ingest Worker', () => {
  assert.equal(workerBaseUrl({} as NodeJS.ProcessEnv), DEFAULT_WORKER_URL);
});

test('workerBaseUrl honors BACKTHREAD_WORKER_URL and trims trailing slash', () => {
  assert.equal(
    workerBaseUrl({ BACKTHREAD_WORKER_URL: 'http://localhost:8787/' } as NodeJS.ProcessEnv),
    'http://localhost:8787',
  );
});

test('buildInferDecisionsUrl points at /infer-decisions on the worker origin', () => {
  const url = buildInferDecisionsUrl({} as NodeJS.ProcessEnv);
  const u = new URL(url);
  assert.equal(u.origin, DEFAULT_WORKER_URL);
  assert.equal(u.pathname, '/infer-decisions');
});

test('buildGroundedAskUrl points at /grounded-ask on the worker origin', () => {
  const u = new URL(buildGroundedAskUrl({} as NodeJS.ProcessEnv));
  assert.equal(u.origin, DEFAULT_WORKER_URL);
  assert.equal(u.pathname, '/grounded-ask');
  // honors the worker-url override for local dev
  const local = new URL(buildGroundedAskUrl({ BACKTHREAD_WORKER_URL: 'http://localhost:8787' } as NodeJS.ProcessEnv));
  assert.equal(local.origin, 'http://localhost:8787');
});

test('buildReadDecisionsUrl points at /read-decisions on the functions origin', () => {
  const url = buildReadDecisionsUrl({} as NodeJS.ProcessEnv);
  assert.equal(url, `${DEFAULT_FUNCTIONS_URL}/read-decisions`);
});

test('buildReadDecisionsUrl honors BACKTHREAD_FUNCTIONS_URL override', () => {
  const url = buildReadDecisionsUrl({
    BACKTHREAD_FUNCTIONS_URL: 'http://localhost:54321/functions/v1/',
  } as NodeJS.ProcessEnv);
  assert.equal(url, 'http://localhost:54321/functions/v1/read-decisions');
});

test('buildOnboardingStateUrl points at /onboarding-state on the functions origin', () => {
  const url = buildOnboardingStateUrl({} as NodeJS.ProcessEnv);
  assert.equal(url, `${DEFAULT_FUNCTIONS_URL}/onboarding-state`);
});

test('buildOnboardingStateUrl honors BACKTHREAD_FUNCTIONS_URL override', () => {
  const url = buildOnboardingStateUrl({
    BACKTHREAD_FUNCTIONS_URL: 'http://localhost:54321/functions/v1/',
  } as NodeJS.ProcessEnv);
  assert.equal(url, 'http://localhost:54321/functions/v1/onboarding-state');
});

test('buildRepoDeepLink links the repo root on the app origin', () => {
  const url = buildRepoDeepLink('backthread', 'marola-platform', {} as NodeJS.ProcessEnv);
  assert.equal(url, `${DEFAULT_APP_URL}/backthread/marola-platform`);
});

test('buildRepoDeepLink encodes owner/name path segments', () => {
  const url = buildRepoDeepLink('a b', 'x/y', {} as NodeJS.ProcessEnv);
  // The slash in a name must be percent-encoded so it can't escape the segment.
  assert.equal(url, `${DEFAULT_APP_URL}/a%20b/x%2Fy`);
});

test('buildRepoDeepLink honors BACKTHREAD_APP_URL for local dev', () => {
  const url = buildRepoDeepLink('o', 'r', { BACKTHREAD_APP_URL: 'http://localhost:5173' } as NodeJS.ProcessEnv);
  assert.equal(url, 'http://localhost:5173/o/r');
});

test('browserCommand maps each platform to a launcher', () => {
  assert.deepEqual(browserCommand('darwin'), { cmd: 'open', prefixArgs: [] });
  assert.deepEqual(browserCommand('win32'), { cmd: 'cmd', prefixArgs: ['/c', 'start', ''] });
  assert.deepEqual(browserCommand('linux'), { cmd: 'xdg-open', prefixArgs: [] });
});
