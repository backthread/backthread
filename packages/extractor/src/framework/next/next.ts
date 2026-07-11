// (Slice 2) — the Next.js FrameworkAdapter DETECTION.
// the route-segment grouping prior + RSC/client roles + the API/action
//           surface edges (the contribution hooks).
//
// DETECTION: decides "is this a Next.js app, and which router (App /
// Pages)?" from package.json deps + config-file/dir existence — never source
// content (never-store-source).
//
// CONTRIBUTION: a Next app's real structure is route segments + the
// server/client boundary + its API/action surface — none of which are plain
// import edges. We recover them with the SHARED file-based-routing convention
// (routing/next-router.ts, the  Next convention) + a static ts-morph scan
// of the RSC directives (`'use client'` / `'use server'`) + call sites. We read
// STATICALLY (install-free; never-store-source — read server-side, persist only
// the derived groups/edges/roles) and contribute in the graph FILE-ID space; the
// generic contribute-step resolves to MODULE ids.
//
//   * groupingPrior  — one FrameworkGroup per top-level ROUTE SEGMENT (`next:<seg>`)
//                      over every file in that segment (page/layout/route + the
//                      co-located components/helpers). The contribute-step makes
//                      each its own subsystem, AUTHORITATIVE over directory — so a
//                      deep `app/dashboard/**` tree renders as ONE "Dashboard"
//                      box instead of fragmenting by sub-directory.
//   * roleTags       — Page/Layout → frontend · RouteHandler/ServerAction/
//                      Middleware → gateway · Client/Server-Component → frontend.
//                      The Server↔Client split is carried in `role` (+ `rsc`
//                      metadata on routed nodes); NO new Module-kind, NO new verb.
//   * syntheticEdges — `calls` only (8-verb): route nav (from the route tree),
//                      client→Server-Action invocation, page→Route-Handler fetch.
//
// Dynamic / unresolvable targets (a computed `<Link href>`, an inline
// function-level `'use server'`) DEGRADE + LOG — no silent caps.
//
// Detection signals (manifest + config/dir existence only):
//   * dep:    `next`                                  — the authoritative signal
//   * config: next.config.{js,ts,mjs}                 — Next-specific
//   * router: app/ | src/app/ (App)  ·  pages/ | src/pages/ (Pages)
//
// scoreNext is PURE; the adapter gathers the fs signals and calls it.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  SyntaxKind,
  type Node,
  type SourceFile,
  type StringLiteral,
} from 'ts-morph';
import {
  addAllSourceFiles,
  buildExtractionProject,
  toId,
} from '../../graph/ts-morph-adapter.js';
import { SOURCE_EXTENSIONS } from '../../graph/file-graph.js';
import {
  buildHrefResolver,
  extractNextRouteTree,
  findNextRouteDirs,
  nextSegmentKey,
  walkNextSourceFiles,
  type NextRouter,
  type RouteNode,
} from '../routing/index.js';
import {
  clampConfidence,
  existsAny,
  isDir,
  readDeps,
  resolveBase,
} from '../detect-util.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  FrameworkGroup,
  FrameworkGroupingPrior,
  RoleTag,
} from '../types.js';
import type { ModuleKind } from '../../types.js';

const NEXT_CONFIG_NAMES = ['next.config.js', 'next.config.ts', 'next.config.mjs'];

/** The deterministic Next.js signal set read from a repo (or workspace package). */
export interface NextSignals {
  hasNextDep: boolean;
  hasNextConfig: boolean; // next.config.{js,ts,mjs,cjs}
  hasAppDir: boolean; // app/ | src/app/  — App Router
  hasPagesDir: boolean; // pages/ | src/pages/ — Pages Router
}

/** Gather the signal set for a single root dir (fs only). */
export function gatherNextSignals(baseDir: string): NextSignals {
  const deps = readDeps(baseDir);
  return {
    hasNextDep: 'next' in deps,
    hasNextConfig: existsAny(baseDir, NEXT_CONFIG_NAMES),
    hasAppDir: isDir(baseDir, 'app') || isDir(baseDir, 'src/app'),
    hasPagesDir: isDir(baseDir, 'pages') || isDir(baseDir, 'src/pages'),
  };
}

/** App-router / Pages-router / both / unknown, for the metadata + log variant. */
function routerOf(s: NextSignals): 'app' | 'pages' | 'app+pages' | 'unknown' {
  if (s.hasAppDir && s.hasPagesDir) return 'app+pages';
  if (s.hasAppDir) return 'app';
  if (s.hasPagesDir) return 'pages';
  return 'unknown';
}

/**
 * Decide Next.js from the signal set. Returns a DetectMatch, or null when the
 * signals are too weak to claim the stack (generic-TS fallthrough intact).
 *
 * SUFFICIENT (match-on-its-own): the `next` dep, OR a next.config.* file — both
 * Next-specific. An app/ or pages/ dir alone is only SUPPORTING (raises
 * confidence) — both names are far too generic to claim the stack on their own.
 */
export function scoreNext(s: NextSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasNextDep && !s.hasNextConfig) return null;

  let confidence = 0;
  if (s.hasNextDep) confidence += 0.6;
  if (s.hasNextConfig) confidence += 0.3;
  if (s.hasAppDir) confidence += 0.1;
  if (s.hasPagesDir) confidence += 0.1;

  const router = routerOf(s);
  return {
    adapter: 'next',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      variant: router,
      router,
      signals: {
        nextDep: s.hasNextDep,
        nextConfig: s.hasNextConfig,
        appDir: s.hasAppDir,
        pagesDir: s.hasPagesDir,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// the route-segment grouping + RSC roles + API/action edges.
//
// Role vocabulary, each mapped onto a LOCKED Module-kind (roles are METADATA,
// never a new Module-kind):
//   * middleware        — middleware.{ts,js} (the edge runtime gate)   → gateway
//   * route-handler     — App route.ts / Pages api/** (HTTP entry)     → gateway
//   * server-action     — module-level 'use server' (RPC entry)        → gateway
//   * page              — App page.* / a Pages page (routed UI)         → frontend
//   * layout            — App layout/template / Pages _app (wrapper)    → frontend
//   * client-component  — 'use client' (the RSC boundary, client side)  → frontend
//   * server-component  — an app/ component, server by default          → frontend
//
// The Server↔Client split is conveyed by `role` (client- vs server-component) +
// an `rsc: 'client' | 'server'` metadata flag on routed nodes — NOT a special
// edge (locked). Route entries (page/route-handler) outrank the RSC component
// markers so a routed file reads by its route identity; among components an
// explicit `'use client'` outranks the server default.
export type NextRole =
  | 'middleware'
  | 'route-handler'
  | 'server-action'
  | 'page'
  | 'layout'
  | 'client-component'
  | 'server-component';

const ROLE_PRIORITY: Record<NextRole, number> = {
  middleware: 7,
  'route-handler': 6,
  'server-action': 5,
  page: 4,
  layout: 3,
  'client-component': 2,
  'server-component': 1,
};
const ROLE_KIND: Record<NextRole, ModuleKind> = {
  middleware: 'gateway',
  'route-handler': 'gateway',
  'server-action': 'gateway',
  page: 'frontend',
  layout: 'frontend',
  'client-component': 'frontend',
  'server-component': 'frontend',
};

// The route-tree RouteRole → the adapter's base NextRole.
const ROUTE_ROLE_TO_NEXT: Record<string, NextRole> = {
  page: 'page',
  layout: 'layout',
  endpoint: 'route-handler',
  route: 'page', // generic routable — Next never emits it; map defensively
};

const SOURCE_EXT_SET = new Set<string>(SOURCE_EXTENSIONS);
const MIDDLEWARE_NAMES = ['middleware.ts', 'middleware.js', 'middleware.tsx', 'middleware.jsx'];

interface NextAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE analysis, while the merge walk's
// per-checkpoint ctx (same clone.dir, different tree) gets a fresh one — no
// cross-tree staleness. Mirrors the Nest / RN adapters.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, NextAnalysis>();

// ---------------------------------------------------------------------------
// Static helpers (install-free, deterministic).

function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

function under(fileId: string, rootId: string): boolean {
  return fileId === rootId || fileId.startsWith(`${rootId}/`);
}

// Deterministic slug (camelCase → kebab, drop non-alnum).
function slugify(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Humanize a route segment into a subsystem label: drop dynamic/group brackets,
// split on separators, title-case ('blog' → 'Blog', '[slug]' → 'Slug').
function humanizeSegment(seg: string): string {
  const base = seg.replace(/[[\]().]/g, '').replace(/^\.\.\.|^\.\.|^\./, '');
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return seg || 'Home';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// The module's directive: a top-of-module 'use client' / 'use server' is a
// directive prologue (the FIRST statement, comments aside — getStatements skips
// comments). Returns 'client' | 'server' | null.
function moduleDirective(sf: SourceFile): 'client' | 'server' | null {
  const first = sf.getStatements()[0];
  if (!first || first.getKind() !== SyntaxKind.ExpressionStatement) return null;
  const expr = (first as unknown as { getExpression?: () => Node }).getExpression?.();
  if (!expr || expr.getKind() !== SyntaxKind.StringLiteral) return null;
  const v = (expr as StringLiteral).getLiteralValue();
  if (v === 'use client') return 'client';
  if (v === 'use server') return 'server';
  return null;
}

// Count function-level 'use server' directives (inline server actions) — a
// 'use server' string-literal expression statement whose parent is NOT the
// SourceFile (it sits inside a function/arrow body). These can't be statically
// linked across the client/server prop boundary → degrade + log.
function countInlineServerActions(sf: SourceFile): number {
  let n = 0;
  for (const es of sf.getDescendantsOfKind(SyntaxKind.ExpressionStatement)) {
    const expr = es.getExpression();
    if (expr.getKind() !== SyntaxKind.StringLiteral) continue;
    if ((expr as StringLiteral).getLiteralValue() !== 'use server') continue;
    if (es.getParent()?.getKind() !== SyntaxKind.SourceFile) n++;
  }
  return n;
}

function hasJsx(sf: SourceFile): boolean {
  return (
    sf.getFirstDescendantByKind(SyntaxKind.JsxElement) !== undefined ||
    sf.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) !== undefined ||
    sf.getFirstDescendantByKind(SyntaxKind.JsxFragment) !== undefined
  );
}

// Resolved INTERNAL import target file ids of one source file (install-free —
// getModuleSpecifierSourceFile is null for a bare external specifier).
function resolvedImports(sf: SourceFile, repoDir: string): string[] {
  const out: string[] = [];
  for (const decl of sf.getImportDeclarations()) {
    const resolved = decl.getModuleSpecifierSourceFile();
    if (resolved) out.push(toId(repoDir, resolved.getFilePath()));
  }
  return out;
}

// `fetch('/path')` string-literal arguments in one source file.
function collectFetchTargets(sf: SourceFile): string[] {
  const out: string[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    // `fetch(…)` (global) — a `.fetch(…)` method call is out of scope.
    if (callee.getKind() !== SyntaxKind.Identifier || callee.getText() !== 'fetch') continue;
    const arg = call.getArguments()[0];
    if (arg && arg.getKind() === SyntaxKind.StringLiteral) out.push((arg as StringLiteral).getLiteralValue());
  }
  return out;
}

function keepHigher(map: Map<string, NextRole>, fileId: string, role: NextRole): void {
  const cur = map.get(fileId);
  if (
    cur === undefined ||
    ROLE_PRIORITY[role] > ROLE_PRIORITY[cur] ||
    (ROLE_PRIORITY[role] === ROLE_PRIORITY[cur] && role < cur)
  ) {
    map.set(fileId, role);
  }
}

function addEdge(edges: Map<string, FrameworkEdge>, from: string, to: string, relation: string): void {
  if (from === to) return; // intra-file collapses; the step drops self-edges too
  const key = `${from}→${to}`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'next', relation } });
  }
}

// ---------------------------------------------------------------------------
// The full analysis.

function analyzeNext(ctx: FrameworkContext): NextAnalysis {
  const { repoDir, rootPath } = ctx;
  // The in-scope base dir (a workspace package when rootPath is set).
  const base = rootPath ? join(repoDir, rootPath) : repoDir;
  const { appDirAbs, pagesDirAbs } = findNextRouteDirs(repoDir, rootPath);
  const appRootId = appDirAbs ? toId(repoDir, appDirAbs) : null;

  // --- the shared routing convention (route nodes + nav edges) -------------
  const tree = extractNextRouteTree({ repoDir, rootPath });
  const routeRoleByFile = new Map<string, RouteNode>();
  for (const node of tree?.routes ?? []) routeRoleByFile.set(node.fileId, node);

  // --- static directive / call-site scan over every in-scope source file ----
  // Glob only the in-scope `base` (not the whole repo) so a per-package fan-out
  // doesn't parse a whole monorepo per Next package; the project root
  // stays `repoDir` so tsconfig path/baseUrl resolution + the repo-relative file
  // ids are unchanged. `inScope` stays as a defensive filter.
  const project = buildExtractionProject(repoDir);
  addAllSourceFiles(project, base);
  const fileById = new Map<string, SourceFile>();
  for (const sf of project.getSourceFiles()) {
    const id = toId(repoDir, sf.getFilePath());
    if (inScope(id, rootPath)) fileById.set(id, sf);
  }

  const directiveByFile = new Map<string, 'client' | 'server'>();
  let inlineServerActions = 0;
  for (const [fileId, sf] of fileById) {
    const dir = moduleDirective(sf);
    if (dir) directiveByFile.set(fileId, dir);
    inlineServerActions += countInlineServerActions(sf);
  }

  // --- roles ---------------------------------------------------------------
  const roleByFile = new Map<string, NextRole>();

  // (1) route-tree structural roles (page / layout / route-handler).
  for (const [fileId, node] of routeRoleByFile) {
    keepHigher(roleByFile, fileId, ROUTE_ROLE_TO_NEXT[node.role] ?? 'page');
  }

  // (2) middleware.{ts,js} at the route base (root or src/).
  for (const cand of MIDDLEWARE_NAMES) {
    for (const sub of ['', 'src']) {
      const abs = join(base, sub, cand);
      if (existsSync(abs)) keepHigher(roleByFile, toId(repoDir, abs), 'middleware');
    }
  }

  // (3) RSC directives. A module-level 'use server' is a server-actions module;
  //     'use client' marks the client side of the boundary. A server component
  //     is the app/-dir default (a JSX component without an explicit directive).
  for (const [fileId, sf] of fileById) {
    const dir = directiveByFile.get(fileId);
    if (dir === 'server') keepHigher(roleByFile, fileId, 'server-action');
    else if (dir === 'client') keepHigher(roleByFile, fileId, 'client-component');
    else if (appRootId && under(fileId, appRootId) && hasJsx(sf)) {
      keepHigher(roleByFile, fileId, 'server-component');
    }
  }

  // Materialize role tags (carry rsc on routed nodes for the server/client read).
  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    const node = routeRoleByFile.get(fileId);
    const dir = directiveByFile.get(fileId);
    const metadata: Record<string, unknown> = { framework: 'next' };
    if (node) {
      metadata.routePath = node.routePath;
      if (node.parentFileId !== undefined) metadata.parentFileId = node.parentFileId;
    }
    // RSC side: an explicit directive wins; else app/ defaults to server.
    if (dir === 'client' || role === 'client-component') metadata.rsc = 'client';
    else if (dir === 'server') metadata.rsc = 'server';
    else if (appRootId && under(fileId, appRootId)) metadata.rsc = 'server';
    roles.set(fileId, { role, kind: ROLE_KIND[role], priority: ROLE_PRIORITY[role], metadata });
  }

  // --- edges (kind 'calls' only) -------------------------------------------
  const edges = new Map<string, FrameworkEdge>();

  // (a) route navigation (from the shared route tree).
  for (const e of tree?.navEdges ?? []) addEdge(edges, e.fromFileId, e.toFileId, 'navigation');

  // (b) client → Server-Action invocation: a 'use client' file that imports a
  //     module-level 'use server' actions module is invoking it across the RPC
  //     boundary. Import resolution IS the static evidence (you only import an
  //     action to call it).
  for (const [fileId, sf] of fileById) {
    if (directiveByFile.get(fileId) !== 'client') continue;
    for (const target of resolvedImports(sf, repoDir)) {
      if (directiveByFile.get(target) === 'server') addEdge(edges, fileId, target, 'server-action');
    }
  }

  // (c) page → Route-Handler fetch: a statically-resolvable `fetch('/api/…')`
  //     whose path matches an endpoint route. Build a resolver over the endpoint
  //     nodes (relabelled `page` so the shared resolver — which only resolves
  //     page/route — includes them).
  const endpoints = (tree?.routes ?? []).filter((r) => r.role === 'endpoint');
  if (endpoints.length > 0) {
    const resolveEndpoint = buildHrefResolver(endpoints.map((r) => ({ ...r, role: 'page' as const })));
    for (const [fileId, sf] of fileById) {
      for (const href of collectFetchTargets(sf)) {
        const target = resolveEndpoint(href);
        if (target) addEdge(edges, fileId, target, 'route-handler-fetch');
      }
    }
  }

  // --- grouping prior (route segment → group) ------------------------------
  const groups = buildSegmentGroups(repoDir, appDirAbs, pagesDirAbs);

  // Deterministic edge ordering.
  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  // Positive signal for validation.
  if (groups.length > 0 || roles.size > 0) {
    console.log(
      `  [next] ${tree?.routes.length ?? 0} route(s) → ${groups.length} segment group(s) · ${roles.size} role(s) · ${sortedEdges.length} edge(s)`,
    );
  }
  // No silent caps: inline (function-level) server actions can't be statically
  // linked across the client/server prop boundary.
  if (inlineServerActions > 0) {
    console.log(
      `  [next] degraded: ${inlineServerActions} inline (function-level) server action(s) not statically linkable (logged, not silently dropped)`,
    );
  }

  return { groups, edges: sortedEdges, roles };
}

// Build one FrameworkGroup per top-level route segment over EVERY file in the
// segment (page/layout/route + co-located components/helpers). App + Pages share
// the URL namespace, so a segment present in both (e.g. `api`) MERGES into one
// group. Deterministic id (path-slug, never an index) + sorted file ids.
function buildSegmentGroups(
  repoDir: string,
  appDirAbs: string | null,
  pagesDirAbs: string | null,
): FrameworkGroup[] {
  const byId = new Map<string, { label: string; files: Set<string> }>();
  const add = (dirAbs: string | null, router: NextRouter): void => {
    if (!dirAbs) return;
    const rootId = toId(repoDir, dirAbs);
    for (const fileId of walkNextSourceFiles(dirAbs, repoDir)) {
      const relToRoot = fileId.slice(rootId.length + 1);
      const key = nextSegmentKey(relToRoot, router);
      const id = slugify(key) || 'root';
      const label = key === '' ? 'Home' : humanizeSegment(key);
      let g = byId.get(id);
      if (!g) {
        g = { label, files: new Set() };
        byId.set(id, g);
      }
      g.files.add(fileId);
    }
  };
  add(appDirAbs, 'app');
  add(pagesDirAbs, 'pages');

  return [...byId.entries()]
    .map(([id, g]) => ({ id, label: g.label, fileIds: [...g.files].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function getAnalysis(ctx: FrameworkContext): NextAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeNext(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const nextAdapter: FrameworkAdapter = {
  name: 'next',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreNext(gatherNextSignals(base), rootPath);
  },

  // one grouping prior per top-level route segment. The contribute-step
  // makes each its own subsystem, AUTHORITATIVE over directory. No
  // classificationsNeeded: segments are deterministic from the path (nothing to
  // defer to the LLM classifier).
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // route nav + client→server-action + page→route-handler fetch (file-id
  // space; the step resolves to modules, drops self-edges, dedupes, 8-verb-validates).
  // kind 'calls' only.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // Page/Layout/Client/Server-Component → frontend; RouteHandler/
  // ServerAction/Middleware → gateway. METADATA; the module's `kind` is unchanged.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE ('use client'/'use server' directives, <Link href>,
  // fetch()/redirect() call sites), so declare the source paths the diff-driven
  // hosted walk must treat as framework-relevant. Never-store-source holds: read
  // server-side, persist only the derived groups/edges/roles.
  scansSourcePath(path: string): boolean {
    const ext = path.split('.').pop();
    return ext !== undefined && SOURCE_EXT_SET.has(ext);
  },
};
