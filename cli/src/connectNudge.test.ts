import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRepoStatus,
  parseNextStep,
  nudgeMessage,
  nextStepMessage,
  freeLimitMessage,
  maybeNudge,
  nudgeStatePath,
  type ServerNextStep,
} from './connectNudge.js';

// Isolate the throttle file under a temp BACKTHREAD_CONFIG_DIR so no real ~/.backthread
// is touched (mirrors config.test.ts).
async function withTempEnv(fn: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'backthread-nudge-'));
  const env = { ...process.env, BACKTHREAD_CONFIG_DIR: join(dir, '.backthread') } as NodeJS.ProcessEnv;
  try {
    await fn(env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REPO = { owner: 'acme', name: 'app' };

// --- parseRepoStatus ---------------------------------------------------------

test('parseRepoStatus accepts the three enum values, rejects everything else', () => {
  assert.equal(parseRepoStatus('connected'), 'connected');
  assert.equal(parseRepoStatus('not_connected'), 'not_connected');
  assert.equal(parseRepoStatus('disconnected'), 'disconnected');
  // Unknown / absent / wrong-typed → null (no nudge; older server compat).
  assert.equal(parseRepoStatus(undefined), null);
  assert.equal(parseRepoStatus('CONNECTED'), null);
  assert.equal(parseRepoStatus(42), null);
  assert.equal(parseRepoStatus(null), null);
});

// --- nudgeMessage ------------------------------------------------------------

test('nudgeMessage builds the connect link from the app URL helper (not hardcoded) and never says "architectural memory"', () => {
  const env = { BACKTHREAD_APP_URL: 'http://localhost:5173' } as unknown as NodeJS.ProcessEnv;
  const m = nudgeMessage('not_connected', REPO, env);
  assert.match(m, /http:\/\/localhost:5173\/acme\/app/);
  assert.match(m, /isn't connected/);
  assert.match(m, /How it works/); // the customer's noun for the diagram
  assert.doesNotMatch(m, /architectural memory/i); // brand vocabulary discipline
});

test('nudgeMessage distinguishes disconnected (App removed) from not_connected', () => {
  const dm = nudgeMessage('disconnected', REPO);
  assert.match(dm, /disconnected/);
  assert.match(dm, /GitHub App was removed/);
});

// --- maybeNudge: the throttle behaviour --------------------------------------

test('nudge shown on the FIRST capture of a session', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const shown = await maybeNudge('not_connected', REPO, 'sess-A', {
      env,
      log: (m) => lines.push(m),
    });
    assert.equal(shown, true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /isn't connected/);
    // The throttle file was written 0600 with the session id recorded.
    const path = nudgeStatePath(env);
    const s = await stat(path);
    assert.equal(s.mode & 0o777, 0o600);
    assert.match(await readFile(path, 'utf8'), /sess-A/);
  });
});

test('nudge SUPPRESSED on a SECOND capture in the same session', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    assert.equal(await maybeNudge('not_connected', REPO, 'sess-A', { env, log }), true);
    // Second capture, same session id → throttled.
    assert.equal(await maybeNudge('not_connected', REPO, 'sess-A', { env, log }), false);
    assert.equal(lines.length, 1, 'only one nudge for the whole session');
  });
});

test('nudge shown AGAIN in a NEW session', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    assert.equal(await maybeNudge('not_connected', REPO, 'sess-A', { env, log }), true);
    assert.equal(await maybeNudge('not_connected', REPO, 'sess-A', { env, log }), false);
    // A different session id re-shows.
    assert.equal(await maybeNudge('not_connected', REPO, 'sess-B', { env, log }), true);
    assert.equal(lines.length, 2);
  });
});

test('connected → NO nudge (and no throttle file written)', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const shown = await maybeNudge('connected', REPO, 'sess-A', {
      env,
      log: (m) => lines.push(m),
    });
    assert.equal(shown, false);
    assert.equal(lines.length, 0);
    // Nothing was written (we only write when we actually nudge).
    await assert.rejects(stat(nudgeStatePath(env)));
  });
});

test('null repoStatus → NO nudge (older server / absent field)', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const shown = await maybeNudge(null, REPO, 'sess-A', { env, log: (m) => lines.push(m) });
    assert.equal(shown, false);
    assert.equal(lines.length, 0);
  });
});

// --- maybeNudge: the free-plan decision cap ----------------------------------

test('free_limit_reached → upgrade line shown, throttled once/session', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    // A free_limit_reached skip is a CONNECTED, healthy repo: repoStatus 'connected'
    // + a terminal nextStep (null) — both of which would normally suppress a nudge.
    const deps = { env, log, nextStep: null, captureSkipped: 'free_limit_reached' } as const;
    assert.equal(await maybeNudge('connected', REPO, 'sess-A', deps), true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /free-plan decision limit/);
    assert.match(lines[0], /account\/billing/);
    // Throttled: a second capture in the same session stays silent.
    assert.equal(await maybeNudge('connected', REPO, 'sess-A', deps), false);
    assert.equal(lines.length, 1, 'one upgrade line for the whole session');
    // A new session re-shows.
    assert.equal(await maybeNudge('connected', REPO, 'sess-B', deps), true);
    assert.equal(lines.length, 2);
  });
});

test('free_limit_reached takes PRIORITY over a connect nudge', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    // Even if repoStatus somehow read not_connected, the cap line wins (and fires once).
    const shown = await maybeNudge('not_connected', REPO, 'sess-A', {
      env,
      log: (m) => lines.push(m),
      captureSkipped: 'free_limit_reached',
    });
    assert.equal(shown, true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /free-plan decision limit/);
    assert.doesNotMatch(lines[0], /isn't connected/);
  });
});

test('freeLimitMessage points at the billing page', () => {
  const m = freeLimitMessage({ BACKTHREAD_APP_URL: 'https://example.test' } as NodeJS.ProcessEnv);
  assert.match(m, /^backthread: /);
  assert.match(m, /free-plan decision limit/);
  assert.equal(m.includes('https://example.test/account/billing'), true);
});

test('missing session id → SUPPRESS (degrade rather than nudge every capture)', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    assert.equal(await maybeNudge('not_connected', REPO, null, { env, log }), false);
    assert.equal(await maybeNudge('not_connected', REPO, '', { env, log }), false);
    assert.equal(lines.length, 0);
  });
});

test('a CORRUPT throttle file is harmless — the nudge still shows, never throws', async () => {
  await withTempEnv(async (env) => {
    // Pre-create a garbage throttle file.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(env.BACKTHREAD_CONFIG_DIR as string), { recursive: true });
    await writeFile(nudgeStatePath(env), 'not-json-at-all{{{', 'utf8');

    const lines: string[] = [];
    const shown = await maybeNudge('not_connected', REPO, 'sess-A', {
      env,
      log: (m) => lines.push(m),
    });
    // Corrupt file → treated as "nothing nudged yet" → nudge shows, then the file is
    // rewritten as valid state.
    assert.equal(shown, true);
    assert.equal(lines.length, 1);
    assert.match(await readFile(nudgeStatePath(env), 'utf8'), /sess-A/);
  });
});

test('disconnected status nudges (and throttles) just like not_connected', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    assert.equal(await maybeNudge('disconnected', REPO, 'sess-D', { env, log }), true);
    assert.match(lines[0], /disconnected/);
    assert.equal(await maybeNudge('disconnected', REPO, 'sess-D', { env, log }), false);
    assert.equal(lines.length, 1);
  });
});

// --- parseNextStep -------------------------------------------------

test('parseNextStep returns the object for a well-formed next step', () => {
  const ns = parseNextStep({ slug: 'connect_repo', title: 'T', body: 'B' });
  assert.deepEqual(ns, { slug: 'connect_repo', title: 'T', body: 'B' });
});

test('parseNextStep returns null for an explicit terminal (server said null)', () => {
  assert.equal(parseNextStep(null), null);
});

test('parseNextStep returns "absent" for a missing/malformed field (older server)', () => {
  assert.equal(parseNextStep(undefined), 'absent');
  assert.equal(parseNextStep({}), 'absent');
  assert.equal(parseNextStep({ slug: 'x' }), 'absent'); // missing title/body
  assert.equal(parseNextStep(42), 'absent');
});

// --- nextStepMessage -----------------------------------------------

test('nextStepMessage renders the server copy + deep link for connect-driven slugs, never says "architectural memory"', () => {
  const env = { BACKTHREAD_APP_URL: 'http://localhost:5173' } as unknown as NodeJS.ProcessEnv;
  const step: ServerNextStep = { slug: 'connect_repo', title: 'Connect', body: 'Anchor your decisions.' };
  const m = nextStepMessage(step, REPO, env);
  assert.match(m, /backthread: Anchor your decisions\./);
  assert.match(m, /http:\/\/localhost:5173\/acme\/app/); // deep link appended
  assert.doesNotMatch(m, /architectural memory/i);
});

test('nextStepMessage does NOT append a link for non-connect slugs', () => {
  const step: ServerNextStep = { slug: 'run_or_backfill', title: 'Run', body: 'Run a session.' };
  const m = nextStepMessage(step, REPO, { BACKTHREAD_APP_URL: 'http://localhost:5173' } as unknown as NodeJS.ProcessEnv);
  assert.match(m, /backthread: Run a session\./);
  assert.doesNotMatch(m, /localhost:5173/);
});

// --- maybeNudge: the UNIFIED next-step path wins over legacy repoStatus -------

test('a server nextStep WINS: renders the server copy even when repoStatus would say connected', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const step: ServerNextStep = { slug: 'connect_repo', title: 'C', body: 'Connect the repo to anchor.' };
    // repoStatus 'connected' would normally suppress; the unified nextStep overrides.
    const shown = await maybeNudge('connected', REPO, 'sess-N', {
      env,
      log: (m) => lines.push(m),
      nextStep: step,
    });
    assert.equal(shown, true);
    assert.match(lines[0], /Connect the repo to anchor\./);
  });
});

test('a server nextStep of null (terminal) SUPPRESSES even if repoStatus says not_connected', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const shown = await maybeNudge('not_connected', REPO, 'sess-T', {
      env,
      log: (m) => lines.push(m),
      nextStep: null, // terminal: fully onboarded
    });
    assert.equal(shown, false);
    assert.equal(lines.length, 0);
  });
});

test("a server nextStep of 'absent' falls back to the legacy repoStatus path", async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const shown = await maybeNudge('not_connected', REPO, 'sess-L', {
      env,
      log: (m) => lines.push(m),
      nextStep: 'absent',
    });
    assert.equal(shown, true);
    assert.match(lines[0], /isn't connected/); // legacy copy
  });
});

// regression (PR #75): a disconnected repo still nudges RECONNECT. The
// server OMITS `nextStep` for a disconnected repo (so `parseNextStep(undefined)` ⇒
// 'absent'), letting the shipped disconnected branch render. An explicit
// `null` here would WRONGLY suppress it.
test('disconnected repo + ABSENT unified nextStep still nudges reconnect (not regressed)', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    // The server omitted nextStep ⇒ rec.nextStep is undefined ⇒ parseNextStep ⇒ 'absent'.
    assert.equal(parseNextStep(undefined), 'absent');
    const shown = await maybeNudge('disconnected', REPO, 'sess-DR', {
      env,
      log: (m) => lines.push(m),
      nextStep: 'absent',
    });
    assert.equal(shown, true);
    assert.match(lines[0], /disconnected/); // the reconnect copy
  });
});

test('the unified nextStep path still throttles once-per-session', async () => {
  await withTempEnv(async (env) => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    const step: ServerNextStep = { slug: 'connect_repo', title: 'C', body: 'Anchor.' };
    assert.equal(await maybeNudge('connected', REPO, 'sess-X', { env, log, nextStep: step }), true);
    assert.equal(await maybeNudge('connected', REPO, 'sess-X', { env, log, nextStep: step }), false);
    assert.equal(lines.length, 1);
  });
});
