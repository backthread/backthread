// the Vercel InfraAdapter (v0).
//
// Surfaces the Vercel deployment topology from declared config: a `static-site`
// node for the app/deployment, a `worker` node per serverless/edge function
// (API routes + middleware), an optional `cdn` node for the Vercel Edge Network,
// and `calls` edges from cron schedules to their target function nodes.
//
// Everything here is `declared` provenance: vercel.json names functions, crons,
// and regions; the file-walk finds route handlers by path convention; package.json
// declares the framework; next.config.* reveals the output mode. No LLM is needed
// (tight static model → `classificationsNeeded: []`).
//
// Kind mapping (frozen 8-kind InfraModuleKind enum — we map onto it, never
// weaken it):
//   Vercel app / deployment → static-site  (the CDN-fronted build artefact;
//     even for SSR apps the *deployment unit* as a whole is static-site because
//     the individual function shards are represented separately as `worker` nodes)
//   Serverless / edge function (API route, middleware) → worker
//   Vercel Edge Network (CDN front-door) → cdn
//
// Edge verbs used:
//   app  → cdn       : deploys-to  (the app is deployed behind the Edge Network)
//   cdn  → function  : calls       (the CDN routes requests to the function)
//   app  → function  : calls       (cron scheduler invokes the function directly,
//                                   no CDN indirection — modelled as app→fn)
//
// v0 scope notes:
//   * Environment / preview deployments are NOT split; we capture the production
//     topology only.
//   * `next.config.*` is parsed by regex heuristic — we do NOT execute it.
//   * Rewrites / headers are captured as metadata on the app node, not topology.
//   * Monorepo layouts (multiple vercel.json files) are supported by the
//     bounded file-walk; each produces separate app nodes keyed by dir.
//   * `vercel.json` `builds` (legacy Vercel v1/v2) are ignored in v0.

import { readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { walkRepo } from '../walk.js';
import {
  parseVercelJson,
  parsePackageJson,
  parseNextConfigOutputMode,
  routeFileToPath,
  routePathToLabel,
  type VercelConfig,
  type PackageInfo,
  type NextOutputMode,
} from './vercel-parse.js';

// ---------------------------------------------------------------------------
// File-walk configuration.

const VERCEL_SKIP_DIRS = [
  'node_modules',
  '.git',
  'dist',
  '.vercel',
  '.next',
  'build',
  'coverage',
  '.wrangler',
  'out',
];

// Files we look for at each directory level.
const VERCEL_CONFIG_NAME = 'vercel.json';
const NEXT_CONFIG_NAMES = ['next.config.js', 'next.config.ts', 'next.config.mjs', 'next.config.cjs'];
const PACKAGE_JSON_NAME = 'package.json';

// Route files we collect during the fs walk.
const ROUTE_RE = /^route\.[jt]sx?$/;
const API_FILE_RE = /\.[jt]sx?$/;

const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------
// Fs helpers.

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config-file discovery.

/**
 * Locate every directory that contains a vercel.json (signals a deployment
 * root), plus the repo root itself if it has a package.json with a Vercel-
 * deployable framework (so a bare Next.js project with no vercel.json still
 * gets picked up — the deploy-to-Vercel convention doesn't require the file).
 *
 * Returns an array of absolute directory paths deduplicated and sorted.
 */
function findProjectRoots(repoDir: string): string[] {
  const roots = new Set<string>();
  // A directory is a project root if it directly contains a vercel.json or a
  // next.config.* — equivalently, for each such file we found, its parent dir
  // is a root. (The legacy walk added `dir`; dirname(file) is the same dir.)
  walkRepo(repoDir, {
    skipDirs: VERCEL_SKIP_DIRS,
    maxDepth: MAX_DEPTH,
    onFile: (abs, e) => {
      if (!e.isFile()) return;
      if (e.name === VERCEL_CONFIG_NAME || NEXT_CONFIG_NAMES.includes(e.name)) {
        roots.add(dirname(abs));
      }
    },
  });

  // Always include the repo root if it carries a package.json with a Vercel
  // framework dep — catches "no vercel.json, no next.config.*" setups.
  if (existsSync(join(repoDir, PACKAGE_JSON_NAME))) {
    const text = readText(join(repoDir, PACKAGE_JSON_NAME));
    if (text) {
      try {
        const info = parsePackageJson(text);
        if (info.detectedFramework || info.hasVercelDep) roots.add(repoDir);
      } catch {
        // ignore malformed package.json at root for detection
      }
    }
  }

  return [...roots].sort();
}

// ---------------------------------------------------------------------------
// API route collector.
//
// Walks the `pages/api/` and `app/` directories under the project root looking
// for route handler files. Returns repo-relative paths.

function collectRouteFiles(projectDir: string, repoDir: string): string[] {
  const files: string[] = [];

  // pages/api/** — any .ts/.js/.tsx/.jsx file
  const pagesApi = join(projectDir, 'pages', 'api');
  const srcPagesApi = join(projectDir, 'src', 'pages', 'api');
  for (const apiDir of [pagesApi, srcPagesApi]) {
    if (!existsSync(apiDir)) continue;
    walkRepo(apiDir, {
      skipDirs: VERCEL_SKIP_DIRS,
      maxDepth: 4,
      onFile: (abs, e) => {
        if (e.isFile() && API_FILE_RE.test(e.name)) {
          files.push(relative(repoDir, abs).replace(/\\/g, '/'));
        }
      },
    });
  }

  // app/**/route.ts — App Router convention
  const appDir = join(projectDir, 'app');
  const srcAppDir = join(projectDir, 'src', 'app');
  for (const aDir of [appDir, srcAppDir]) {
    if (!existsSync(aDir)) continue;
    walkRepo(aDir, {
      skipDirs: VERCEL_SKIP_DIRS,
      maxDepth: 8,
      onFile: (abs, e) => {
        if (e.isFile() && ROUTE_RE.test(e.name)) {
          files.push(relative(repoDir, abs).replace(/\\/g, '/'));
        }
      },
    });
  }

  // middleware.ts at project root (and src/ variant)
  for (const middlewarePath of [
    join(projectDir, 'middleware.ts'),
    join(projectDir, 'middleware.js'),
    join(projectDir, 'src', 'middleware.ts'),
    join(projectDir, 'src', 'middleware.js'),
  ]) {
    if (existsSync(middlewarePath)) {
      files.push(relative(repoDir, middlewarePath).replace(/\\/g, '/'));
    }
  }

  return [...new Set(files)].sort();
}

// ---------------------------------------------------------------------------
// Inputs type for the pure builder (enables unit testing).

export interface VercelProjectInputs {
  /** Absolute path of this deployment root within the repo. */
  projectDir: string;
  /** Repo-relative path to vercel.json (or undefined if absent). */
  vercelJsonPath?: string;
  /** Parsed vercel.json (if present and valid). */
  vercelConfig?: VercelConfig;
  /** Parsed package.json (if present and valid). */
  packageInfo?: PackageInfo;
  /** Output mode from next.config.* (if present). */
  nextOutputMode?: NextOutputMode;
  /** Repo-relative paths to API route files. */
  routeFiles: string[];
  /**
   * does `<projectDir>/src` exist? Used as the app's source-root
   * fallback when the project sits at the repo root (so we never emit '' — a
   * catch-all that swallows sibling units), mirroring the netlify base→root guard.
   */
  srcExists?: boolean;
}

// ---------------------------------------------------------------------------
// Node-id helpers. Ids are adapter-local (registry prefixes `vercel:`).

function appId(projectDir: string, repoDir: string): string {
  const rel = relative(repoDir, projectDir) || '.';
  return `app:${rel}`;
}

function fnId(routePath: string, projectDir: string, repoDir: string): string {
  // Namespace by project dir so two monorepo projects exposing the same route
  // path produce distinct nodes rather than collapsing into one (which would
  // dangle/misattribute edges). Format: fn:<projectRel>:<routeSegment>
  const projectRel = relative(repoDir, projectDir) || '.';
  const segment = routePath === '/' ? 'middleware' : routePath;
  return `fn:${projectRel}:${segment}`;
}

const EDGE_NETWORK_ID = 'edge-network';

// ---------------------------------------------------------------------------
// Source-root helpers. Repo-relative, normalized — same idiom as
// netlify.ts / compose.ts.

/** Normalize a repo-relative path: backslashes→/, collapse `.`/`./`, strip trailing `/`. */
function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
}

/** The repo-relative directory of a repo-relative file path ('' = repo root). */
function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

// ---------------------------------------------------------------------------
// Glob matching for vercel.json `functions` keys.
//
// Keys in vercel.json `functions` are glob patterns (e.g. "app/api/**",
// "api/*.js"). We need to match a concrete file path against these patterns.
// Supported glob syntax (covering the Vercel docs examples):
//   **  — matches any number of path segments (including zero)
//   *   — matches any characters within a single path segment (not /)
// No external dep: implemented as a small regex transpiler.

function globToRegex(pattern: string): RegExp {
  // Escape regex metacharacters except * which we handle specially.
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      // `**` matches zero or more path segments.
      re += '.*';
      i += 2;
      // Consume a trailing slash after ** if present so "app/api/**" matches
      // "app/api/foo" (no double-slash in the regex).
      if (pattern[i] === '/') i++;
    } else if (pattern[i] === '*') {
      // `*` matches anything except a slash.
      re += '[^/]*';
      i++;
    } else {
      // Escape regex special chars.
      re += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Find the first vercel.json `functions` entry whose key (a glob) matches
 * the given repo-relative file path. Returns the config or undefined.
 */
function matchFunctionConfig(
  functions: Record<string, import('./vercel-parse.js').VercelFunctionConfig>,
  filePath: string,
): import('./vercel-parse.js').VercelFunctionConfig | undefined {
  for (const [pattern, cfg] of Object.entries(functions)) {
    if (globToRegex(pattern).test(filePath)) return cfg;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pure builder.

/**
 * Build an InfraGraph from already-collected Vercel project inputs.
 * Separated from fs IO so it can be unit-tested with synthetic inputs.
 */
export function buildVercelGraph(inputs: VercelProjectInputs[], root: string): InfraGraph {
  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];

  const addNode = (n: InfraNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };
  const addEdge = (e: InfraEdge) => edges.push(e);

  // Emit the shared CDN node once — only if any project root has a Vercel
  // deployment (not a purely static export, which bypasses the CDN layer).
  let needCdn = false;
  for (const p of inputs) {
    if (p.nextOutputMode !== 'export') needCdn = true;
  }
  if (needCdn) {
    addNode({
      id: EDGE_NETWORK_ID,
      label: 'Vercel Edge Network',
      kind: 'cdn',
      provenance: 'declared',
      metadata: { provider: 'vercel' },
    });
  }

  for (const project of inputs) {
    const aId = appId(project.projectDir, root);
    const cfg = project.vercelConfig ?? {};
    const pkg = project.packageInfo ?? { hasVercelDep: false };

    // Determine a readable label for the app node.
    const appLabel =
      pkg.name ??
      (relative(root, project.projectDir) || 'app');

    // Build metadata for the app node — keep under ~500 bytes.
    const appMeta: Record<string, unknown> = {
      provider: 'vercel',
      ...(project.vercelJsonPath ? { config: project.vercelJsonPath } : {}),
      ...(cfg.framework ? { framework: cfg.framework } : {}),
      ...(pkg.detectedFramework ? { detectedFramework: pkg.detectedFramework } : {}),
      ...(project.nextOutputMode ? { outputMode: project.nextOutputMode } : {}),
      ...(cfg.regions?.length ? { regions: cfg.regions } : {}),
    };

    // the app's source root: its deployment-root dir (repo-relative).
    // For a monorepo app (apps/web) that's the project dir; for a root project
    // it would be '' (a catch-all that swallows the function units + any sibling
    // provider's code) — so we mirror the netlify base→root guard: fall back to
    // `src/` if it exists, else emit no source root (loose code honestly stays
    // "Other"). Per-function dirs are deeper, so they out-rank this by the
    // longest-prefix rule.
    const projectRel = normalizeRoot(relative(root, project.projectDir));
    let appRoots: string[] = [];
    if (projectRel) appRoots = [projectRel];
    else if (project.srcExists) appRoots = ['src'];

    addNode({
      id: aId,
      label: appLabel,
      kind: 'static-site',
      provenance: 'declared',
      metadata: appMeta,
      ...(appRoots.length ? { sourceRoots: appRoots } : {}),
    });

    // The app deploys-to the Edge Network (unless it's a pure static export).
    if (project.nextOutputMode !== 'export' && needCdn) {
      addEdge({
        source: aId,
        target: EDGE_NETWORK_ID,
        kind: 'deploys-to',
        metadata: { provider: 'vercel' },
      });
    }

    // --- Serverless / edge function nodes from route files ---

    for (const relPath of project.routeFiles) {
      const routePath = routeFileToPath(relPath);
      const isMiddleware = routePath === '/';
      const label = routePathToLabel(routePath, isMiddleware);
      const id = fnId(routePath, project.projectDir, root);

      // Function-level metadata from vercel.json `functions` block (if present).
      // Keys in vercel.json `functions` can be glob patterns — match with the
      // glob helper rather than exact-key lookup.
      const fnCfg = cfg.functions ? matchFunctionConfig(cfg.functions, relPath) : undefined;

      // the function's source root: its route file's dir, for clean
      // per-function attribution (app/api/users/route.ts → app/api/users). A
      // route file at the repo root (dir '') yields none (no catch-all) — e.g.
      // a root middleware.ts must not claim the whole repo.
      const fnDir = normalizeRoot(dirOf(relPath));

      const fnNode: InfraNode = {
        id,
        label,
        kind: 'worker',
        provenance: 'declared',
        metadata: {
          file: relPath,
          routePath,
          ...(isMiddleware ? { isMiddleware: true } : {}),
          // Use explicit `!== undefined` guards so that legitimate 0 values
          // (e.g. memory: 0, maxDuration: 0) are not silently dropped.
          ...(fnCfg?.runtime !== undefined ? { runtime: fnCfg.runtime } : {}),
          ...(fnCfg?.memory !== undefined ? { memory: fnCfg.memory } : {}),
          ...(fnCfg?.maxDuration !== undefined ? { maxDuration: fnCfg.maxDuration } : {}),
          ...(fnCfg?.regions !== undefined ? { regions: fnCfg.regions } : {}),
        },
        ...(fnDir ? { sourceRoots: [fnDir] } : {}),
      };

      addNode(fnNode);

      // CDN routes requests to the function.
      if (needCdn && !isMiddleware) {
        addEdge({
          source: EDGE_NETWORK_ID,
          target: id,
          kind: 'calls',
          metadata: { via: 'vercel-routing', routePath },
        });
      }
    }

    // --- Cron edges: scheduler calls the target function ---
    // vercel.json `crons` entries name a `path`; the scheduler invokes that
    // function on a schedule. Model as: app --calls--> fn (the cron is a
    // Vercel platform mechanism, not a separate node in v0).
    for (const cron of cfg.crons ?? []) {
      const cronRoutePath = cron.path.startsWith('/') ? cron.path : `/${cron.path}`;
      const targetId = fnId(cronRoutePath, project.projectDir, root);

      // Ensure the target function node exists even if not found in the
      // file-walk (e.g., a cron targeting a route not present in the repo
      // snapshot — still emit the node so the edge endpoint resolves).
      if (!nodes.has(targetId)) {
        addNode({
          id: targetId,
          label: routePathToLabel(cronRoutePath),
          kind: 'worker',
          provenance: 'declared',
          metadata: { routePath: cronRoutePath, source: 'vercel.json-cron' },
        });
      }

      addEdge({
        source: aId,
        target: targetId,
        kind: 'calls',
        metadata: { via: 'vercel-cron', schedule: cron.schedule, path: cron.path },
      });
    }
  }

  return {
    root,
    adapter: 'vercel',
    nodes: [...nodes.values()],
    edges,
    classificationsNeeded: [], // Vercel's model maps statically — no LLM needed
  };
}

// ---------------------------------------------------------------------------
// Detect + extract helpers.

function isVercelProject(dir: string): boolean {
  if (existsSync(join(dir, VERCEL_CONFIG_NAME))) return true;
  if (NEXT_CONFIG_NAMES.some((n) => existsSync(join(dir, n)))) return true;
  return false;
}

function loadProjectInputs(projectDir: string, repoDir: string): VercelProjectInputs {
  const result: VercelProjectInputs = { projectDir, routeFiles: [] };

  // vercel.json
  const vercelJsonAbs = join(projectDir, VERCEL_CONFIG_NAME);
  if (existsSync(vercelJsonAbs)) {
    result.vercelJsonPath = relative(repoDir, vercelJsonAbs).replace(/\\/g, '/');
    const text = readText(vercelJsonAbs);
    if (text) {
      try {
        result.vercelConfig = parseVercelJson(text);
      } catch (err) {
        console.warn(`  [vercel] skipping unparseable ${result.vercelJsonPath}: ${(err as Error).message}`);
      }
    }
  }

  // package.json
  const pkgAbs = join(projectDir, PACKAGE_JSON_NAME);
  if (existsSync(pkgAbs)) {
    const text = readText(pkgAbs);
    if (text) {
      try {
        result.packageInfo = parsePackageJson(text);
      } catch (err) {
        console.warn(`  [vercel] skipping unparseable ${relative(repoDir, pkgAbs)}: ${(err as Error).message}`);
      }
    }
  }

  // next.config.* — check each candidate, parse the first found
  for (const cfgName of NEXT_CONFIG_NAMES) {
    const abs = join(projectDir, cfgName);
    if (!existsSync(abs)) continue;
    const text = readText(abs);
    if (text) {
      result.nextOutputMode = parseNextConfigOutputMode(text);
    }
    break; // only read one
  }

  // API route files
  result.routeFiles = collectRouteFiles(projectDir, repoDir);

  // the src/ fallback signal for the app source root (root projects).
  result.srcExists = existsSync(join(projectDir, 'src'));

  return result;
}

// ---------------------------------------------------------------------------
// source-path predicate for the diff-driven hosted walk.
//
// This adapter reads ordinary application source — the route-handler files
// collected by collectRouteFiles (app-router `**/route.[jt]sx?`, `pages/api/**`
// JS/TS files, and `middleware.[jt]s`, each optionally under a `src/` root and
// at any monorepo project depth). A change to any of those CAN change the
// worker-node set / edges, so the carried infra graph would go stale unless we
// force a re-extract. This predicate mirrors collectRouteFiles' file matchers
// (kept adjacent so the two don't drift). The framework-detection inputs
// (package.json / next.config.* / vercel.json) are config — already covered by
// relevance.ts' diffTouchesInfra + the container's config-invalidator gate — so
// they're intentionally NOT included here.
//
// Matched against a repo-relative POSIX path at any segment depth:
//   - `**/route.{js,jsx,ts,tsx}`                 (App Router handlers)
//   - `**/pages/api/**/*.{js,jsx,ts,tsx}`        (Pages API routes)
//   - `**/middleware.{js,jsx,ts,tsx}`            (edge middleware)
const VERCEL_ROUTE_FILE_RE = /(?:^|\/)route\.[jt]sx?$/;
const VERCEL_PAGES_API_RE = /(?:^|\/)pages\/api\/.*\.[jt]sx?$/;
const VERCEL_MIDDLEWARE_RE = /(?:^|\/)middleware\.[jt]sx?$/;

export function vercelScansSourcePath(path: string): boolean {
  return (
    VERCEL_ROUTE_FILE_RE.test(path) ||
    VERCEL_PAGES_API_RE.test(path) ||
    VERCEL_MIDDLEWARE_RE.test(path)
  );
}

// ---------------------------------------------------------------------------
// Exported adapter.

export const vercelAdapter: InfraAdapter = {
  name: 'vercel',
  scansSourcePath: vercelScansSourcePath,

  async detect(repoDir: string): Promise<boolean> {
    // A real Vercel signal is required: vercel.json, next.config.*, OR a
    // package.json whose parsed deps indicate a Vercel-deployable framework
    // (next/nuxt/sveltekit/astro/remix) or an explicit `vercel`/`@vercel/*`
    // dep. A bare package.json with no framework/Vercel dep must NOT match —
    // this mirrors the CF adapter's gating logic to avoid false-positive fires
    // on plain Express / CLI / library repos.
    const roots = findProjectRoots(repoDir);
    if (roots.some((r) => isVercelProject(r))) return true;

    // findProjectRoots already vetted the package.json at repoDir for
    // framework/vercelDep before adding it — so if repoDir is in roots AND
    // is not an isVercelProject hit, it was added because the package.json
    // carried a real Vercel/framework signal.
    if (roots.includes(repoDir)) {
      const text = readText(join(repoDir, PACKAGE_JSON_NAME));
      if (text) {
        try {
          const info = parsePackageJson(text);
          if (info.detectedFramework || info.hasVercelDep) return true;
        } catch {
          // ignore
        }
      }
    }
    return false;
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const roots = findProjectRoots(repoDir);
    const inputs: VercelProjectInputs[] = [];
    for (const dir of roots) {
      try {
        inputs.push(loadProjectInputs(dir, repoDir));
      } catch (err) {
        console.warn(`  [vercel] skipping project at ${relative(repoDir, dir)}: ${(err as Error).message}`);
      }
    }
    return buildVercelGraph(inputs, repoDir);
  },
};
