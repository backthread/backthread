// cliAuthCrypto.ts — the CLI half of the poll-flow's end-to-end encryption (ARP-773).
//
// `backthread login` (poll flow) generates an ephemeral P-256 keypair, puts the PUBLIC
// key in the /cli-auth URL (`k`), and polls a server endpoint for the ciphertext the
// browser stashed. The browser encrypted the device token to our public key; only the
// PRIVATE key here (which never leaves this machine) can decrypt it. The server only ever
// stores/forwards ciphertext — the plaintext token is never visible server-side.
//
// Protocol — MUST stay byte-identical to the browser's Web Crypto encrypt in
// backthread-app/src/cli-auth/cliAuthCrypto.ts:
//   1. ECDH on P-256 between our ephemeral keypair and the page's ephemeral public key →
//      a 32-byte shared secret (the X coordinate; node ecdh.computeSecret and Web Crypto
//      deriveBits both return exactly this).
//   2. HKDF-SHA256(sharedSecret, salt=HKDF_SALT, info=HKDF_INFO) → a 32-byte AES key.
//   3. AES-256-GCM(key, iv). Web Crypto appends the 16-byte tag to the ciphertext; we
//      split the last 16 bytes off as the auth tag before decrypting.
// All wire fields are base64url (no padding). Both keypairs are single-use (forward secrecy).
import { createECDH, hkdfSync, createDecipheriv, randomBytes, type ECDH } from 'node:crypto';

// HKDF salt + info — the protocol's domain separation, part of the page<->CLI contract
// (versioned by `info`). Changing either side breaks the round-trip.
const HKDF_SALT = Buffer.from('backthread-cli-auth');
const HKDF_INFO = Buffer.from('device-token-v1');

export interface EphemeralKeypair {
  /** The node ECDH holding the private key — kept in memory only for this login. */
  ecdh: ECDH;
  /** Our public key, raw uncompressed P-256 point, base64url — goes in the URL `k`. */
  publicKeyB64url: string;
}

export interface EncryptedPayload {
  page_ephemeral_pubkey: string;
  iv: string;
  ciphertext: string;
}

// A high-entropy session id: 32 bytes (256 bits) CSPRNG, base64url. Unguessable — the
// server's poll endpoint is public, so confidentiality of WHICH ciphertext you can fetch
// rests on this.
export function generateSessionId(): string {
  return toB64url(randomBytes(32));
}

// A fresh ephemeral P-256 keypair for one login. The private key stays in the returned
// ECDH object (never serialized, never leaves the process).
export function generateEphemeralKeypair(): EphemeralKeypair {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, publicKeyB64url: toB64url(ecdh.getPublicKey()) };
}

// Decrypt the browser-encrypted device token with our ephemeral private key. Throws if
// the GCM tag fails (wrong key / tampered ciphertext) — the caller treats that as a hard
// error rather than accepting an unverified token.
export function decryptToken(enc: EncryptedPayload, ecdh: ECDH): string {
  const pagePub = fromB64url(enc.page_ephemeral_pubkey);
  const shared = ecdh.computeSecret(pagePub); // 32-byte X coordinate
  const aesKey = Buffer.from(hkdfSync('sha256', shared, HKDF_SALT, HKDF_INFO, 32));

  const ctFull = fromB64url(enc.ciphertext);
  const tag = ctFull.subarray(ctFull.length - 16);
  const ct = ctFull.subarray(0, ctFull.length - 16);
  const iv = fromB64url(enc.iv);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// base64url (RFC 4648 §5, no padding).
function toB64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Buffer {
  // Buffer.from tolerates missing padding, but normalize the url-safe alphabet first.
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
