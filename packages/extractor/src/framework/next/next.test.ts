// (Slice 2) — Next.js adapter tests.
//
// scoreNext is pure; the adapter's detect() runs against real tmp dirs (App
// Router, Pages Router, config-only, plain-TS no-match). Mirrors the RN adapter's
// pure-builder + fs-adapter test split.

import { describe, it, expect, beforeAll, afterAll, vi } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextAdapter, scoreNext, gatherNextSignals, type NextSignals } from './next.js';
import { TsMorphExtractor } from '../../graph/ts-morph-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import { writeNextFixture, NEXT_FIXTURE_FILES as F } from '../routing/next-fixture.js';

const NO_SIGNALS: NextSignals = {
  hasNextDep: false,
  hasNextConfig: false,
  hasAppDir: false,
  hasPagesDir: false,
};

describe('scoreNext (pure)', () => {
  it('returns null when no sufficient signal is present (generic-TS fallthrough)', () => {
    expect(scoreNext(NO_SIGNALS)).toBeNull();
    // an app/ dir alone is too generic to claim the stack.
    expect(scoreNext({ ...NO_SIGNALS, hasAppDir: true })).toBeNull();
    // a pages/ dir alone is too generic too.
    expect(scoreNext({ ...NO_SIGNALS, hasPagesDir: true })).toBeNull();
  });

  it('detects App Router from the next dep + app/ dir', () => {
    const m = scoreNext({ ...NO_SIGNALS, hasNextDep: true, hasNextConfig: true, hasAppDir: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('next');
    expect(m!.metadata?.router).toBe('app');
    expect(m!.metadata?.variant).toBe('app');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(m!.rootPath).toBe('');
  });

  it('detects Pages Router from the next dep + pages/ dir', () => {
    const m = scoreNext({ ...NO_SIGNALS, hasNextDep: true, hasPagesDir: true });
    expect(m).not.toBeNull();
    expect(m!.metadata?.router).toBe('pages');
  });

  it('reports app+pages when both router dirs exist', () => {
    const m = scoreNext({ ...NO_SIGNALS, hasNextDep: true, hasAppDir: true, hasPagesDir: true });
    expect(m!.metadata?.router).toBe('app+pages');
  });

  it('matches on next.config.* alone (no dep) — router unknown', () => {
    const m = scoreNext({ ...NO_SIGNALS, hasNextConfig: true });
    expect(m).not.toBeNull();
    expect(m!.metadata?.router).toBe('unknown');
    expect(m!.confidence).toBeLessThan(0.6);
  });

  it('clamps confidence to 1 and passes rootPath through', () => {
    const m = scoreNext(
      { hasNextDep: true, hasNextConfig: true, hasAppDir: true, hasPagesDir: true },
      'apps/web',
    );
    expect(m!.confidence).toBe(1);
    expect(m!.rootPath).toBe('apps/web');
  });
});

describe('nextAdapter.detect (fs fixtures)', () => {
  let appRouter: string;
  let pagesRouter: string;
  let plain: string;

  beforeAll(() => {
    // App Router fixture: next dep + next.config.mjs + app/ (under src/).
    appRouter = mkdtempSync(join(tmpdir(), 'backthread-next-app-'));
    writeFileSync(
      join(appRouter, 'package.json'),
      JSON.stringify({ name: 'next-app', dependencies: { next: '14.2.0', react: '18.2.0' } }),
    );
    writeFileSync(join(appRouter, 'next.config.mjs'), 'export default {};');
    mkdirSync(join(appRouter, 'src', 'app'), { recursive: true });

    // Pages Router fixture: next dep + next.config.js + pages/.
    pagesRouter = mkdtempSync(join(tmpdir(), 'backthread-next-pages-'));
    writeFileSync(
      join(pagesRouter, 'package.json'),
      JSON.stringify({ name: 'next-pages', dependencies: { next: '13.5.0', react: '18.2.0' } }),
    );
    writeFileSync(join(pagesRouter, 'next.config.js'), 'module.exports = {};');
    mkdirSync(join(pagesRouter, 'pages'), { recursive: true });

    // Plain-TS fixture: no Next signal → must NOT detect.
    plain = mkdtempSync(join(tmpdir(), 'backthread-next-plain-'));
    writeFileSync(
      join(plain, 'package.json'),
      JSON.stringify({ name: 'plain', dependencies: { react: '18.2.0', typescript: '5.4.0' } }),
    );
    mkdirSync(join(plain, 'src'), { recursive: true });
  });

  afterAll(() => {
    for (const d of [appRouter, pagesRouter, plain]) rmSync(d, { recursive: true, force: true });
  });

  it('detects a Next App Router repo (router=app)', async () => {
    const m = await nextAdapter.detect({ repoDir: appRouter });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('next');
    expect(m!.metadata?.router).toBe('app');
    expect(m!.rootPath).toBe('');
    expect((m!.metadata?.signals as Record<string, boolean>).nextDep).toBe(true);
  });

  it('detects a Next Pages Router repo (router=pages)', async () => {
    const m = await nextAdapter.detect({ repoDir: pagesRouter });
    expect(m).not.toBeNull();
    expect(m!.metadata?.router).toBe('pages');
    expect((m!.metadata?.signals as Record<string, boolean>).pagesDir).toBe(true);
  });

  it('does NOT detect a plain repo (empty → generic-TS fallthrough)', async () => {
    expect(await nextAdapter.detect({ repoDir: plain })).toBeNull();
  });

  it('scopes to a workspace package + reports its rootPath (per-package shape)', async () => {
    const m = await nextAdapter.detect({ repoDir: plain, packageDir: appRouter });
    expect(m).not.toBeNull();
    expect(typeof m!.rootPath).toBe('string');
  });

  it('gatherNextSignals reads deps + config/dir existence from disk', () => {
    const s = gatherNextSignals(appRouter);
    expect(s.hasNextDep).toBe(true);
    expect(s.hasNextConfig).toBe(true);
    expect(s.hasAppDir).toBe(true);
    expect(s.hasPagesDir).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the route-segment grouping prior, RSC/client roles, and the
// API/action surface edges (FILE-ID space; the contribute-step resolves to
// modules). Hermetic Next fixture (App + Pages routers co-existing).

describe('nextAdapter contribution hooks (, file-id space)', () => {
  let dir: string;
  let groups: Awaited<ReturnType<NonNullable<typeof nextAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;
  const logged: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backthread-next-contrib-'));
    await writeNextFixture(dir);
    const graph = await new TsMorphExtractor().extract(dir);
    const ctx: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'next', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logged.push(a.join(' '));
    });
    ({ groups } = await nextAdapter.groupingPrior!(ctx));
    edges = await nextAdapter.syntheticEdges!(ctx);
    roles = await nextAdapter.roleTags!(ctx);
    logSpy.mockRestore();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const group = (id: string) => groups.find((g) => g.id === id);
  const hasEdge = (source: string, target: string, kind = 'calls') =>
    edges.some((e) => e.source === source && e.target === target && e.kind === kind);

  it('emits one group per top-level route segment (App + Pages MERGED by URL)', () => {
    expect(groups.map((g) => g.id).sort()).toEqual(['api', 'blog', 'dashboard', 'pricing', 'root']);
    expect(group('root')!.label).toBe('Home');
    expect(group('dashboard')!.label).toBe('Dashboard');
  });

  it('a segment group collects every file in the segment (routes + co-located), sorted', () => {
    const dash = group('dashboard')!.fileIds;
    expect(dash).toEqual([...dash].sort()); // deterministic
    expect(dash).toContain(F.dashboardPage);
    expect(dash).toContain(F.dashboardLayout);
    expect(dash).toContain(F.dashboardChart); // co-located client component
    expect(dash).toContain(F.dashboardStatsCard); // co-located server component
    expect(dash).not.toContain(F.appHome);
    // the `api` segment merges App route handlers + Pages api routes.
    expect(group('api')!.fileIds).toContain(F.apiStatsRoute);
    expect(group('api')!.fileIds).toContain(F.pagesApiPing);
    // the route GROUP `(marketing)` is stripped → pricing is its own top segment.
    expect(group('pricing')!.fileIds).toContain(F.pricingPage);
    // root collects the un-nested files of both routers.
    expect(group('root')!.fileIds).toEqual(expect.arrayContaining([F.appHome, F.appActions, F.pagesLegacy]));
  });

  it('maps roles onto the locked Module-kinds (frontend / gateway), never a new kind', () => {
    // gateway: the server/API/edge surface.
    expect(roles.get(F.middleware)).toMatchObject({ role: 'middleware', kind: 'gateway' });
    expect(roles.get(F.apiStatsRoute)).toMatchObject({ role: 'route-handler', kind: 'gateway' });
    expect(roles.get(F.pagesApiPing)).toMatchObject({ role: 'route-handler', kind: 'gateway' });
    expect(roles.get(F.appActions)).toMatchObject({ role: 'server-action', kind: 'gateway' });
    // frontend: the UI surface (pages, layouts, components).
    expect(roles.get(F.appHome)).toMatchObject({ role: 'page', kind: 'frontend' });
    expect(roles.get(F.appRootLayout)).toMatchObject({ role: 'layout', kind: 'frontend' });
    expect(roles.get(F.dashboardChart)).toMatchObject({ role: 'client-component', kind: 'frontend' });
    expect(roles.get(F.dashboardStatsCard)).toMatchObject({ role: 'server-component', kind: 'frontend' });
    expect(roles.get(F.pagesLegacy)).toMatchObject({ role: 'page', kind: 'frontend' });
    expect(roles.get(F.pagesApp)).toMatchObject({ role: 'layout', kind: 'frontend' });
    // every role's kind is a locked app-tier Module-kind (no new kind invented).
    for (const tag of roles.values()) expect(['frontend', 'gateway']).toContain(tag.kind);
  });

  it('carries the Server↔Client split as `rsc` metadata (a role, NOT a special edge)', () => {
    // app/ defaults to server; an explicit `use client` flips the side.
    expect(roles.get(F.appHome)!.metadata!.rsc).toBe('server');
    expect(roles.get(F.dashboardStatsCard)!.metadata!.rsc).toBe('server');
    expect(roles.get(F.dashboardChart)!.metadata!.rsc).toBe('client');
    // a `use client` PAGE keeps its route role `page` but reads as the client side.
    expect(roles.get(F.dashboardPage)).toMatchObject({ role: 'page', kind: 'frontend' });
    expect(roles.get(F.dashboardPage)!.metadata!.rsc).toBe('client');
  });

  it('emits route-nav edges (kind calls), including a cross-router Pages nav', () => {
    expect(hasEdge(F.appHome, F.dashboardPage)).toBe(true);
    expect(hasEdge(F.appHome, F.blogPost)).toBe(true);
    expect(hasEdge(F.appHome, F.pricingPage)).toBe(true);
    expect(hasEdge(F.pagesLegacy, F.pagesAbout)).toBe(true);
  });

  it('emits the client→Server-Action invocation edge (kind calls)', () => {
    // dashboard/page.tsx (`use client`) imports app/actions.ts (`use server`).
    expect(hasEdge(F.dashboardPage, F.appActions)).toBe(true);
  });

  it('emits the page→Route-Handler fetch edge where statically resolvable (kind calls)', () => {
    // dashboard/page.tsx fetch('/api/stats') → app/api/stats/route.ts.
    expect(hasEdge(F.dashboardPage, F.apiStatsRoute)).toBe(true);
  });

  it('every contributed edge is the `calls` verb (8-verb taxonomy; nesting is never an edge)', () => {
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
  });

  it('degrades + logs the inline (function-level) server action (no silent caps)', () => {
    const degraded = logged.find((l) => l.includes('[next] degraded'));
    expect(degraded).toBeTruthy();
    expect(degraded).toContain('inline');
  });

  it('is deterministic — a second analysis yields the identical group/edge/role set', async () => {
    const graph = await new TsMorphExtractor().extract(dir);
    const ctx: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'next', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const g2 = (await nextAdapter.groupingPrior!(ctx)).groups;
    const e2 = await nextAdapter.syntheticEdges!(ctx);
    const r2 = await nextAdapter.roleTags!(ctx);
    expect(g2.map((g) => `${g.id}|${g.fileIds.join(',')}`)).toEqual(
      groups.map((g) => `${g.id}|${g.fileIds.join(',')}`),
    );
    expect(e2.map((e) => `${e.source}|${e.target}|${e.kind}`)).toEqual(
      edges.map((e) => `${e.source}|${e.target}|${e.kind}`),
    );
    expect([...r2.keys()].sort()).toEqual([...roles.keys()].sort());
  });
});
