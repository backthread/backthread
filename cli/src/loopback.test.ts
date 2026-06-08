import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateState, validateCallback, startLoopbackServer } from './loopback.js';

test('generateState is high-entropy, url-safe, and unique', () => {
  const a = generateState();
  const b = generateState();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/); // base64url, no padding
  assert.ok(a.length >= 40); // 32 bytes → ~43 chars
});

test('validateCallback accepts the correct path + state + backthread_pat_ token', () => {
  const state = 'nonce-123';
  const r = validateCallback('GET', `/callback?state=${state}&token=backthread_pat_abc`, state);
  assert.deepEqual(r, { ok: true, token: 'backthread_pat_abc' });
});

test('validateCallback rejects a state mismatch (CSRF guard)', () => {
  const r = validateCallback('GET', '/callback?state=evil&token=backthread_pat_abc', 'real-nonce');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'state_mismatch');
});

test('validateCallback rejects a missing state', () => {
  const r = validateCallback('GET', '/callback?token=backthread_pat_abc', 'real-nonce');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'state_mismatch');
});

test('validateCallback rejects a non-bt_pat token', () => {
  const r = validateCallback('GET', '/callback?state=n&token=ghp_somethingelse', 'n');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_token');
});

test('validateCallback rejects a missing token', () => {
  const r = validateCallback('GET', '/callback?state=n', 'n');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_token');
});

test('validateCallback rejects a backthread_pat_ token with non-base64url bytes', () => {
  // A header-injection style payload that starts with the right prefix but
  // carries control chars / spaces must NOT be accepted (it would later ride in
  // an Authorization header).
  const encoded = encodeURIComponent('backthread_pat_abc\r\nX-Evil: 1');
  const r = validateCallback('GET', `/callback?state=n&token=${encoded}`, 'n');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_token');
  // A space-bearing token is likewise rejected.
  const r2 = validateCallback('GET', '/callback?state=n&token=backthread_pat_a%20b', 'n');
  assert.equal(r2.ok, false);
});

test('validateCallback ignores non-/callback paths', () => {
  const r = validateCallback('GET', '/favicon.ico', 'n');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_path');
});

test('validateCallback rejects non-GET methods', () => {
  const r = validateCallback('POST', '/callback?state=n&token=backthread_pat_abc', 'n');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_method');
});

test('validateCallback surfaces an ?error= without a token', () => {
  const r = validateCallback('GET', '/callback?state=n&error=not_signed_in', 'n');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error_param');
  assert.equal(r.error, 'not_signed_in');
});

test('startLoopbackServer binds a real port and delivers the token end-to-end', async () => {
  const handle = await startLoopbackServer();
  assert.ok(handle.port > 0);
  assert.match(handle.state, /^[A-Za-z0-9_-]+$/);

  // Simulate the browser redirect by fetching the loopback callback ourselves.
  const tokenPromise = handle.waitForToken(5000);
  const res = await fetch(
    `http://127.0.0.1:${handle.port}/callback?state=${handle.state}&token=backthread_pat_e2e`,
  );
  assert.equal(res.status, 200);
  const token = await tokenPromise;
  assert.equal(token, 'backthread_pat_e2e');
});

test('startLoopbackServer keeps waiting on a probe hit to a wrong path', async () => {
  const handle = await startLoopbackServer();
  // A favicon probe returns 404 and must NOT resolve/reject the wait.
  const probe = await fetch(`http://127.0.0.1:${handle.port}/favicon.ico`);
  assert.equal(probe.status, 404);

  // The real callback still works afterward.
  const tokenPromise = handle.waitForToken(5000);
  await fetch(`http://127.0.0.1:${handle.port}/callback?state=${handle.state}&token=backthread_pat_ok`);
  assert.equal(await tokenPromise, 'backthread_pat_ok');
});

test('startLoopbackServer rejects waitForToken on a state mismatch', async () => {
  const handle = await startLoopbackServer();
  // Attach the rejection expectation BEFORE the fetch can settle the promise, so
  // the rejection is never momentarily unhandled.
  const tokenPromise = handle.waitForToken(5000);
  const expectation = assert.rejects(tokenPromise, /invalid callback/);
  await fetch(`http://127.0.0.1:${handle.port}/callback?state=wrong&token=backthread_pat_x`);
  await expectation;
});
