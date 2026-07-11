// (Slice 2) — NestJS adapter tests.
//
// scoreNest is pure; the adapter's detect() runs against real tmp dirs (Nest via
// dep + nest-cli.json, and a plain-TS no-match).

import { describe, it, expect, beforeAll, afterAll, vi } from '../../testkit.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nestAdapter, scoreNest, gatherNestSignals, type NestSignals } from './nest.js';
import { TsMorphExtractor } from '../../graph/ts-morph-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import { writeNestFixture, NEST_FIXTURE_FILES as F } from './nest-test-fixture.js';

const NO_SIGNALS: NestSignals = { hasNestCoreDep: false, hasNestCliJson: false };

describe('scoreNest (pure)', () => {
  it('returns null when no signal is present (generic-TS fallthrough)', () => {
    expect(scoreNest(NO_SIGNALS)).toBeNull();
  });

  it('detects Nest from @nestjs/core dep + nest-cli.json', () => {
    const m = scoreNest({ hasNestCoreDep: true, hasNestCliJson: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('nest');
    expect(m!.confidence).toBe(1);
    expect(m!.rootPath).toBe('');
  });

  it('matches on @nestjs/core dep alone', () => {
    const m = scoreNest({ ...NO_SIGNALS, hasNestCoreDep: true });
    expect(m).not.toBeNull();
    expect(m!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('matches on nest-cli.json alone (no dep) at lower confidence', () => {
    const m = scoreNest({ ...NO_SIGNALS, hasNestCliJson: true });
    expect(m).not.toBeNull();
    expect(m!.confidence).toBeLessThan(0.6);
  });

  it('passes rootPath through', () => {
    const m = scoreNest({ hasNestCoreDep: true, hasNestCliJson: false }, 'apps/api');
    expect(m!.rootPath).toBe('apps/api');
  });
});

describe('nestAdapter.detect (fs fixtures)', () => {
  let nest: string;
  let plain: string;

  beforeAll(() => {
    nest = mkdtempSync(join(tmpdir(), 'backthread-nest-'));
    writeFileSync(
      join(nest, 'package.json'),
      JSON.stringify({
        name: 'nest-api',
        dependencies: { '@nestjs/core': '10.0.0', '@nestjs/common': '10.0.0' },
      }),
    );
    writeFileSync(join(nest, 'nest-cli.json'), JSON.stringify({ collection: '@nestjs/schematics' }));

    plain = mkdtempSync(join(tmpdir(), 'backthread-nest-plain-'));
    writeFileSync(
      join(plain, 'package.json'),
      JSON.stringify({ name: 'plain', dependencies: { typescript: '5.4.0' } }),
    );
  });

  afterAll(() => {
    for (const d of [nest, plain]) rmSync(d, { recursive: true, force: true });
  });

  it('detects a NestJS repo', async () => {
    const m = await nestAdapter.detect({ repoDir: nest });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('nest');
    expect((m!.metadata?.signals as Record<string, boolean>).nestCoreDep).toBe(true);
    expect((m!.metadata?.signals as Record<string, boolean>).nestCliJson).toBe(true);
  });

  it('does NOT detect a plain repo (empty → generic-TS fallthrough)', async () => {
    expect(await nestAdapter.detect({ repoDir: plain })).toBeNull();
  });

  it('gatherNestSignals reads dep + config existence from disk', () => {
    const s = gatherNestSignals(nest);
    expect(s.hasNestCoreDep).toBe(true);
    expect(s.hasNestCliJson).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the @Module grouping prior, DI graph, and role tags (FILE-ID space;
// the contribute-step resolves to modules). Hermetic Nest fixture.

describe('nestAdapter contribution hooks (, file-id space)', () => {
  let dir: string;
  let groups: Awaited<ReturnType<NonNullable<typeof nestAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;
  const logged: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backthread-nest-contrib-'));
    await writeNestFixture(dir);
    const graph = await new TsMorphExtractor().extract(dir);
    const ctx: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'nest', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logged.push(a.join(' '));
    });
    ({ groups } = await nestAdapter.groupingPrior!(ctx));
    edges = await nestAdapter.syntheticEdges!(ctx);
    roles = await nestAdapter.roleTags!(ctx);
    logSpy.mockRestore();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const group = (id: string) => groups.find((g) => g.id === id);
  const hasEdge = (source: string, target: string, kind = 'calls') =>
    edges.some((e) => e.source === source && e.target === target && e.kind === kind);

  it('emits one group per @Module, id slug + humanized label', () => {
    expect(groups.map((g) => g.id).sort()).toEqual(['app-module', 'orders-module', 'users-module']);
    expect(group('users-module')!.label).toBe('Users');
    expect(group('orders-module')!.label).toBe('Orders');
    expect(group('app-module')!.label).toBe('App');
  });

  it('a @Module group collects its controller + provider + module files (NOT imports)', () => {
    const users = group('users-module')!.fileIds;
    expect(users).toEqual([...users].sort()); // deterministic sorted order
    expect(users).toContain(F.usersController);
    expect(users).toContain(F.usersService);
    expect(users).toContain(F.usersRepository);
    expect(users).toContain(F.usersModule);
    expect(users).not.toContain(F.ordersController); // not another module's file
    expect(users).not.toContain(F.usersModule.replace('users', 'orders'));
    // AppModule only imports other modules → just its own file.
    expect(group('app-module')!.fileIds).toEqual([F.appModule]);
  });

  it('emits DI edges (kind calls): controller→service + cross-module service→service', () => {
    expect(hasEdge(F.usersController, F.usersService)).toBe(true);
    expect(hasEdge(F.ordersController, F.ordersService)).toBe(true);
    expect(hasEdge(F.ordersService, F.usersService)).toBe(true); // cross-module DI
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
  });

  it('emits @Module import edges (kind calls)', () => {
    expect(hasEdge(F.ordersModule, F.usersModule)).toBe(true);
    expect(hasEdge(F.appModule, F.usersModule)).toBe(true);
    expect(hasEdge(F.appModule, F.ordersModule)).toBe(true);
  });

  it('maps roles onto the locked Module-kinds (gateway / service)', () => {
    expect(roles.get(F.usersController)).toMatchObject({ role: 'controller', kind: 'gateway' });
    expect(roles.get(F.usersResolver)).toMatchObject({ role: 'resolver', kind: 'gateway' });
    expect(roles.get(F.usersService)).toMatchObject({ role: 'service', kind: 'service' });
    expect(roles.get(F.rolesGuard)).toMatchObject({ role: 'guard', kind: 'service' });
    expect(roles.get(F.loggingInterceptor)).toMatchObject({ role: 'interceptor', kind: 'service' });
    expect(roles.get(F.parseIntPipe)).toMatchObject({ role: 'pipe', kind: 'service' });
    expect(roles.get(F.usersModule)).toMatchObject({ role: 'module', kind: 'service' });
  });

  it('degrades + logs unresolved custom providers + @Inject tokens (no silent caps)', () => {
    const degraded = logged.find((l) => l.includes('[nest] degraded'));
    expect(degraded).toBeTruthy();
    expect(degraded).toContain('custom provider'); // the useFactory CONFIG provider
    expect(degraded).toContain('CONFIG'); // the @Inject('CONFIG') token
  });

  it('is deterministic — a second analysis yields the identical group/edge set', async () => {
    const graph = await new TsMorphExtractor().extract(dir);
    const ctx: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'nest', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const g2 = (await nestAdapter.groupingPrior!(ctx)).groups;
    const e2 = await nestAdapter.syntheticEdges!(ctx);
    expect(g2.map((g) => `${g.id}|${g.fileIds.join(',')}`)).toEqual(
      groups.map((g) => `${g.id}|${g.fileIds.join(',')}`),
    );
    expect(e2.map((e) => `${e.source}|${e.target}`).sort()).toEqual(
      edges.map((e) => `${e.source}|${e.target}`).sort(),
    );
  });
});
