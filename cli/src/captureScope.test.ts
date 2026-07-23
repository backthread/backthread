import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretScopeResponse, checkCaptureScope } from './captureScope.js';
import type { BackthreadConfig } from './config.js';

// captureScope.test.ts (ARP-1054) — the pre-send capture-scope check.
//
// Two layers:
//   1. interpretScopeResponse (PURE) — the fail-open mapping. The ONLY suppressing
//      case is a clean 200 whose body says decision:'skip'; everything else sends.
//   2. checkCaptureScope (fetch-stubbed) — no-token / skip / capture / network-error,
//      and that it carries the token + repo slug + NO transcript.

const CONFIG: BackthreadConfig = { device_token: 'backthread_pat_secret' };
const REPO = { owner: 'acme', name: 'app' };

// --- 1. interpretScopeResponse (pure, fail-open) -----------------------------

test('interpret: a clean 200 skip → do NOT send, carry the reason', () => {
  assert.deepEqual(interpretScopeResponse(true, 200, { decision: 'skip', reason: 'capture_paused' }), {
    send: false,
    reason: 'capture_paused',
  });
  assert.deepEqual(interpretScopeResponse(true, 200, { decision: 'skip', reason: 'not_connected' }), {
    send: false,
    reason: 'not_connected',
  });
});

test('interpret: a 200 skip with an UNKNOWN reason → skip, but a SILENT (non-nudging) reason', () => {
  // A future server skip reason must never be coerced to not_connected (which would
  // fire a connect nudge we can't justify) — default to a silent skip.
  assert.deepEqual(interpretScopeResponse(true, 200, { decision: 'skip', reason: 'brand_new_reason' }), {
    send: false,
    reason: 'capture_paused',
  });
});

test('interpret: a 200 capture → send', () => {
  assert.deepEqual(interpretScopeResponse(true, 200, { decision: 'capture', reason: 'connected' }), {
    send: true,
    reason: 'connected',
  });
});

test('interpret: FAIL-OPEN on every doubt → send', () => {
  // fetch threw (ok:false)
  assert.equal(interpretScopeResponse(false, 0, null).send, true);
  // any non-200
  assert.equal(interpretScopeResponse(true, 500, { decision: 'skip', reason: 'capture_paused' }).send, true);
  assert.equal(interpretScopeResponse(true, 401, null).send, true);
  assert.equal(interpretScopeResponse(true, 426, { error: 'client_too_old' }).send, true);
  // 200 but no/blank/unknown decision (older or unexpected server)
  assert.equal(interpretScopeResponse(true, 200, {}).send, true);
  assert.equal(interpretScopeResponse(true, 200, null).send, true);
  assert.equal(interpretScopeResponse(true, 200, { decision: 'maybe' }).send, true);
});

// --- 2. checkCaptureScope (fetch-stubbed) ------------------------------------

test('checkCaptureScope: no device token → send (fail open), no fetch', async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response('{}');
  }) as typeof fetch;
  const v = await checkCaptureScope(REPO, {}, { fetchImpl });
  assert.deepEqual(v, { send: true, reason: 'unknown' });
  assert.equal(called, false, 'must not call the network without a token');
});

test('checkCaptureScope: a 200 skip → send:false; request carries token + slug, NO transcript', async () => {
  let seenUrl = '';
  let seenAuth: string | null = null;
  let seenBody: Record<string, unknown> = {};
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    seenUrl = String(input);
    seenAuth = new Headers(init?.headers).get('Authorization');
    seenBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    return new Response(JSON.stringify({ ok: true, decision: 'skip', reason: 'capture_paused' }), { status: 200 });
  }) as typeof fetch;

  const v = await checkCaptureScope(REPO, CONFIG, { fetchImpl });
  assert.deepEqual(v, { send: false, reason: 'capture_paused' });
  assert.match(seenUrl, /\/capture-scope$/);
  assert.equal(seenAuth, 'Bearer backthread_pat_secret');
  assert.deepEqual(seenBody, { repo: { owner: 'acme', name: 'app' } });
  // The body is the slug ONLY — never a transcript / turns / source.
  const raw = JSON.stringify(seenBody);
  assert.doesNotMatch(raw, /transcript|turns|content/i);
});

test('checkCaptureScope: a 200 capture → send', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ok: true, decision: 'capture', reason: 'connected' }), {
      status: 200,
    })) as typeof fetch;
  assert.deepEqual(await checkCaptureScope(REPO, CONFIG, { fetchImpl }), { send: true, reason: 'connected' });
});

test('checkCaptureScope: a network throw → send (fail open, never throws)', async () => {
  const fetchImpl = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  assert.deepEqual(await checkCaptureScope(REPO, CONFIG, { fetchImpl }), { send: true, reason: 'unknown' });
});

test('checkCaptureScope: a 5xx (server lookup error) → send (fail open)', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: 'scope_lookup_failed' }), { status: 502 })) as typeof fetch;
  assert.equal((await checkCaptureScope(REPO, CONFIG, { fetchImpl })).send, true);
});
