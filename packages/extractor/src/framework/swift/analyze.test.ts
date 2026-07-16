// The shared Swift framework-analysis layer: the AST accessors (typeDeclarations /
// properties / conformance + attributes) and the scope builder (buildSwiftBindings /
// parseSwiftScope).

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  typeDeclarations,
  properties,
  simpleTypeName,
  hasBodyProperty,
  conformsTo,
} from './swift-ast.js';
import { buildSwiftBindings, parseSwiftScope } from './analyze.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

describe('typeDeclarations', () => {
  it('captures kind, conformances, and attributes', () => {
    const src = [
      'import SwiftUI',
      '@main',
      'struct MyApp: App {',
      '  var body: some Scene { WindowGroup {} }',
      '}',
      'final class TodoController: RouteCollection, Sendable {}',
      '@Model final class Item {}',
      'extension String: Identifiable {}',
    ].join('\n');
    const decls = typeDeclarations(src);
    const app = decls.find((d) => d.name === 'MyApp')!;
    expect(app.kind).toBe('struct');
    expect(app.inherits).toContain('App');
    expect(app.attributes).toContain('main');

    const ctrl = decls.find((d) => d.name === 'TodoController')!;
    expect(ctrl.inherits).toEqual(expect.arrayContaining(['RouteCollection', 'Sendable']));

    const item = decls.find((d) => d.name === 'Item')!;
    expect(item.attributes).toContain('Model');

    const ext = decls.find((d) => d.kind === 'extension')!;
    expect(ext.name).toBe('String');
    expect(conformsTo(ctrl, 'RouteCollection')).toBe(true);
  });
});

describe('properties + simpleTypeName', () => {
  it('reads property-wrapper attributes + the associated simple type', () => {
    const src = [
      'final class Star: Model {',
      '  @Parent(key: "galaxy_id") var galaxy: Galaxy',
      '  @Children(for: \\.$star) var planets: [Planet]',
      '  @Relationship(deleteRule: .cascade) var tags: Set<Tag>',
      '}',
    ].join('\n');
    const props = properties(src);
    const byName = Object.fromEntries(props.map((p) => [p.name, p]));
    expect(byName['galaxy'].attributes).toContain('Parent');
    expect(byName['galaxy'].type).toBe('Galaxy');
    expect(byName['planets'].attributes).toContain('Children');
    expect(byName['planets'].type).toBe('Planet');
    expect(byName['tags'].type).toBe('Tag');
  });

  it('simpleTypeName strips container wrappers', () => {
    expect(simpleTypeName('[Comment]')).toBe('Comment');
    expect(simpleTypeName('Star?')).toBe('Star');
    expect(simpleTypeName('Set<Tag>')).toBe('Tag');
    expect(simpleTypeName('[UserID: Profile]')).toBe('Profile');
  });

  it('hasBodyProperty detects a SwiftUI View body', () => {
    expect(hasBodyProperty('struct V: View {\n  var body: some View { EmptyView() }\n}')).toBe(true);
    expect(hasBodyProperty('struct Model {\n  var name: String\n}')).toBe(false);
  });
});

describe('buildSwiftBindings', () => {
  it('indexes unique primary declarations, drops ambiguous, ignores extensions', () => {
    const texts = new Map<string, string>([
      ['a/User.swift', 'struct User {}\n'],
      ['b/Repo.swift', 'protocol Repo {}\n'],
      ['c/Ext.swift', 'extension User {}\n'], // extension is not a declarer
      ['d/Dup.swift', 'struct Dup {}\n'],
      ['e/Dup.swift', 'struct Dup {}\n'], // Dup declared twice → ambiguous
    ]);
    const idx = buildSwiftBindings(texts);
    expect(idx.get('User')).toBe('a/User.swift');
    expect(idx.get('Repo')).toBe('b/Repo.swift');
    expect(idx.has('Dup')).toBe(false); // ambiguous → omitted
  });
});

describe('parseSwiftScope', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-swift-scope-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
    return dir;
  }
  function ctx(repoDir: string, ids: string[]): FrameworkContext {
    const graph: NormalizedGraph = {
      root: repoDir,
      files: ids.map((id) => ({ id, loc: 3, language: 'swift' })),
      edges: [],
      externals: [],
    };
    return {
      repoDir,
      rootPath: '',
      match: { adapter: 'test', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set() },
    };
  }

  it('pre-scans in-scope Swift files + resolves type names', async () => {
    const dir = await repo({
      'Sources/App/View.swift': 'import SwiftUI\nstruct HomeView: View {\n  let store: Store\n}\n',
      'Sources/App/Store.swift': 'final class Store {}\n',
    });
    const scope = parseSwiftScope(ctx(dir, ['Sources/App/View.swift', 'Sources/App/Store.swift']));
    expect(scope.swiftFiles).toHaveLength(2);
    expect(scope.resolve('Store')).toBe('Sources/App/Store.swift');
    const view = scope.parsed.get('Sources/App/View.swift')!;
    expect(view.decls[0].name).toBe('HomeView');
    expect(view.imports).toContain('SwiftUI');
  });
});
