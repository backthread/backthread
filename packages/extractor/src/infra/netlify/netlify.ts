// the Netlify InfraAdapter.
//
// Netlify is the only one of the three AI-builder default frontends (Vercel /
// Netlify / Cloudflare) we didn't cover — a top-3 frontend host + the default
// export target for Lovable / Bolt / v0. This surfaces a Netlify deployment from
// `netlify.toml` (+ the `netlify/functions` / `netlify/edge-functions` conventions):
// the static site, its Functions, and its Edge Functions.
//
// Entirely `declared`/`inferred` provenance — netlify.toml names the build base +
// functions dir; the default function dirs are a convention (inferred). No LLM
// (classificationsNeeded: []).
//
// Kind mapping (locked 8-kind InfraModuleKind enum — map onto it, never weaken):
//   the site                       → static-site
//   Netlify Functions (dir)        → worker  (serverless functions)
//   Netlify Edge Functions (dir)   → worker  (Deno edge runtime)
//
// sourceRoots:
//   * site  → `[build].base` (where the build runs = the frontend source). When
//     absent, fall back to `src/` IF it exists (the SPA convention, mirroring the
//     Cloudflare Vite-SPA rule) — never the repo root (no catch-all that swallows
//     the functions). A base that resolves to the repo root yields no source root.
//   * functions / edge functions → their directory (clean per-unit attribution).
//
// Zone label: "Netlify" (PROVIDER_ZONE_LABEL['netlify'] in zones.ts).
//
// Disambiguation ( precedence seam): the Vercel adapter detects bare
// `next.config.*`, and Next.js deploys to Netlify too — so a Next-on-Netlify repo
// trips BOTH adapters. That's fine: netlify.toml is the explicit, stronger Netlify
// signal and it emits `sourceRoots`, whereas the Vercel `next.config` path emits
// none today — so code attributes to Netlify by 's source-root rule, and
// `next.config` alone never outranks `netlify.toml`. (Both still render their zone.)

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { parseTomlSubset, type WranglerTree } from '../cloudflare/wrangler-parse.js';
import { findFiles } from '../walk.js';

const CONFIG_NAME = 'netlify.toml';
const DEFAULT_FUNCTIONS_DIR = 'netlify/functions';
const DEFAULT_EDGE_FUNCTIONS_DIR = 'netlify/edge-functions';

// ---------------------------------------------------------------------------
// Path helpers (repo-relative, normalized).

function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

function resolveRel(baseDir: string, rel: string): string {
  const parts = (baseDir ? baseDir.split('/') : []).concat(rel.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function rec(v: unknown): WranglerTree | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as WranglerTree) : undefined;
}

// ---------------------------------------------------------------------------
// Typed config extracted from the parsed netlify.toml tree.

export interface NetlifyConfig {
  /** `[build].base` — where the build runs (the frontend source root). */
  baseDir?: string;
  /** `[build].publish` — the build output dir (metadata only). */
  publishDir?: string;
  /** `[functions].directory` or `[build].functions` — the Functions source dir. */
  functionsDir?: string;
  /** True iff `[[edge_functions]]` blocks are declared. */
  hasEdgeFunctionsDeclared: boolean;
}

/** Pure: parsed netlify.toml tree → the typed NetlifyConfig. */
export function parseNetlifyConfig(tree: WranglerTree): NetlifyConfig {
  const build = rec(tree.build);
  const functions = rec(tree.functions);
  const cfg: NetlifyConfig = {
    hasEdgeFunctionsDeclared: Array.isArray(tree.edge_functions) && tree.edge_functions.length > 0,
  };
  const baseDir = str(build?.base);
  if (baseDir) cfg.baseDir = baseDir;
  const publishDir = str(build?.publish);
  if (publishDir) cfg.publishDir = publishDir;
  const functionsDir = str(functions?.directory) ?? str(build?.functions);
  if (functionsDir) cfg.functionsDir = functionsDir;
  return cfg;
}

// ---------------------------------------------------------------------------
// Node-id helpers (adapter-local; registry prefixes `netlify:`).

const siteId = (name: string) => `site:${name}`;
// Scoped by site name so a monorepo with multiple netlify.toml files (apps/web +
// apps/admin) doesn't collide its function units onto one shared id (which would
// silently drop the second site's functions at the first-wins dedup).
const functionsId = (site: string) => `function:${site}:functions`;
const edgeId = (site: string) => `function:${site}:edge`;

// ---------------------------------------------------------------------------
// Pure graph builder. fs-derived facts (does src/ exist, do the default function
// dirs exist) are injected so the builder stays unit-testable without a real repo.

export interface BuildNetlifyOpts {
  /** Repo-relative dir of the netlify.toml ('' = repo root). */
  configDir: string;
  /** Site node label/id name (package.json name or repo dir). */
  siteName: string;
  /** Does `<configDir>/src` exist? (the site source-root fallback when no base) */
  srcExists: boolean;
  /** Does `<configDir>/netlify/functions` exist? (default Functions dir) */
  defaultFunctionsDirExists: boolean;
  /** Does `<configDir>/netlify/edge-functions` exist? (default Edge Functions dir) */
  edgeDirExists: boolean;
}

export function buildNetlifyGraph(
  configs: Array<{ config: NetlifyConfig; opts: BuildNetlifyOpts; configFile: string }>,
  root: string,
): InfraGraph {
  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];
  const addNode = (n: InfraNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  for (const { config, opts, configFile } of configs) {
    const { configDir, siteName } = opts;

    // --- the static site -----------------------------------------------------
    // sourceRoots: base if set; else src/ if it exists; else none (never repo root).
    let siteRoots: string[] = [];
    if (config.baseDir) {
      const r = resolveRel(configDir, config.baseDir);
      if (r) siteRoots = [r];
    } else if (opts.srcExists) {
      const r = resolveRel(configDir, 'src');
      if (r) siteRoots = [r];
    }
    const site: InfraNode = {
      id: siteId(siteName),
      label: siteName,
      kind: 'static-site',
      provenance: 'declared',
      metadata: {
        provider: 'netlify',
        config: configFile,
        ...(config.publishDir ? { publish: config.publishDir } : {}),
      },
      ...(siteRoots.length ? { sourceRoots: siteRoots } : {}),
    };
    addNode(site);

    // --- Netlify Functions ---------------------------------------------------
    // Explicit `[functions].directory` (declared) or the default dir (inferred).
    const funcDir = config.functionsDir ?? (opts.defaultFunctionsDirExists ? DEFAULT_FUNCTIONS_DIR : undefined);
    if (funcDir) {
      const r = resolveRel(configDir, funcDir);
      const id = functionsId(siteName);
      addNode({
        id,
        label: 'Netlify Functions',
        kind: 'worker',
        provenance: config.functionsDir ? 'declared' : 'inferred',
        metadata: { provider: 'netlify', config: configFile, directory: funcDir },
        ...(r ? { sourceRoots: [r] } : {}),
      });
      edges.push({ source: site.id, target: id, kind: 'calls', metadata: { config: configFile } });
    }

    // --- Netlify Edge Functions ----------------------------------------------
    // Declared via `[[edge_functions]]` or the default `netlify/edge-functions` dir.
    if (config.hasEdgeFunctionsDeclared || opts.edgeDirExists) {
      const r = resolveRel(configDir, DEFAULT_EDGE_FUNCTIONS_DIR);
      const id = edgeId(siteName);
      addNode({
        id,
        label: 'Netlify Edge Functions',
        kind: 'worker',
        provenance: config.hasEdgeFunctionsDeclared ? 'declared' : 'inferred',
        metadata: { provider: 'netlify', config: configFile, directory: DEFAULT_EDGE_FUNCTIONS_DIR },
        ...(r ? { sourceRoots: [r] } : {}),
      });
      edges.push({ source: site.id, target: id, kind: 'calls', metadata: { config: configFile } });
    }
  }

  return {
    root,
    adapter: 'netlify',
    nodes: [...nodes.values()],
    edges,
    classificationsNeeded: [],
  };
}

// ---------------------------------------------------------------------------
// fs helpers for extract().

function findNetlifyConfigs(repoDir: string): string[] {
  return findFiles(repoDir, (_abs, e) => e.name === CONFIG_NAME, { maxDepth: 5 });
}

/** Derive a site name from the configDir's package.json, else its basename, else repo. */
function deriveSiteName(repoDir: string, configDir: string): string {
  const dir = configDir ? join(repoDir, configDir) : repoDir;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name) return pkg.name.replace(/^@[^/]+\//, '');
  } catch {
    /* no/invalid package.json — fall through */
  }
  const base = (configDir ? configDir.split('/').pop() : repoDir.split('/').filter(Boolean).pop()) ?? 'site';
  return base;
}

function dirExists(repoDir: string, configDir: string, sub: string): boolean {
  return existsSync(join(repoDir, configDir, sub));
}

// ---------------------------------------------------------------------------
// Adapter.

export const netlifyAdapter: InfraAdapter = {
  name: 'netlify',

  async detect(repoDir: string): Promise<boolean> {
    if (findNetlifyConfigs(repoDir).length > 0) return true;
    // Secondary: the unambiguous Netlify function-dir conventions (a repo can
    // ship functions without a netlify.toml). `_redirects` is NOT used — it's
    // shared with Cloudflare Pages, so it's not a Netlify-specific signal.
    return (
      existsSync(join(repoDir, DEFAULT_FUNCTIONS_DIR)) ||
      existsSync(join(repoDir, DEFAULT_EDGE_FUNCTIONS_DIR))
    );
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const files = findNetlifyConfigs(repoDir);
    const configs: Array<{ config: NetlifyConfig; opts: BuildNetlifyOpts; configFile: string }> = [];

    if (files.length > 0) {
      for (const file of files) {
        const configFile = (relative(repoDir, file) || file).split('\\').join('/');
        const configDir = dirOf(configFile);
        let config: NetlifyConfig;
        try {
          config = parseNetlifyConfig(parseTomlSubset(readFileSync(file, 'utf8')));
        } catch (err) {
          console.warn(`  [netlify] skipping unparseable ${file}: ${(err as Error).message}`);
          continue;
        }
        configs.push({
          config,
          configFile,
          opts: {
            configDir,
            siteName: deriveSiteName(repoDir, configDir),
            srcExists: dirExists(repoDir, configDir, 'src'),
            defaultFunctionsDirExists: dirExists(repoDir, configDir, DEFAULT_FUNCTIONS_DIR),
            edgeDirExists: dirExists(repoDir, configDir, DEFAULT_EDGE_FUNCTIONS_DIR),
          },
        });
      }
    } else {
      // No netlify.toml, but a function-dir convention tripped detect() — model a
      // root site + the functions it found.
      configs.push({
        config: { hasEdgeFunctionsDeclared: false },
        configFile: '(netlify convention)',
        opts: {
          configDir: '',
          siteName: deriveSiteName(repoDir, ''),
          srcExists: dirExists(repoDir, '', 'src'),
          defaultFunctionsDirExists: dirExists(repoDir, '', DEFAULT_FUNCTIONS_DIR),
          edgeDirExists: dirExists(repoDir, '', DEFAULT_EDGE_FUNCTIONS_DIR),
        },
      });
    }

    return buildNetlifyGraph(configs, repoDir);
  },
};
