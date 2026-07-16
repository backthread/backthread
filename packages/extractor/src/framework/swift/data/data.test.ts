// The Swift data adapter: SwiftData/CoreData/Fluent model detection, service role
// tags, association (calls) edges, and Data-Model grouping. NO datastore node.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { swiftDataAdapter, detectDataSignals, scoreData, isModelFile } from './data.js';
import { typeDeclarations, scanImports, properties } from '../swift-ast.js';
import { SwiftExtractor } from '../../../graph/swift-adapter.js';
import type { FrameworkContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-swift-data-'));
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
    match: { adapter: 'swift-data', confidence: 1, rootPath: '' },
    graph,
    cluster: { fileModuleMap: {}, moduleIds: new Set() },
  };
}
const parsed = (text: string) => ({ text, decls: typeDeclarations(text), imports: scanImports(text), properties: properties(text) });

describe('detectDataSignals / scoreData', () => {
  it('detects SwiftData from import + @Model', async () => {
    const dir = await repo({ 'Sources/App/Item.swift': 'import SwiftData\n@Model final class Item { var name: String = "" }\n' });
    const s = detectDataSignals(dir, new Set());
    expect(s.hasSwiftData).toBe(true);
    expect(scoreData(s)?.adapter).toBe('swift-data');
  });
  it('detects CoreData from a .xcdatamodeld bundle + import', async () => {
    const dir = await repo({
      'Model.xcdatamodeld/contents': '<model/>\n',
      'Sources/App/Item+CD.swift': 'import CoreData\nclass Item: NSManagedObject {}\n',
    });
    expect(detectDataSignals(dir, new Set()).hasCoreData).toBe(true);
  });
  it('detects Fluent from the fluent dep', async () => {
    const dir = await repo({ 'Sources/App/Star.swift': 'import Fluent\nfinal class Star: Model {}\n' });
    expect(detectDataSignals(dir, new Set(['fluent'])).hasFluent).toBe(true);
  });
  it('returns null when no persistence framework is present', async () => {
    const dir = await repo({ 'Sources/App/Math.swift': 'import Foundation\nstruct Math {}\n' });
    expect(scoreData(detectDataSignals(dir, new Set()))).toBeNull();
  });
});

describe('isModelFile', () => {
  it('recognizes SwiftData @Model / CoreData NSManagedObject / Fluent : Model + import', () => {
    expect(isModelFile(parsed('import SwiftData\n@Model final class Item {}'))).toBe(true);
    expect(isModelFile(parsed('import CoreData\nclass Country: NSManagedObject {}'))).toBe(true);
    expect(isModelFile(parsed('import Fluent\nfinal class Planet: Model, Content {}'))).toBe(true);
  });
  it('does NOT treat a : Model conformance without a Fluent import as a model', () => {
    expect(isModelFile(parsed('protocol Model {}\nstruct View3D: Model {}'))).toBe(false);
  });
  it('does NOT treat a plain struct as a model', () => {
    expect(isModelFile(parsed('struct Money { let cents: Int }'))).toBe(false);
  });
});

describe('roleTags + syntheticEdges (SwiftData)', () => {
  const APP: Record<string, string> = {
    'Sources/App/Models/Author.swift':
      'import SwiftData\n@Model final class Author {\n  var name: String = ""\n  @Relationship(deleteRule: .cascade) var books: [Book] = []\n}\n',
    'Sources/App/Models/Book.swift':
      'import SwiftData\n@Model final class Book {\n  var title: String = ""\n  @Relationship var author: Author?\n}\n',
  };
  it('tags models service (never datastore) and emits association calls edges', async () => {
    const ctx = await contextFor(await repo(APP));
    const roles = await swiftDataAdapter.roleTags!(ctx);
    expect(roles.get('Sources/App/Models/Author.swift')?.role).toBe('model');
    // Every data role is `service` — NEVER the infra `datastore` kind.
    for (const t of roles.values()) expect(t.kind).toBe('service');

    const edges = await swiftDataAdapter.syntheticEdges!(ctx);
    const keys = new Set(edges.map((e) => `${e.source} -> ${e.target}`));
    expect(keys).toContain('Sources/App/Models/Author.swift -> Sources/App/Models/Book.swift');
    expect(keys).toContain('Sources/App/Models/Book.swift -> Sources/App/Models/Author.swift');
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
  });
  it('groups the models dir into a Data Model subsystem', async () => {
    const ctx = await contextFor(await repo(APP));
    const { groups } = await swiftDataAdapter.groupingPrior!(ctx);
    expect(new Set(groups.map((g) => g.label))).toContain('Data Model');
  });
  it('emits NO datastore node / stores-in edge (only calls edges)', async () => {
    const ctx = await contextFor(await repo(APP));
    const edges = await swiftDataAdapter.syntheticEdges!(ctx);
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
    // The adapter contributes roles/edges/groups only — no InfraNode surface exists.
  });
});

describe('Fluent associations (@Parent / @Children)', () => {
  it('emits calls edges from @Parent and @Children relationships', async () => {
    const ctx = await contextFor(
      await repo({
        'Sources/App/Models/Galaxy.swift':
          'import Fluent\nfinal class Galaxy: Model {\n  @Children(for: \\.$galaxy) var stars: [Star]\n}\n',
        'Sources/App/Models/Star.swift':
          'import Fluent\nfinal class Star: Model {\n  @Parent(key: "galaxy_id") var galaxy: Galaxy\n}\n',
      }),
    );
    const edges = await swiftDataAdapter.syntheticEdges!(ctx);
    const keys = new Set(edges.map((e) => `${e.source} -> ${e.target}`));
    expect(keys).toContain('Sources/App/Models/Galaxy.swift -> Sources/App/Models/Star.swift');
    expect(keys).toContain('Sources/App/Models/Star.swift -> Sources/App/Models/Galaxy.swift');
  });

  it('resolves the IDIOMATIC MULTI-LINE wrapper layout (@Parent on its own line above the var)', async () => {
    const ctx = await contextFor(
      await repo({
        'Sources/App/Models/Comment.swift':
          'import Fluent\nfinal class Comment: Model {\n  @Parent(key: "postID")\n  var post: Post\n}\n',
        'Sources/App/Models/Post.swift':
          'import Fluent\nfinal class Post: Model {\n  @Children(for: \\.$post)\n  var comments: [Comment]\n}\n',
      }),
    );
    const keys = new Set((await swiftDataAdapter.syntheticEdges!(ctx)).map((e) => `${e.source} -> ${e.target}`));
    expect(keys).toContain('Sources/App/Models/Comment.swift -> Sources/App/Models/Post.swift');
    expect(keys).toContain('Sources/App/Models/Post.swift -> Sources/App/Models/Comment.swift');
  });
});
