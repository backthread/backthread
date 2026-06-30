// urls.ts — web-app endpoint construction for the loopback flow.
//
// The CLI opens the web app's one-click authorize page. The default origin is
// production; BACKTHREAD_APP_URL overrides it for local dev against `vite dev`
// (http://localhost:5173). The page itself (src/cli-auth/) reads `port` + `state`
// from the query string, mints the token via mint-device-token, and redirects
// back to the loopback.

// Production web app origin. Mirrors the diagram app's deployed host.
export const DEFAULT_APP_URL = 'https://app.backthread.dev';

export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BACKTHREAD_APP_URL;
  if (override && override.trim().length > 0) return override.replace(/\/+$/, '');
  return DEFAULT_APP_URL;
}

// Build the /cli-auth URL the browser opens. The loopback `port` + CSRF `state`
// nonce are passed so the page can redirect back to 127.0.0.1:<port>/callback with
// the minted token + the same state.
export function buildCliAuthUrl(
  port: number,
  state: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const u = new URL('/cli-auth', appBaseUrl(env));
  u.searchParams.set('port', String(port));
  u.searchParams.set('state', state);
  return u.toString();
}

// Production ingest Worker origin — the host of the `POST /infer-decisions`
// endpoint (server-side inference, Model 2). Overridable via BACKTHREAD_WORKER_URL for
// local dev against `wrangler dev` (e.g. http://localhost:8787).
export const DEFAULT_WORKER_URL = 'https://clew-ingest-worker.arpy-183.workers.dev';

export function workerBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BACKTHREAD_WORKER_URL;
  if (override && override.trim().length > 0) return override.replace(/\/+$/, '');
  return DEFAULT_WORKER_URL;
}

// Build the /infer-decisions URL the router POSTs the redacted transcript to.
export function buildInferDecisionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL('/infer-decisions', workerBaseUrl(env)).toString();
}

// Build the /grounded-ask URL the MCP `query` tool POSTs `{ question, repo }` to
// (ARP-753). On the WORKER origin (not Functions): the worker reuses the bundled
// LLM stack to retrieve + synthesize a grounded, cited answer server-side, so the
// cli is a thin relay that renders the returned prose verbatim. Same device-token
// auth as /infer-decisions.
export function buildGroundedAskUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL('/grounded-ask', workerBaseUrl(env)).toString();
}

// Production Supabase Functions origin — the host of the `ingest-decisions` Edge
// Function the capture hook POSTs DERIVED decisions to (the persist leg, when
// the router didn't already persist them server-side). Overridable via
// BACKTHREAD_FUNCTIONS_URL for local dev against `supabase functions serve`
// (e.g. http://localhost:54321/functions/v1). The functions ref is the project's
// publishable Supabase URL; we keep it as a constant here (the cli is dependency-
// light and never imports the supabase-js client) so the hook stays a plain fetch.
export const DEFAULT_FUNCTIONS_URL = 'https://yempemohevgpctkpstuf.supabase.co/functions/v1';

export function functionsBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BACKTHREAD_FUNCTIONS_URL;
  if (override && override.trim().length > 0) return override.replace(/\/+$/, '');
  return DEFAULT_FUNCTIONS_URL;
}

// Build the ingest-decisions URL the capture hook POSTs derived decisions to.
export function buildIngestDecisionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(`${functionsBaseUrl(env).replace(/\/+$/, '')}/ingest-decisions`).toString();
}

// Build the read-decisions URL the MCP `query` tool POSTs `{ repo }` to. Same
// Functions origin + auth (device token) as ingest-decisions; the endpoint
// returns the salience-ranked Flows + Decisions for the repo.
export function buildReadDecisionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(`${functionsBaseUrl(env).replace(/\/+$/, '')}/read-decisions`).toString();
}

// Build the onboarding-state URL the onboarding fetch POSTs an
// OPTIONAL `{ repo_slug }` to. Same Functions origin + auth (device token) as
// read/ingest; the endpoint returns the unified onboarding state (the three
// booleans + the canonical next step) the future plugin first-run consumes.
export function buildOnboardingStateUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(`${functionsBaseUrl(env).replace(/\/+$/, '')}/onboarding-state`).toString();
}

// Build the web-app deep-link into a repo's "How it works" diagram. The query tool
// returns this so the founder can jump from Claude Code to the visual. The route is
// `/<owner>/<repo>` (src/App.tsx: `<Route path="/:owner/:repo/*">`); we link the
// repo root rather than a per-flow slug because the diagram's slug subtree selects
// MODULES (nodes), not Flows (DiagramApp.tsx), so there is no stable per-Flow slug
// to deep-link to. Owner/name are path segments (encoded) on the app origin
// (BACKTHREAD_APP_URL-overridable for local dev), NOT the Worker/Functions origin.
export function buildRepoDeepLink(
  owner: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = appBaseUrl(env);
  return `${base}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
