// (Slice 1) — Expo Router convention parser tests against a synthetic
// `app/` fixture (the hermetic gate — no connected Expo repo exists yet).
//
// Asserts: route paths, roles (page/layout/endpoint), parentFileId NESTING
// metadata, resolvable nav targets → navEdges, the dynamic targets LOGGED +
// skipped, navEdges map to a valid `calls` EdgeKind, and DETERMINISM.

import { describe, it, expect, beforeAll, afterAll, vi } from '../../testkit.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEdgeKind } from '../../types.js';
import {
  extractExpoRouterTree,
  expoRouteInfo,
  findExpoRouterAppDir,
  EXPO_ROUTER_CONVENTION,
} from './expo-router.js';
import type { RouteNode, RouteTree } from './route-tree.js';
import { writeExpoRouterFixture, EXPO_FIXTURE_FILES as F } from './expo-fixture.js';

describe('expoRouteInfo (pure filename → role + URL)', () => {
  it('maps index → segment root, drops the index filename', () => {
    expect(expoRouteInfo('index.tsx')).toEqual({ routePath: '/', role: 'page' });
    expect(expoRouteInfo('settings/index.tsx')).toEqual({ routePath: '/settings', role: 'page' });
  });

  it('keeps dynamic [param] / [...rest] segments in the path', () => {
    expect(expoRouteInfo('profile/[id].tsx')).toEqual({ routePath: '/profile/[id]', role: 'page' });
    expect(expoRouteInfo('blog/[...slug].tsx')).toEqual({ routePath: '/blog/[...slug]', role: 'page' });
  });

  it('strips route groups (group) from the URL', () => {
    expect(expoRouteInfo('(tabs)/home.tsx')).toEqual({ routePath: '/home', role: 'page' });
    expect(expoRouteInfo('(app)/(tabs)/feed.tsx')).toEqual({ routePath: '/feed', role: 'page' });
  });

  it('classifies _layout as layout (governs its dir URL)', () => {
    expect(expoRouteInfo('_layout.tsx')).toEqual({ routePath: '/', role: 'layout' });
    expect(expoRouteInfo('settings/_layout.tsx')).toEqual({ routePath: '/settings', role: 'layout' });
    expect(expoRouteInfo('(tabs)/_layout.tsx')).toEqual({ routePath: '/', role: 'layout' });
  });

  it('classifies +api / +html files as endpoint', () => {
    expect(expoRouteInfo('hello+api.ts')).toEqual({ routePath: '/hello', role: 'endpoint' });
    expect(expoRouteInfo('users/[id]+api.ts')).toEqual({ routePath: '/users/[id]', role: 'endpoint' });
    expect(expoRouteInfo('+html.tsx').role).toBe('endpoint');
  });
});

describe('findExpoRouterAppDir', () => {
  it('returns null when there is no app/ dir', () => {
    expect(findExpoRouterAppDir(tmpdir(), 'definitely-not-a-real-pkg-xyz')).toBeNull();
  });
});

describe('extractExpoRouterTree (fixture)', () => {
  let dir: string;
  let tree: RouteTree;
  const logged: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backthread-expo-'));
    await writeExpoRouterFixture(dir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logged.push(a.join(' '));
    });
    tree = extractExpoRouterTree({ repoDir: dir })!;
    logSpy.mockRestore();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const node = (fileId: string): RouteNode | undefined => tree.routes.find((r) => r.fileId === fileId);
  const hasEdge = (from: string, to: string) =>
    tree.navEdges.some((e) => e.fromFileId === from && e.toFileId === to);

  it('finds the app/ dir + tags the convention', () => {
    expect(tree).not.toBeNull();
    expect(tree.convention).toBe(EXPO_ROUTER_CONVENTION);
    expect(tree.rootDir).toBe('app');
  });

  it('extracts correct route paths', () => {
    expect(node(F.index)?.routePath).toBe('/');
    expect(node(F.profileId)?.routePath).toBe('/profile/[id]');
    expect(node(F.settingsIndex)?.routePath).toBe('/settings');
    expect(node(F.tabsHome)?.routePath).toBe('/home'); // (tabs) group stripped
    expect(node(F.helloApi)?.routePath).toBe('/hello');
  });

  it('assigns roles: page / layout / endpoint', () => {
    expect(node(F.index)?.role).toBe('page');
    expect(node(F.profileId)?.role).toBe('page');
    expect(node(F.tabsHome)?.role).toBe('page');
    expect(node(F.rootLayout)?.role).toBe('layout');
    expect(node(F.tabsLayout)?.role).toBe('layout');
    expect(node(F.helloApi)?.role).toBe('endpoint');
  });

  it('carries parentFileId NESTING metadata (nearest enclosing layout — NOT an edge)', () => {
    // Routes with no closer layout nest under the root layout.
    expect(node(F.index)?.parentFileId).toBe(F.rootLayout);
    expect(node(F.profileId)?.parentFileId).toBe(F.rootLayout);
    expect(node(F.settingsIndex)?.parentFileId).toBe(F.rootLayout);
    // The (tabs) group has its own layout → home + helloApi nest under it.
    expect(node(F.tabsHome)?.parentFileId).toBe(F.tabsLayout);
    // The (tabs) layout itself nests under the root layout (strict-ancestor rule).
    expect(node(F.tabsLayout)?.parentFileId).toBe(F.rootLayout);
    // The root layout has no parent.
    expect(node(F.rootLayout)?.parentFileId).toBeUndefined();
    // Nesting is NEVER expressed as a navEdge.
    expect(hasEdge(F.tabsHome, F.tabsLayout)).toBe(false);
    expect(hasEdge(F.index, F.rootLayout)).toBe(false);
  });

  it('resolves static + dynamic nav targets to navEdges', () => {
    expect(hasEdge(F.index, F.profileId)).toBe(true); // Link '/profile/42' → [id]
    expect(hasEdge(F.index, F.tabsHome)).toBe(true); // push '/home' (group-stripped)
    expect(hasEdge(F.profileId, F.settingsIndex)).toBe(true); // push '/settings'
    expect(hasEdge(F.tabsHome, F.index)).toBe(true); // Redirect '/'
  });

  it('never makes an endpoint or layout a nav target', () => {
    expect(tree.navEdges.some((e) => e.toFileId === F.helloApi)).toBe(false);
    expect(tree.navEdges.some((e) => e.toFileId === F.rootLayout || e.toFileId === F.tabsLayout)).toBe(false);
  });

  it('logs + skips the dynamic nav targets (no phantom edges)', () => {
    // profile's `router.push(`/profile/${next}`)` (template literal) and home's
    // `<Link href={dest}>` (variable) are dynamic → no edge from them.
    // home's ONLY edge is the static Redirect '/' → index; the dynamic Link adds none.
    const fromHome = tree.navEdges.filter((e) => e.fromFileId === F.tabsHome);
    expect(fromHome).toEqual([{ fromFileId: F.tabsHome, toFileId: F.index }]);
    // profile resolves only '/settings' (the template-literal push is dropped).
    expect(tree.navEdges.filter((e) => e.fromFileId === F.profileId)).toEqual([
      { fromFileId: F.profileId, toFileId: F.settingsIndex },
    ]);
    expect(logged.some((l) => l.includes('[expo-router] skipped') && l.includes('dynamic'))).toBe(true);
  });

  it('every navEdge is a valid `calls` EdgeKind (nav = calls, the only verb)', () => {
    for (const _ of tree.navEdges) expect(parseEdgeKind('calls')).toBe('calls');
  });

  it('is deterministic — two runs produce identical output', () => {
    const a = extractExpoRouterTree({ repoDir: dir })!;
    const b = extractExpoRouterTree({ repoDir: dir })!;
    expect(a).toEqual(b);
    // routes sorted by fileId; navEdges sorted by (from, to).
    expect(a.routes.map((r) => r.fileId)).toEqual([...a.routes.map((r) => r.fileId)].sort());
  });
});
