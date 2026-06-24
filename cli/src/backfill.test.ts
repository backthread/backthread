import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeProjectsDir, runBackfill, type BackfillDeps } from './backfill.js';
import { runCapture, type CaptureDeps } from './capture.js';
import type { SweepState } from './sweep.js';

// backfill.ts is now a THIN ALIAS over runSweep(force:true). These tests assert the
// delegation + summary mapping + that the redact fence still holds end-to-end; the
// exhaustive engine behavior (worktree family, attribution, idempotence) lives in
// sweep.test.ts.

const HOME = '/home/jb';
const PROJ = `${HOME}/.claude/projects`;
const CWD = '/Users/jb/www/clew';
const SLUG = '-Users-jb-www-clew';

// --- claudeProjectsDir (still exported for back-compat) ----------------------

test('claudeProjectsDir builds ~/.claude/projects/<slug>/', () => {
  assert.equal(claudeProjectsDir(CWD, HOME), `${PROJ}/${SLUG}`);
});

// --- delegation + summary mapping -------------------------------------------

function deps(over: Partial<BackfillDeps> = {}, capture?: BackfillDeps['runCaptureImpl']): BackfillDeps {
  let state: SweepState = { processed: [], lastSweptAt: {} };
  return {
    env: {} as NodeJS.ProcessEnv,
    log: () => {},
    homedirImpl: () => HOME,
    nowImpl: () => '2026-06-24T12:00:00Z',
    mainRootImpl: () => CWD,
    readRemoteImpl: (c) => (c === CWD ? 'git@github.com:acme/app.git' : null),
    readConfigImpl: async () => ({ account: 'a', device_token: 'backthread_pat_x' }),
    readDirImpl: async (dir) =>
      dir === PROJ ? [SLUG] : dir === `${PROJ}/${SLUG}` ? ['a.jsonl', 'b.jsonl'] : [],
    readFileImpl: async () => JSON.stringify({ type: 'user', cwd: CWD, message: { content: 'why?' } }),
    pathExistsImpl: async (p) => p === CWD,
    readSweepStateImpl: async () => structuredClone(state),
    writeSweepStateImpl: async (s) => {
      state = s;
    },
    runCaptureImpl: capture ?? (async () => ({ status: 'persisted', detail: 'ok', count: 2 })),
    ...over,
  };
}

test('runBackfill delegates to the sweep and maps the summary (found/captured/decisions)', async () => {
  const summary = await runBackfill({ cwd: CWD }, deps());
  assert.equal(summary.found, 2);
  assert.equal(summary.captured, 2);
  assert.equal(summary.decisions, 4); // 2 + 2
  assert.deepEqual(summary.results, []); // back-compat field, always empty now
  assert.match(summary.text, /backthread sweep/);
});

test('runBackfill FORCES the sweep — runs even when the repo was just swept (no debounce)', async () => {
  let calls = 0;
  const summary = await runBackfill(
    { cwd: CWD },
    deps(
      {
        // a very recent lastSweptAt would debounce a normal sweep; install must still run.
        readSweepStateImpl: async () => ({ processed: [], lastSweptAt: { 'acme/app': '2026-06-24T11:59:59Z' } }),
      },
      async () => ((calls += 1), { status: 'persisted', detail: '', count: 1 }),
    ),
  );
  assert.equal(calls, 2); // both transcripts processed despite the recent sweep
  assert.equal(summary.decisions, 2);
});

test('runBackfill maps an empty result when nothing is found (never throws)', async () => {
  const summary = await runBackfill({ cwd: CWD }, deps({ readDirImpl: async () => [] }));
  assert.equal(summary.found, 0);
  assert.equal(summary.captured, 0);
  assert.equal(summary.decisions, 0);
});

// --- integration: REAL runCapture through backfill (redact fence holds) ------

test('runBackfill drives the REAL runCapture pipeline; source never leaves the machine', async () => {
  const TRANSCRIPT = [
    JSON.stringify({ type: 'user', cwd: CWD, sessionId: 's1', message: { content: 'why a queue?' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-03T09:00:00Z',
      message: { content: [{ type: 'text', text: 'Decouple ingestion.\n```js\nconst secret=1;\n```' }] },
    }),
  ].join('\n');
  const posted: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    posted.push(String(init?.body ?? ''));
    const body = String(url).includes('/infer-decisions')
      ? { decisions: [{ title: 'Use a queue' }], persisted: true }
      : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  const captureDeps: CaptureDeps = {
    env: {} as NodeJS.ProcessEnv,
    readConfigImpl: async () => ({ account: 'acc', device_token: 'backthread_pat_secret' }),
    readFileImpl: async () => TRANSCRIPT,
    ensureAuthImpl: () => {},
    fetchImpl,
    log: () => {},
  };
  const summary = await runBackfill(
    { cwd: CWD },
    deps(
      {
        readDirImpl: async (dir) => (dir === PROJ ? [SLUG] : dir === `${PROJ}/${SLUG}` ? ['s1.jsonl'] : []),
        readFileImpl: async () => TRANSCRIPT,
        captureDeps,
      },
      runCapture, // the REAL pipeline
    ),
  );
  assert.equal(summary.decisions, 1);
  const all = posted.join('\n');
  assert.ok(!all.includes('const secret=1'), 'source code must not leave the machine');
  assert.match(all, /code redacted/);
});
