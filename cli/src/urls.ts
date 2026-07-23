// urls.ts — web-app + Functions endpoint construction for the poll-based login flow.
//
// The CLI opens the web app's one-click authorize page. The default origin is
// production; BACKTHREAD_APP_URL overrides it for local dev against `vite dev`
// (http://localhost:5173). The page (src/cli-auth/) reads `session` + `k` from the
// query string, mints the token, ENCRYPTS it in the browser to `k`, and stashes only
// the ciphertext — which the CLI then polls for and decrypts locally (no loopback).

// Production web app origin. Mirrors the diagram app's deployed host.
export const DEFAULT_APP_URL = 'https://app.backthread.dev';

export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BACKTHREAD_APP_URL;
  if (override && override.trim().length > 0) return override.replace(/\/+$/, '');
  return DEFAULT_APP_URL;
}

// The app's plan & billing page — where the free-plan upgrade CTA points. The CLI
// surfaces this when the server skips a capture because the account is over its
// free-plan decision limit.
export function buildBillingUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL('/account/billing', appBaseUrl(env)).toString();
}

// Build the /cli-auth URL the browser opens for the POLL flow: the high-entropy
// `session` id + the CLI's ephemeral public key `k` (raw P-256 point, base64url) so the
// page can encrypt the minted token to us. An optional `label` (the device hostname) is
// forwarded so mint-device-token names + rotates-in-place the token for this machine.
export function buildCliAuthUrl(
  session: string,
  clientPubKey: string,
  env: NodeJS.ProcessEnv = process.env,
  label?: string,
): string {
  const u = new URL('/cli-auth', appBaseUrl(env));
  u.searchParams.set('session', session);
  u.searchParams.set('k', clientPubKey);
  if (label && label.trim().length > 0) u.searchParams.set('label', label.trim());
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

// Build the /capture-scope URL the capture hook POSTs `{ repo:{owner,name} }` to
// BEFORE sending any transcript (ARP-1054). On the WORKER origin (same device-token
// auth as /infer-decisions): the reply ('capture' | 'skip') lets the hook keep an
// off / unconnected repo's transcript on the machine entirely. No transcript, no
// source — only the repo slug + the device token leave the machine.
export function buildCaptureScopeUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL('/capture-scope', workerBaseUrl(env)).toString();
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

// Build the cli-auth-poll URL the poll-flow login POSTs `{ session_id }` to (ARP-773).
// PUBLIC endpoint (no device token yet — that's what we're fetching): confidentiality is
// ECDH, so the CLI just posts the session id and decrypts the returned ciphertext locally.
// Same Functions origin + override seam as ingest/read.
export function buildCliAuthPollUrl(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(`${functionsBaseUrl(env).replace(/\/+$/, '')}/cli-auth-poll`).toString();
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
