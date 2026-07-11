// (closes  "≥ Next + Expo") — the Next.js routing CONVENTION
// parser tests. Pure path→role/URL functions + extractNextRouteTree against the
// shared hermetic fixture (App + Pages routers co-existing).
//
// Asserts: App/Pages role + URL derivation, route-group/slot stripping, dynamic
// segments kept, segment keys, parentFileId NESTING metadata (NOT an edge),
// resolvable nav targets → navEdges (incl. cross-router), dynamic targets
// LOGGED + skipped, nav = a valid `calls` EdgeKind, and DETERMINISM.

import { describe, it, expect, beforeAll, afterAll, vi } from '../../testkit.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEdgeKind } from '../../types.js';
import {
  extractNextRouteTree,
  findNextRouteDirs,
  nextRouteInfo,
  nextSegmentKey,
  NEXT_CONVENTION,
} from './next-router.js';
import type { RouteNode, RouteTree } from './route-tree.js';
import { writeNextFixture, NEXT_FIXTURE_FILES as F } from './next-fixture.js';

describe('nextRouteInfo (pure path → role + URL)', () => {
  describe('App Router', () => {
    it('maps the special files to their roles, dir as the URL', () => {
      expect(nextRouteInfo('page.tsx', 'app')).toEqual({ routePath: '/', role: 'page' });
      expect(nextRouteInfo('layout.tsx', 'app')).toEqual({ routePath: '/', role: 'layout' });
      expect(nextRouteInfo('template.tsx', 'app')).toEqual({ routePath: '/', role: 'layout' });
      expect(nextRouteInfo('dashboard/page.tsx', 'app')).toEqual({ routePath: '/dashboard', role: 'page' });
      expect(nextRouteInfo('dashboard/layout.tsx', 'app')).toEqual({ routePath: '/dashboard', role: 'layout' });
      expect(nextRouteInfo('api/stats/route.ts', 'app')).toEqual({ routePath: '/api/stats', role: 'endpoint' });
    });

    it('keeps dynamic [param] / catch-all / optional-catch-all segments', () => {
      expect(nextRouteInfo('blog/[slug]/page.tsx', 'app')).toEqual({ routePath: '/blog/[slug]', role: 'page' });
      expect(nextRouteInfo('shop/[...all]/page.tsx', 'app')).toEqual({ routePath: '/shop/[...all]', role: 'page' });
      expect(nextRouteInfo('docs/[[...path]]/page.tsx', 'app')).toEqual({ routePath: '/docs/[[...path]]', role: 'page' });
    });

    it('strips route groups (group) and parallel slots @slot from the URL', () => {
      expect(nextRouteInfo('(marketing)/pricing/page.tsx', 'app')).toEqual({ routePath: '/pricing', role: 'page' });
      expect(nextRouteInfo('(a)/(b)/page.tsx', 'app')).toEqual({ routePath: '/', role: 'page' });
      expect(nextRouteInfo('dashboard/@team/page.tsx', 'app')).toEqual({ routePath: '/dashboard', role: 'page' });
    });

    it('returns null for co-located non-route files', () => {
      expect(nextRouteInfo('dashboard/Chart.tsx', 'app')).toBeNull();
      expect(nextRouteInfo('lib/utils.ts', 'app')).toBeNull();
    });
  });

  describe('Pages Router', () => {
    it('treats every file as a route; index → segment root', () => {
      expect(nextRouteInfo('index.tsx', 'pages')).toEqual({ routePath: '/', role: 'page' });
      expect(nextRouteInfo('about.tsx', 'pages')).toEqual({ routePath: '/about', role: 'page' });
      expect(nextRouteInfo('blog/index.tsx', 'pages')).toEqual({ routePath: '/blog', role: 'page' });
      expect(nextRouteInfo('blog/[slug].tsx', 'pages')).toEqual({ routePath: '/blog/[slug]', role: 'page' });
    });

    it('classifies pages/api/** as endpoint', () => {
      expect(nextRouteInfo('api/ping.ts', 'pages')).toEqual({ routePath: '/api/ping', role: 'endpoint' });
      expect(nextRouteInfo('api/users/[id].ts', 'pages')).toEqual({ routePath: '/api/users/[id]', role: 'endpoint' });
    });

    it('handles the special _app / _document files', () => {
      expect(nextRouteInfo('_app.tsx', 'pages')).toEqual({ routePath: '/', role: 'layout' });
      expect(nextRouteInfo('_document.tsx', 'pages')).toBeNull();
    });
  });
});

describe('nextSegmentKey (pure — top-level route segment)', () => {
  it('returns the first URL-visible directory segment, or "" for the root', () => {
    expect(nextSegmentKey('page.tsx', 'app')).toBe('');
    expect(nextSegmentKey('layout.tsx', 'app')).toBe('');
    expect(nextSegmentKey('dashboard/page.tsx', 'app')).toBe('dashboard');
    expect(nextSegmentKey('dashboard/Chart.tsx', 'app')).toBe('dashboard');
    expect(nextSegmentKey('api/stats/route.ts', 'app')).toBe('api');
    // route group / slot are invisible → the first VISIBLE segment is the key.
    expect(nextSegmentKey('(marketing)/pricing/page.tsx', 'app')).toBe('pricing');
    expect(nextSegmentKey('(marketing)/page.tsx', 'app')).toBe('');
    // Pages: a file sitting directly in the root is the root segment.
    expect(nextSegmentKey('about.tsx', 'pages')).toBe('');
    expect(nextSegmentKey('api/ping.ts', 'pages')).toBe('api');
  });
});

describe('findNextRouteDirs', () => {
  it('returns nulls when neither router dir exists', () => {
    const { appDirAbs, pagesDirAbs } = findNextRouteDirs(tmpdir(), 'definitely-not-a-real-pkg-xyz');
    expect(appDirAbs).toBeNull();
    expect(pagesDirAbs).toBeNull();
  });
});

describe('extractNextRouteTree (fixture — App + Pages co-existing)', () => {
  let dir: string;
  let tree: RouteTree;
  const logged: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backthread-next-route-'));
    await writeNextFixture(dir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logged.push(a.join(' '));
    });
    tree = extractNextRouteTree({ repoDir: dir })!;
    logSpy.mockRestore();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const node = (fileId: string): RouteNode | undefined => tree.routes.find((r) => r.fileId === fileId);
  const hasEdge = (from: string, to: string) =>
    tree.navEdges.some((e) => e.fromFileId === from && e.toFileId === to);

  it('finds both route dirs + tags the convention', () => {
    const { appDirAbs, pagesDirAbs } = findNextRouteDirs(dir);
    expect(appDirAbs).not.toBeNull();
    expect(pagesDirAbs).not.toBeNull();
    expect(tree.convention).toBe(NEXT_CONVENTION);
  });

  it('extracts route nodes across both routers (co-located components excluded)', () => {
    expect(node(F.appHome)?.routePath).toBe('/');
    expect(node(F.dashboardPage)?.routePath).toBe('/dashboard');
    expect(node(F.blogPost)?.routePath).toBe('/blog/[slug]');
    expect(node(F.pricingPage)?.routePath).toBe('/pricing'); // (marketing) group stripped
    expect(node(F.apiStatsRoute)?.routePath).toBe('/api/stats');
    expect(node(F.pagesLegacy)?.routePath).toBe('/legacy');
    expect(node(F.pagesApiPing)?.routePath).toBe('/api/ping');
    // co-located components + _document are NOT route nodes.
    expect(node(F.dashboardChart)).toBeUndefined();
    expect(node(F.dashboardStatsCard)).toBeUndefined();
    expect(node(F.pagesDocument)).toBeUndefined();
  });

  it('assigns roles: page / layout / endpoint', () => {
    expect(node(F.appHome)?.role).toBe('page');
    expect(node(F.appRootLayout)?.role).toBe('layout');
    expect(node(F.dashboardLayout)?.role).toBe('layout');
    expect(node(F.apiStatsRoute)?.role).toBe('endpoint');
    expect(node(F.pagesApiPing)?.role).toBe('endpoint');
    expect(node(F.pagesApp)?.role).toBe('layout'); // _app → global wrapper
  });

  it('carries parentFileId NESTING metadata (nearest enclosing layout — NOT an edge)', () => {
    expect(node(F.appHome)?.parentFileId).toBe(F.appRootLayout);
    expect(node(F.dashboardPage)?.parentFileId).toBe(F.dashboardLayout);
    // the dashboard layout itself nests under the root layout (strict ancestor).
    expect(node(F.dashboardLayout)?.parentFileId).toBe(F.appRootLayout);
    // the root layout has no parent.
    expect(node(F.appRootLayout)?.parentFileId).toBeUndefined();
    // nesting is NEVER an edge.
    expect(hasEdge(F.dashboardPage, F.dashboardLayout)).toBe(false);
  });

  it('resolves nav targets (static + dynamic-segment + cross-router) to navEdges', () => {
    expect(hasEdge(F.appHome, F.dashboardPage)).toBe(true); // Link '/dashboard'
    expect(hasEdge(F.appHome, F.blogPost)).toBe(true); // Link '/blog/42' → [slug]
    expect(hasEdge(F.appHome, F.pricingPage)).toBe(true); // Link '/pricing' (group stripped)
    expect(hasEdge(F.pagesLegacy, F.pagesAbout)).toBe(true); // Pages Link '/about'
  });

  it('never makes an endpoint or layout a nav target', () => {
    expect(tree.navEdges.some((e) => e.toFileId === F.apiStatsRoute)).toBe(false);
    expect(tree.navEdges.some((e) => e.toFileId === F.appRootLayout)).toBe(false);
  });

  it('logs + skips the dynamic nav target (no phantom edge)', () => {
    // blog's `<Link href={`/blog/${slug}`}>` is a template literal → dynamic.
    expect(tree.navEdges.some((e) => e.fromFileId === F.blogPost)).toBe(false);
    expect(logged.some((l) => l.includes('[next-router] skipped') && l.includes('dynamic'))).toBe(true);
  });

  it('every navEdge maps to the `calls` verb (nav = calls, the only verb)', () => {
    expect(tree.navEdges.length).toBeGreaterThan(0);
    for (const _ of tree.navEdges) expect(parseEdgeKind('calls')).toBe('calls');
  });

  it('is deterministic — two runs produce identical, sorted output', () => {
    const a = extractNextRouteTree({ repoDir: dir })!;
    const b = extractNextRouteTree({ repoDir: dir })!;
    expect(a).toEqual(b);
    expect(a.routes.map((r) => r.fileId)).toEqual([...a.routes.map((r) => r.fileId)].sort());
    expect(a.navEdges).toEqual(
      [...a.navEdges].sort((x, y) =>
        x.fromFileId < y.fromFileId ? -1 : x.fromFileId > y.fromFileId ? 1 : x.toFileId < y.toFileId ? -1 : 1,
      ),
    );
  });
});
