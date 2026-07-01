import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, hkdfSync, createCipheriv, randomBytes } from 'node:crypto';
import { pollForToken } from './cliAuthPoll.js';
import { generateEphemeralKeypair, type EphemeralKeypair, type EncryptedPayload } from './cliAuthCrypto.js';

// Encrypt a token to the CLI keypair exactly as the page would (node:crypto reference),
// so a mocked 'ready' response carries a payload the real decrypt can open.
function encryptForKeypair(token: string, kp: EphemeralKeypair): EncryptedPayload {
  const page = createECDH('prime256v1');
  page.generateKeys();
  const shared = page.computeSecret(kp.ecdh.getPublicKey());
  const aesKey = Buffer.from(
    hkdfSync('sha256', shared, Buffer.from('backthread-cli-auth'), Buffer.from('device-token-v1'), 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    page_ephemeral_pubkey: b64url(page.getPublicKey()),
    iv: b64url(iv),
    ciphertext: b64url(Buffer.concat([ct, tag])),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const noSleep = () => Promise.resolve();
const env = { BACKTHREAD_FUNCTIONS_URL: 'http://localhost:54321/functions/v1' } as NodeJS.ProcessEnv;

test('polls through pending → ready and decrypts the token', async () => {
  const kp = generateEphemeralKeypair();
  const token = 'backthread_pat_abcDEF123';
  const enc = encryptForKeypair(token, kp);

  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls < 3) return jsonResponse(200, { status: 'pending' });
    return jsonResponse(200, { status: 'ready', ...enc });
  }) as unknown as typeof fetch;

  const r = await pollForToken('sess', kp, { env, fetchImpl, sleep: noSleep });
  assert.deepEqual(r, { ok: true, token });
  assert.equal(calls, 3);
});

test('posts the session id (consume mode — no mode field) with version headers', async () => {
  const kp = generateEphemeralKeypair();
  const enc = encryptForKeypair('backthread_pat_x', kp);
  let seenBody: any = null;
  let seenHeaders: any = null;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seenBody = JSON.parse(init.body as string);
    seenHeaders = init.headers;
    return jsonResponse(200, { status: 'ready', ...enc });
  }) as unknown as typeof fetch;

  await pollForToken('the-session-id', kp, { env, fetchImpl, sleep: noSleep });
  assert.equal(seenBody.session_id, 'the-session-id');
  assert.equal(seenBody.mode, undefined); // consuming poll uses the default mode
  assert.ok(seenHeaders['x-backthread-version']); // fleet telemetry rides along
});

test('returns expired when the session expired', async () => {
  const kp = generateEphemeralKeypair();
  const fetchImpl = (async () => jsonResponse(200, { status: 'expired' })) as unknown as typeof fetch;
  const r = await pollForToken('sess', kp, { env, fetchImpl, sleep: noSleep });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'expired');
});

test('returns error when the session was already consumed', async () => {
  const kp = generateEphemeralKeypair();
  const fetchImpl = (async () => jsonResponse(200, { status: 'consumed' })) as unknown as typeof fetch;
  const r = await pollForToken('sess', kp, { env, fetchImpl, sleep: noSleep });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'error');
});

test('times out (deadline) if the browser never delivers', async () => {
  const kp = generateEphemeralKeypair();
  // now() advances 2s per call so a 5s budget elapses after a few polls.
  let t = 0;
  const now = () => (t += 2000);
  const fetchImpl = (async () => jsonResponse(200, { status: 'pending' })) as unknown as typeof fetch;
  const r = await pollForToken('sess', kp, { env, fetchImpl, sleep: noSleep, now, timeoutMs: 5000 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'timeout');
});

test('backs off (does not fail) on a 429 rate_limited, then succeeds', async () => {
  const kp = generateEphemeralKeypair();
  const enc = encryptForKeypair('backthread_pat_ok', kp);
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return jsonResponse(429, { status: 'rate_limited' });
    return jsonResponse(200, { status: 'ready', ...enc });
  }) as unknown as typeof fetch;
  const r = await pollForToken('sess', kp, { env, fetchImpl, sleep: noSleep });
  assert.deepEqual(r, { ok: true, token: 'backthread_pat_ok' });
});

test('retries on a transient network throw, then succeeds', async () => {
  const kp = generateEphemeralKeypair();
  const enc = encryptForKeypair('backthread_pat_net', kp);
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) throw new Error('ECONNRESET');
    return jsonResponse(200, { status: 'ready', ...enc });
  }) as unknown as typeof fetch;
  const r = await pollForToken('sess', kp, { env, fetchImpl, sleep: noSleep });
  assert.deepEqual(r, { ok: true, token: 'backthread_pat_net' });
});

test('rejects a ready payload the CLI cannot decrypt (key mismatch)', async () => {
  const kp = generateEphemeralKeypair();
  const otherKp = generateEphemeralKeypair();
  const enc = encryptForKeypair('backthread_pat_x', otherKp); // encrypted to the WRONG key
  const fetchImpl = (async () => jsonResponse(200, { status: 'ready', ...enc })) as unknown as typeof fetch;
  const r = await pollForToken('sess', kp, { env, fetchImpl, sleep: noSleep });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'error');
});
