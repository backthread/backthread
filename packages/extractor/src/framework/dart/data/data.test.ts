// The local-data adapter over a small on-disk app using Drift, Isar, and Floor
// together (+ a Freezed DTO and a sqflite dep that must NOT be tagged). Asserts
// entities are `service`, the Drift FK spine (`calls`), data-subsystem grouping, and
// that NO datastore node / `stores-in` edge is produced.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { extractGraph } from '../../../graph/extract.js';
import { dataAdapter, scoreData } from './data.js';
import type { FrameworkContext } from '../../types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-dart-data-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

async function ctxFor(dir: string): Promise<FrameworkContext> {
  const graph = await extractGraph(dir);
  return {
    repoDir: dir,
    rootPath: '',
    match: { adapter: 'flutter-data', confidence: 0.8, rootPath: '' },
    graph,
    cluster: { fileModuleMap: {}, moduleIds: new Set() },
  };
}

const APP: Record<string, string> = {
  'pubspec.yaml':
    'name: app\ndependencies:\n  drift: ^2.0.0\n  isar: ^3.0.0\n  floor: ^1.0.0\n  freezed_annotation: ^2.0.0\n  sqflite: ^2.0.0\n',
  // Drift: two tables (Posts → Users FK) + the database aggregate.
  'lib/db/users_table.dart':
    "import 'package:drift/drift.dart';\nclass Users extends Table {\n  IntColumn get id => integer()();\n}\n",
  'lib/db/posts_table.dart':
    "import 'package:drift/drift.dart';\nimport 'users_table.dart';\nclass Posts extends Table {\n  IntColumn get author => integer().references(Users, #id)();\n}\n",
  'lib/db/app_database.dart':
    "import 'package:drift/drift.dart';\n@DriftDatabase(tables: [Users, Posts])\nclass AppDatabase extends _\$AppDatabase {}\n",
  // Isar collection.
  'lib/isar/todo.dart': "import 'package:isar/isar.dart';\n@collection\nclass Todo {\n  Id id = Isar.autoIncrement;\n}\n",
  // Floor entity + database.
  'lib/floor/person.dart':
    "import 'package:floor/floor.dart';\n@Entity(tableName: 'person')\nclass Person {\n  @primaryKey\n  final int id = 0;\n}\n",
  'lib/floor/floor_db.dart':
    "import 'package:floor/floor.dart';\n@Database(version: 1, entities: [Person])\nabstract class FloorDb extends FloorDatabase {}\n",
  // A Freezed DTO — model-file NOISE, must NOT be tagged as data.
  'lib/models/weather.dart':
    "import 'package:freezed_annotation/freezed_annotation.dart';\n@freezed\nclass Weather with _\$Weather {\n  const factory Weather(String city) = _Weather;\n}\n",
};

describe('dataAdapter', () => {
  it('detects the local-DB libs', async () => {
    const m = await dataAdapter.detect({ repoDir: await makeRepo(APP) });
    expect(m?.adapter).toBe('flutter-data');
  });

  it('tags Drift/Isar/Floor entities `service` (and skips Freezed + sqflite)', async () => {
    const roles = await dataAdapter.roleTags!(await ctxFor(await makeRepo(APP)));
    expect(roles.get('lib/db/users_table.dart')).toMatchObject({ role: 'table', kind: 'service' });
    expect(roles.get('lib/db/posts_table.dart')).toMatchObject({ role: 'table', kind: 'service' });
    expect(roles.get('lib/db/app_database.dart')).toMatchObject({ role: 'database', kind: 'service' });
    expect(roles.get('lib/isar/todo.dart')).toMatchObject({ role: 'collection', kind: 'service' });
    expect(roles.get('lib/floor/person.dart')).toMatchObject({ role: 'entity', kind: 'service' });
    expect(roles.get('lib/floor/floor_db.dart')).toMatchObject({ role: 'database', kind: 'service' });
    // Freezed DTO is NOT data.
    expect(roles.has('lib/models/weather.dart')).toBe(false);
  });

  it('emits a Drift FK `calls` edge and NO stores-in / datastore', async () => {
    const edges = await dataAdapter.syntheticEdges!(await ctxFor(await makeRepo(APP)));
    const keys = new Set(edges.map((e) => `${e.source} -> ${e.target}`));
    expect(keys.has('lib/db/posts_table.dart -> lib/db/users_table.dart')).toBe(true);
    // NO datastore node / stores-in — associations are the neutral 'calls' verb.
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
  });

  it('groups a directory of ≥2 entities into a data subsystem', async () => {
    const { groups } = await dataAdapter.groupingPrior!(await ctxFor(await makeRepo(APP)));
    const g = groups.find((x) => x.fileIds.includes('lib/db/users_table.dart'));
    expect(g).toBeDefined();
    expect(g!.label).toBe('Data Model'); // a `db/` dir is models-ish
    expect(g!.fileIds).toEqual(['lib/db/posts_table.dart', 'lib/db/users_table.dart']);
    // the database aggregate is not grouped as a persisted entity
    expect(g!.fileIds).not.toContain('lib/db/app_database.dart');
  });

  it('is deterministic across runs', async () => {
    const ctx = await ctxFor(await makeRepo(APP));
    const a = await dataAdapter.syntheticEdges!(ctx);
    const b = await dataAdapter.syntheticEdges!(ctx);
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
  });
});

describe('scoreData (pure)', () => {
  it('matches any of drift/isar/floor, null on none', () => {
    expect(scoreData({ hasDrift: false, hasIsar: false, hasFloor: false })).toBeNull();
    expect(scoreData({ hasDrift: true, hasIsar: false, hasFloor: false })?.adapter).toBe('flutter-data');
  });
});
