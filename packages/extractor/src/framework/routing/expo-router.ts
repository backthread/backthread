// (Slice 1) — the Expo Router convention parser.
//
// Expo Router is file-system routing: every file under `app/` (or `src/app/`)
// is a route, derived from its PATH. This parser builds the convention-agnostic
// RouteTree (route-tree.ts) for that convention:
//   * route TREE (paths + roles + parent nesting) from file PATHS/NAMES alone —
//     no source content needed;
//   * nav EDGES from statically-resolvable `<Link href>` / `<Redirect href>` /
//     `router.push|replace|navigate('…')` / `redirect('…')` targets — these DO
//     read source CONTENT (install-free ts-morph, the same parsing style as the
//     structural extractor + the RN adapter).
//
// Never-store-source: this reads the route dir + file contents server-side and
// returns ONLY the derived tree/edges. It persists nothing itself (the library
// is pure; the consuming adapter declares `scansSourcePath` and the pipeline
// persists only the derived data Slice B / ).
//
// Filename → role + URL rules (Expo Router):
//   * `_layout.{tsx,ts,jsx,js}`            → role `layout`; governs its dir's URL
//   * `*+api.{ts,js}` · `+html.*`          → role `endpoint` (server / web shell)
//   * `index.*`                            → the segment ROOT (drops `index`)
//   * `[param].*` / `[...rest].*`          → DYNAMIC segment (kept in the path)
//   * `(group)/…`                          → route GROUP (stripped from the URL)
//   * any other screen file                → role `page`
//
// Per the convention, EVERY file under `app/` is a route — so a non-route helper
// accidentally colocated there (e.g. `app/utils/format.ts`) becomes a phantom
// `page`. That's the documented Expo gotcha (keep non-route code out of `app/`),
// not a parser bug; a default-export check to demote such files to `route` is a
// Slice-2 refinement.
//
// Nesting (NOT an edge — locked): a route's `parentFileId` is the nearest
// enclosing `_layout`; a layout's parent is the nearest layout in an ANCESTOR
// dir; the root layout has none.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceFile } from 'ts-morph';
import { SyntaxKind, type JsxAttribute, type JsxExpression, type ObjectLiteralExpression, type PropertyAccessExpression, type PropertyAssignment, type StringLiteral } from 'ts-morph';
import { buildExtractionProject, toId } from '../../graph/ts-morph-adapter.js';
import { SOURCE_EXTENSIONS, EXCLUDE_DIRS } from '../../graph/file-graph.js';
import { buildHrefResolver, type RouteNavEdge, type RouteNode, type RouteRole, type RouteTree } from './route-tree.js';

export const EXPO_ROUTER_CONVENTION = 'expo-router';

const SOURCE_EXT_SET = new Set<string>(SOURCE_EXTENSIONS);
const EXCLUDE_SET = new Set<string>(EXCLUDE_DIRS);

// `router.<m>('…')` methods whose first arg is a navigation target.
const ROUTER_NAV_METHODS = new Set(['push', 'replace', 'navigate']);
// The identifier(s) that name the Expo Router imperative API in practice
// (`const router = useRouter(); router.push(…)`, or the imported `router`).
// DELIBERATELY a literal name match: a `useRouter()` result bound to a DIFFERENT
// name (`const nav = useRouter(); nav.push(…)`) is not recognized as a nav call
// — so it's not a dropped target either (it's just not seen). Tracking the
// binding is a Slice-2 refinement; `router` is the overwhelming convention.
const ROUTER_RECEIVERS = new Set(['router']);
// JSX components whose `href` prop is a navigation target.
const NAV_COMPONENTS = new Set(['Link', 'Redirect']);
// Bare function nav (`redirect('/x')`). NOT an Expo Router primitive — included
// for the SHARED/Next path (Next's `redirect()`); harmless under Expo since it
// only emits an edge when its string arg resolves to a real route.
const NAV_FUNCS = new Set(['redirect']);

export interface ExpoRouterOptions {
  /** Absolute repo dir. */
  repoDir: string;
  /**
   * Repo-relative posix root the adapter matched ('' / undefined = repo root).
   * A monorepo Expo app under `apps/mobile` passes `apps/mobile`; the route dir
   * is then `apps/mobile/app` and file ids stay repo-relative.
   */
  rootPath?: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locate the Expo Router route dir for a repo (or workspace package). Expo
 * Router lives at `app/` or `src/app/`. Returns the ABSOLUTE dir, or `null`.
 */
export function findExpoRouterAppDir(repoDir: string, rootPath = ''): string | null {
  const base = rootPath ? join(repoDir, rootPath) : repoDir;
  for (const cand of ['app', join('src', 'app')]) {
    const abs = join(base, cand);
    if (isDir(abs)) return abs;
  }
  return null;
}

// Recursively collect repo-relative posix file ids of source files under a dir,
// skipping dot-entries + excluded dirs (mirror the extractor's glob). Sorted.
function walkSourceFiles(absDir: string, repoDir: string): string[] {
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
      if (e.name.startsWith('.')) continue; // Expo Router ignores dot-entries
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

function isGroupSeg(seg: string): boolean {
  return seg.startsWith('(') && seg.endsWith(')');
}

interface ExpoRouteInfo {
  routePath: string;
  role: RouteRole;
}

// Derive role + URL-shaped route path from a route file's path relative to the
// route root dir (e.g. 'profile/[id].tsx', '_layout.tsx', '(tabs)/home.tsx',
// 'hello+api.ts'). Pure — no content read.
export function expoRouteInfo(relToRoot: string): ExpoRouteInfo {
  const segments = relToRoot.split('/');
  const fileName = segments.pop() ?? relToRoot;
  const dirSegments = segments;
  const stem = stripExt(fileName);

  let role: RouteRole;
  let urlSegments: string[];

  if (stem === '_layout') {
    role = 'layout';
    urlSegments = [...dirSegments]; // a layout governs its directory's URL
  } else if (stem === '+html') {
    role = 'endpoint';
    urlSegments = [...dirSegments, '+html'];
  } else if (stem.endsWith('+api')) {
    role = 'endpoint';
    const apiStem = stem.slice(0, -'+api'.length);
    urlSegments = apiStem === '' ? [...dirSegments] : [...dirSegments, apiStem];
  } else {
    role = 'page';
    urlSegments = stem === 'index' ? [...dirSegments] : [...dirSegments, stem];
  }

  const visible = urlSegments.filter((s) => !isGroupSeg(s)); // route groups don't appear in the URL
  const routePath = visible.length > 0 ? `/${visible.join('/')}` : '/';
  return { routePath, role };
}

// dir of a repo-relative file id ('app/profile/[id].tsx' → 'app/profile').
function dirOf(fileId: string): string {
  const i = fileId.lastIndexOf('/');
  return i === -1 ? '' : fileId.slice(0, i);
}

// Ancestor dirs from `dir` up to (and including) `rootDir`, nearest first.
function ancestorDirs(dir: string, rootDir: string): string[] {
  const out: string[] = [];
  let cur = dir;
  // Walk up while still inside (or equal to) the route root.
  while (cur === rootDir || cur.startsWith(`${rootDir}/`)) {
    out.push(cur);
    if (cur === rootDir) break;
    cur = dirOf(cur);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nav-target extraction (reads source content via ts-morph).

// A string nav target from a literal arg/attr: a bare string literal, or an
// object literal's `pathname` string (`<Link href={{ pathname:'/x', params }}>`,
// `router.push({ pathname:'/x' })`). Anything else (template literal, variable)
// → null (a DYNAMIC target the caller logs + skips).
function literalTarget(node: import('ts-morph').Node | undefined): string | null {
  if (!node) return null;
  if (node.getKind() === SyntaxKind.StringLiteral) return (node as StringLiteral).getLiteralValue();
  if (node.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const pathname = (node as ObjectLiteralExpression).getProperty('pathname');
    if (pathname && pathname.getKind() === SyntaxKind.PropertyAssignment) {
      const init = (pathname as PropertyAssignment).getInitializer();
      if (init && init.getKind() === SyntaxKind.StringLiteral) return (init as StringLiteral).getLiteralValue();
    }
  }
  return null;
}

interface FileNavTargets {
  /** statically-resolvable href strings. */
  literals: string[];
  /** count of nav sites whose target exists but is dynamic (non-literal). */
  dynamic: number;
}

// Pull nav targets from one source file: <Link href> / <Redirect href> JSX
// attributes + router.push|replace|navigate('…') + redirect('…') calls.
function collectNavTargets(sf: SourceFile): FileNavTargets {
  const literals: string[] = [];
  let dynamic = 0;

  // JSX <Link href> / <Redirect href>.
  const jsxEls = [
    ...sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];
  for (const el of jsxEls) {
    const tag = el.getTagNameNode().getText();
    const local = tag.split('.').pop() ?? tag; // `ExpoRouter.Link` → `Link`
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

  // router.push|replace|navigate('…') + redirect('…').
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
    if (!arg) continue; // `router.back()`-style no-arg → not a target
    const target = literalTarget(arg);
    if (target !== null) literals.push(target);
    else dynamic++;
  }

  return { literals, dynamic };
}

// ---------------------------------------------------------------------------
// The convention entrypoint.

/**
 * Extract the Expo Router route tree for a repo (or workspace package). Returns
 * `null` when there is no Expo Router `app/` dir or it holds no route files
 * (→ the caller contributes nothing). Output is fully deterministic (routes
 * sorted by fileId; navEdges deduped + sorted) — snapshot-stable by construction.
 */
export function extractExpoRouterTree(opts: ExpoRouterOptions): RouteTree | null {
  const { repoDir } = opts;
  const rootPath = opts.rootPath ?? '';
  const appDirAbs = findExpoRouterAppDir(repoDir, rootPath);
  if (!appDirAbs) return null;

  const rootDir = toId(repoDir, appDirAbs); // repo-relative posix, e.g. 'app' or 'apps/mobile/app'
  const fileIds = walkSourceFiles(appDirAbs, repoDir);
  if (fileIds.length === 0) return null;

  // --- route nodes (paths + roles) from file paths -------------------------
  const routes: RouteNode[] = [];
  const layoutByDir = new Map<string, string>(); // dir → layout fileId (one per dir; lexical-first)
  for (const fileId of fileIds) {
    // fileId is always `${rootDir}/<suffix>` (walkSourceFiles ran under rootDir),
    // so a slice is exact + platform-independent (no cwd-relative resolution).
    const relToRoot = fileId.slice(rootDir.length + 1);
    const { routePath, role } = expoRouteInfo(relToRoot);
    routes.push({ routePath, fileId, role });
    if (role === 'layout') {
      const dir = dirOf(fileId);
      if (!layoutByDir.has(dir)) layoutByDir.set(dir, fileId);
    }
  }

  // --- nesting (parentFileId = nearest enclosing layout) -------------------
  for (const node of routes) {
    const fileDir = dirOf(node.fileId);
    // A layout's own dir-layout is itself; its parent must be a STRICT ancestor.
    const searchDirs =
      node.role === 'layout'
        ? ancestorDirs(fileDir, rootDir).slice(1)
        : ancestorDirs(fileDir, rootDir);
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
  for (const fileId of fileIds) {
    try {
      sfById.set(fileId, project.addSourceFileAtPath(join(repoDir, fileId)));
    } catch {
      // Unreadable / unparseable route file — skip its nav edges (logged below).
    }
  }

  const edgeKeys = new Set<string>();
  const navEdges: RouteNavEdge[] = [];
  let dynamicTargets = 0;
  const unresolvedTargets = new Set<string>();

  for (const fileId of fileIds) {
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
      if (targetFile === fileId) continue; // self-navigation — not a route→route edge
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
    console.log(`  [expo-router] skipped ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  return { convention: EXPO_ROUTER_CONVENTION, rootDir, routes, navEdges };
}
