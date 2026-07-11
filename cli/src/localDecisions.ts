// localDecisions.ts — `backthread sync`: pull the repo's MERGED decision log
// ("why") down from the server and cache it in the `decisions` section of the
// repo-local cache (localCache.ts).
//
// This is the WHY half of the two-tier grep-time context hook. The structure
// half (localGraph.ts) is computed locally; the why is authored server-side (the
// merge-gated decision log the app shows) and rarely changes intra-session (a
// decision is only visible once its work merges), so we sync it DOWN once per
// session with an hours-TTL fallback rather than hitting the network per grep.
// The per-grep join (localJoin.ts) then reads this cache — no network, no LLM,
// no billing.
//
// AUTH + SCOPING. The read is authenticated by the existing device token and
// gated SERVER-SIDE by account membership (the read-decisions Edge Function),
// so we only ever cache what the caller is already entitled to see — the same
// redacted, derived rationale the web panel renders. Nothing new leaves the
// machine; only merged (visible) decisions come back.
//
// FAIL-SOFT. Not logged in / no repo / a network hiccup → we skip (leaving any
// prior cache intact) and return a status; we never throw and never disrupt the
// session-start path that calls us.

import { readConfig as defaultReadConfig, type BackthreadConfig } from './config.js';
import { resolveRepo, type RemoteReader, type RepoHandle } from './repo.js';
import { buildReadDecisionsUrl } from './urls.js';
import { versionHeaders } from './version.js';
import {
  resolveRepoRoot as defaultResolveRepoRoot,
  readCache as defaultReadCache,
  writeCacheSection as defaultWriteCacheSection,
  type LocalCache,
  type CachedDecision,
  type DecisionsSection,
} from './localCache.js';

/** Default hours-TTL: decisions are merge-gated (rarely change intra-session),
 * so a sub-hourly re-pull is pointless. A session-start sync + this fallback
 * keeps the cache fresh without polling. */
export const DEFAULT_TTL_HOURS = 6;

// A read is fast (no LLM); bound it so a hung worker degrades cleanly. One retry
// (read-only + idempotent — safe to repeat) on timeout/5xx.
const READ_TIMEOUT_MS = 15_000;
const READ_ATTEMPTS = 2;

export type SyncDecisionsStatus =
  | 'synced' // pulled + wrote the decisions section
  | 'fresh' // cache still within TTL for this repo — skipped
  | 'no-auth' // no device token — not logged in
  | 'no-repo' // no repo in config and none resolvable from cwd
  | 'read-failed' // the read request failed / was rejected
  | 'error'; // any unexpected failure (swallowed; never thrown)

export interface SyncDecisionsOutcome {
  status: SyncDecisionsStatus;
  detail: string;
  repo?: RepoHandle;
  /** How many decisions were cached (on 'synced'). */
  count?: number;
}

export interface SyncDecisionsOptions {
  cwd?: string;
  /** Ignore the TTL and force a fresh pull. */
  force?: boolean;
  /** Override the freshness TTL (hours). Defaults to DEFAULT_TTL_HOURS. */
  ttlHours?: number;
}

export interface SyncDecisionsDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readConfigImpl?: (env: NodeJS.ProcessEnv) => Promise<BackthreadConfig>;
  readRemoteImpl?: RemoteReader;
  resolveRepoRootImpl?: (cwd: string) => string;
  readCacheImpl?: (repoRoot: string) => Promise<LocalCache | null>;
  writeCacheSectionImpl?: typeof defaultWriteCacheSection;
  now?: () => Date;
}

/** Parse an `owner/name` slug, or null. */
function parseSlug(slug: string): RepoHandle | null {
  const parts = slug.trim().replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], name: parts[1] };
}

/** Resolve the repo: config.repo first, then the cwd's git remote. */
export function resolveSyncRepo(
  config: BackthreadConfig,
  cwd: string,
  readRemote?: RemoteReader,
): RepoHandle | null {
  if (config.repo) {
    const parsed = parseSlug(config.repo);
    if (parsed) return parsed;
  }
  return resolveRepo(cwd, readRemote);
}

/** Is a cached decisions section still fresh for `repoSlug`? Pure. */
export function isFresh(
  section: DecisionsSection | null,
  repoSlug: string,
  ttlHours: number,
  now: Date,
): boolean {
  if (!section || section.repo !== repoSlug) return false;
  const synced = Date.parse(section.syncedAt);
  if (Number.isNaN(synced)) return false;
  const ageMs = now.getTime() - synced;
  return ageMs >= 0 && ageMs < ttlHours * 3_600_000;
}

// --- the read-decisions response contract (structural — the server owns it) ---

interface ReadFlow {
  id: string;
  name: string;
}
interface ReadDecision {
  id?: unknown;
  title?: unknown;
  why?: unknown;
  problem?: unknown;
  decidedAt?: unknown;
  significance?: unknown;
  moduleIds?: unknown;
  flowIds?: unknown;
  tradeoffs?: unknown;
  assumptions?: unknown;
  limitations?: unknown;
}

const asStrArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Map the read-decisions response into CachedDecision[] — only the redacted,
 * derived fields the panel shows, plus flow NAMES (resolved from the flows list)
 * so the term-join can match "how does invoicing flow" against a Flow name. Pure
 * + defensive (never trusts the network payload's shape). Exported for testing.
 */
export function mapDecisions(flows: ReadFlow[], decisions: ReadDecision[]): CachedDecision[] {
  const flowName = new Map<string, string>();
  for (const f of flows) if (f && typeof f.id === 'string' && typeof f.name === 'string') flowName.set(f.id, f.name);

  const out: CachedDecision[] = [];
  for (const d of decisions) {
    if (!d || typeof d.id !== 'string' || typeof d.title !== 'string') continue;
    const flowNames = asStrArray(d.flowIds)
      .map((id) => flowName.get(id))
      .filter((n): n is string => typeof n === 'string');
    out.push({
      id: d.id,
      title: d.title,
      why: typeof d.why === 'string' ? d.why : null,
      problem: typeof d.problem === 'string' ? d.problem : null,
      moduleIds: asStrArray(d.moduleIds),
      flowNames,
      decidedAt: typeof d.decidedAt === 'string' ? d.decidedAt : null,
      significance: typeof d.significance === 'number' ? d.significance : null,
      tradeoffs: asStrArray(d.tradeoffs),
      assumptions: asStrArray(d.assumptions),
      limitations: asStrArray(d.limitations),
    });
  }
  return out;
}

/**
 * Sync the merged decision log into the repo-local cache. NEVER throws — every
 * failure resolves to an outcome. Skips (leaves the cache untouched) when the
 * cached decisions are still within TTL for the same repo.
 */
export async function syncDecisions(
  opts: SyncDecisionsOptions = {},
  deps: SyncDecisionsDeps = {},
): Promise<SyncDecisionsOutcome> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const readConfigImpl = deps.readConfigImpl ?? defaultReadConfig;
  const resolveRoot = deps.resolveRepoRootImpl ?? defaultResolveRepoRoot;
  const readCacheImpl = deps.readCacheImpl ?? defaultReadCache;
  const writeSection = deps.writeCacheSectionImpl ?? defaultWriteCacheSection;
  const now = deps.now ?? (() => new Date());
  const ttlHours = opts.ttlHours ?? DEFAULT_TTL_HOURS;
  const cwd = opts.cwd ?? process.cwd();

  try {
    const config = await Promise.resolve()
      .then(() => readConfigImpl(env))
      .catch(() => ({}) as BackthreadConfig);

    if (!config.device_token) {
      return { status: 'no-auth', detail: 'not logged in — run `backthread login` to sync the decision cache.' };
    }

    const repo = resolveSyncRepo(config, cwd, deps.readRemoteImpl);
    if (!repo) {
      return { status: 'no-repo', detail: 'could not determine a repo (no config.repo and no git origin remote).' };
    }
    const repoSlug = `${repo.owner}/${repo.name}`;
    const repoRoot = resolveRoot(cwd);

    // Freshness gate (skip a sub-TTL re-pull) unless forced.
    if (!opts.force) {
      const prior = await readCacheImpl(repoRoot).catch(() => null);
      if (isFresh(prior?.decisions ?? null, repoSlug, ttlHours, now())) {
        return {
          status: 'fresh',
          detail: `decision cache is fresh (< ${ttlHours}h) — skipped.`,
          repo,
          count: prior?.decisions?.items.length,
        };
      }
    }

    // Fetch merged decisions (device-token auth; server gates by membership).
    let res: Response | undefined;
    let failDetail = '';
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), READ_TIMEOUT_MS);
      try {
        res = await doFetch(buildReadDecisionsUrl(env), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.device_token}`,
            'Content-Type': 'application/json',
            ...versionHeaders(),
          },
          // read-decisions expects `{ repo: { owner, name } }` (validate.ts), NOT a
          // slug string — the caller is identified from the bearer token.
          body: JSON.stringify({ repo: { owner: repo.owner, name: repo.name } }),
          signal: ac.signal,
        });
        if (res.status >= 500 && attempt < READ_ATTEMPTS) {
          failDetail = `read-decisions rejected (${res.status})`;
          res = undefined;
          continue;
        }
        break;
      } catch (e) {
        failDetail =
          (e as Error).name === 'AbortError'
            ? `read-decisions timed out after ${READ_TIMEOUT_MS / 1000}s`
            : `read-decisions request failed: ${(e as Error).message}`;
        res = undefined;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!res) {
      return { status: 'read-failed', detail: `${failDetail} (after ${READ_ATTEMPTS} attempts).`, repo };
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    if (!res.ok) {
      const serverErr =
        typeof rec.message === 'string' && rec.message.length > 0
          ? rec.message
          : 'error' in rec
            ? String(rec.error)
            : `HTTP ${res.status}`;
      return { status: 'read-failed', detail: `read-decisions rejected (${res.status}): ${serverErr}`, repo };
    }

    const flows = (Array.isArray(rec.flows) ? rec.flows : []) as ReadFlow[];
    const decisions = (Array.isArray(rec.decisions) ? rec.decisions : []) as ReadDecision[];
    const items = mapDecisions(flows, decisions);

    const section: DecisionsSection = {
      syncedAt: now().toISOString(),
      ttlHours,
      repo: repoSlug,
      items,
    };
    await writeSection(repoRoot, { decisions: section, repo: repoSlug });

    return { status: 'synced', detail: `cached ${items.length} merged decision(s).`, repo, count: items.length };
  } catch (e) {
    return { status: 'error', detail: `decision sync failed (swallowed): ${(e as Error).message}` };
  }
}
