// (closes  "≥ Next + Expo") — the Next.js file-based routing
// convention parser, the SECOND convention on the shared route-tree model.
//
// Next.js encodes its page/navigation graph + API surface in the directory tree,
// across TWO routers that can co-exist during a migration:
//   * App Router  (`app/` | `src/app/`)   — only SPECIAL files are routes:
//       page.{tsx,ts,jsx,js}     → role `page`      (routed UI; navigable)
//       route.{ts,js}            → role `endpoint`  (Route Handler / API; not nav)
//       layout.* / template.*    → role `layout`    (structural wrapper)
//       (co-located components/helpers are NOT route nodes — unlike Expo Router,
//        where every file under `app/` is a route)
//     URL rules: route groups `(group)` + parallel slots `@slot` are STRIPPED from
//     the URL; dynamic `[param]` / catch-all `[...slug]` / optional `[[...slug]]`
//     segments are kept (the shared bracket resolver matches them).
//   * Pages Router (`pages/` | `src/pages/`) — EVERY file is a route, except:
//       _document            → not a route (the server doc shell)
//       _app                 → role `layout` at `/` (the global wrapper)
//       pages/api/**         → role `endpoint`
//       everything else      → role `page`  (`index` → segment root)
//
// Mirrors expo-router.ts in style + discipline (LOCKED, ):
//   * Nav edges are `calls`, nothing else (the adapter feeds navEdges through
//     contribute-step). Route NESTING is parentFileId METADATA, never an edge.
//   * Deterministic ids — every keyed value derives from the path/file id.
//   * No silent caps — a dynamic/unresolvable nav target is LOGGED + skipped.
// Never-store-source: reads the route dirs + file contents server-side, returns
// only the derived tree/edges; the consuming adapter declares `scansSourcePath`.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceFile } from 'ts-morph';
import {
  SyntaxKind,
  type JsxAttribute,
  type JsxExpression,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyAssignment,
  type StringLiteral,
} from 'ts-morph';
import { buildExtractionProject, toId } from '../../graph/ts-morph-adapter.js';
import { SOURCE_EXTENSIONS, EXCLUDE_DIRS } from '../../graph/file-graph.js';
import {
  buildHrefResolver,
  type RouteNavEdge,
  type RouteNode,
  type RouteRole,
  type RouteTree,
} from './route-tree.js';

export const NEXT_CONVENTION = 'next';

/** Which Next router a route dir belongs to. */
export type NextRouter = 'app' | 'pages';

const SOURCE_EXT_SET = new Set<string>(SOURCE_EXTENSIONS);
const EXCLUDE_SET = new Set<string>(EXCLUDE_DIRS);

// `router.<m>('…')` methods whose first arg is a navigation target (the
// `useRouter()` result, conventionally bound to `router`, from next/navigation or
// next/router). A different binding name isn't recognized — so it isn't a dropped
// target either (matching the Expo parser's deliberate literal-name discipline).
const ROUTER_NAV_METHODS = new Set(['push', 'replace', 'prefetch']);
const ROUTER_RECEIVERS = new Set(['router']);
// JSX components whose `href` prop is a navigation target.
const NAV_COMPONENTS = new Set(['Link']);
// Bare function nav (`redirect('/x')` / `permanentRedirect('/x')` from
// next/navigation).
const NAV_FUNCS = new Set(['redirect', 'permanentRedirect']);

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locate the Next route dirs for a repo (or workspace package). Next uses EITHER
 * the repo-root layout (`app` / `pages`) OR the `src/` layout (`src/app` /
 * `src/pages`) — root takes precedence. Both routers can co-exist (a migration).
 */
export function findNextRouteDirs(
  repoDir: string,
  rootPath = '',
): { appDirAbs: string | null; pagesDirAbs: string | null } {
  const base = rootPath ? join(repoDir, rootPath) : repoDir;
  const firstDir = (cands: string[]): string | null => {
    for (const c of cands) {
      const abs = join(base, c);
      if (isDir(abs)) return abs;
    }
    return null;
  };
  return {
    appDirAbs: firstDir(['app', join('src', 'app')]),
    pagesDirAbs: firstDir(['pages', join('src', 'pages')]),
  };
}

/**
 * Recursively collect repo-relative posix file ids of source files under a dir,
 * skipping dot-entries + excluded dirs (mirror expo-router's walk). Sorted.
 */
export function walkNextSourceFiles(absDir: string, repoDir: string): string[] {
  const out: string[] = [];
  const stack = [absDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDE_SET.has(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        const ext = e.name.split('.').pop();
        if (ext && SOURCE_EXT_SET.has(ext)) out.push(toId(repoDir, abs));
      }
    }
  }
  return out.sort();
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

// A URL-invisible directory segment: an App Router route group `(group)` or a
// parallel-route slot `@slot` (both stripped from the path AND from the segment
// key used for grouping).
function isInvisibleSeg(seg: string): boolean {
  return (seg.startsWith('(') && seg.endsWith(')')) || seg.startsWith('@');
}

/**
 * Derive role + URL-shaped route path from a route file's path relative to its
 * route-root dir, or `null` when the file is NOT a route node (an App Router
 * co-located component, or `pages/_document`). Pure — no content read.
 */
export function nextRouteInfo(
  relToRoot: string,
  router: NextRouter,
): { routePath: string; role: RouteRole } | null {
  const segments = relToRoot.split('/');
  const fileName = segments.pop() ?? relToRoot;
  const dirSegments = segments;
  const stem = stripExt(fileName);

  if (router === 'app') {
    // App Router: ONLY the special files are route nodes.
    let role: RouteRole;
    if (stem === 'page') role = 'page';
    else if (stem === 'route') role = 'endpoint';
    else if (stem === 'layout' || stem === 'template') role = 'layout';
    else return null; // co-located component/helper — not a route node
    const visible = dirSegments.filter((s) => !isInvisibleSeg(s));
    const routePath = visible.length > 0 ? `/${visible.join('/')}` : '/';
    return { routePath, role };
  }

  // Pages Router: every file is a route, with three special cases.
  if (stem === '_document') return null; // the server doc shell — not a route
  if (stem === '_app') return { routePath: '/', role: 'layout' }; // global wrapper
  const role: RouteRole = dirSegments[0] === 'api' ? 'endpoint' : 'page';
  const urlSegments = stem === 'index' ? [...dirSegments] : [...dirSegments, stem];
  const visible = urlSegments.filter((s) => !isInvisibleSeg(s));
  const routePath = visible.length > 0 ? `/${visible.join('/')}` : '/';
  return { routePath, role };
}

/**
 * The top-level route SEGMENT key a file belongs to (for the route-segment
 * grouping prior): the first URL-visible directory segment, or `''` (the root
 * segment) for a file sitting directly in the route root (or only inside
 * groups/slots). Pure — path only.
 */
export function nextSegmentKey(relToRoot: string, _router: NextRouter): string {
  const segments = relToRoot.split('/');
  segments.pop(); // drop the filename
  const visible = segments.filter((s) => !isInvisibleSeg(s));
  return visible.length > 0 ? visible[0] : '';
}

// dir of a repo-relative file id ('app/blog/[slug]/page.tsx' → 'app/blog/[slug]').
function dirOf(fileId: string): string {
  const i = fileId.lastIndexOf('/');
  return i === -1 ? '' : fileId.slice(0, i);
}

// Ancestor dirs from `dir` up to (and including) `rootDir`, nearest first.
function ancestorDirs(dir: string, rootDir: string): string[] {
  const out: string[] = [];
  let cur = dir;
  while (cur === rootDir || cur.startsWith(`${rootDir}/`)) {
    out.push(cur);
    if (cur === rootDir) break;
    cur = dirOf(cur);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nav-target extraction (reads source content via ts-morph) — same shape as the
// Expo parser, retargeted to Next's primitives (next/link <Link>, redirect()).

function literalTarget(node: import('ts-morph').Node | undefined): string | null {
  if (!node) return null;
  if (node.getKind() === SyntaxKind.StringLiteral) return (node as StringLiteral).getLiteralValue();
  if (node.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const pathname = (node as ObjectLiteralExpression).getProperty('pathname');
    if (pathname && pathname.getKind() === SyntaxKind.PropertyAssignment) {
      const init = (pathname as PropertyAssignment).getInitializer();
      if (init && init.getKind() === SyntaxKind.StringLiteral) {
        return (init as StringLiteral).getLiteralValue();
      }
    }
  }
  return null;
}

interface FileNavTargets {
  literals: string[];
  dynamic: number;
}

// Pull nav targets from one source file: <Link href> + router.push|replace('…') +
// redirect|permanentRedirect('…').
function collectNavTargets(sf: SourceFile): FileNavTargets {
  const literals: string[] = [];
  let dynamic = 0;

  const jsxEls = [
    ...sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];
  for (const el of jsxEls) {
    const tag = el.getTagNameNode().getText();
    const local = tag.split('.').pop() ?? tag; // `NextLink.Link`-style → `Link`
    if (!NAV_COMPONENTS.has(local)) continue;
    const hrefAttr = el.getAttribute('href');
    if (!hrefAttr || hrefAttr.getKind() !== SyntaxKind.JsxAttribute) continue;
    const init = (hrefAttr as JsxAttribute).getInitializer();
    if (!init) continue;
    let target: string | null = null;
    if (init.getKind() === SyntaxKind.StringLiteral) {
      target = (init as StringLiteral).getLiteralValue();
    } else if (init.getKind() === SyntaxKind.JsxExpression) {
      target = literalTarget((init as JsxExpression).getExpression());
    }
    if (target !== null) literals.push(target);
    else dynamic++;
  }

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    let isNav = false;
    if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
      const pae = callee as PropertyAccessExpression;
      const base = pae.getExpression();
      isNav =
        ROUTER_NAV_METHODS.has(pae.getName()) &&
        base.getKind() === SyntaxKind.Identifier &&
        ROUTER_RECEIVERS.has(base.getText());
    } else if (callee.getKind() === SyntaxKind.Identifier) {
      isNav = NAV_FUNCS.has(callee.getText());
    }
    if (!isNav) continue;
    const arg = call.getArguments()[0];
    if (!arg) continue;
    const target = literalTarget(arg);
    if (target !== null) literals.push(target);
    else dynamic++;
  }

  return { literals, dynamic };
}

// ---------------------------------------------------------------------------
// The convention entrypoint.

interface DirSpec {
  abs: string;
  rootId: string; // repo-relative posix id of the route root (e.g. 'app' / 'src/pages')
  router: NextRouter;
}

/**
 * Extract the Next route tree for a repo (or workspace package), spanning BOTH
 * the App Router and Pages Router when present (a migration). Returns `null` when
 * neither route dir exists or holds route files. Fully deterministic (routes
 * sorted by fileId; navEdges deduped + sorted) — snapshot-stable by construction.
 */
export function extractNextRouteTree(opts: {
  repoDir: string;
  rootPath?: string;
}): RouteTree | null {
  const { repoDir } = opts;
  const rootPath = opts.rootPath ?? '';
  const { appDirAbs, pagesDirAbs } = findNextRouteDirs(repoDir, rootPath);

  const dirs: DirSpec[] = [];
  if (appDirAbs) dirs.push({ abs: appDirAbs, rootId: toId(repoDir, appDirAbs), router: 'app' });
  if (pagesDirAbs) dirs.push({ abs: pagesDirAbs, rootId: toId(repoDir, pagesDirAbs), router: 'pages' });
  if (dirs.length === 0) return null;

  // --- route nodes (paths + roles) from file paths -------------------------
  const routes: RouteNode[] = [];
  const rootIdByFile = new Map<string, string>(); // fileId → its route-root id (nesting scope)
  const layoutByDir = new Map<string, string>(); // dir → layout fileId (lexical-first)
  const allFiles: string[] = []; // every source file under a route dir (for callers)

  for (const spec of dirs) {
    for (const fileId of walkNextSourceFiles(spec.abs, repoDir)) {
      allFiles.push(fileId);
      const relToRoot = fileId.slice(spec.rootId.length + 1);
      const info = nextRouteInfo(relToRoot, spec.router);
      if (!info) continue; // co-located component / _document — not a route node
      routes.push({ routePath: info.routePath, fileId, role: info.role });
      rootIdByFile.set(fileId, spec.rootId);
      if (info.role === 'layout') {
        const dir = dirOf(fileId);
        if (!layoutByDir.has(dir)) layoutByDir.set(dir, fileId);
      }
    }
  }
  if (routes.length === 0) return null;

  // --- nesting (parentFileId = nearest enclosing layout, within the same root) -
  for (const node of routes) {
    const rootId = rootIdByFile.get(node.fileId)!;
    const fileDir = dirOf(node.fileId);
    // A layout's own dir-layout is itself → its parent must be a STRICT ancestor.
    const searchDirs =
      node.role === 'layout'
        ? ancestorDirs(fileDir, rootId).slice(1)
        : ancestorDirs(fileDir, rootId);
    for (const dir of searchDirs) {
      const layoutId = layoutByDir.get(dir);
      if (layoutId && layoutId !== node.fileId) {
        node.parentFileId = layoutId;
        break;
      }
    }
  }

  routes.sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));

  // --- nav edges (statically-resolvable targets; reads source content) -----
  const resolve = buildHrefResolver(routes);
  const project = buildExtractionProject(repoDir);
  const sfById = new Map<string, SourceFile>();
  for (const fileId of allFiles) {
    try {
      sfById.set(fileId, project.addSourceFileAtPath(join(repoDir, fileId)));
    } catch {
      // Unreadable/unparseable — its nav edges are skipped (no crash).
    }
  }

  const edgeKeys = new Set<string>();
  const navEdges: RouteNavEdge[] = [];
  let dynamicTargets = 0;
  const unresolvedTargets = new Set<string>();

  for (const fileId of allFiles) {
    const sf = sfById.get(fileId);
    if (!sf) continue;
    const { literals, dynamic } = collectNavTargets(sf);
    dynamicTargets += dynamic;
    for (const href of literals) {
      const targetFile = resolve(href);
      if (!targetFile) {
        unresolvedTargets.add(href);
        continue;
      }
      if (targetFile === fileId) continue; // self-nav — not a route→route edge
      const key = `${fileId}→${targetFile}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      navEdges.push({ fromFileId: fileId, toFileId: targetFile });
    }
  }

  navEdges.sort((a, b) =>
    a.fromFileId < b.fromFileId
      ? -1
      : a.fromFileId > b.fromFileId
        ? 1
        : a.toFileId < b.toFileId
          ? -1
          : a.toFileId > b.toFileId
            ? 1
            : 0,
  );

  // No silent caps: log every dynamic + unresolvable nav target once.
  if (dynamicTargets > 0 || unresolvedTargets.size > 0) {
    const parts: string[] = [];
    if (dynamicTargets > 0) parts.push(`${dynamicTargets} dynamic target(s)`);
    if (unresolvedTargets.size > 0) {
      parts.push(`${unresolvedTargets.size} unresolvable target(s): ${[...unresolvedTargets].sort().join(', ')}`);
    }
    console.log(`  [next-router] skipped ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  const rootDir = dirs[0].rootId; // informational; the first present route root
  return { convention: NEXT_CONVENTION, rootDir, routes, navEdges };
}
