import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, hkdfSync, createCipheriv, randomBytes } from 'node:crypto';
import {
  generateSessionId,
  generateEphemeralKeypair,
  decryptToken,
  type EncryptedPayload,
} from './cliAuthCrypto.js';

// The riskiest surface in the epic: the browser encrypt must round-trip with this CLI
// decrypt. We prove it WITHOUT a browser by running the EXACT page-side encrypt using the
// global Web Crypto (`crypto.subtle`, present in Node ≥ 20 / this repo's Node 22 floor),
// then decrypting with the real `decryptToken`. Mirrors the app repo's interop test from
// the opposite side — both are pinned to the same protocol constants
// (salt='backthread-cli-auth', info='device-token-v1', P-256, AES-256-GCM, tag appended).

const HKDF_SALT = new TextEncoder().encode('backthread-cli-auth');
const HKDF_INFO = new TextEncoder().encode('device-token-v1');

function toB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The page-side encrypt, byte-identical to backthread-app/src/cli-auth/cliAuthCrypto.ts.
async function browserEncrypt(token: string, cliPubKeyB64url: string): Promise<EncryptedPayload> {
  const subtle = globalThis.crypto.subtle;
  const cliPub = await subtle.importKey(
    'raw',
    Buffer.from(cliPubKeyB64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const pageKp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pagePubRaw = new Uint8Array(await subtle.exportKey('raw', pageKp.publicKey));
  const sharedBits = await subtle.deriveBits({ name: 'ECDH', public: cliPub }, pageKp.privateKey, 256);
  const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
  const aesKeyBits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    hkdfKey,
    256,
  );
  const aesKey = await subtle.importKey('raw', aesKeyBits, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(token));
  return {
    page_ephemeral_pubkey: toB64url(pagePubRaw),
    iv: toB64url(iv),
    ciphertext: toB64url(new Uint8Array(ctBuf)),
  };
}

test('generateSessionId is high-entropy, url-safe, unique', () => {
  const a = generateSessionId();
  const b = generateSessionId();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 40); // 32 bytes → ~43 chars
});

test('generateEphemeralKeypair yields a base64url raw P-256 public point', () => {
  const kp = generateEphemeralKeypair();
  assert.match(kp.publicKeyB64url, /^[A-Za-z0-9_-]+$/);
  // 65-byte uncompressed point → ~87 base64url chars
  assert.ok(kp.publicKeyB64url.length >= 80 && kp.publicKeyB64url.length <= 100);
});

test('decryptToken recovers a token the BROWSER (Web Crypto) encrypted to the CLI key', async () => {
  const kp = generateEphemeralKeypair();
  const token = 'backthread_pat_' + toB64url(new Uint8Array(randomBytes(32)));
  const enc = await browserEncrypt(token, kp.publicKeyB64url);
  assert.equal(decryptToken(enc, kp.ecdh), token);
});

test('a wrong private key cannot decrypt (GCM tag fails)', async () => {
  const kp = generateEphemeralKeypair();
  const enc = await browserEncrypt('backthread_pat_secret', kp.publicKeyB64url);
  const attacker = createECDH('prime256v1');
  attacker.generateKeys();
  assert.throws(() => decryptToken(enc, attacker));
});

test('a tampered ciphertext is rejected by the GCM tag', async () => {
  const kp = generateEphemeralKeypair();
  const enc = await browserEncrypt('backthread_pat_secret', kp.publicKeyB64url);
  const bytes = Buffer.from(enc.ciphertext.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  bytes[0] ^= 0xff;
  const tampered: EncryptedPayload = {
    ...enc,
    ciphertext: bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  };
  assert.throws(() => decryptToken(tampered, kp.ecdh));
});

test('format check: a node-encrypted payload (page protocol) also decrypts', () => {
  // Independent of Web Crypto — guards the tag-append + base64url layout.
  const cli = generateEphemeralKeypair();
  const page = createECDH('prime256v1');
  page.generateKeys();
  const shared = page.computeSecret(cli.ecdh.getPublicKey());
  const aesKey = Buffer.from(hkdfSync('sha256', shared, Buffer.from('backthread-cli-auth'), Buffer.from('device-token-v1'), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([cipher.update('backthread_pat_xyz', 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const enc: EncryptedPayload = {
    page_ephemeral_pubkey: toB64url(new Uint8Array(page.getPublicKey())),
    iv: toB64url(new Uint8Array(iv)),
    ciphertext: toB64url(new Uint8Array(Buffer.concat([ct, tag]))),
  };
  assert.equal(decryptToken(enc, cli.ecdh), 'backthread_pat_xyz');
});
