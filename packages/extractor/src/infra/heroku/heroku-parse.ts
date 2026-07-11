// Heroku config parsers (Procfile + app.json).
//
// Vendored, dependency-free. Procfile is a plain-text line format; app.json
// is JSON (using parseJsonc from the Cloudflare adapter for consistency).
//
// heroku.yml (Docker-based deploys) is DEFERRED — it is YAML, and there is
// no YAML parser available. detect() notes its presence; parsing is omitted
// for this v0. Tracked for  expansion.

import { parseJsonc } from '../cloudflare/wrangler-parse.js';

// ---------------------------------------------------------------------------
// Procfile

/** One entry from a Heroku Procfile. */
export interface ProcfileEntry {
  processType: string; // 'web' | 'worker' | 'release' | 'clock' | …
  command: string;
}

/**
 * Parse a Procfile. Format: one `processType: command` per line. Lines that
 * don't match (blank, comment, malformed) are silently skipped.
 * Never throws.
 */
export function parseProcfile(text: string): ProcfileEntry[] {
  const entries: ProcfileEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const processType = line.slice(0, colon).trim();
    const command = line.slice(colon + 1).trim();
    if (!processType) continue;
    entries.push({ processType, command });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// app.json

/** Normalized representation of one addon entry from app.json. */
export interface AppJsonAddon {
  /** The raw addon slug string (e.g. 'heroku-postgresql', 'sendgrid'). */
  slug: string;
  /** Optional plan string if declared (e.g. 'mini', 'starter-0'). */
  plan?: string;
}

/** Subset of app.json we care about. */
export interface AppJson {
  name?: string;
  addons: AppJsonAddon[];
  env: Record<string, unknown>;
  formation: Record<string, unknown>;
}

/**
 * Parse app.json (a standard JSON file). Returns a normalized AppJson or
 * throws on unparseable input. Addon entries may be plain strings or objects
 * `{ "id": "heroku-postgresql", "plan": "mini" }` — both are normalized to
 * AppJsonAddon.
 */
export function parseAppJson(text: string): AppJson {
  // parseJsonc handles both plain JSON and JSONC (comments/trailing commas)
  const raw = parseJsonc(text);

  const name = typeof raw.name === 'string' ? raw.name : undefined;

  const addons: AppJsonAddon[] = [];
  const rawAddons = Array.isArray(raw.addons) ? raw.addons : [];
  for (const a of rawAddons) {
    if (typeof a === 'string' && a) {
      addons.push({ slug: a });
    } else if (a && typeof a === 'object' && !Array.isArray(a)) {
      const obj = a as Record<string, unknown>;
      const slug = typeof obj.id === 'string' ? obj.id : typeof obj.slug === 'string' ? obj.slug : undefined;
      if (!slug) continue;
      const plan = typeof obj.plan === 'string' ? obj.plan : undefined;
      addons.push({ slug, ...(plan ? { plan } : {}) });
    }
  }

  const env: Record<string, unknown> =
    raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? (raw.env as Record<string, unknown>) : {};

  const formation: Record<string, unknown> =
    raw.formation && typeof raw.formation === 'object' && !Array.isArray(raw.formation)
      ? (raw.formation as Record<string, unknown>)
      : {};

  return { name, addons, env, formation };
}
