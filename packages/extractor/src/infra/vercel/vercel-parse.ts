// Vercel config + route parsing utilities.
//
// Pure parsing functions separated from fs IO so they can be unit-tested with
// inline inputs without a real repo. Handles:
//   - vercel.json  → functions, crons, regions, rewrites, headers, framework
//   - package.json → framework detection, app name, Vercel-related deps
//   - next.config.*  → output mode detection (static / standalone / serverless)
//   - API route file paths → route path derivation
//
// Dependency-free (no npm deps beyond what's already vendored). Reuses
// parseJsonc from the cloudflare adapter for JSON-with-comments/trailing-comma
// tolerance.

import { parseJsonc } from '../cloudflare/wrangler-parse.js';

// ---------------------------------------------------------------------------
// Types emitted by the parse functions.

export interface VercelConfig {
  /** From vercel.json `framework` field */
  framework?: string;
  /** From vercel.json `regions` array (strings like 'iad1') */
  regions?: string[];
  /** Per-function overrides: key = route glob e.g. "api/large.js" */
  functions?: Record<string, VercelFunctionConfig>;
  /** Cron schedules: each entry names a path the cron invokes */
  crons?: VercelCronConfig[];
  /** Rewrites array (for annotation / metadata only, not topology) */
  rewrites?: VercelRewrite[];
  /** Headers array (for annotation only) */
  headers?: VercelHeader[];
}

export interface VercelFunctionConfig {
  runtime?: string;
  memory?: number;
  maxDuration?: number;
  regions?: string[];
}

export interface VercelCronConfig {
  path: string;
  schedule: string;
}

export interface VercelRewrite {
  source: string;
  destination: string;
}

export interface VercelHeader {
  source: string;
  headers?: Array<{ key: string; value: string }>;
}

export interface PackageInfo {
  name?: string;
  /** True if any of the known Vercel-deployable framework deps are present */
  detectedFramework?: FrameworkName;
  /** True if `vercel` or `@vercel/*` packages appear in deps/devDeps */
  hasVercelDep: boolean;
}

export type FrameworkName = 'next' | 'nuxt' | 'sveltekit' | 'astro' | 'remix';

/**
 * The output mode from next.config.*:
 *   'export'     → purely static (SSG / export output; no serverless)
 *   'standalone' → serverless with a self-contained server bundle
 *   'serverless' → legacy Next.js serverless mode
 *   undefined    → not set / could not parse (default Vercel serverless)
 */
export type NextOutputMode = 'export' | 'standalone' | 'serverless' | undefined;

// ---------------------------------------------------------------------------
// vercel.json parser.

/**
 * Parse a vercel.json (JSONC-tolerant). Returns an empty object if the text
 * is blank or unparseable — callers rely on graceful degradation.
 */
export function parseVercelJson(text: string): VercelConfig {
  if (!text.trim()) return {};
  let raw: Record<string, unknown>;
  try {
    raw = parseJsonc(text);
  } catch {
    throw new Error(`vercel.json: invalid JSON — ${text.slice(0, 80)}`);
  }

  const out: VercelConfig = {};

  if (typeof raw.framework === 'string') out.framework = raw.framework;

  if (Array.isArray(raw.regions)) {
    out.regions = (raw.regions as unknown[]).filter((r) => typeof r === 'string') as string[];
  }

  if (raw.functions && typeof raw.functions === 'object' && !Array.isArray(raw.functions)) {
    out.functions = {};
    for (const [key, val] of Object.entries(raw.functions as Record<string, unknown>)) {
      if (!val || typeof val !== 'object') continue;
      const v = val as Record<string, unknown>;
      const fc: VercelFunctionConfig = {};
      if (typeof v.runtime === 'string') fc.runtime = v.runtime;
      if (typeof v.memory === 'number') fc.memory = v.memory;
      if (typeof v.maxDuration === 'number') fc.maxDuration = v.maxDuration;
      if (Array.isArray(v.regions)) fc.regions = v.regions.filter((r) => typeof r === 'string') as string[];
      out.functions[key] = fc;
    }
  }

  if (Array.isArray(raw.crons)) {
    out.crons = (raw.crons as unknown[]).flatMap((c) => {
      if (!c || typeof c !== 'object') return [];
      const cc = c as Record<string, unknown>;
      if (typeof cc.path !== 'string' || typeof cc.schedule !== 'string') return [];
      return [{ path: cc.path, schedule: cc.schedule }];
    });
  }

  if (Array.isArray(raw.rewrites)) {
    out.rewrites = (raw.rewrites as unknown[]).flatMap((r) => {
      if (!r || typeof r !== 'object') return [];
      const rr = r as Record<string, unknown>;
      if (typeof rr.source !== 'string' || typeof rr.destination !== 'string') return [];
      return [{ source: rr.source, destination: rr.destination }];
    });
  }

  if (Array.isArray(raw.headers)) {
    out.headers = (raw.headers as unknown[]).flatMap((h) => {
      if (!h || typeof h !== 'object') return [];
      const hh = h as Record<string, unknown>;
      if (typeof hh.source !== 'string') return [];
      return [{ source: hh.source }];
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// package.json parser.

const FRAMEWORK_DEPS: Record<string, FrameworkName> = {
  next: 'next',
  nuxt: 'nuxt',
  '@nuxt/core': 'nuxt',
  '@sveltejs/kit': 'sveltekit',
  astro: 'astro',
  '@remix-run/react': 'remix',
  '@remix-run/node': 'remix',
  '@remix-run/server-runtime': 'remix',
};

/**
 * Parse package.json to extract the app name, framework, and Vercel dep presence.
 * Tolerates malformed or empty inputs without throwing.
 */
export function parsePackageJson(text: string): PackageInfo {
  if (!text.trim()) return { hasVercelDep: false };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`package.json: invalid JSON`);
  }

  const info: PackageInfo = { hasVercelDep: false };
  if (typeof raw.name === 'string' && raw.name) info.name = raw.name;

  const allDeps: Record<string, string> = {
    ...((raw.dependencies as Record<string, string>) ?? {}),
    ...((raw.devDependencies as Record<string, string>) ?? {}),
    ...((raw.peerDependencies as Record<string, string>) ?? {}),
  };

  for (const [dep, framework] of Object.entries(FRAMEWORK_DEPS)) {
    if (dep in allDeps) {
      info.detectedFramework = framework;
      break;
    }
  }

  info.hasVercelDep = Object.keys(allDeps).some(
    (dep) => dep === 'vercel' || dep.startsWith('@vercel/'),
  );

  return info;
}

// ---------------------------------------------------------------------------
// next.config.* output-mode heuristic.
//
// We deliberately do NOT execute or import the config file (security +
// complexity). A light regex over the raw text is sufficient for the
// common patterns:
//   output: 'export'      → static export
//   output: "standalone"  → standalone server bundle
//   output: 'serverless'  → legacy serverless mode
// Any other value (including "undefined" / absent) maps to `undefined` (the
// default Vercel serverless/ISR behaviour).

export function parseNextConfigOutputMode(text: string): NextOutputMode {
  // Strip line comments (// ...) and block comments (/* ... */) before
  // matching, so a commented-out `// output: 'export'` is not picked up as
  // the active output mode.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/[^\n]*/g, '');         // line comments

  const m = stripped.match(/\boutput\s*:\s*['"]([^'"]+)['"]/);
  if (!m) return undefined;
  const val = m[1];
  if (val === 'export' || val === 'standalone' || val === 'serverless') return val;
  return undefined;
}

// ---------------------------------------------------------------------------
// API route file-path → route path derivation.
//
// Vercel/Next.js conventions:
//   pages/api/users/[id].ts  → /api/users/[id]
//   app/api/users/route.ts   → /api/users
//   middleware.ts            → / (edge middleware, intercepts all routes)
//
// The returned routePath is the canonical URL-path string used as the node id.

export function routeFileToPath(repoRelPath: string): string {
  // Normalise path separators.
  const p = repoRelPath.replace(/\\/g, '/');

  // middleware.ts / middleware.js at the root (or inside src/).
  if (/^(?:src\/)?middleware\.[jt]sx?$/.test(p)) return '/';

  // pages/api/** → /api/...
  const pagesApi = p.match(/^(?:src\/)?pages\/api\/(.+)\.[jt]sx?$/);
  if (pagesApi) {
    return `/api/${pagesApi[1]}`;
  }

  // app/**/route.ts → derive path from directory
  const appRoute = p.match(/^(?:src\/)?app\/(.+?)\/route\.[jt]sx?$/);
  if (appRoute) {
    // Strip trailing /route if the segment is literally "route"
    return `/${appRoute[1]}`;
  }

  // Fallback: return the path as-is (caller will use it as an id).
  return `/${p}`;
}

/**
 * Derive a human-readable label from a route path.
 *   /api/users/[id] → "api/users/[id]"
 *   /              → "middleware"
 */
export function routePathToLabel(routePath: string, isMiddleware = false): string {
  if (isMiddleware || routePath === '/') return 'middleware';
  return routePath.replace(/^\//, '');
}
