// claim.ts — the claim-code exchange client, the CLI half of the
// /device/claim endpoint pair.
//
// The frictionless-onboarding auth path: the web app (authed session) mints a
// short-lived, SINGLE-USE claim code via mint-claim and shows the user a command
// like `npx backthread install --claim backthread_claim_…`. This module posts that
// code to the UNAUTHED exchange-claim Edge Function, which burns it and mints a
// real `backthread_pat_` device token via the existing path. The token comes
// back ONCE over TLS and goes straight into ~/.backthread/config.json at 0600 —
// it is NEVER printed, logged, or placed in a URL/command. Only the disposable
// code ever travels in a command, by design.
//
// Mirrors the deps-seam style of query.ts/capture.ts so tests inject a mocked
// fetch and a temp config dir (BACKTHREAD_CONFIG_DIR) — no live network, no real
// $HOME.

import { updateConfig } from './config.js';
import { functionsBaseUrl, appBaseUrl } from './urls.js';
import { versionHeaders } from './version.js';

// Plaintext prefix of every claim code (lockstep with the mint-claim /
// exchange-claim Edge Functions). A code is NOT a token — visually distinct from
// `backthread_pat_` so the two can never be confused or cross-accepted.
export const CLAIM_PREFIX = 'backthread_claim_';

/** A string is claim-shaped iff it carries the prefix AND a non-empty body. */
export function isClaimCode(code: string): boolean {
  return code.startsWith(CLAIM_PREFIX) && code.length > CLAIM_PREFIX.length;
}

// Build the exchange-claim URL on the Functions origin (same origin + override
// seam as ingest/read — BACKTHREAD_FUNCTIONS_URL for local dev).
export function buildExchangeClaimUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(`${functionsBaseUrl(env)}/exchange-claim`).toString();
}

export interface ClaimExchangeOptions {
  /** Device label stored on the minted token (the caller passes the hostname). */
  label?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: inject a fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ClaimExchangeResult {
  ok: boolean;
  /** Human-readable outcome — NEVER contains the token value. */
  message: string;
}

/**
 * Exchange a claim code for a device token and persist it (with its account
 * binding) to ~/.backthread/config.json at 0600. The token is deliberately not
 * returned — a caller can't accidentally log it (same posture as login()).
 */
export async function exchangeClaim(
  rawCode: string,
  opts: ClaimExchangeOptions = {},
): Promise<ClaimExchangeResult> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;

  // Shape-check locally first: a pasted token, a truncated code, or random text
  // gets a clear message with zero network.
  const code = rawCode.trim();
  if (!isClaimCode(code)) {
    return {
      ok: false,
      message: `That doesn't look like a claim code (expected ${CLAIM_PREFIX}…). Copy the full code from ${appBaseUrl(env)}.`,
    };
  }

  let res: Response;
  try {
    res = await doFetch(buildExchangeClaimUrl(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...versionHeaders() },
      // The code travels in the BODY (never the URL, so it can't land in server
      // access logs), alongside the device label for the "Connected devices" UI.
      body: JSON.stringify({ code, label: opts.label ?? null }),
    });
  } catch (err) {
    return { ok: false, message: `Could not reach the exchange endpoint: ${(err as Error).message}` };
  }

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (!res.ok) {
    return { ok: false, message: exchangeErrorMessage(res.status, body, env) };
  }

  const token = body?.token;
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, message: 'Exchange succeeded but no token was returned — please try a fresh code.' };
  }

  // Persist at 0600 via the config writer (read-modify-write — an existing
  // repo slug is left untouched). The account binding comes back with the token
  // so `backthread whoami` can show it.
  const account = typeof body?.account === 'string' && body.account.length > 0 ? body.account : undefined;
  await updateConfig(account ? { device_token: token, account } : { device_token: token }, env);

  return { ok: true, message: `Device authorized. Token stored in ${configLocationHint(env)} (chmod 0600).` };
}

// Map the exchange endpoint's error slugs to actionable messages. The slugs are
// the contract from exchange-claim/index.ts; anything unrecognized falls back to
// the HTTP status (+ server message when present, which never echoes the code).
function exchangeErrorMessage(
  status: number,
  body: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
): string {
  const slug = typeof body?.error === 'string' ? body.error : null;
  const fresh = `Generate a fresh code at ${appBaseUrl(env)} and try again.`;
  switch (slug) {
    case 'invalid_code':
      return `Unknown claim code. ${fresh}`;
    case 'code_expired':
      return `This claim code has expired (codes live ~10 minutes). ${fresh}`;
    case 'code_used':
      return `This claim code was already used — codes are single-use. ${fresh}`;
    case 'rate_limited':
      return 'Too many attempts from this machine — wait a few minutes and try again.';
    default: {
      const detail = typeof body?.message === 'string' ? ` — ${body.message}` : '';
      return `Exchange failed (HTTP ${status})${detail}`;
    }
  }
}

// Human-readable config path for messages, without leaking the token (same hint
// login.ts prints).
function configLocationHint(env: NodeJS.ProcessEnv): string {
  return env.BACKTHREAD_CONFIG_DIR ? `${env.BACKTHREAD_CONFIG_DIR}/config.json` : '~/.backthread/config.json';
}
