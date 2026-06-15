import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferDecisions,
  serverInfer,
  localByokInfer,
  type RedactedTranscriptInput,
  type InferOptions,
} from './infer.js';
import type { BackthreadConfig } from './config.js';

const TRANSCRIPT: RedactedTranscriptInput = {
  sessionId: 'sess-1',
  turns: [
    { role: 'user', text: 'why did we switch to a queue?' },
    { role: 'assistant', text: 'to decouple ingestion from the web request.' },
  ],
};

const CONFIG: BackthreadConfig = { account: 'acc-1', device_token: 'backthread_pat_secret' };

// A fetch stub that records the single call it receives and returns a canned response.
function stubFetch(
  responder: (url: string, init: RequestInit) => { status: number; body: unknown },
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const i = init ?? {};
    calls.push({ url, init: i });
    const { status, body } = responder(url, i);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

test('serverInfer POSTs to /infer-decisions with the bearer device token', async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => ({
    status: 200,
    body: { ok: true, persisted: false, count: 1, decisions: [{ title: 'Use a queue' }], tokensSpent: 42 },
  }));

  const res = await serverInfer(TRANSCRIPT, CONFIG, { fetchImpl, env: {} as NodeJS.ProcessEnv });

  assert.equal(res.ok, true);
  assert.equal(res.model, 'server');
  assert.equal(res.persisted, false);
  assert.equal(res.sessionId, 'sess-1');
  assert.equal(res.tokensSpent, 42);
  assert.deepEqual(res.decisions, [{ title: 'Use a queue' }]);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/infer-decisions$/);
  assert.equal(calls[0].init.method, 'POST');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer backthread_pat_secret');
  assert.equal(headers['Content-Type'], 'application/json');
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(sent.transcript.turns, TRANSCRIPT.turns);
  assert.equal(sent.transcript.sessionId, 'sess-1');
  // Derive-only by default: no persist leg in the body.
  assert.equal(sent.persist, undefined);
  assert.equal(sent.repo, undefined);
});

test('serverInfer honors BACKTHREAD_WORKER_URL override', async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => ({
    status: 200,
    body: { ok: true, persisted: false, decisions: [] },
  }));
  await serverInfer(TRANSCRIPT, CONFIG, {
    fetchImpl,
    env: { BACKTHREAD_WORKER_URL: 'http://localhost:8787' } as NodeJS.ProcessEnv,
  });
  assert.equal(calls[0].url, 'http://localhost:8787/infer-decisions');
});

test('serverInfer forwards the persist leg when persist + repo are set', async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => ({
    status: 200,
    body: { ok: true, persisted: true, count: 2, decisions: [{ title: 'a' }, { title: 'b' }] },
  }));

  const opts: InferOptions = {
    fetchImpl,
    env: {} as NodeJS.ProcessEnv,
    persist: true,
    repo: { owner: 'backthread', name: 'marola-platform' },
    decidedAt: '2026-06-03T00:00:00Z',
  };
  const res = await serverInfer(TRANSCRIPT, CONFIG, opts);

  assert.equal(res.ok, true);
  assert.equal(res.persisted, true);
  assert.equal(res.decisions.length, 2);
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.persist, true);
  assert.deepEqual(sent.repo, { owner: 'backthread', name: 'marola-platform' });
  assert.equal(sent.decidedAt, '2026-06-03T00:00:00Z');
});

test('serverInfer forwards filePaths on the persist leg (the module anchor)', async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => ({
    status: 200,
    body: { ok: true, persisted: true, count: 1, decisions: [{ title: 'a' }] },
  }));

  const opts: InferOptions = {
    fetchImpl,
    env: {} as NodeJS.ProcessEnv,
    persist: true,
    repo: { owner: 'backthread', name: 'marola-platform' },
    decidedAt: '2026-06-03T00:00:00Z',
    filePaths: ['src/auth/login.ts', 'src/auth/session.ts'],
  };
  await serverInfer(TRANSCRIPT, CONFIG, opts);

  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(sent.filePaths, ['src/auth/login.ts', 'src/auth/session.ts']);
});

test('serverInfer omits filePaths from the body when empty', async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => ({
    status: 200,
    body: { ok: true, persisted: true, decisions: [] },
  }));

  await serverInfer(TRANSCRIPT, CONFIG, {
    fetchImpl,
    env: {} as NodeJS.ProcessEnv,
    persist: true,
    repo: { owner: 'backthread', name: 'marola-platform' },
    filePaths: [], // a code-less session → no paths → field omitted (server reads it as unanchored)
  });

  const sent = JSON.parse(String(calls[0].init.body));
  // Pin 'key absent', not merely falsy: after JSON.parse an explicit `filePaths:
  // undefined` and a genuinely-omitted key both read as `undefined`, so an
  // `=== undefined` check would also pass a regression that sent the key with an
  // undefined value. Asserting the key is absent is the trust-boundary property
  // we care about (no empty/undefined filePaths riding the wire).
  assert.ok(!('filePaths' in sent));
});

test('serverInfer does NOT send filePaths on the derive-only leg (anchoring is persist-side)', async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => ({
    status: 200,
    body: { ok: true, persisted: false, decisions: [] },
  }));

  // No persist target → derive-only. filePaths are anchoring metadata, which the
  // server only consumes when it persists, so they must not ride the derive-only body.
  await serverInfer(TRANSCRIPT, CONFIG, {
    fetchImpl,
    env: {} as NodeJS.ProcessEnv,
    filePaths: ['src/auth/login.ts'],
  });

  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.filePaths, undefined);
  assert.equal(sent.persist, undefined);
});

test('serverInfer rejects persist without a repo target (no network call)', async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => ({ status: 200, body: {} }));
  const res = await serverInfer(TRANSCRIPT, CONFIG, {
    fetchImpl,
    env: {} as NodeJS.ProcessEnv,
    persist: true,
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /no valid repo target/);
  assert.equal(calls.length, 0); // failed before fetching
});

test('serverInfer rejects persist with an empty-string owner/name (no network call)', async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => ({ status: 200, body: {} }));
  const res = await serverInfer(TRANSCRIPT, CONFIG, {
    fetchImpl,
    env: {} as NodeJS.ProcessEnv,
    persist: true,
    repo: { owner: '', name: 'marola-platform' },
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /no valid repo target/);
  assert.equal(calls.length, 0);
});

test('serverInfer fails clearly when no device token is configured', async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => ({ status: 200, body: {} }));
  const res = await serverInfer(TRANSCRIPT, {}, { fetchImpl, env: {} as NodeJS.ProcessEnv });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /not authenticated/);
  assert.equal(calls.length, 0);
});

test('serverInfer surfaces a non-2xx server error with status + message', async () => {
  const { fetch: fetchImpl } = stubFetch(() => ({ status: 401, body: { error: 'token revoked' } }));
  const res = await serverInfer(TRANSCRIPT, CONFIG, { fetchImpl, env: {} as NodeJS.ProcessEnv });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /401/);
  assert.match(res.error ?? '', /token revoked/);
  assert.deepEqual(res.decisions, []);
});

test('serverInfer surfaces a network failure without leaking the token', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const res = await serverInfer(TRANSCRIPT, CONFIG, { fetchImpl, env: {} as NodeJS.ProcessEnv });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /ECONNREFUSED/);
  assert.doesNotMatch(res.error ?? '', /backthread_pat_/);
});

test('serverInfer tolerates a non-JSON / empty body on 2xx', async () => {
  const fetchImpl = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    }) as unknown as Response) as typeof fetch;
  const res = await serverInfer(TRANSCRIPT, CONFIG, { fetchImpl, env: {} as NodeJS.ProcessEnv });
  assert.equal(res.ok, true);
  assert.deepEqual(res.decisions, []);
  assert.equal(res.persisted, false);
  // Falls back to the session id we sent when the body omits it.
  assert.equal(res.sessionId, 'sess-1');
});

test('localByokInfer is a stub: never configured (seam)', async () => {
  const outcome = await localByokInfer(TRANSCRIPT, CONFIG, {});
  assert.equal(outcome.configured, false);
  assert.equal(outcome.result, undefined);
});

test('inferDecisions routes to Model 2 (server) by default', async () => {
  const { fetch: fetchImpl, calls } = stubFetch(() => ({
    status: 200,
    body: { ok: true, persisted: false, decisions: [{ title: 'x' }] },
  }));
  const res = await inferDecisions(TRANSCRIPT, CONFIG, { fetchImpl, env: {} as NodeJS.ProcessEnv });
  assert.equal(res.model, 'server');
  assert.equal(res.ok, true);
  assert.deepEqual(res.decisions, [{ title: 'x' }]);
  assert.equal(calls.length, 1);
});

test('inferDecisions returns an empty-but-ok result for an empty transcript answer', async () => {
  const { fetch: fetchImpl } = stubFetch(() => ({
    status: 200,
    body: { ok: true, persisted: false, count: 0, decisions: [] },
  }));
  const res = await inferDecisions(
    { sessionId: null, turns: [] },
    CONFIG,
    { fetchImpl, env: {} as NodeJS.ProcessEnv },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.decisions, []);
});
