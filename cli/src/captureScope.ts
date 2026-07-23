// captureScope.ts — the pre-send capture-scope check (ARP-1054).
//
// Before the capture hook sends ANYTHING for a session, it asks the Worker's
// /capture-scope preflight "is capture on for owner/name, for me?" carrying ONLY the
// repo slug + the device token — never the transcript, never source. The reply lets
// the hook SKIP the whole send for a repo the user turned capture OFF, or a repo that
// isn't connected to Backthread — so an off-repo's source never leaves the machine
// (the client-side half of per-repo capture scoping; the server enforces the same
// decision post-send, ARP-1053, but by then the transcript has already been sent on
// the connected/persist path, so only THIS pre-send skip keeps it on the machine).
//
// FAIL-OPEN (load-bearing): the hook SKIPS only on an explicit, clean `skip` verdict
// from a 200 response. ANY doubt — a network error, any non-200, a malformed body, a
// missing/unrecognized `decision` — resolves to SEND, so a preflight hiccup can never
// silently drop a real capture (matching the server's own posture: it returns a 5xx,
// never a false skip, on any lookup error). The extra cost is one tiny background
// round-trip per capture; the capture hook is detached + best-effort, so it's unseen.

import type { BackthreadConfig } from './config.js';
import { buildCaptureScopeUrl } from './urls.js';
import { versionHeaders } from './version.js';

// The server's scope reasons (mirrors worker/src/captureScope.ts ScopeReason). Only
// 'not_connected' drives the local connect nudge; every other skip reason is silent.
export type ScopeReason =
  | 'connected'
  | 'not_connected'
  | 'repo_not_writable'
  | 'not_a_member'
  | 'capture_paused';

export interface ScopeVerdict {
  /** Whether the hook should send this session's transcript at all. */
  send: boolean;
  /**
   * The server's reason verbatim (a ScopeReason), or one of two client-only sentinels:
   *   'unknown' — we failed OPEN (no clean verdict → send).
   *   'other'   — a clean skip whose reason we don't recognize (a future server value)
   *               → still a SILENT skip (only 'not_connected' nudges).
   * The caller nudges iff this is exactly 'not_connected'.
   */
  reason: ScopeReason | 'unknown' | 'other';
}

// The preflight fetch timeout. This is a NEW blocking gate ahead of the transcript
// read, so a black-hole endpoint must not hang the (detached) capture process — on
// abort the catch below fails OPEN (send), like any other network error. Matches the
// read-path idiom (query.ts / localDecisions.ts wrap fetch in an AbortController).
const CAPTURE_SCOPE_TIMEOUT_MS = 10_000;

/**
 * PURE core: map a preflight HTTP outcome → the send/skip verdict. FAIL-OPEN — the
 * ONLY suppressing case is a clean 200 whose body says `decision:'skip'`. Everything
 * else resolves to send:
 *   - ok:false (the fetch threw)                 → send (reason 'unknown')
 *   - any non-200 status                         → send (reason 'unknown')
 *   - 200 with decision:'capture'                → send (reason 'connected')
 *   - 200 with an absent/unrecognized decision   → send (reason 'unknown')
 *   - 200 with decision:'skip'                   → SKIP (reason = the server's reason)
 * Exported + unit-tested. `ok` is whether the fetch itself resolved; `status`/`payload`
 * are only meaningful when ok.
 */
export function interpretScopeResponse(ok: boolean, status: number, payload: unknown): ScopeVerdict {
  if (!ok || status !== 200) return { send: true, reason: 'unknown' };
  const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (rec.decision === 'skip') {
    // Skip on the server's word. Carry the reason through when it's one we recognize;
    // an unrecognized skip reason (a future server value) maps to the 'other' sentinel
    // — a SILENT skip (only 'not_connected' nudges), with a faithful label for logs.
    const reason = isKnownReason(rec.reason) ? rec.reason : 'other';
    return { send: false, reason };
  }
  // capture / absent / unrecognized decision → send (fail-open).
  return { send: true, reason: rec.decision === 'capture' ? 'connected' : 'unknown' };
}

function isKnownReason(v: unknown): v is ScopeReason {
  return (
    v === 'connected' ||
    v === 'not_connected' ||
    v === 'repo_not_writable' ||
    v === 'not_a_member' ||
    v === 'capture_paused'
  );
}

export interface CaptureScopeDeps {
  /** Env override seam (BACKTHREAD_WORKER_URL). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test/dev seam: inject a fetch. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Ask the Worker whether capture is on for `repo`, for this device token. Returns the
 * send/skip verdict. NEVER throws + FAILS OPEN: no token, a network error, or any
 * non-200 → { send: true } (the capture proceeds and the server applies the same,
 * authoritative decision). Only a clean 200 `decision:'skip'` suppresses the send.
 */
export async function checkCaptureScope(
  repo: { owner: string; name: string },
  config: BackthreadConfig,
  deps: CaptureScopeDeps = {},
): Promise<ScopeVerdict> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const token = config.device_token;
  // No credential → can't ask → fail open (the pipeline's auth gate handles no-token
  // upstream, but be defensive: never block a capture on a missing preflight).
  if (!token) return { send: true, reason: 'unknown' };

  // Bound the preflight so a hung endpoint can't stall the detached capture (+ the
  // gap-recovery sweep behind it). An abort throws into the catch → fail open (send).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_SCOPE_TIMEOUT_MS);
  try {
    const res = await doFetch(buildCaptureScopeUrl(env), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, // device token — never logged
        'Content-Type': 'application/json',
        ...versionHeaders(),
      },
      body: JSON.stringify({ repo: { owner: repo.owner, name: repo.name } }),
      signal: controller.signal,
    });
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    return interpretScopeResponse(true, res.status, payload);
  } catch {
    // Network/transport error OR a timeout abort → fail open. A preflight hiccup must
    // never drop a capture.
    return interpretScopeResponse(false, 0, null);
  } finally {
    clearTimeout(timer);
  }
}
