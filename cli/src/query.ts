// query.ts — the "how does X work?" read path behind the MCP
// `query` tool.
//
// This is the in-Claude-Code complement to the in-app materialized Flows list
// (src/lib/decisionsPanel.ts): per product.md the CC-side MCP query + a future
// in-app ask-bar are the two query entry points. It reads the salience-ranked
// Flows + Decisions ("why" layer) for the configured repo from the read
// endpoint (read-decisions), authenticated with the `backthread_pat_` device
// token, and returns them PLUS a deep-link into the web-app diagram so the founder
// can jump from CC to the visual.
//
// READ-ONLY: no DML, no inference, no source ever leaves the machine. The only
// network hop is the authenticated POST to read-decisions (repo ref in the body,
// never in a logged URL). Mirrors capture.ts's deps-seam style so tests inject a
// fake config (WITH a device_token), a mocked fetch, and a git-remote reader — no
// live network, no browser, no real auth.

import { readConfig, type BackthreadConfig } from './config.js';
import { resolveRepo, type RemoteReader, type RepoHandle } from './repo.js';
import { buildReadDecisionsUrl, buildRepoDeepLink } from './urls.js';
import { versionHeaders } from './version.js';

// --- response contract (mirrors read-decisions/shape.ts FlowOut / DecisionOut) ---
// Kept structural (not imported from supabase/) so the cli package never crosses
// into the Edge Function bundle. The endpoint already salience-ranks both lists.

export interface QueryFlow {
  id: string;
  name: string;
  lifecycle: string;
  salience: number | null;
  canonicalFlowId: string | null;
}

export interface QueryDecision {
  id: string;
  title: string;
  why: string | null;
  significance: number | null;
  domainRisk: string | null;
  decidedAt: string | null;
  flowIds: string[];
  moduleIds: string[];
}

/** A terse machine-readable status for the MCP tool layer + tests. */
export type QueryStatus =
  | 'ok' // got flows/decisions (either list may be empty — a valid answer)
  | 'no-auth' // no device token in config — the user must `backthread login`
  | 'no-repo' // no repo in config and none resolvable from cwd
  | 'read-failed' // the read-decisions request failed / was rejected
  | 'error'; // any unexpected failure (swallowed; never thrown)

export interface QueryOutcome {
  status: QueryStatus;
  /** Human-readable detail. Never contains the device token. */
  detail: string;
  /** The repo the query ran against (when resolved). */
  repo?: RepoHandle;
  /** Salience-ranked Flows for the repo (when status === 'ok'). */
  flows?: QueryFlow[];
  /** Salience-ranked Decisions for the repo (when status === 'ok'). */
  decisions?: QueryDecision[];
  /** Deep-link into the web-app diagram for the repo (when resolved). */
  deepLink?: string;
}

export interface QueryInput {
  /**
   * Optional caller-supplied repo override as `owner/name` or `owner`+`name`.
   * When absent we resolve the repo from config.repo, then from cwd's git remote.
   * (The "how does X work?" free-text intent is NOT a repo selector — X is the
   * subsystem the founder asks about; the answer is the whole salience-ranked log,
   * which is already "a log, not a firehose". We surface the ranked lists and let
   * the agent narrate against X; we do not server-side filter by X here.)
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
 * Run the "how does X work?" read. NEVER throws — every failure mode resolves with
 * a `QueryOutcome` (the MCP tool layer renders it). The only network hop is the
 * authenticated POST to read-decisions.
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

    let res: Response;
    try {
      res = await doFetch(buildReadDecisionsUrl(env), {
        method: 'POST',
        headers: {
          // Bearer device token — never logged.
          Authorization: `Bearer ${config.device_token}`,
          'Content-Type': 'application/json',
          ...versionHeaders(), // x-backthread-version — server-side compat guard
        },
        body: JSON.stringify({ repo: { owner: repo.owner, name: repo.name } }),
      });
    } catch (e) {
      return {
        status: 'read-failed',
        detail: `read request failed: ${(e as Error).message}`,
        repo,
        deepLink,
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
        status: 'read-failed',
        detail: `read rejected (${res.status}): ${serverErr}`,
        repo,
        deepLink,
      };
    }

    const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const flows = normalizeFlows(rec.flows);
    const decisions = normalizeDecisions(rec.decisions);

    // Non-fatal upgrade nudge for an outdated-but-supported client.
    const upgrade = typeof rec.upgrade === 'string' && rec.upgrade.length > 0 ? rec.upgrade : null;
    const base = `${flows.length} flow(s), ${decisions.length} decision(s) for ${repo.owner}/${repo.name}.`;
    return {
      status: 'ok',
      detail: upgrade ? `${base} ${upgrade}` : base,
      repo,
      flows,
      decisions,
      deepLink,
    };
  } catch (e) {
    return { status: 'error', detail: `query failed (swallowed): ${(e as Error).message}` };
  }
}

// --- defensive normalizers ---------------------------------------------------
// The endpoint owns the shape, but we never trust a network payload blindly:
// coerce to the contract so a malformed field can't crash the tool layer.

function normalizeFlows(raw: unknown): QueryFlow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => {
    const r = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      lifecycle: String(r.lifecycle ?? ''),
      salience: typeof r.salience === 'number' ? r.salience : null,
      canonicalFlowId: typeof r.canonicalFlowId === 'string' ? r.canonicalFlowId : null,
    };
  });
}

function normalizeDecisions(raw: unknown): QueryDecision[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => {
    const r = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? ''),
      title: String(r.title ?? ''),
      why: typeof r.why === 'string' ? r.why : null,
      significance: typeof r.significance === 'number' ? r.significance : null,
      domainRisk: typeof r.domainRisk === 'string' ? r.domainRisk : null,
      decidedAt: typeof r.decidedAt === 'string' ? r.decidedAt : null,
      flowIds: Array.isArray(r.flowIds) ? r.flowIds.map(String) : [],
      moduleIds: Array.isArray(r.moduleIds) ? r.moduleIds.map(String) : [],
    };
  });
}
