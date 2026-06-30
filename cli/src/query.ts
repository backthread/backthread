// query.ts — the "how does X work?" read path behind the MCP `query` tool.
//
// THIN CLIENT (ARP-753/758): the cli no longer fetches the raw decision log and
// lets the agent synthesize. It relays the user's question + the resolved repo to
// the worker's `/grounded-ask` endpoint, which retrieves the question-relevant
// merged decisions and SYNTHESISES one grounded, cited, never-refusing answer on a
// cheap model (Gemini Flash-Lite) — then we render that prose VERBATIM. After this
// one change all prompt/model/retrieval tuning stays server-side (no further cli
// publishes).
//
// READ-ONLY: no DML, no inference here, no source ever leaves the machine. The only
// network hop is the authenticated POST to /grounded-ask (question + repo ref in the
// body, never in a logged URL). Mirrors capture.ts's deps-seam style so tests inject
// a fake config (WITH a device_token), a mocked fetch, and a git-remote reader — no
// live network, no browser, no real auth.

import { readConfig, type BackthreadConfig } from './config.js';
import { resolveRepo, type RemoteReader, type RepoHandle } from './repo.js';
import { buildGroundedAskUrl, buildRepoDeepLink } from './urls.js';
import { versionHeaders } from './version.js';

// The general-purpose question used when the caller invokes the tool without one.
// /grounded-ask requires a non-empty question; this keeps a bare `query` useful.
const DEFAULT_QUESTION = 'How does this project work?';

// Client-side bound on the grounded-ask round-trip (two server-side Flash-Lite
// calls). Comfortably above the typical few seconds; abort → a clean read-failed.
const GROUNDED_ASK_TIMEOUT_MS = 30_000;

// --- response contract (mirrors the worker /grounded-ask answer contract) -----
// Kept structural (not imported from worker/) so the cli package never crosses into
// the worker bundle. The server owns synthesis + the citation shape.

/** A structured citation the server resolved (for future spatial highlighting; the
 * Tier-1 cli renders the prose `answer`, which already embeds [n] + a Sources list). */
export interface QueryCitation {
  n: number;
  decisionId: string;
  title: string;
  url: string;
  moduleIds: string[];
  decidedAt: string | null;
}

/** A terse machine-readable status for the MCP tool layer + tests. */
export type QueryStatus =
  | 'ok' // got a synthesized grounded answer
  | 'no-auth' // no device token in config — the user must `backthread login`
  | 'no-repo' // no repo in config and none resolvable from cwd
  | 'read-failed' // the grounded-ask request failed / was rejected
  | 'error'; // any unexpected failure (swallowed; never thrown)

export interface QueryOutcome {
  status: QueryStatus;
  /** Human-readable detail. Never contains the device token. */
  detail: string;
  /** The repo the query ran against (when resolved). */
  repo?: RepoHandle;
  /** The server's synthesized, cited answer — rendered VERBATIM (when status 'ok'). */
  answer?: string;
  /** 'full' | 'partial' — the server's coverage flag (when status 'ok'). */
  coverage?: string;
  /** Structured citations the answer's [n] markers map to (when status 'ok'). */
  citations?: QueryCitation[];
  /** The claims the server flagged inferred (when status 'ok'). */
  inferredSpans?: string[];
  /** Deep-link into the web-app diagram for the repo (when resolved). */
  deepLink?: string;
  /**
   * ARP-734 — the server's non-fatal `upgrade` nudge string, when present. Kept
   * SEPARATE from `detail`/`answer` so the interactive presenter (the MCP query
   * tool) can surface it THROTTLED (once/day per machine). Absent when no nudge.
   */
  upgrade?: string;
}

export interface QueryInput {
  /**
   * The "how does X work?" question. RELAYED to the server, which retrieves the
   * question-relevant decisions and synthesises the answer (unlike the old path,
   * the question IS now load-bearing server-side). Defaults to a general question
   * when absent so a bare `query` still returns something useful.
   */
  question?: string;
  /**
   * Optional caller-supplied repo override as `owner/name` or `owner`+`name`. When
   * absent we resolve the repo from config.repo, then from cwd's git remote.
   */
  repo?: string | { owner: string; name: string };
  /** The session's working directory, used as the repo fallback (git remote). */
  cwd?: string;
}

export interface QueryDeps {
  /** Env override seam. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: inject a fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: the config reader. Defaults to readConfig(). */
  readConfigImpl?: (env: NodeJS.ProcessEnv) => Promise<BackthreadConfig>;
  /** Test seam: the git-remote reader threaded into resolveRepo. */
  readRemoteImpl?: RemoteReader;
}

/** Parse a `owner/name` slug into a RepoHandle, or null if malformed. */
function parseSlug(slug: string): RepoHandle | null {
  const parts = slug.trim().replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  return { owner, name };
}

/**
 * Resolve which repo the query runs against. Precedence:
 *   1. an explicit `input.repo` (string slug or {owner,name}),
 *   2. the configured repo slug (config.repo = "owner/name"),
 *   3. the cwd's git remote (resolveRepo).
 * Returns null when none yields a valid owner/name.
 */
export function resolveQueryRepo(
  input: QueryInput,
  config: BackthreadConfig,
  readRemote?: RemoteReader,
): RepoHandle | null {
  if (input.repo) {
    if (typeof input.repo === 'string') {
      const parsed = parseSlug(input.repo);
      if (parsed) return parsed;
    } else if (input.repo.owner && input.repo.name) {
      return { owner: input.repo.owner, name: input.repo.name };
    }
  }
  if (config.repo) {
    const parsed = parseSlug(config.repo);
    if (parsed) return parsed;
  }
  if (input.cwd) {
    return resolveRepo(input.cwd, readRemote);
  }
  return null;
}

/**
 * Run the "how does X work?" grounded ask. NEVER throws — every failure mode
 * resolves with a `QueryOutcome` (the MCP tool layer renders it). The only network
 * hop is the authenticated POST to /grounded-ask; the server does the retrieval +
 * synthesis and returns ready-to-render prose.
 */
export async function queryDecisions(
  input: QueryInput,
  deps: QueryDeps = {},
): Promise<QueryOutcome> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const doReadConfig = deps.readConfigImpl ?? readConfig;

  try {
    const config = await Promise.resolve()
      .then(() => doReadConfig(env))
      .catch(() => ({}) as BackthreadConfig);

    // Auth gate. Unlike capture (a best-effort hook), query is an explicit user
    // action — so we DON'T kick off a browser login fire-and-forget here. We just
    // tell the caller to `backthread login`. (The guardrail: never trigger real auth.)
    if (!config.device_token) {
      return {
        status: 'no-auth',
        detail: 'not authenticated — run `backthread login` first (no device token in config).',
      };
    }

    const repo = resolveQueryRepo(input, config, deps.readRemoteImpl);
    if (!repo) {
      return {
        status: 'no-repo',
        detail:
          'could not determine a repo — set one with `backthread connect` / config.repo, pass repo "owner/name", or run from a git repo with an origin remote.',
      };
    }

    const deepLink = buildRepoDeepLink(repo.owner, repo.name, env);
    const question =
      typeof input.question === 'string' && input.question.trim().length > 0
        ? input.question.trim()
        : DEFAULT_QUESTION;

    // Unlike the old read-decisions hop, /grounded-ask does two Flash-Lite calls
    // server-side, so a response is seconds — bound it with a client-side timeout so
    // a hung/slow worker yields a clean read-failed instead of stalling the tool
    // (the MCP host timeout would be the only backstop otherwise).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), GROUNDED_ASK_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(buildGroundedAskUrl(env), {
        method: 'POST',
        headers: {
          // Bearer device token — never logged.
          Authorization: `Bearer ${config.device_token}`,
          'Content-Type': 'application/json',
          ...versionHeaders(), // x-backthread-version — server-side compat guard
        },
        // The server accepts `repo` as an "owner/name" slug (it re-resolves + gates).
        body: JSON.stringify({ question, repo: `${repo.owner}/${repo.name}` }),
        signal: ac.signal,
      });
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      return {
        status: 'read-failed',
        detail: aborted
          ? `grounded-ask timed out after ${GROUNDED_ASK_TIMEOUT_MS / 1000}s — try again.`
          : `grounded-ask request failed: ${(e as Error).message}`,
        repo,
        deepLink,
      };
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

    if (!res.ok) {
      // A 426 means the server soft-blocked this `backthread` as too old. Prefer the
      // friendly `message` over the machine error code.
      const serverErr =
        typeof rec.message === 'string' && rec.message.length > 0
          ? rec.message
          : 'error' in rec
            ? String(rec.error)
            : `HTTP ${res.status}`;
      return {
        status: 'read-failed',
        detail: `grounded-ask rejected (${res.status}): ${serverErr}`,
        repo,
        deepLink,
      };
    }

    const answer = typeof rec.answer === 'string' ? rec.answer : '';
    if (!answer) {
      // Shouldn't happen (the server never-refuses), but never render an empty tool
      // result: degrade to a clear read-failed with the diagram link.
      return {
        status: 'read-failed',
        detail: 'grounded-ask returned no answer.',
        repo,
        deepLink,
      };
    }

    const upgrade = typeof rec.upgrade === 'string' && rec.upgrade.length > 0 ? rec.upgrade : undefined;
    return {
      status: 'ok',
      detail: `grounded answer (${typeof rec.coverage === 'string' ? rec.coverage : 'partial'} coverage)`,
      repo,
      answer,
      coverage: typeof rec.coverage === 'string' ? rec.coverage : undefined,
      citations: normalizeCitations(rec.citations),
      inferredSpans: Array.isArray(rec.inferredSpans) ? rec.inferredSpans.map(String) : [],
      // Prefer the server's deepLink; fall back to the locally-built one.
      deepLink: typeof rec.deepLink === 'string' && rec.deepLink.length > 0 ? rec.deepLink : deepLink,
      ...(upgrade ? { upgrade } : {}),
    };
  } catch (e) {
    return { status: 'error', detail: `query failed (swallowed): ${(e as Error).message}` };
  }
}

// --- defensive normalizer ----------------------------------------------------
// The endpoint owns the shape, but we never trust a network payload blindly.

function normalizeCitations(raw: unknown): QueryCitation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const r = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    return {
      n: typeof r.n === 'number' ? r.n : 0,
      decisionId: String(r.decisionId ?? ''),
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      moduleIds: Array.isArray(r.moduleIds) ? r.moduleIds.map(String) : [],
      decidedAt: typeof r.decidedAt === 'string' ? r.decidedAt : null,
    };
  });
}
