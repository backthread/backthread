// The Vapor adapter: detection (SPM vapor dep), controller/router gateway roles, and
// the route-mount spine (direct + var-bound register(collection:)).

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { vaporAdapter, scoreVapor, isRouteCollection } from './vapor.js';
import { typeDeclarations, scanImports, properties } from '../swift-ast.js';
import { SwiftExtractor } from '../../../graph/swift-adapter.js';
import type { FrameworkContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-swift-vapor-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}
async function contextFor(repoDir: string): Promise<FrameworkContext> {
  const graph: NormalizedGraph = await new SwiftExtractor().extract(repoDir);
  return {
    repoDir,
    rootPath: '',
    match: { adapter: 'vapor', confidence: 1, rootPath: '' },
    graph,
    cluster: { fileModuleMap: {}, moduleIds: new Set() },
  };
}
const parsed = (text: string) => ({ text, decls: typeDeclarations(text), imports: scanImports(text), properties: properties(text) });

// A minimal Vapor app: Package.swift with the vapor dep, two controllers, and a
// routes.swift that mounts them (both the direct + var-bound forms).
const APP: Record<string, string> = {
  'Package.swift':
    'let p = Package(name: "App", dependencies: [.package(url: "https://github.com/vapor/vapor.git", from: "4.0.0")], targets: [.target(name: "App")])\n',
  'Sources/App/Controllers/TodoController.swift':
    'import Vapor\nstruct TodoController: RouteCollection {\n  func boot(routes: RoutesBuilder) throws {\n    routes.get(use: index)\n  }\n  func index(req: Request) -> String { "" }\n}\n',
  'Sources/App/Controllers/UserController.swift':
    'import Vapor\nstruct UserController: RouteCollection {\n  func boot(routes: RoutesBuilder) throws {\n    routes.post(use: create)\n  }\n  func create(req: Request) -> String { "" }\n}\n',
  'Sources/App/routes.swift':
    'import Vapor\nfunc routes(_ app: Application) throws {\n  try app.register(collection: TodoController())\n  let userController = UserController()\n  try app.register(collection: userController)\n}\n',
};

describe('scoreVapor / detect', () => {
  it('detects Vapor from the SPM vapor dep', async () => {
    const ctx = await contextFor(await repo(APP));
    expect((await vaporAdapter.detect!({ repoDir: ctx.repoDir }))?.adapter).toBe('vapor');
  });
  it('returns null with no vapor dep and no Vapor import', async () => {
    const dir = await repo({ 'Sources/App/Math.swift': 'import Foundation\nstruct Math {}\n' });
    expect(await vaporAdapter.detect!({ repoDir: dir })).toBeNull();
    expect(scoreVapor(false)).toBeNull();
  });
});

describe('isRouteCollection', () => {
  it('recognizes a RouteCollection conformer', () => {
    expect(isRouteCollection(parsed('struct TodoController: RouteCollection {}'))).toBe(true);
    expect(isRouteCollection(parsed('struct Widget: Codable {}'))).toBe(false);
  });
});

describe('roleTags', () => {
  it('tags controllers + the route-wiring file gateway', async () => {
    const ctx = await contextFor(await repo(APP));
    const roles = await vaporAdapter.roleTags!(ctx);
    expect(roles.get('Sources/App/Controllers/TodoController.swift')?.role).toBe('controller');
    expect(roles.get('Sources/App/Controllers/TodoController.swift')?.kind).toBe('gateway');
    expect(roles.get('Sources/App/routes.swift')?.role).toBe('router');
    // Every Vapor role is gateway (the one Swift role that earns gateway).
    for (const t of roles.values()) expect(t.kind).toBe('gateway');
  });
});

describe('roleTags — no false router on a Fluent migration', () => {
  it('does NOT tag a migration (its schema .delete() is not a route)', async () => {
    const ctx = await contextFor(
      await repo({
        ...APP,
        // A Fluent migration's revert() drops a schema with `.delete()` — data, not a route.
        'Sources/App/Migrations/CreateTodo.swift':
          'import Fluent\nstruct CreateTodo: AsyncMigration {\n  func prepare(on database: Database) async throws { try await database.schema("todos").id().create() }\n  func revert(on database: Database) async throws { try await database.schema("todos").delete() }\n}\n',
      }),
    );
    const roles = await vaporAdapter.roleTags!(ctx);
    expect(roles.has('Sources/App/Migrations/CreateTodo.swift')).toBe(false);
  });
});

describe('syntheticEdges (route-mount spine)', () => {
  it('mounts controllers via both the direct and var-bound register(collection:) forms', async () => {
    const ctx = await contextFor(await repo(APP));
    const edges = await vaporAdapter.syntheticEdges!(ctx);
    const keys = new Set(edges.map((e) => `${e.source} -> ${e.target}`));
    // direct: register(collection: TodoController())
    expect(keys).toContain('Sources/App/routes.swift -> Sources/App/Controllers/TodoController.swift');
    // var-bound: let userController = UserController(); register(collection: userController)
    expect(keys).toContain('Sources/App/routes.swift -> Sources/App/Controllers/UserController.swift');
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
  });

  it('resolves an explicitly-typed local binding (let c: Controller = Controller())', async () => {
    const ctx = await contextFor(
      await repo({
        'Package.swift': APP['Package.swift'],
        'Sources/App/Controllers/PingController.swift':
          'import Vapor\nstruct PingController: RouteCollection {\n  func boot(routes: RoutesBuilder) throws {}\n}\n',
        'Sources/App/routes.swift':
          'import Vapor\nfunc routes(_ app: Application) throws {\n  let ping: PingController = PingController()\n  try app.register(collection: ping)\n}\n',
      }),
    );
    const keys = new Set((await vaporAdapter.syntheticEdges!(ctx)).map((e) => `${e.source} -> ${e.target}`));
    expect(keys).toContain('Sources/App/routes.swift -> Sources/App/Controllers/PingController.swift');
  });
});
