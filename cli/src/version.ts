// version.ts — the single source of truth for the `backthread` CLI's self-reported
// version and the version header it stamps on every server request
// (cli↔server version-compatibility guard).
//
// WHY a header: once `backthread` is distributed (npx / plugin), users run versions we
// don't control. Every request to our endpoints (ingest-decisions, read-decisions,
// and the worker /infer-decisions) carries `x-backthread-version` so the server can detect
// a client that's too old for a future API change and return a clear "please update
// backthread" signal — instead of the change silently breaking old installs.
//
// The version is READ FROM package.json (the package's own version field), not
// duplicated here, so it can never drift from what npm publishes. package.json ships
// in the published tarball (`files: ["dist", ...]` plus the manifest), and at runtime
// dist/version.js sits one directory below package.json — so `../package.json`
// resolves in both the built package and under tsx (src/version.ts → ../package.json
// from cli/src is cli/package.json). Read-only: this module never writes package.json.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The HTTP header name the CLI stamps its version on. Lowercase by convention; the
// server reads it case-insensitively (HTTP header names are case-insensitive, and
// both Supabase Edge Functions' `Headers` and the Worker's `Request.headers` lower-
// case on lookup). Kept in lockstep with the server policy modules (which re-declare
// the same literal — each server bundle is its own deploy, like deviceToken.ts).
export const VERSION_HEADER = 'x-backthread-version';

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

/**
 * The header object to merge into every request to our endpoints. A single helper so
 * the three request sites (capture/ingest, query/read, infer) can't diverge on the
 * header name or value.
 */
export function versionHeaders(): Record<string, string> {
  return { [VERSION_HEADER]: cliVersion() };
}

// NOTE: the SINGLE warning channel the cli honors is the JSON
// `upgrade` body field — capture/query/infer read it directly off the parsed
// response and fold it into their result detail. The server ALSO mirrors the warning
// in an `x-backthread-upgrade` response header (handy for opaque proxies / non-cli clients),
// but the cli intentionally does not read the header, so there is exactly one path to
// reason about. (An earlier `readUpgradeWarning()` header-reader was removed as dead
// code to avoid implying a second, untaken channel.)
