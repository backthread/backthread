// onboardingState.ts — the CLI's reader for the unified onboarding-state endpoint.
// The FUTURE plugin first-run will call this to decide what
// to tell a brand-new user ("connect a repo" / "run a session" / "you're set up"),
// reading the SAME backend signal the web wizard reads — one source of truth,
// no per-surface re-derivation of the cell→next-step decision.
//
// Authenticated with the `backthread_pat_` device token (the plugin's on-disk
// credential), exactly like query.ts. The repo context is OPTIONAL: pass the
// configured/cwd repo to ask "is THIS repo connected?", or omit it for the account-
// level cold-start view (plugin installed before any repo is connected).
//
// NEVER throws — every failure mode resolves with an outcome the caller renders.
// Mirrors query.ts's deps-seam style so tests inject a fake config, a mocked fetch,
// and a git-remote reader: no live network, no real auth.
import { readConfig, type BackthreadConfig } from './config.js';
import { resolveRepo, type RemoteReader, type RepoHandle } from './repo.js';
import { buildOnboardingStateUrl } from './urls.js';
import { versionHeaders } from './version.js';

// --- response contract (mirrors supabase/functions/onboarding-state/state.ts) ---
// Kept structural (not imported from supabase/) so the cli package never crosses
// into the Edge Function bundle. STABLE — the future plugin first-run branches on
// `nextStep.slug` / `terminal`.

export type NextStepSlug = 'cold_start' | 'install_plugin' | 'connect_repo' | 'run_or_backfill';
export type TerminalKind = 'fully_onboarded' | 'transcript_less';

export interface OnboardingSignals {
  repoConnected: boolean;
  agentCapturing: boolean;
  anythingCaptured: boolean;
}

export interface OnboardingNextStep {
  /**
   * The next-step slug. Typed as `string` (not the NextStepSlug union) on purpose:
   * forward-compat. A NEWER server may ship a fifth slug; we must KEEP it (the
   * title/body copy is still renderable) rather than fold an unknown slug into the
   * terminal `null` — that would be indistinguishable from "fully onboarded" and is
   * inconsistent with connectNudge.parseNextStep, the OTHER reader of this same wire
   * field, which already accepts any slug string. Callers that branch on the KNOWN
   * slugs narrow against the exported NextStepSlug union.
   */
  slug: string;
  title: string;
  body: string;
}

export interface OnboardingStateResult {
  signals: OnboardingSignals;
  cell: string;
  /** null ⇒ terminal (render cleanly, no nudge). */
  nextStep: OnboardingNextStep | null;
  terminal: TerminalKind | null;
  repoSyncStatus: string | null;
  repo: { owner: string; name: string } | null;
}

/** A terse machine-readable status for the caller (plugin first-run) + tests. */
export type OnboardingStatus =
  | 'ok' // got a state (terminal or with a next step)
  | 'no-auth' // no device token in config — the user must `backthread login`
  | 'fetch-failed' // the onboarding-state request failed / was rejected
  | 'error'; // any unexpected failure (swallowed; never thrown)

export interface OnboardingOutcome {
  status: OnboardingStatus;
  /** Human-readable detail. Never contains the device token. */
  detail: string;
  /** The repo context the state was scoped to (when one was resolved). */
  repo?: RepoHandle;
  /** The unified onboarding state (when status === 'ok'). */
  state?: OnboardingStateResult;
}

export interface OnboardingInput {
  /**
   * Optional repo override as `owner/name` or `owner`+`name`. When absent we resolve
   * from config.repo, then from cwd's git remote — but UNLIKE query, a missing repo
   * is NOT an error: we fetch the account-level (cold-start) state instead.
   */
  repo?: string | { owner: string; name: string };
  /** The session's working directory, used as the repo fallback (git remote). */
  cwd?: string;
}

export interface OnboardingDeps {
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
 * Resolve the OPTIONAL repo context the onboarding state is scoped to. Same
 * precedence as query (explicit → config.repo → cwd git remote), but returns null
 * rather than failing when none resolves — the endpoint answers the account-level
 * cold-start question for a repo-less call.
 */
export function resolveOnboardingRepo(
  input: OnboardingInput,
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
 * Fetch the caller's unified onboarding state. NEVER throws — every failure mode
 * resolves with an `OnboardingOutcome`. The only network hop is the authenticated
 * POST to onboarding-state (repo slug in the body, never in a logged URL).
 */
export async function fetchOnboardingState(
  input: OnboardingInput = {},
  deps: OnboardingDeps = {},
): Promise<OnboardingOutcome> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const doReadConfig = deps.readConfigImpl ?? readConfig;

  try {
    const config = await Promise.resolve()
      .then(() => doReadConfig(env))
      .catch(() => ({}) as BackthreadConfig);

    // Auth gate — same as query: an explicit caller action, so we DON'T trigger a
    // browser login here; we tell the caller to `backthread login`.
    if (!config.device_token) {
      return {
        status: 'no-auth',
        detail: 'not authenticated — run `backthread login` first (no device token in config).',
      };
    }

    // OPTIONAL repo context — a missing repo is fine (cold-start, account-level view).
    const repo = resolveOnboardingRepo(input, config, deps.readRemoteImpl);

    let res: Response;
    try {
      res = await doFetch(buildOnboardingStateUrl(env), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.device_token}`, // never logged
          'Content-Type': 'application/json',
          ...versionHeaders(), // x-backthread-version — server-side compat guard
        },
        // CLI shape: repo_slug = "owner/name". Omitted when no repo resolved.
        body: JSON.stringify(repo ? { repo_slug: `${repo.owner}/${repo.name}` } : {}),
      });
    } catch (e) {
      return { status: 'fetch-failed', detail: `onboarding request failed: ${(e as Error).message}`, repo: repo ?? undefined };
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const obj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
      const serverErr =
        typeof obj.message === 'string' && obj.message.length > 0
          ? obj.message
          : 'error' in obj
            ? String(obj.error)
            : `HTTP ${res.status}`;
      return {
        status: 'fetch-failed',
        detail: `onboarding rejected (${res.status}): ${serverErr}`,
        repo: repo ?? undefined,
      };
    }

    const state = normalizeState(payload);
    const where = state.nextStep ? `next: ${state.nextStep.slug}` : `terminal: ${state.terminal ?? 'done'}`;
    return {
      status: 'ok',
      detail: `onboarding cell ${state.cell} (${where}).`,
      repo: repo ?? undefined,
      state,
    };
  } catch (e) {
    return { status: 'error', detail: `onboarding fetch failed (swallowed): ${(e as Error).message}` };
  }
}

// --- defensive normalizer ----------------------------------------------------
// The endpoint owns the shape, but we never trust a network payload blindly: coerce
// to the contract so a malformed field can't crash the plugin first-run.

const TERMINAL_KINDS: ReadonlySet<string> = new Set(['fully_onboarded', 'transcript_less']);

export function normalizeState(raw: unknown): OnboardingStateResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sig = (r.signals && typeof r.signals === 'object' ? r.signals : {}) as Record<string, unknown>;
  const signals: OnboardingSignals = {
    repoConnected: sig.repoConnected === true,
    agentCapturing: sig.agentCapturing === true,
    anythingCaptured: sig.anythingCaptured === true,
  };

  // nextStep: accept a well-formed object with ANY non-empty string slug — forward-
  // compat. We KEEP an unknown slug (a NEWER server's fifth step) rather than fold it
  // into the terminal `null`, which would be indistinguishable from "fully onboarded"
  // and inconsistent with connectNudge.parseNextStep (the other reader of this field).
  // An explicit `null` terminal, or a malformed object (no string slug), still → null.
  let nextStep: OnboardingNextStep | null = null;
  const ns = r.nextStep;
  if (ns && typeof ns === 'object') {
    const o = ns as Record<string, unknown>;
    if (typeof o.slug === 'string' && o.slug.trim().length > 0) {
      nextStep = {
        slug: o.slug,
        title: typeof o.title === 'string' ? o.title : '',
        body: typeof o.body === 'string' ? o.body : '',
      };
    }
  }

  const terminal =
    typeof r.terminal === 'string' && TERMINAL_KINDS.has(r.terminal)
      ? (r.terminal as TerminalKind)
      : null;

  const repo =
    r.repo && typeof r.repo === 'object'
      ? (() => {
          const ro = r.repo as Record<string, unknown>;
          return typeof ro.owner === 'string' && typeof ro.name === 'string'
            ? { owner: ro.owner, name: ro.name }
            : null;
        })()
      : null;

  return {
    signals,
    cell: typeof r.cell === 'string' ? r.cell : '',
    nextStep,
    terminal,
    repoSyncStatus: typeof r.repoSyncStatus === 'string' ? r.repoSyncStatus : null,
    repo,
  };
}
