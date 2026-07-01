// cliAuthPoll.ts — the CLI's poll loop for the loopback-free login (ARP-773).
//
// After opening the browser to /cli-auth?session=&k=, `backthread login` polls the public
// cli-auth-poll endpoint (consume mode) until the browser has stashed the encrypted token.
// On 'ready' we decrypt locally with our ephemeral private key and return the token. The
// browser stays on app.backthread.dev the whole time — no 127.0.0.1, no localhost landing,
// and because delivery is via polling the browser can even be on ANOTHER device (SSH /
// containers work with no flags).
//
// The network + timing are injectable (fetch / sleep / now) so the loop is unit-testable
// without a real server or real waits.
import type { ECDH } from 'node:crypto';
import { decryptToken, type EphemeralKeypair, type EncryptedPayload } from './cliAuthCrypto.js';
import { buildCliAuthPollUrl } from './urls.js';
import { versionHeaders } from './version.js';

const TOKEN_RE = /^backthread_pat_[A-Za-z0-9_-]+$/;

export type PollResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'expired' | 'timeout' | 'error'; message: string };

export interface PollOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: inject a fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Poll cadence (ms). Default 1500. */
  intervalMs?: number;
  /** Overall budget (ms) before giving up. Default 5 min (the CLI's wait window). */
  timeoutMs?: number;
  /** Test seams for deterministic timing. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// Poll until the browser delivers the encrypted token (then decrypt + return it), the
// session expires, or the timeout elapses. Never throws — every failure path returns a
// typed reason the caller turns into a clear message.
export async function pollForToken(
  sessionId: string,
  keypair: EphemeralKeypair,
  opts: PollOptions = {},
): Promise<PollResult> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const interval = opts.intervalMs ?? 1500;
  const timeout = opts.timeoutMs ?? 5 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  const url = buildCliAuthPollUrl(env);
  const deadline = now() + timeout;

  while (now() < deadline) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...versionHeaders() },
        // The CLI is the CONSUMING poller (default mode) — the browser peeks separately.
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch {
      // Transient network error — back off and retry within the budget.
      await sleep(interval);
      continue;
    }

    // 429 rate_limited (or any 5xx): back off and retry; never fatal on its own.
    if (res.status === 429 || res.status >= 500) {
      await sleep(interval);
      continue;
    }

    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const status = typeof body?.status === 'string' ? body.status : null;

    if (status === 'ready') {
      const enc = extractPayload(body);
      if (!enc) return { ok: false, reason: 'error', message: 'incomplete token payload from the server' };
      let token: string;
      try {
        token = decryptToken(enc, keypair.ecdh as ECDH);
      } catch {
        return { ok: false, reason: 'error', message: 'could not decrypt the token (key mismatch)' };
      }
      // Bound the decrypted plaintext to the exact token shape before it's stored/used.
      if (!TOKEN_RE.test(token)) {
        return { ok: false, reason: 'error', message: 'the decrypted token was malformed' };
      }
      return { ok: true, token };
    }

    if (status === 'expired') {
      return { ok: false, reason: 'expired', message: 'the login session expired before you authorized' };
    }
    if (status === 'consumed') {
      // Someone (or a duplicate poll) already claimed this session's one-time fetch.
      return { ok: false, reason: 'error', message: 'this login was already used — start a fresh `backthread login`' };
    }

    // 'pending' (or an unknown transient) → keep waiting.
    await sleep(interval);
  }

  return { ok: false, reason: 'timeout', message: 'timed out waiting for the browser to authorize this device' };
}

// Pull the three ciphertext fields out of a 'ready' response, or null if any is missing.
function extractPayload(body: Record<string, unknown> | null): EncryptedPayload | null {
  if (!body) return null;
  const { page_ephemeral_pubkey, iv, ciphertext } = body;
  if (typeof page_ephemeral_pubkey === 'string' && typeof iv === 'string' && typeof ciphertext === 'string') {
    return { page_ephemeral_pubkey, iv, ciphertext };
  }
  return null;
}
