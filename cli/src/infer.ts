// infer.ts — the plugin-side inference router.
//
// Given a normalized + redacted transcript and the local config, this decides
// HOW decisions get derived and WHOSE credentials pay, then returns the derived
// decisions for the caller (the hook / MCP) to POST to ingest-decisions
// — unless the server already persisted them (see `persisted` in the result).
//
// The model menu was LOCKED after the ToS spike:
//
//   Model 2 (server-side, OUR keys) — the DEFAULT path, shipping now.
//     The plugin POSTs the REDACTED transcript to the ingest Worker's
//     `POST /infer-decisions` (worker/src/infer.ts), authenticated with the
//     `backthread_pat_` device token. The Worker runs server-side inference
//     with our keys and returns derived decisions.
//
//   Model 3 (BYO API key) — a power-user / cost-conscious override.
//     If the account has a BYO provider key configured, inference runs LOCALLY
//     with it (the user pays their provider directly). The key storage +
//     validation + settings UX is — NOT built here. This module
//     ships only the SEAM (see `localByokInfer`), which currently always reports
//     "no BYOK configured" so the router falls through to Model 2.
//
//   Model 4 (vendor-sanctioned first-party headless) — PARKED, post-MVP, opt-in.
//     Deliberately NOT modelled here. Do not add it without a fresh ToS verdict.
//
// TRUST BOUNDARY (load-bearing): on the Model-2 path the *redacted* transcript
// leaves the machine — never raw source or tool I/O (transcript.ts strips that
// before this router ever sees it, and the Worker re-scrubs as defense-in-depth).
// This is the weaker "only a redacted transcript leaves the machine" claim that
// /security restates. On the Model-3 path nothing leaves the machine at all.
//
// Dependency-free: uses only global `fetch` (Node 18+/22 builtin). A `fetchImpl`
// seam lets tests inject a stub without a live network or Worker.

import { buildInferDecisionsUrl } from './urls.js';
import { versionHeaders } from './version.js';
import type { BackthreadConfig } from './config.js';

// --- public types ------------------------------------------------------------

/** Which credential path actually derived the decisions. */
export type InferModel = 'server' | 'byok';

/**
 * The redacted transcript the router accepts. Intentionally structural (not an
 * import from scripts/ingest) so the cli package stays dependency-light and the
 * worker/scripts boundary isn't crossed. Mirrors the request body's
 * `transcript` field (worker/src/infer.ts InferRequestBody).
 */
export interface RedactedTranscriptInput {
  sessionId?: string | null;
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Optional redaction stats; forwarded verbatim, ignored by the server. */
  stats?: unknown;
}

/**
 * A derived decision as returned by inference. Kept as an opaque record on the
 * cli side: the router is a transport/selection layer, not a schema validator —
 * the authoritative decision shape lives in scripts/ingest/decisions/extract.ts
 * (DecisionDraft) and the ingest-decisions RPC is the schema gate. Treating it
 * opaquely keeps the cli package free of the ingest types.
 */
export type DerivedDecision = Record<string, unknown>;

/** Optional persist target — forwarded to the Worker's optional persist leg. */
export interface PersistTarget {
  owner: string;
  name: string;
}

export interface InferOptions {
  /**
   * Ask the SERVER to also persist the derived decisions (membership-gated) under
   * `repo`, instead of only returning them. When true + `repo` set, the Model-2
   * response comes back with `persisted: true` and the caller MUST NOT re-POST to
   * ingest-decisions (it would double-write). Defaults to false: derive-only, the
   * caller persists. The hook chooses based on whether a repo is connected.
   */
  persist?: boolean;
  /** Repo to persist under (required when `persist` is true). */
  repo?: PersistTarget;
  /** ISO-8601 decided-at, threaded into the dedupe key + decided_at (persist leg). */
  decidedAt?: string;
  /**
   * Repo-relative file paths the session touched (the `sessionPaths` harvest,
   * collected pre-redaction by the caller). Forwarded to the Worker so the hosted
   * path can ANCHOR decisions to modules (the server's W3 reconcile pass maps
   * paths → modules), exactly like the local pipeline. METADATA only — directory
   * structure, never file contents (the redaction fence still strips all source +
   * tool I/O). Ignored by the server when not persisting (anchoring is persist-
   * side). Omitted from the body when empty/absent → decisions land unanchored,
   * which is correct, not an error.
   */
  filePaths?: string[];
  /**
   * ARP-696 — the session's local git context (current branch + HEAD sha + a
   * capture timestamp), forwarded to the persist leg so the server HOLDS the
   * decision as `pending_merge` until that work merges (epic ARP-694). Rides only
   * on the persist leg (like filePaths/decidedAt). The cli REPORTS git state; the
   * server decides the held state — an old client omits this → `merged`, shown
   * immediately. Individual null fields are omitted from the body.
   */
  captured?: { branch?: string | null; headSha?: string | null; at?: string | null };
  /** Test/dev seam: inject a fetch. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Env override seam (BACKTHREAD_WORKER_URL). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface InferResult {
  ok: boolean;
  /** Which credential path ran. */
  model: InferModel;
  /** The derived decisions. Empty array is a valid, cheap answer (nothing to extract). */
  decisions: DerivedDecision[];
  /**
   * True ONLY when the SERVER already wrote the decisions (Model 2 + persist).
   * When true the caller must NOT re-POST to ingest-decisions. When false the
   * caller owns persistence.
   */
  persisted: boolean;
  /** The session id echoed back (or the one we sent), for the caller's logs. */
  sessionId: string | null;
  /** Tokens spent by the inference run, when the path reports it (Model 2 does). */
  tokensSpent?: number;
  /** A human-readable error when `ok` is false. Never contains the device token. */
  error?: string;
}

// --- BYOK seam (Model 3) -----------------------------------------

/**
 * Does this config have a usable BYO provider key, and if so run inference
 * locally with it?
 *
 * TODO: implement local BYOK execution. The BYOK key storage,
 * validation, and (pleasant, non-paste-box) settings UX is groomed
 * separately. Until then this is a STUB
 * that always reports "no BYOK configured" so the router falls through to the
 * Model-2 server path. When implemented, this should:
 *   1. read the user's provider key from secure local storage (NOT config.json
 *      in plaintext — keychain / OS credential store),
 *   2. run the SAME tuned extraction pipeline locally with that key,
 *   3. return { configured: true, result } so the router skips the server.
 *
 * Returning `{ configured: false }` is the load-bearing default: absent a BYOK
 * key, we never fail — we serve the user via Model 2.
 */
export interface ByokOutcome {
  configured: boolean;
  result?: InferResult;
}

export async function localByokInfer(
  _transcript: RedactedTranscriptInput,
  _config: BackthreadConfig,
  _opts: InferOptions,
): Promise<ByokOutcome> {
  // TODO: detect + run a configured BYO key locally.
  // No key is ever configured today → always fall through to Model 2.
  return { configured: false };
}

// --- Model 2: server-side inference (the default) ----------------------------

/**
 * POST the redacted transcript to the Worker endpoint and return the
 * derived decisions. The device token authenticates the call (same credential
 * as ingest-decisions). Network/HTTP/contract failures surface as `ok:false`
 * with a clean message — the caller decides whether to retry or surface it.
 */
export async function serverInfer(
  transcript: RedactedTranscriptInput,
  config: BackthreadConfig,
  opts: InferOptions = {},
): Promise<InferResult> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;

  const token = config.device_token;
  if (!token) {
    return {
      ok: false,
      model: 'server',
      decisions: [],
      persisted: false,
      sessionId: transcript.sessionId ?? null,
      error: 'not authenticated: run `backthread login` first (no device token in config).',
    };
  }

  // Persist leg is opt-in and requires a non-empty owner/name. We validate here
  // rather than let the server reject it, so the error is actionable on the
  // client. (An empty-string owner/name would pass the Worker's `typeof ===
  // 'string'` check and only surface as a 404 from resolveRepo — fail fast here
  // with a clear message instead.)
  const wantPersist = opts.persist === true;
  if (wantPersist && !(opts.repo && opts.repo.owner && opts.repo.name)) {
    return {
      ok: false,
      model: 'server',
      decisions: [],
      persisted: false,
      sessionId: transcript.sessionId ?? null,
      error: 'persist requested but no valid repo target (owner/name) provided.',
    };
  }

  const body: Record<string, unknown> = {
    transcript: {
      sessionId: transcript.sessionId ?? null,
      turns: transcript.turns,
      stats: transcript.stats,
    },
  };
  if (wantPersist && opts.repo) {
    body.persist = true;
    body.repo = { owner: opts.repo.owner, name: opts.repo.name };
    if (opts.decidedAt) body.decidedAt = opts.decidedAt;
    // Forward the session's touched file paths so the hosted persist leg anchors
    // decisions to modules (server-side W3 reconcile). Only when non-empty — the
    // server treats an absent array as "unanchored", which is the same outcome.
    // Anchoring is a persist-side concern, so this rides only on the persist leg
    // (mirrors decidedAt). The harvest is the redact package's `sessionPaths`.
    if (opts.filePaths && opts.filePaths.length > 0) body.filePaths = opts.filePaths;
    // ARP-696 — session-level git context (branch/sha/at). Each field rides only
    // when present; absent/null → omitted, so the server reads "no capture ctx" for
    // that field. A capture with neither branch nor sha → the server keeps it merged.
    if (opts.captured?.branch != null) body.capturedBranch = opts.captured.branch;
    if (opts.captured?.headSha != null) body.capturedHeadSha = opts.captured.headSha;
    if (opts.captured?.at != null) body.capturedAt = opts.captured.at;
  }

  let res: Response;
  try {
    res = await doFetch(buildInferDecisionsUrl(env), {
      method: 'POST',
      headers: {
        // Bearer device token. Never logged by this module.
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...versionHeaders(), // x-backthread-version — server-side compat guard
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      model: 'server',
      decisions: [],
      persisted: false,
      sessionId: transcript.sessionId ?? null,
      error: `inference request failed: ${(e as Error).message}`,
    };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    // A 426 means the server soft-blocked this `backthread` as too old. Prefer
    // the friendly `message` ("please update backthread …") over the machine error code.
    const obj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const serverErr =
      typeof obj.message === 'string' && obj.message.length > 0
        ? obj.message
        : 'error' in obj
          ? String(obj.error)
          : `HTTP ${res.status}`;
    return {
      ok: false,
      model: 'server',
      decisions: [],
      persisted: false,
      sessionId: transcript.sessionId ?? null,
      error: `inference rejected (${res.status}): ${serverErr}`,
    };
  }

  const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const decisions = Array.isArray(rec.decisions) ? (rec.decisions as DerivedDecision[]) : [];
  const persisted = rec.persisted === true;
  const sessionId =
    typeof rec.sessionId === 'string' ? rec.sessionId : (transcript.sessionId ?? null);
  const tokensSpent = typeof rec.tokensSpent === 'number' ? rec.tokensSpent : undefined;

  return {
    ok: true,
    model: 'server',
    decisions,
    persisted,
    sessionId,
    ...(tokensSpent !== undefined ? { tokensSpent } : {}),
  };
}

// --- the router --------------------------------------------------------------

/**
 * Route a redacted transcript to the right inference path and return the derived
 * decisions.
 *
 * Selection (LOCKED):
 *   1. If the account has a BYO key configured (Model 3), run inference locally
 *      with it. — SEAM ONLY today (localByokInfer is a stub → never selected).
 *   2. Otherwise (the default), POST to the Worker (Model 2, our keys).
 *
 * The caller persists the returned decisions to ingest-decisions UNLESS
 * `result.persisted` is true (Model 2 + server-side persist), in which case the
 * decisions are already written — re-POSTing would double-write.
 */
export async function inferDecisions(
  transcript: RedactedTranscriptInput,
  config: BackthreadConfig,
  opts: InferOptions = {},
): Promise<InferResult> {
  // Model 3 first: a configured BYO key is an explicit user override.
  const byok = await localByokInfer(transcript, config, opts);
  if (byok.configured && byok.result) {
    return byok.result;
  }

  // Model 2 (default): server-side inference with our keys.
  return serverInfer(transcript, config, opts);
}
