import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  firstRunStatePath,
  parseFirstRunState,
  readFirstRunState,
  updateFirstRunState,
  isOnboarded,
  maybeShowTrustGate,
  runStart,
  renderNextStep,
  type StartDeps,
} from './firstRun.js';
import { TRUST_COPY } from './install.js';
import type { OnboardingOutcome } from './onboardingState.js';
import type { BackthreadConfig } from './config.js';

// GUARDRAIL: every test isolates the state under a temp BACKTHREAD_CONFIG_DIR and
// injects auth + state-fetch seams, so NOTHING here touches real ~/.backthread, real
// auth, a browser, or the network. Mirrors connectNudge.test.ts + onboardingState.test.ts.

async function withTempEnv(fn: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'backthread-firstrun-'));
  const env = { ...process.env, BACKTHREAD_CONFIG_DIR: join(dir, '.backthread') } as NodeJS.ProcessEnv;
  try {
    await fn(env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const AUTHED: BackthreadConfig = { account: 'acc', repo: 'acme/app', device_token: 'backthread_pat_x' };

// A start-deps factory with a successful auth + a configurable state outcome.
function startDeps(over: Partial<StartDeps> = {}): StartDeps {
  return {
    ensureAuthImpl: async () => AUTHED,
    fetchStateImpl: async () =>
      ({
        status: 'ok',
        detail: '',
        repo: { owner: 'acme', name: 'app' },
        state: {
          signals: { repoConnected: true, agentCapturing: true, anythingCaptured: true },
          cell: '111',
          nextStep: null,
          terminal: 'fully_onboarded',
          repoSyncStatus: 'ready',
          repo: { owner: 'acme', name: 'app' },
        },
      }) as OnboardingOutcome,
    ...over,
  };
}

// --- state file (parse / read / write / 0600) --------------------------------

test('parseFirstRunState keeps only the known boolean flags, drops garbage', () => {
  assert.deepEqual(parseFirstRunState('{"onboarded":true}'), { onboarded: true });
  assert.deepEqual(parseFirstRunState('{"trustShown":true,"firstCaptureShown":true}'), {
    trustShown: true,
    firstCaptureShown: true,
  });
  // Non-true values / extra keys / corrupt JSON → empty (treat as not-onboarded).
  assert.deepEqual(parseFirstRunState('{"onboarded":"yes","x":1}'), {});
  assert.deepEqual(parseFirstRunState('not json'), {});
  assert.deepEqual(parseFirstRunState('[1,2]'), {});
});

test('updateFirstRunState merges + persists at 0600; readFirstRunState round-trips', async () => {
  await withTempEnv(async (env) => {
    await updateFirstRunState({ trustShown: true }, env);
    await updateFirstRunState({ onboarded: true }, env); // merge, not clobber
    const s = await readFirstRunState(env);
    assert.deepEqual(s, { trustShown: true, onboarded: true });
    const mode = (await stat(firstRunStatePath(env))).mode & 0o777;
    assert.equal(mode, 0o600, 'state file is owner-only');
  });
});

test('isOnboarded reflects the flag; missing file → false (never throws)', async () => {
  await withTempEnv(async (env) => {
    assert.equal(await isOnboarded(env), false); // no file yet
    await updateFirstRunState({ onboarded: true }, env);
    assert.equal(await isOnboarded(env), true);
  });
});

// --- maybeShowTrustGate (the silent hook path) -------------------------------

test('trust gate prints TRUST_COPY exactly ONCE, then no-ops (throttled)', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const first = await maybeShowTrustGate({ env, log: (m) => lines.push(m) });
    assert.equal(first, true);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], TRUST_COPY);
    // The trust copy is the never-store-source claim; vocabulary-disciplined.
    assert.doesNotMatch(lines[0], /architectural memory/i);

    const second = await maybeShowTrustGate({ env, log: (m) => lines.push(m) });
    assert.equal(second, false, 'second call is suppressed');
    assert.equal(lines.length, 1, 'no second print');
  });
});

test('trust gate is suppressed when already onboarded (full wizard ran)', async () => {
  await withTempEnv(async (env) => {
    await updateFirstRunState({ onboarded: true }, env);
    const lines: string[] = [];
    const shown = await maybeShowTrustGate({ env, log: (m) => lines.push(m) });
    assert.equal(shown, false);
    assert.equal(lines.length, 0);
  });
});

test('trust gate NEVER throws (write failure is swallowed)', async () => {
  const lines: string[] = [];
  // A throwing writeStateImpl must not escape; the log still fires (the throttle simply
  // won't persist, so it may re-show next time — a mild over-show, never a crash).
  let returned: boolean | undefined;
  await assert.doesNotReject(async () => {
    returned = await maybeShowTrustGate({
      env: {} as NodeJS.ProcessEnv,
      log: (m) => lines.push(m),
      readStateImpl: async () => ({}),
      writeStateImpl: async () => {
        throw new Error('disk full');
      },
    });
  });
  assert.equal(lines.length, 1, 'the trust copy was still printed before the failed write');
  assert.equal(returned, false, 'a failed persist degrades to false (not durably shown)');
});

// --- runStart: idempotence (the headline AC) ---------------------------------

test('runStart is idempotent — a returning, signed-in user is NOT re-onboarded', async () => {
  await withTempEnv(async (env) => {
    await updateFirstRunState({ onboarded: true }, env);
    const lines: string[] = [];
    let authCalled = false;
    const res = await runStart(
      { env, log: (m) => lines.push(m) },
      startDeps({
        // Onboarded + a device token on disk → the authed short-circuit.
        readConfigImpl: async () => AUTHED,
        ensureAuthImpl: async () => {
          authCalled = true;
          return AUTHED;
        },
      }),
    );
    assert.equal(res.status, 'already-onboarded');
    assert.equal(res.exitCode, 0);
    assert.equal(res.authed, true);
    assert.equal(authCalled, false, 'no auth handshake for a returning user');
    assert.match(lines.join('\n'), /you're good to go/i);
    // The trust copy is NOT re-printed for a returning user.
    assert.doesNotMatch(lines.join('\n'), /NEVER leave your machine/);
  });
});

test('runStart: onboarded but no device token → signed-out guidance, exit 0, authed false', async () => {
  await withTempEnv(async (env) => {
    await updateFirstRunState({ onboarded: true }, env);
    const lines: string[] = [];
    let authCalled = false;
    const res = await runStart(
      { env, log: (m) => lines.push(m) },
      startDeps({
        // Onboarded but the on-disk config has no device_token (e.g. token revoked/cleared).
        readConfigImpl: async () => ({ account: 'acc', repo: 'acme/app' }),
        ensureAuthImpl: async () => {
          authCalled = true;
          return AUTHED;
        },
      }),
    );
    // Still short-circuits (no full wizard, no auth handshake) — but reports the truth.
    assert.equal(res.status, 'already-onboarded');
    // exitCode is 0: the user IS onboarded; a missing token is actionable guidance, not a failure.
    assert.equal(res.exitCode, 0);
    assert.equal(res.authed, false);
    assert.equal(authCalled, false, 'no auth handshake — the short-circuit just informs');
    const text = lines.join('\n');
    assert.match(text, /already set up/i);
    assert.match(text, /this device isn't signed in/i);
    assert.match(text, /backthread login/);
    assert.match(text, /--claim/);
    // Not the "you're good to go" false assurance.
    assert.doesNotMatch(text, /you're good to go/i);
  });
});

// --- runStart: the happy first run -------------------------------------------

test('runStart first run: trust copy BEFORE auth, then state-driven next step, marks onboarded', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const order: string[] = [];
    const res = await runStart(
      { env, cwd: '/tmp/repo', log: (m) => lines.push(m) },
      startDeps({
        ensureAuthImpl: async () => {
          order.push('auth');
          return AUTHED;
        },
        fetchStateImpl: async () => {
          order.push('state');
          return startDeps().fetchStateImpl!();
        },
      }),
    );
    assert.equal(res.status, 'onboarded');
    assert.equal(res.exitCode, 0);
    assert.equal(res.authed, true);

    const text = lines.join('\n');
    const trustIdx = text.indexOf('NEVER leave your machine');
    const authIdx = text.indexOf('[1/2] Auth');
    assert.ok(trustIdx >= 0, 'trust copy shown');
    assert.ok(authIdx > trustIdx, 'trust copy precedes the auth line');
    // The deps order proves auth ran before the state fetch.
    assert.deepEqual(order, ['auth', 'state']);

    // The terminal state renders cleanly with the diagram deep-link, no "architectural memory".
    assert.match(text, /You're all set/);
    assert.match(text, /How it works|backthread\.dev\/acme\/app/);
    assert.doesNotMatch(text, /architectural memory/i);

    // Marked onboarded (+ trustShown) so the next run short-circuits.
    assert.deepEqual(await readFirstRunState(env), { onboarded: true, trustShown: true });
  });
});

test('runStart with a claim code authorizes without a browser (one-tap)', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    let sawClaim: string | undefined;
    const res = await runStart(
      { env, claim: 'backthread_claim_abc', log: (m) => lines.push(m) },
      startDeps({
        ensureAuthImpl: async (opts) => {
          sawClaim = opts.claim;
          return AUTHED;
        },
      }),
    );
    assert.equal(res.status, 'onboarded');
    assert.equal(sawClaim, 'backthread_claim_abc', 'claim code threaded into ensureAuth');
    assert.match(lines.join('\n'), /claim code accepted — no browser/);
  });
});

// --- runStart: auth failure does NOT mark onboarded (retry-able) -------------

test('runStart auth failure exits 1 and does NOT mark onboarded (so a retry re-runs)', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const res = await runStart(
      { env, log: (m) => lines.push(m) },
      startDeps({
        ensureAuthImpl: async () => {
          throw new Error('loopback timed out');
        },
      }),
    );
    assert.equal(res.status, 'auth-failed');
    assert.equal(res.exitCode, 1);
    assert.equal(res.authed, false);
    assert.match(lines.join('\n'), /Auth: failed — loopback timed out/);
    // NOT onboarded — the next `/backthread:start` retries.
    assert.equal(await isOnboarded(env), false);
  });
});

test('runStart auth that yields no token exits 1 (not onboarded)', async () => {
  await withTempEnv(async (env) => {
    const res = await runStart(
      { env, log: () => {} },
      startDeps({ ensureAuthImpl: async () => ({}) as BackthreadConfig }),
    );
    assert.equal(res.status, 'auth-failed');
    assert.equal(res.exitCode, 1);
    assert.equal(await isOnboarded(env), false);
  });
});

// --- runStart: --device is OUT OF SCOPE (loud stub, never silent loopback) ----

test('runStart --device refuses with the loud stub (does not fall back to loopback)', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    let authCalled = false;
    const res = await runStart(
      { env, device: true, log: (m) => lines.push(m) },
      startDeps({
        ensureAuthImpl: async () => {
          authCalled = true;
          return AUTHED;
        },
      }),
    );
    assert.equal(res.status, 'device-unsupported');
    assert.equal(res.exitCode, 1);
    assert.equal(authCalled, false, 'never silently falls back to the loopback');
    assert.match(lines.join('\n'), /not available yet/i);
    assert.equal(await isOnboarded(env), false);
  });
});

// --- renderNextStep: the cell→next-step copy ---------------------------------

test('renderNextStep: connect_repo step appends the repo deep-link', () => {
  const env = { BACKTHREAD_APP_URL: 'http://localhost:5173' } as unknown as NodeJS.ProcessEnv;
  const out = {
    status: 'ok',
    detail: '',
    repo: { owner: 'acme', name: 'app' },
    state: {
      signals: { repoConnected: false, agentCapturing: true, anythingCaptured: true },
      cell: '011',
      nextStep: { slug: 'connect_repo', title: 'Connect', body: 'Connect the repo to anchor your decisions.' },
      terminal: null,
      repoSyncStatus: null,
      repo: { owner: 'acme', name: 'app' },
    },
  } as OnboardingOutcome;
  const line = renderNextStep(out, env);
  assert.match(line, /Connect the repo to anchor your decisions\./);
  assert.match(line, /http:\/\/localhost:5173\/acme\/app/);
  assert.doesNotMatch(line, /architectural memory/i);
});

test('renderNextStep: cold_start with no repo links the app root', () => {
  const env = { BACKTHREAD_APP_URL: 'http://localhost:5173' } as unknown as NodeJS.ProcessEnv;
  const out = {
    status: 'ok',
    detail: '',
    repo: undefined,
    state: {
      signals: { repoConnected: false, agentCapturing: false, anythingCaptured: false },
      cell: '000',
      nextStep: { slug: 'cold_start', title: 'Pick a door', body: 'Connect a repo or install the plugin.' },
      terminal: null,
      repoSyncStatus: null,
      repo: null,
    },
  } as OnboardingOutcome;
  const line = renderNextStep(out, env);
  assert.match(line, /Connect a repo or install the plugin\./);
  assert.match(line, /http:\/\/localhost:5173$/);
});

test('renderNextStep: a non-ok fetch degrades to a plain hint (never crashes)', () => {
  const env = { BACKTHREAD_APP_URL: 'http://localhost:5173' } as unknown as NodeJS.ProcessEnv;
  const out = { status: 'error', detail: 'boom' } as OnboardingOutcome;
  const line = renderNextStep(out, env);
  assert.match(line, /set up/);
  assert.match(line, /How it works/);
  assert.doesNotMatch(line, /architectural memory/i);
});

test('renderNextStep: a run_or_backfill step renders the server body verbatim (no link appended)', () => {
  const out = {
    status: 'ok',
    detail: '',
    repo: { owner: 'acme', name: 'app' },
    state: {
      signals: { repoConnected: true, agentCapturing: true, anythingCaptured: false },
      cell: '110',
      nextStep: { slug: 'run_or_backfill', title: 'Run a session', body: 'Run a session to capture your first decisions.' },
      terminal: null,
      repoSyncStatus: 'ready',
      repo: { owner: 'acme', name: 'app' },
    },
  } as OnboardingOutcome;
  const line = renderNextStep(out);
  assert.match(line, /Run a session to capture your first decisions\.$/);
});

// --- runStart degrades when the state fetch fails (still onboards) -----------

test('runStart marks onboarded even when the state fetch fails (auth succeeded)', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const res = await runStart(
      { env, log: (m) => lines.push(m) },
      startDeps({
        fetchStateImpl: async () => ({ status: 'error', detail: 'down' }) as OnboardingOutcome,
      }),
    );
    assert.equal(res.status, 'onboarded');
    assert.equal(res.exitCode, 0);
    assert.equal(await isOnboarded(env), true, 'auth succeeded → onboarded despite the state hiccup');
    assert.match(lines.join('\n'), /set up/);
  });
});

// A corrupt state file does not brick the wizard (treated as not-onboarded).
test('runStart treats a corrupt state file as not-onboarded (runs the wizard)', async () => {
  await withTempEnv(async (env) => {
    const dir = join(env.BACKTHREAD_CONFIG_DIR as string);
    await mkdir(dir, { recursive: true });
    await writeFile(firstRunStatePath(env), 'not json at all', 'utf8');
    const res = await runStart({ env, log: () => {} }, startDeps());
    assert.equal(res.status, 'onboarded');
    assert.equal(await isOnboarded(env), true);
  });
});
