// FastAPI adapter tests. (Celery was EXTRACTED into its own adapter in
// ; the Celery task/enqueue behavior is covered by framework/celery/.)
//
// scoreFastApi is pure; detect() runs against real tmp dirs (pyproject +
// requirements, and a non-FastAPI Python no-match + a TS no-match). The analysis
// hooks run over a real PythonExtractor graph of a small FastAPI fixture and
// assert the file-id-space contributions (the contribute-step resolves those to
// modules downstream; that resolution is covered by contribute-step.test.ts).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fastApiAdapter,
  scoreFastApi,
  gatherFastApiSignals,
  type FastApiSignals,
} from './fastapi.js';
import { PythonExtractor } from '../../graph/python-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: FastApiSignals = { hasFastApi: false, hasUvicorn: false };

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// scoreFastApi (pure)

describe('scoreFastApi (pure)', () => {
  it('returns null with no fastapi dep (generic-Python fallthrough)', () => {
    expect(scoreFastApi(NO_SIGNALS)).toBeNull();
    // uvicorn without fastapi is NOT FastAPI.
    expect(scoreFastApi({ hasFastApi: false, hasUvicorn: true })).toBeNull();
  });

  it('detects FastAPI on the fastapi dep', () => {
    const m = scoreFastApi({ ...NO_SIGNALS, hasFastApi: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('fastapi');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('raises confidence with uvicorn', () => {
    const m = scoreFastApi({ hasFastApi: true, hasUvicorn: true });
    expect(m!.confidence).toBeGreaterThan(0.8);
    expect((m!.metadata?.signals as Record<string, boolean>).uvicorn).toBe(true);
  });

  it('passes rootPath through', () => {
    const m = scoreFastApi({ ...NO_SIGNALS, hasFastApi: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('fastApiAdapter.detect (fs fixtures)', () => {
  let pyproject: string;
  let requirements: string;
  let plainPy: string;
  let tsRepo: string;

  beforeAll(() => {
    pyproject = mkdtempSync(join(tmpdir(), 'bt-fastapi-toml-'));
    writeFileSync(
      join(pyproject, 'pyproject.toml'),
      [
        '[project]',
        'name = "svc"',
        'dependencies = [',
        '  "fastapi[standard]>=0.138.1,<1.0.0",',
        '  "sqlmodel>=0.0.39",',
        ']',
        '[dependency-groups]',
        'dev = ["pytest>=7"]',
      ].join('\n'),
    );

    requirements = mkdtempSync(join(tmpdir(), 'bt-fastapi-req-'));
    writeFileSync(
      join(requirements, 'requirements.txt'),
      ['# app deps', 'fastapi==0.111.0', 'uvicorn[standard]>=0.29', 'celery>=5.3', 'redis'].join('\n'),
    );

    plainPy = mkdtempSync(join(tmpdir(), 'bt-fastapi-plain-'));
    writeFileSync(join(plainPy, 'pyproject.toml'), '[project]\nname = "x"\ndependencies = ["requests>=2", "click"]\n');

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-fastapi-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [pyproject, requirements, plainPy, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects FastAPI from pyproject PEP 621 dependencies', async () => {
    const m = await fastApiAdapter.detect({ repoDir: pyproject });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('fastapi');
  });

  it('detects FastAPI from requirements.txt (uvicorn signal)', async () => {
    const m = await fastApiAdapter.detect({ repoDir: requirements });
    expect(m).not.toBeNull();
    expect((m!.metadata?.signals as Record<string, boolean>).uvicorn).toBe(true);
  });

  it('does NOT detect a non-FastAPI Python repo', async () => {
    expect(await fastApiAdapter.detect({ repoDir: plainPy })).toBeNull();
  });

  it('does NOT detect a TS repo (no Python manifest)', async () => {
    expect(await fastApiAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED FastAPI backend and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-fastapi-nested-'));
    // A frontend+backend monorepo: no root Python manifest; fastapi under backend/.
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'pyproject.toml'), '[project]\nname="be"\ndependencies=["fastapi>=0.100"]\n');
    try {
      const m = await fastApiAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherFastApiSignals reads deps from disk', () => {
    const s = gatherFastApiSignals(requirements);
    expect(s.hasFastApi).toBe(true);
    expect(s.hasUvicorn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real FastAPI + Celery fixture

describe('fastApiAdapter analysis (groupingPrior / syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let groups: Awaited<ReturnType<NonNullable<typeof fastApiAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-fastapi-app-'));
    // The FastAPI app entry: mounts the aggregator router.
    write(dir, 'app/main.py', [
      'from fastapi import FastAPI',
      'from app.api.main import api_router',
      'app = FastAPI(title="svc")',
      'app.include_router(api_router, prefix="/api/v1")',
    ].join('\n'));
    // The aggregator router: mounts the leaf routers.
    write(dir, 'app/api/main.py', [
      'from fastapi import APIRouter',
      'from app.api.routes import users, items, dynamic',
      'api_router = APIRouter()',
      'api_router.include_router(users.router)',
      'api_router.include_router(items.router)',
      'api_router.include_router(dynamic.router)',
    ].join('\n'));
    // Leaf routers with real route decorators + shared deps.
    write(dir, 'app/api/routes/users.py', [
      'from fastapi import APIRouter, Depends',
      'from app.models import User',
      'router = APIRouter(prefix="/users", tags=["users"])',
      '@router.get("/")',
      'def read_users():',
      '    return []',
      '@router.post("/")',
      'def create_user(u: User):',
      '    return u',
    ].join('\n'));
    write(dir, 'app/api/routes/items.py', [
      'from fastapi import APIRouter',
      'from app.models import Item',
      'router = APIRouter(tags=["items"])',
      '@router.get("/items")',
      'async def read_items():', // async def is the FastAPI norm — must still register
      '    return []',
    ].join('\n'));
    // add_api_route with a cross-file endpoint handler.
    write(dir, 'app/api/routes/dynamic.py', [
      'from fastapi import APIRouter',
      'from app.handlers.legacy import legacy_handler',
      'router = APIRouter()',
      'router.add_api_route("/legacy", endpoint=legacy_handler)',
    ].join('\n'));
    write(dir, 'app/handlers/legacy.py', ['def legacy_handler():', '    return {"ok": True}'].join('\n'));
    write(dir, 'app/models.py', ['class User:', '    pass', 'class Item:', '    pass'].join('\n'));

    graph = await new PythonExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'fastapi', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    ({ groups } = await fastApiAdapter.groupingPrior!(ctx));
    edges = await fastApiAdapter.syntheticEdges!(ctx);
    roles = await fastApiAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags roles onto locked MODULE_KINDS (gateway for app/router/handler)', () => {
    expect(roles.get('app/main.py')).toMatchObject({ role: 'app', kind: 'gateway' });
    expect(roles.get('app/api/main.py')).toMatchObject({ role: 'router', kind: 'gateway' });
    expect(roles.get('app/api/routes/users.py')).toMatchObject({ role: 'route-handler', kind: 'gateway' });
    expect(roles.get('app/api/routes/items.py')).toMatchObject({ role: 'route-handler', kind: 'gateway' });
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('groups each route-declaring router into its own named subsystem', () => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get('users')?.label).toBe('Users');
    expect(byId.get('users')?.fileIds).toEqual(['app/api/routes/users.py']);
    expect(byId.get('items')?.label).toBe('Items');
    // The pure aggregator (api/main.py — include_router only, no routes) is NOT a
    // group (it's the routing spine); nor is the FastAPI app file.
    expect(byId.has('main')).toBe(false);
  });

  it('emits include_router mounting edges (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('app/main.py→app/api/main.py:calls');
    expect(keys).toContain('app/api/main.py→app/api/routes/users.py:calls');
    expect(keys).toContain('app/api/main.py→app/api/routes/items.py:calls');
  });

  it('emits an add_api_route endpoint edge to the cross-file handler (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('app/api/routes/dynamic.py→app/handlers/legacy.py:calls');
  });

  it('emits only route/mounting `calls` edges — no celery publishes (extracted to framework/celery)', () => {
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
  });

  it('is deterministic across two runs (stable ids + ordering)', async () => {
    const g2 = (await fastApiAdapter.groupingPrior!(ctx)).groups;
    const e2 = await fastApiAdapter.syntheticEdges!(ctx);
    const r2 = await fastApiAdapter.roleTags!(ctx);
    expect(g2).toEqual(groups);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
    expect([...r2.keys()].sort()).toEqual([...roles.keys()].sort());
  });
});
