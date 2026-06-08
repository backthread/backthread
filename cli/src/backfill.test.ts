import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeProjectsDir, runBackfill, type BackfillDeps } from './backfill.js';
import { runCapture, type CaptureOutcome, type HookInput } from './capture.js';
import type { BackthreadConfig } from './config.js';

// All seams mocked: NO real fs / network / capture. Backfill must never throw.

const HOME = '/home/jb';
const CWD = '/Users/jb/www/clew';
// `~/.claude/projects/<slug(cwd)>/` — the Claude Code per-repo transcript dir.
const DIR = '/home/jb/.claude/projects/-Users-jb-www-clew';

function deps(over: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    env: {} as NodeJS.ProcessEnv,
    homedirImpl: () => HOME,
    log: () => {},
    ...over,
  };
}

// --- claudeProjectsDir -------------------------------------------------------

test('claudeProjectsDir builds ~/.claude/projects/<slug>/', () => {
  assert.equal(claudeProjectsDir(CWD, HOME), DIR);
});

// --- empty / missing dir -----------------------------------------------------

test('no transcripts dir → found 0, never throws, never calls capture', async () => {
  let captureCalls = 0;
  const summary = await runBackfill(
    { cwd: CWD },
    deps({
      readDirImpl: async () => [],
      runCaptureImpl: async () => ((captureCalls += 1), { status: 'persisted', detail: '', count: 1 }),
    }),
  );
  assert.equal(summary.found, 0);
  assert.equal(summary.captured, 0);
  assert.equal(summary.decisions, 0);
  assert.equal(captureCalls, 0);
  assert.match(summary.text, /nothing to backfill/i);
});

test('a readDir that throws degrades to found 0 (never throws)', async () => {
  const summary = await runBackfill(
    { cwd: CWD },
    deps({
      readDirImpl: async () => {
        throw new Error('EACCES');
      },
    }),
  );
  assert.equal(summary.found, 0);
});

// --- enumeration + delegation ------------------------------------------------

test('enumerates only *.jsonl, sorted, and feeds each to runCapture with cwd', async () => {
  const seen: HookInput[] = [];
  const summary = await runBackfill(
    { cwd: CWD },
    deps({
      readDirImpl: async (dir) => {
        assert.equal(dir, DIR); // located the right per-repo dir
        return ['b.jsonl', 'README.md', 'a.jsonl', 'notes.txt'];
      },
      runCaptureImpl: async (input) => {
        seen.push(input);
        return { status: 'persisted', detail: 'ok', count: 2 };
      },
    }),
  );

  // Only the two .jsonl files, in sorted order.
  assert.deepEqual(
    seen.map((h) => h.transcript_path),
    [`${DIR}/a.jsonl`, `${DIR}/b.jsonl`],
  );
  // Each capture got the repo cwd so the pipeline resolves the same repo.
  assert.ok(seen.every((h) => h.cwd === CWD));
  assert.ok(seen.every((h) => h.hook_event_name === 'SessionEnd'));

  assert.equal(summary.found, 2);
  assert.equal(summary.captured, 2);
  assert.equal(summary.decisions, 4); // 2 + 2
});

// --- tally across mixed outcomes ---------------------------------------------

test('tally counts only persisted outcomes; other statuses are processed but not counted', async () => {
  const outcomes: Record<string, CaptureOutcome> = {
    'a.jsonl': { status: 'persisted', detail: '', count: 3 },
    'b.jsonl': { status: 'nothing-to-capture', detail: '', count: 0 },
    'c.jsonl': { status: 'persisted-by-server', detail: '', count: 1 },
    'd.jsonl': { status: 'no-auth', detail: '' },
  };
  const summary = await runBackfill(
    { cwd: CWD },
    deps({
      readDirImpl: async () => Object.keys(outcomes),
      runCaptureImpl: async (input) => outcomes[input.transcript_path!.split('/').pop()!],
    }),
  );
  assert.equal(summary.found, 4);
  assert.equal(summary.captured, 2); // persisted + persisted-by-server
  assert.equal(summary.decisions, 4); // 3 + 1
  assert.equal(summary.results.length, 4);
});

// --- one bad transcript can't abort the run ----------------------------------

test('a runCapture that throws on one transcript is swallowed; the rest still run', async () => {
  const summary = await runBackfill(
    { cwd: CWD },
    deps({
      readDirImpl: async () => ['a.jsonl', 'b.jsonl', 'c.jsonl'],
      runCaptureImpl: async (input) => {
        if (input.transcript_path!.endsWith('b.jsonl')) throw new Error('boom');
        return { status: 'persisted', detail: '', count: 1 };
      },
    }),
  );
  assert.equal(summary.found, 3);
  assert.equal(summary.captured, 2);
  assert.equal(summary.decisions, 2);
  const bad = summary.results.find((r) => r.file === 'b.jsonl')!;
  assert.equal(bad.outcome.status, 'error');
  assert.match(bad.outcome.detail, /swallowed/);
});

// --- integration: REAL runCapture through backfill (mocked fetch/fs only) ----

test('backfill drives the REAL runCapture pipeline with all I/O seams mocked', async () => {
  // A transcript with prose + a code fence — proves the redact fence runs (the code
  // must NOT appear in the body POSTed to the server). No real network/fs.
  const TRANSCRIPT = [
    JSON.stringify({ type: 'user', sessionId: 's1', message: { content: 'why a queue?' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-03T09:00:00Z',
      message: { content: [{ type: 'text', text: 'Decouple ingestion.\n```js\nconst secret=1;\n```' }] },
    }),
  ].join('\n');

  const config: BackthreadConfig = { account: 'acc', device_token: 'backthread_pat_secret' };
  const posted: string[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    posted.push(String(init?.body ?? ''));
    // The router's /infer-decisions returns derived decisions + persisted:true (it
    // gets persist:true because the repo resolves), so the hook is done after infer.
    const body =
      url.includes('/infer-decisions')
        ? { decisions: [{ title: 'Use a queue' }], persisted: true }
        : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  const summary = await runBackfill(
    { cwd: CWD },
    deps({
      readDirImpl: async () => ['s1.jsonl'],
      runCaptureImpl: runCapture, // the REAL pipeline
      captureDeps: {
        env: {} as NodeJS.ProcessEnv,
        readConfigImpl: async () => config,
        readFileImpl: async () => TRANSCRIPT,
        readRemoteImpl: () => 'git@github.com:acme/app.git',
        ensureAuthImpl: () => {}, // NEVER reach the real browser/login
        fetchImpl,
        log: () => {},
      },
    }),
  );

  assert.equal(summary.found, 1);
  assert.equal(summary.captured, 1);
  assert.equal(summary.decisions, 1);
  // The redact fence held: the source code never reached the wire.
  const allPosted = posted.join('\n');
  assert.ok(!allPosted.includes('const secret=1'), 'source code must not leave the machine');
  assert.match(allPosted, /code redacted/);
});
