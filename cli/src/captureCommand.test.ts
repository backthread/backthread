import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveTranscriptPath,
  formatManualSummary,
  parseManualArgs,
  resolveTranscriptPath,
  runManualCapture,
  slugifyCwd,
  type ManualCaptureDeps,
} from './captureCommand.js';
import type { CaptureDeps, CaptureOutcome, HookInput } from './capture.js';
import type { BackthreadConfig } from './config.js';

// --- slugifyCwd / deriveTranscriptPath --------------------------------------

test('slugifyCwd replaces every non-alphanumeric char with a dash', () => {
  // Mirrors Claude Code's ~/.claude/projects/<slug>/ layout (verified against a
  // real machine: /Users/jb/.claude/skills → -Users-jb--claude-skills).
  assert.equal(slugifyCwd('/Users/jb/www/clew'), '-Users-jb-www-clew');
  assert.equal(slugifyCwd('/Users/jb/.claude/skills'), '-Users-jb--claude-skills');
});

test('deriveTranscriptPath builds ~/.claude/projects/<slug>/<session>.jsonl', () => {
  const p = deriveTranscriptPath('sess-7', '/Users/jb/www/clew', '/home/jb');
  assert.equal(p, '/home/jb/.claude/projects/-Users-jb-www-clew/sess-7.jsonl');
});

test('deriveTranscriptPath returns null without a session id', () => {
  assert.equal(deriveTranscriptPath(undefined, '/x', '/home'), null);
  assert.equal(deriveTranscriptPath('   ', '/x', '/home'), null);
});

// --- resolveTranscriptPath --------------------------------------------------

test('resolveTranscriptPath: explicit path wins (no stat needed)', async () => {
  let statCalls = 0;
  const out = await resolveTranscriptPath(
    { transcriptPath: '/explicit/t.jsonl', sessionId: 'sess', cwd: '/x' },
    { statImpl: async () => ((statCalls += 1), true) },
  );
  assert.equal(out, '/explicit/t.jsonl');
  assert.equal(statCalls, 0); // explicit path is trusted; pipeline readFile reports any error
});

test('resolveTranscriptPath: derives + confirms existence', async () => {
  const out = await resolveTranscriptPath(
    { sessionId: 'sess-7', cwd: '/Users/jb/www/clew' },
    { homedirImpl: () => '/home/jb', statImpl: async () => true },
  );
  assert.equal(out, '/home/jb/.claude/projects/-Users-jb-www-clew/sess-7.jsonl');
});

test('resolveTranscriptPath: derived-but-missing → null (so caller can hint)', async () => {
  const out = await resolveTranscriptPath(
    { sessionId: 'sess-7', cwd: '/x' },
    { homedirImpl: () => '/home/jb', statImpl: async () => false },
  );
  assert.equal(out, null);
});

test('resolveTranscriptPath: no session id and no explicit path → null', async () => {
  const out = await resolveTranscriptPath({ cwd: '/x' }, { homedirImpl: () => '/home/jb' });
  assert.equal(out, null);
});

// --- runManualCapture (mocked runCapture) -----------------------------------

const DERIVE_DEPS: ManualCaptureDeps = {
  homedirImpl: () => '/home/jb',
  statImpl: async () => true,
};

function fakeOutcome(over: Partial<CaptureOutcome>): CaptureOutcome {
  return { status: 'persisted', detail: 'ok', ...over } as CaptureOutcome;
}

test('runManualCapture: no resolvable transcript → actionable hint, exit 1, never runs pipeline', async () => {
  let ran = false;
  const result = await runManualCapture(
    { sessionId: 'sess-7', cwd: '/x' },
    {
      ...DERIVE_DEPS,
      statImpl: async () => false, // derived path missing
      runCaptureImpl: async () => ((ran = true), fakeOutcome({})),
    },
  );
  assert.equal(ran, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.outcome, null);
  assert.match(result.text, /could not find this session's transcript/);
  assert.match(result.text, /--transcript/);
});

test('runManualCapture: ARP-734 — appends the throttled upgrade nudge to the summary (interactive)', async () => {
  let nudgeArg: string | null | undefined = 'unset';
  const result = await runManualCapture(
    { transcriptPath: '/t.jsonl', cwd: '/x' },
    {
      ...DERIVE_DEPS,
      runCaptureImpl: async () => fakeOutcome({ status: 'persisted', count: 2, upgrade: 'Update backthread: npm i -g backthread@latest' }),
      // Stub the throttle so the test is deterministic (no fs / clock).
      upgradeNudgeImpl: async (u) => { nudgeArg = u; return 'Update backthread: npm i -g backthread@latest'; },
    },
  );
  // The presenter passed the outcome's upgrade string to the throttle, and the
  // (un-suppressed) nudge is appended to the printed summary.
  assert.equal(nudgeArg, 'Update backthread: npm i -g backthread@latest');
  assert.match(result.text, /Update backthread: npm i -g backthread@latest/);
});

test('runManualCapture: ARP-734 — a throttled (suppressed) nudge is NOT appended', async () => {
  const result = await runManualCapture(
    { transcriptPath: '/t.jsonl', cwd: '/x' },
    {
      ...DERIVE_DEPS,
      runCaptureImpl: async () => fakeOutcome({ status: 'persisted', count: 1, upgrade: 'a nudge' }),
      upgradeNudgeImpl: async () => null, // within the 24h window → suppressed
    },
  );
  assert.doesNotMatch(result.text, /a nudge/);
});

test('runManualCapture: resolves the path and feeds it to runCapture as transcript_path', async () => {
  let seen: HookInput | undefined;
  const result = await runManualCapture(
    { sessionId: 'sess-7', cwd: '/Users/jb/www/clew' },
    {
      ...DERIVE_DEPS,
      runCaptureImpl: async (input) => {
        seen = input;
        return fakeOutcome({ status: 'persisted', count: 3, repoConnected: true, detail: 'captured 3 decision(s) to acme/app.' });
      },
    },
  );
  assert.equal(seen?.transcript_path, '/home/jb/.claude/projects/-Users-jb-www-clew/sess-7.jsonl');
  assert.equal(seen?.session_id, 'sess-7');
  assert.equal(seen?.cwd, '/Users/jb/www/clew');
  assert.equal(result.exitCode, 0);
  assert.match(result.text, /captured 3 decision\(s\)/);
});

test('runManualCapture: injects a NO-OP ensureAuth so manual mode never pops a browser', async () => {
  let capturedDeps: CaptureDeps | undefined;
  await runManualCapture(
    { transcriptPath: '/t.jsonl', cwd: '/x' },
    {
      runCaptureImpl: async (_input, deps) => {
        capturedDeps = deps;
        return fakeOutcome({});
      },
    },
  );
  assert.equal(typeof capturedDeps?.ensureAuthImpl, 'function');
  // Calling it must be a harmless no-op (never reaches the real ensureAuth/browser).
  assert.doesNotThrow(() => capturedDeps?.ensureAuthImpl?.({} as NodeJS.ProcessEnv));
});

test('runManualCapture: caller captureDeps override the no-op ensureAuth', async () => {
  let capturedDeps: CaptureDeps | undefined;
  const myAuth = () => {};
  await runManualCapture(
    { transcriptPath: '/t.jsonl' },
    {
      captureDeps: { ensureAuthImpl: myAuth },
      runCaptureImpl: async (_input, deps) => {
        capturedDeps = deps;
        return fakeOutcome({});
      },
    },
  );
  assert.equal(capturedDeps?.ensureAuthImpl, myAuth);
});

test('runManualCapture: no-auth → backthread login hint, exit 1', async () => {
  const result = await runManualCapture(
    { transcriptPath: '/t.jsonl' },
    { runCaptureImpl: async () => fakeOutcome({ status: 'no-auth', detail: 'no token' }) },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.text, /backthread login/);
  assert.doesNotMatch(result.text, /no token/); // we render our own hint, not the raw detail
});

test('runManualCapture: failure statuses exit 1; nothing-to-capture exits 0', async () => {
  for (const status of ['infer-failed', 'persist-failed', 'error'] as const) {
    const r = await runManualCapture(
      { transcriptPath: '/t.jsonl' },
      { runCaptureImpl: async () => fakeOutcome({ status, detail: 'boom' }) },
    );
    assert.equal(r.exitCode, 1, `${status} should exit 1`);
    assert.match(r.text, /failed/);
  }
  const ok = await runManualCapture(
    { transcriptPath: '/t.jsonl' },
    { runCaptureImpl: async () => fakeOutcome({ status: 'nothing-to-capture', count: 0, detail: 'all code' }) },
  );
  assert.equal(ok.exitCode, 0);
  assert.match(ok.text, /nothing to capture/);
});

test('runManualCapture: a thrown runCapture is swallowed into a structured result', async () => {
  const result = await runManualCapture(
    { transcriptPath: '/t.jsonl' },
    {
      runCaptureImpl: async () => {
        throw new Error('unexpected');
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.outcome, null);
  assert.match(result.text, /error — unexpected/);
});

// --- formatManualSummary ----------------------------------------------------

test('formatManualSummary: persisted shows count', () => {
  const s = formatManualSummary(fakeOutcome({ status: 'persisted', count: 2, repoConnected: true, detail: 'd' }));
  assert.match(s, /captured 2 decision\(s\)/);
  assert.doesNotMatch(s, /not yet connected/);
});

test('formatManualSummary: repo-not-connected note appears', () => {
  const s = formatManualSummary(fakeOutcome({ status: 'persisted', count: 1, repoConnected: false, detail: 'held' }));
  assert.match(s, /not yet connected/);
});

test('formatManualSummary: no-auth becomes a backthread login hint', () => {
  const s = formatManualSummary(fakeOutcome({ status: 'no-auth', detail: 'x' }));
  assert.match(s, /backthread login/);
});

// --- parseManualArgs --------------------------------------------------------

test('parseManualArgs: flags', () => {
  const { manual, input } = parseManualArgs(['--manual', '--session', 's1', '--cwd', '/w']);
  assert.equal(manual, true);
  assert.equal(input.sessionId, 's1');
  assert.equal(input.cwd, '/w');
});

test('parseManualArgs: --transcript and a bare positional both set transcriptPath', () => {
  assert.equal(parseManualArgs(['--transcript', '/a.jsonl']).input.transcriptPath, '/a.jsonl');
  assert.equal(parseManualArgs(['/bare.jsonl']).input.transcriptPath, '/bare.jsonl');
});

test('parseManualArgs: empty argv → not manual, empty input (bin keeps the hook default)', () => {
  const { manual, input } = parseManualArgs([]);
  assert.equal(manual, false);
  assert.deepEqual(input, {});
});

// --- end-to-end through the REAL runCapture (fully mocked — no net/browser/bin) ---
// This proves the manual path drives the genuine pipeline. Every external seam
// is injected: readConfig returns a fake config WITH a device_token, ensureAuth is a
// no-op, readFile returns a canned transcript, fetch is a stub. The real ensureAuth /
// login / browser / network are NEVER reached.

const TRANSCRIPT_JSONL = [
  JSON.stringify({ type: 'user', sessionId: 'sess-7', message: { content: 'why a queue?' } }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-03T09:00:00Z',
    message: { content: [{ type: 'text', text: 'To decouple ingestion.' }] },
  }),
].join('\n');

const FAKE_CONFIG: BackthreadConfig = { account: 'acc-1', device_token: 'backthread_pat_secret' };

test('end-to-end: manual capture drives the real runCapture with all seams mocked', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    // Server derives + persists (connected repo) → single infer call, no re-POST.
    const r = { ok: true, persisted: true, decisions: [{ title: 'Use a queue' }] };
    return { ok: true, status: 200, json: async () => r } as Response;
  }) as typeof fetch;

  const captureDeps: CaptureDeps = {
    env: {} as NodeJS.ProcessEnv,
    readConfigImpl: async () => FAKE_CONFIG,
    readFileImpl: async () => TRANSCRIPT_JSONL,
    readRemoteImpl: () => 'git@github.com:acme/app.git',
    ensureAuthImpl: () => {}, // never the real login/browser
    fetchImpl,
    log: () => {},
  };

  const result = await runManualCapture(
    { transcriptPath: '/tmp/sess.jsonl', cwd: '/work/app' },
    { captureDeps },
  );

  assert.equal(result.outcome?.status, 'persisted-by-server');
  assert.equal(result.exitCode, 0);
  assert.match(result.text, /captured 1 decision\(s\)/);
  // The redacted transcript reached the router; raw code/tool I/O never would have.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/infer-decisions$/);
  // The device token never leaks into the user-facing summary.
  assert.doesNotMatch(result.text, /backthread_pat_/);
});
