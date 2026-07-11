// (Slice 1) — the CONVENTION-AGNOSTIC route-tree model.
//
// File-system routing frameworks (Expo Router, Next app/pages, Remix, Nuxt,
// SvelteKit, TanStack) encode the page/navigation graph IN THE DIRECTORY TREE —
// completely invisible to an import/call graph. This module is the shared shape
// every per-convention parser targets: a flat list of route nodes (each with a
// route-path label, a role, and a STRUCTURAL parent pointer) plus the
// statically-resolvable navigation edges between them.
//
// LOCKED design calls (orchestrator-decided 2026-06-26 — see the  brief):
//   * Navigation edges are `calls`, nothing else. A `navEdge` becomes a `calls`
//     FrameworkEdge when an adapter feeds it through contribute-step (this module
//     never emits FrameworkEdges itself — it stays decoupled from the framework
//     contract so Next/Remix/… reuse it unchanged).
//   * Route NESTING is NOT an edge. A layout wrapping a page has no taxonomy verb;
//     nesting is carried as STRUCTURAL METADATA (routePath + parentFileId), never
//     a graph edge — and there is NO "nesting"/"contains" verb anywhere.
//   * Deterministic ids: every keyed value derives from the route path / file id,
//     never an index — snapshots stay stable across re-ingest.
//   * No silent caps: a dynamic/unresolvable nav target is LOGGED + skipped by the
//     caller, never silently dropped.
//
// This module is PURE-ish: types + a reusable href→fileId resolver (the bracket
// `[param]` / `[...rest]` dynamic-segment syntax shared by Expo Router AND Next).
// It reads nothing and persists nothing.

/**
 * The role a route file plays. METADATA, not a Module-kind — the locked
 * discipline ("fix the classifier, never weaken the Module-kind enum") holds:
 * an adapter maps these onto an existing ModuleKind (a screen/page → `frontend`,
 * an endpoint → `gateway`/`service`). The finer role is carried for the label.
 *
 *  - `page`     — a screen/file that renders UI for a concrete URL.
 *  - `route`    — a routable node we recognize but can't confirm as page vs
 *                 endpoint (the generic fallback; conventions that always know
 *                 the answer, like Expo Router, don't emit it).
 *  - `layout`   — wraps child routes (Expo `_layout`, Next `layout`, SvelteKit
 *                 `+layout`). Its nesting is the parent pointer, never an edge.
 *  - `endpoint` — a server/API handler with no UI (Expo `+api`, Next `route.ts`,
 *                 SvelteKit `+server`).
 */
export type RouteRole = 'route' | 'page' | 'layout' | 'endpoint';

export const ROUTE_ROLES: readonly RouteRole[] = ['route', 'page', 'layout', 'endpoint'] as const;

/**
 * One route file. `fileId` is the repo-relative posix path — the same file-id
 * space the NormalizedGraph + contribute-step's `fileModuleMap` key on (so a
 * consuming adapter resolves it to a module for free). `routePath` is the
 * URL-shaped label (dynamic segments kept as `[id]`/`[...rest]`, route groups
 * stripped). `parentFileId` is the nearest enclosing layout — the STRUCTURAL
 * nesting pointer (NOT an edge); absent on the root layout / un-nested routes.
 */
export interface RouteNode {
  routePath: string;
  fileId: string;
  role: RouteRole;
  parentFileId?: string;
}

/**
 * A statically-resolvable navigation between two route files (a `<Link href>`,
 * `router.push('…')`, `<Redirect href>`, `redirect('…')` whose target resolves
 * to a route file). `from`/`to` are repo-relative posix file ids. Every navEdge
 * becomes a `calls` edge when an adapter feeds it through contribute-step.
 */
export interface RouteNavEdge {
  fromFileId: string;
  toFileId: string;
}

/**
 * A repo's (or workspace package's) file-based route tree for one convention.
 */
export interface RouteTree {
  /** The convention that produced this tree (e.g. 'expo-router'). */
  convention: string;
  /** The repo-relative posix dir the routes were read from (e.g. 'app'). */
  rootDir: string;
  /** Route nodes, sorted by fileId (deterministic). */
  routes: RouteNode[];
  /** Resolvable nav edges, deduped + sorted by (from, to) (deterministic). */
  navEdges: RouteNavEdge[];
}

// ---------------------------------------------------------------------------
// Shared href resolution (bracket dynamic-segment syntax: `[param]` / `[...rest]`).
// Reused by Expo Router (this slice) and the Next.js adapter.

function isDynamicSeg(seg: string): boolean {
  return seg.startsWith('[') && seg.endsWith(']');
}

function isCatchAllSeg(seg: string): boolean {
  // `[...rest]` (Expo) and `[[...rest]]` (Next optional catch-all) both carry the
  // `...` marker inside the brackets.
  return isDynamicSeg(seg) && seg.includes('...');
}

/**
 * Normalize an href to an absolute, query/hash-free, single-slash path — or
 * `null` when it isn't statically resolvable as an absolute URL.
 *
 * RELATIVE hrefs (`./x`, `../x`, bare `x`) return `null` (resolved against the
 * current route — a Slice-2 refinement; logged + skipped for now, never guessed).
 */
export function normalizeHref(raw: string): string | null {
  let h = raw.trim();
  h = h.split('?')[0].split('#')[0];
  if (h === '') return null;
  if (!h.startsWith('/')) return null; // relative / bare — deferred (logged + skipped)
  h = h.replace(/\/{2,}/g, '/');
  if (h.length > 1) h = h.replace(/\/+$/, '');
  return h === '' ? '/' : h;
}

function splitPath(routePath: string): string[] {
  return routePath === '/' ? [] : routePath.replace(/^\//, '').split('/');
}

// Does a dynamic-segment pattern match a concrete href's segments? A catch-all
// (always last by convention) absorbs ≥1 trailing segment; a `[param]` matches
// exactly one; a literal must equal.
function segMatch(pattern: string[], href: string[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (isCatchAllSeg(p)) return href.length - i >= 1;
    if (i >= href.length) return false;
    if (isDynamicSeg(p)) continue;
    if (p !== href[i]) return false;
  }
  return href.length === pattern.length;
}

/**
 * Build a deterministic href→fileId resolver over a route tree's navigable
 * nodes (roles `page` / `route` — layouts + endpoints are never `<Link>`
 * targets). Resolution order: exact route-path match first (covers literal
 * `/profile/[id]` and static `/home`), then the most-specific dynamic-pattern
 * match (covers a concrete `/profile/42` → `/profile/[id]`). Unresolvable ⇒
 * `null`. Specificity tiebreak: fewest dynamic segments, then non-catch-all,
 * then lexical fileId — so the choice never depends on input order.
 */
export function buildHrefResolver(routes: RouteNode[]): (href: string) => string | null {
  const navigable = routes
    .filter((r) => r.role === 'page' || r.role === 'route')
    .sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));

  const exact = new Map<string, string>();
  const patterns: { segs: string[]; fileId: string; dyn: number; catchAll: boolean }[] = [];
  for (const r of navigable) {
    if (!exact.has(r.routePath)) exact.set(r.routePath, r.fileId);
    const segs = splitPath(r.routePath);
    patterns.push({
      segs,
      fileId: r.fileId,
      dyn: segs.filter(isDynamicSeg).length,
      catchAll: segs.some(isCatchAllSeg),
    });
  }

  return (href: string): string | null => {
    const norm = normalizeHref(href);
    if (norm === null) return null;
    const hit = exact.get(norm);
    if (hit) return hit;
    const hrefSegs = splitPath(norm);
    const candidates = patterns.filter((p) => segMatch(p.segs, hrefSegs));
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) =>
        a.dyn - b.dyn ||
        Number(a.catchAll) - Number(b.catchAll) ||
        (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0),
    );
    return candidates[0].fileId;
  };
}
