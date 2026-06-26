// version.ts — the single source of truth for the `backthread` CLI's self-reported
// version AND the shared OPERATIONAL-METADATA header set it stamps on every server
// request (the cli↔server version-compatibility guard + the ARP-731/732 fleet picture).
//
// WHY headers: once `backthread` is distributed (npx / plugin), users run versions +
// agents + platforms we don't control. Every request to our endpoints (ingest-decisions,
// read-decisions, onboarding-state, exchange-claim, and the worker /infer-decisions)
// carries a small COARSE, NON-IDENTIFYING set so the server can (a) detect a client
// too old for a future API change and return a clear "please update backthread" signal,
// and (b) persist a real fleet picture (who's on what version / agent / platform) —
// all WITHOUT any new data leaving the machine: they ride the already-authenticated
// device token, carry no content, and introduce no new identifier.
//
//   x-backthread-version        — the CLI's own version (read from package.json).
//   x-backthread-agent          — the host agent/provider (claude-code/cursor/codex/…).
//   x-backthread-redact-version — @backthread/redact's version (redaction-format drift).
//   x-backthread-platform       — process.platform (darwin/linux/win32).
//   x-backthread-node           — Node major (from process.versions.node).
//
// ADDITIVE-ONLY: the server (ARP-731) and any older server tolerate these being present
// or absent — none is ever required. The version is READ FROM package.json (never
// duplicated here) so it can't drift from what npm publishes; the read-once-and-cache
// pattern is reused for each derived value. Read-only: this module never writes anything.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The HTTP header names the CLI stamps (lowercase by convention; the server reads them
// case-insensitively — HTTP header names are case-insensitive, and both Supabase Edge
// Functions' `Headers` and the Worker's `Request.headers` lower-case on lookup). Kept
// in lockstep with the server policy modules (versionGuard.ts / clientMeta.ts re-declare
// the same literals — each server bundle is its own deploy, like deviceToken.ts).
export const VERSION_HEADER = 'x-backthread-version';
export const AGENT_HEADER = 'x-backthread-agent';
export const REDACT_VERSION_HEADER = 'x-backthread-redact-version';
export const PLATFORM_HEADER = 'x-backthread-platform';
export const NODE_HEADER = 'x-backthread-node';

// --- cli version -------------------------------------------------------------

// Cached so we read + parse package.json at most once per process.
let cached: string | null = null;

/**
 * The running `backthread` version, read from the package's own package.json. Falls back to
 * '0.0.0' if package.json can't be read or has no version — a missing/unparseable
 * version must never crash a request path (capture is best-effort + non-blocking),
 * and the server treats '0.0.0'/unknown leniently (warn, never block) anyway.
 */
export function cliVersion(): string {
  if (cached !== null) return cached;
  try {
    // dist/version.js → ../package.json (built); src/version.ts → ../package.json
    // (tsx). Both resolve to cli/package.json.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cached = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

// --- @backthread/redact version ----------------------------------------------

// The published bundle INLINES this at build time (esbuild `define` in
// esbuild.config.mjs reads packages/redact/package.json). `declare` keeps TypeScript
// happy; at runtime in the bundle it's a string literal, and in dev/tsx it's an
// undeclared identifier — which `typeof` reads as 'undefined' WITHOUT throwing, so the
// disk fallback below kicks in. WHY the inline: redact's `exports` map exposes only `.`
// (no `./package.json`), so a runtime subpath read of its package.json is unreliable
// from the inlined bundle.
declare const __REDACT_VERSION__: string | undefined;

let cachedRedact: string | null = null;

/**
 * `@backthread/redact`'s version. Build-time inline in the published bundle; a
 * `createRequire` walk-up off the resolved package in dev/tsx; '0.0.0' as the ultimate
 * fallback (never crashes a request path). Read-once-and-cache, same as cliVersion().
 */
export function redactVersion(): string {
  if (cachedRedact !== null) return cachedRedact;
  if (typeof __REDACT_VERSION__ === 'string' && __REDACT_VERSION__.length > 0) {
    cachedRedact = __REDACT_VERSION__;
    return cachedRedact;
  }
  cachedRedact = readRedactVersionFromDisk();
  return cachedRedact;
}

/**
 * Dev/tsx fallback (NEVER reached in the published bundle, which inlines the constant):
 * resolve `@backthread/redact`'s entry, then walk up to the nearest package.json whose
 * name matches and read its version. The walk-up avoids hardcoding the monorepo layout
 * and sidesteps the `exports` block on the `./package.json` subpath. Returns '0.0.0' on
 * any failure — a metadata read must never break a best-effort request.
 */
function readRedactVersionFromDisk(): string {
  try {
    const req = createRequire(import.meta.url);
    let dir = dirname(req.resolve('@backthread/redact'));
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg.name === '@backthread/redact' && typeof pkg.version === 'string' && pkg.version.length > 0) {
          return pkg.version;
        }
      } catch {
        // no package.json here (or unreadable) — keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break; // hit the filesystem root
      dir = parent;
    }
  } catch {
    // resolution failed entirely — fall through to the safe default.
  }
  return '0.0.0';
}

// --- platform + node ---------------------------------------------------------

/** The OS platform tag: darwin / linux / win32 (process.platform). */
export function platformTag(): string {
  return process.platform;
}

let cachedNodeMajor: string | null = null;

/** The Node major version as a string (e.g. "22"), parsed from process.versions.node. */
export function nodeMajor(): string {
  if (cachedNodeMajor !== null) return cachedNodeMajor;
  const m = /^(\d+)/.exec(process.versions.node ?? '');
  cachedNodeMajor = m ? m[1] : '';
  return cachedNodeMajor;
}

// --- agent register ----------------------------------------------------------

// The host agent/provider for THIS process. Set ONCE by the bin from the `--agent`
// value threaded through capture (and 'claude-code' for the bare CC hook); defaults to
// 'unknown' for surfaces with no agent signal (the MCP server, manual query). Read live
// (not cached) by versionHeaders so a set before the first POST is reflected.
let requestAgent = 'unknown';

/**
 * Set the host agent/provider stamped on subsequent requests (`x-backthread-agent`).
 * A blank/absent value is ignored (keeps the prior value / the 'unknown' default), so
 * the bin can call this unconditionally with a possibly-undefined `--agent`.
 */
export function setRequestAgent(agent: string | null | undefined): void {
  if (typeof agent === 'string' && agent.trim().length > 0) requestAgent = agent.trim();
}

/** The currently-registered agent (for tests / diagnostics). */
export function currentAgent(): string {
  return requestAgent;
}

// --- the shared builder ------------------------------------------------------

/**
 * The header object to merge into every request to our endpoints. A single helper so
 * all request sites (capture/ingest, query/read, onboarding, exchange-claim, infer)
 * stamp the SAME coarse operational set without diverging. All values are derived +
 * cached; none is ever required by the server (additive-only).
 */
export function versionHeaders(): Record<string, string> {
  return {
    [VERSION_HEADER]: cliVersion(),
    [AGENT_HEADER]: requestAgent,
    [REDACT_VERSION_HEADER]: redactVersion(),
    [PLATFORM_HEADER]: platformTag(),
    [NODE_HEADER]: nodeMajor(),
  };
}

// NOTE: the SINGLE warning channel the cli honors is the JSON
// `upgrade` body field — capture/query/infer read it directly off the parsed
// response and fold it into their result detail. The server ALSO mirrors the warning
// in an `x-backthread-upgrade` response header (handy for opaque proxies / non-cli clients),
// but the cli intentionally does not read the header, so there is exactly one path to
// reason about. (An earlier `readUpgradeWarning()` header-reader was removed as dead
// code to avoid implying a second, untaken channel.)
