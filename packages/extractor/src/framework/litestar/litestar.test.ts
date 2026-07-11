// Litestar adapter tests.
//
// scoreLitestar is pure; detect() runs against real tmp dirs (pyproject +
// requirements, a non-Litestar Python no-match + a TS no-match + a nested
// backend). The analysis hooks run over a real PythonExtractor graph of a small
// Litestar fixture (function-based handlers + Controllers + a Router + layered
// Provide DI) and assert the file-id-space contributions (the contribute-step
// resolves those to modules downstream; that resolution is covered separately).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  litestarAdapter,
  scoreLitestar,
  gatherLitestarSignals,
  type LitestarSignals,
} from './litestar.js';
import { PythonExtractor } from '../../graph/python-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: LitestarSignals = { hasLitestar: false, hasLitestarPlugin: false };

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// scoreLitestar (pure)

describe('scoreLitestar (pure)', () => {
  it('returns null with no litestar dep (generic-Python fallthrough)', () => {
    expect(scoreLitestar(NO_SIGNALS)).toBeNull();
    // a litestar plugin without litestar itself is NOT a match.
    expect(scoreLitestar({ hasLitestar: false, hasLitestarPlugin: true })).toBeNull();
  });

  it('detects Litestar on the litestar dep', () => {
    const m = scoreLitestar({ ...NO_SIGNALS, hasLitestar: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('litestar');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('raises confidence with a litestar-* plugin', () => {
    const m = scoreLitestar({ hasLitestar: true, hasLitestarPlugin: true });
    expect(m!.confidence).toBeGreaterThan(0.8);
    expect((m!.metadata?.signals as Record<string, boolean>).litestarPlugin).toBe(true);
  });

  it('passes rootPath through', () => {
    const m = scoreLitestar({ ...NO_SIGNALS, hasLitestar: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('litestarAdapter.detect (fs fixtures)', () => {
  let pyproject: string;
  let requirements: string;
  let plainPy: string;
  let tsRepo: string;

  beforeAll(() => {
    pyproject = mkdtempSync(join(tmpdir(), 'bt-litestar-toml-'));
    writeFileSync(
      join(pyproject, 'pyproject.toml'),
      [
        '[project]',
        'name = "svc"',
        'dependencies = [',
        '  "litestar[standard]>=2.8.0",',
        '  "advanced-alchemy>=0.9",',
        ']',
        '[dependency-groups]',
        'dev = ["pytest>=7"]',
      ].join('\n'),
    );

    requirements = mkdtempSync(join(tmpdir(), 'bt-litestar-req-'));
    writeFileSync(
      join(requirements, 'requirements.txt'),
      ['# app deps', 'litestar==2.9.1', 'litestar-saq>=0.1', 'uvicorn[standard]>=0.29'].join('\n'),
    );

    plainPy = mkdtempSync(join(tmpdir(), 'bt-litestar-plain-'));
    writeFileSync(join(plainPy, 'pyproject.toml'), '[project]\nname = "x"\ndependencies = ["requests>=2", "click"]\n');

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-litestar-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [pyproject, requirements, plainPy, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects Litestar from pyproject PEP 621 dependencies', async () => {
    const m = await litestarAdapter.detect({ repoDir: pyproject });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('litestar');
  });

  it('detects Litestar from requirements.txt and raises confidence on a litestar-* plugin', async () => {
    const m = await litestarAdapter.detect({ repoDir: requirements });
    expect(m).not.toBeNull();
    expect(m!.confidence).toBeGreaterThan(0.8);
    expect((m!.metadata?.signals as Record<string, boolean>).litestarPlugin).toBe(true);
  });

  it('does NOT detect a non-Litestar Python repo', async () => {
    expect(await litestarAdapter.detect({ repoDir: plainPy })).toBeNull();
  });

  it('does NOT detect a TS repo (no Python manifest)', async () => {
    expect(await litestarAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED Litestar backend and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-litestar-nested-'));
    // A frontend+backend monorepo: no root Python manifest; litestar under backend/.
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'pyproject.toml'), '[project]\nname="be"\ndependencies=["litestar>=2.8"]\n');
    try {
      const m = await litestarAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherLitestarSignals reads deps from disk', () => {
    const s = gatherLitestarSignals(requirements);
    expect(s.hasLitestar).toBe(true);
    expect(s.hasLitestarPlugin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real Litestar fixture

describe('litestarAdapter analysis (groupingPrior / syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let groups: Awaited<ReturnType<NonNullable<typeof litestarAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-litestar-app-'));
    // The app entry: mounts a function handler + an aggregator Router; app-level DI.
    write(dir, 'app/main.py', [
      'from litestar import Litestar',
      'from litestar.di import Provide',
      'from app.handlers import health',
      'from app.routers import api_router',
      'from app.db import provide_db',
      'from app.late import late_handler',
      'from app.neg import handler_thing',
      'app = Litestar(',
      '    route_handlers=[health, api_router],',
      '    dependencies={"db": Provide(provide_db)},',
      ')',
      'app.register(late_handler)', // late registration on the app var → a mount edge
      'bus = EventBus()', // a non-app/router object …
      'bus.register(handler_thing)', // … whose .register() must NOT produce an edge
    ].join('\n'));
    // A late-registered function handler (`app.register(...)`).
    write(dir, 'app/late.py', [
      'from litestar import get',
      '@get("/late")',
      'async def late_handler() -> dict:',
      '    return {}',
    ].join('\n'));
    // The negative-case target — reachable only via a non-app `.register`, so it
    // must NOT be wired.
    write(dir, 'app/neg.py', ['def handler_thing() -> None:', '    return None'].join('\n'));
    // A bare function-based handler (`@get`, imported from litestar).
    write(dir, 'app/handlers.py', [
      'from litestar import get',
      '@get("/health")',
      'async def health() -> dict:',
      '    return {"status": "ok"}',
    ].join('\n'));
    // A handler decorated via the module alias (`import litestar` + `@litestar.get`).
    write(dir, 'app/aliased.py', [
      'import litestar',
      '@litestar.get("/ping")',
      'async def ping() -> dict:',
      '    return {}',
    ].join('\n'));
    // An aggregator Router registering two Controllers.
    write(dir, 'app/routers.py', [
      'from litestar import Router',
      'from app.users.controller import UserController',
      'from app.products.controller import ProductController',
      'api_router = Router(path="/api", route_handlers=[UserController, ProductController])',
    ].join('\n'));
    // A Controller with a path, decorated method handlers, and layered Provide DI.
    write(dir, 'app/users/controller.py', [
      'from litestar import Controller, get, post',
      'from litestar.di import Provide',
      'from app.users.deps import provide_user_service',
      'from app.users.models import User',
      'class UserController(Controller):',
      '    path = "/users"',
      '    dependencies = {"svc": Provide(provide_user_service)}',
      '    @get("/")',
      '    async def list_users(self) -> list:',
      '        return []',
      '    @post("/")',
      '    async def create_user(self, data: User) -> User:',
      '        return data',
    ].join('\n'));
    // The Controller's DI provider function → its file is a `service`.
    write(dir, 'app/users/deps.py', ['def provide_user_service() -> object:', '    return object()'].join('\n'));
    write(dir, 'app/users/models.py', ['class User:', '    pass'].join('\n'));
    // A second Controller (a different domain → a different subsystem). Its
    // OpenAPI `tags=[…]` names the subsystem (tag-first, over the path/class name).
    write(dir, 'app/products/controller.py', [
      'from litestar import Controller, get',
      'class ProductController(Controller):',
      '    tags = ["Catalog"]',
      '    path = "/api/products"',
      '    @get("/")',
      '    async def list_products(self) -> list:',
      '        return []',
    ].join('\n'));
    // The app-level DI provider function.
    write(dir, 'app/db.py', ['def provide_db() -> object:', '    return object()'].join('\n'));

    graph = await new PythonExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'litestar', confidence: 1, rootPath: '', metadata: {} },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    ({ groups } = await litestarAdapter.groupingPrior!(ctx));
    edges = await litestarAdapter.syntheticEdges!(ctx);
    roles = await litestarAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags roles onto locked MODULE_KINDS (gateway for app/controller/handler, service for a DI provider)', () => {
    expect(roles.get('app/main.py')).toMatchObject({ role: 'app', kind: 'gateway' });
    expect(roles.get('app/handlers.py')).toMatchObject({ role: 'route-handler', kind: 'gateway' });
    // The module-aliased `@litestar.get` handler still registers.
    expect(roles.get('app/aliased.py')).toMatchObject({ role: 'route-handler', kind: 'gateway' });
    expect(roles.get('app/users/controller.py')).toMatchObject({ role: 'controller', kind: 'gateway' });
    expect(roles.get('app/products/controller.py')).toMatchObject({ role: 'controller', kind: 'gateway' });
    // DI provider functions' files are services.
    expect(roles.get('app/users/deps.py')).toMatchObject({ role: 'provider', kind: 'service' });
    expect(roles.get('app/db.py')).toMatchObject({ role: 'provider', kind: 'service' });
    // A pure Router file has no role (scope: routers group + wire, they don't tag).
    expect(roles.get('app/routers.py')).toBeUndefined();
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('groups each Controller and Router into its own named subsystem', () => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    // UserController has no `tags` → named by its `path="/users"` domain segment.
    expect(byId.get('users')?.label).toBe('Users');
    expect(byId.get('users')?.fileIds).toEqual(['app/users/controller.py']);
    // ProductController has `tags=["Catalog"]` → tag-first (over path "/api/products").
    expect(byId.get('catalog')?.label).toBe('Catalog');
    expect(byId.get('catalog')?.fileIds).toEqual(['app/products/controller.py']);
    // The aggregator Router is its own subsystem, named by its `path="/api"`.
    expect(byId.get('api')?.label).toBe('Api');
    expect(byId.get('api')?.fileIds).toEqual(['app/routers.py']);
  });

  it('emits route_handlers mounting edges from the app + router (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    // app → function handler + aggregator router.
    expect(keys).toContain('app/main.py→app/handlers.py:calls');
    expect(keys).toContain('app/main.py→app/routers.py:calls');
    // router → its two Controllers.
    expect(keys).toContain('app/routers.py→app/users/controller.py:calls');
    expect(keys).toContain('app/routers.py→app/products/controller.py:calls');
  });

  it('emits an app.register(...) late-mount edge, but ignores .register on a non-app var', () => {
    const keys = new Set(edges.map(edgeKey));
    // `app.register(late_handler)` on the Litestar app var → a mount edge.
    expect(keys).toContain('app/main.py→app/late.py:calls');
    expect(roles.get('app/late.py')).toMatchObject({ role: 'route-handler', kind: 'gateway' });
    // `bus.register(handler_thing)` on a non-app/router object → NO edge.
    expect(keys).not.toContain('app/main.py→app/neg.py:calls');
  });

  it('emits layered Provide() DI edges consumer→provider (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    // app-level dependency.
    expect(keys).toContain('app/main.py→app/db.py:calls');
    // Controller-level dependency.
    expect(keys).toContain('app/users/controller.py→app/users/deps.py:calls');
  });

  it('every synthetic edge is one of the 8 verbs (here: calls)', () => {
    for (const e of edges) expect(e.kind).toBe('calls');
  });

  it('is deterministic across two runs (stable ids + ordering)', async () => {
    const g2 = (await litestarAdapter.groupingPrior!(ctx)).groups;
    const e2 = await litestarAdapter.syntheticEdges!(ctx);
    const r2 = await litestarAdapter.roleTags!(ctx);
    expect(g2).toEqual(groups);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
    expect([...r2.keys()].sort()).toEqual([...roles.keys()].sort());
  });
});
