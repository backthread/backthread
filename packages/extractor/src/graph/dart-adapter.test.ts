// The Dart import-graph extractor, over small on-disk Flutter-shaped fixtures.
// Asserts path-arithmetic resolution (`package:<self>` + relative), external
// collapse, the `dart:` scheme drop, `export` as an import-kind edge, the `part`/
// `part of` merge (generated files folded into their parent library node, loc
// summed), melos cross-package resolution, isolation, and determinism.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DartExtractor, resolveDartUri, posixJoin } from './dart-adapter.js';
import type { NormalizedGraph } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-dart-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

function nodeIds(g: NormalizedGraph): Set<string> {
  return new Set(g.files.map((f) => f.id));
}
function internalEdges(g: NormalizedGraph): Set<string> {
  return new Set(g.edges.filter((e) => !e.external).map((e) => `${e.from} -> ${e.to}`));
}
function externalIds(g: NormalizedGraph): Set<string> {
  return new Set(g.externals.map((x) => x.id));
}

const FLUTTERish: Record<string, string> = {
  'pubspec.yaml':
    'name: my_app\ndescription: a demo\ndependencies:\n  flutter:\n    sdk: flutter\n  http: ^1.0.0\n',
  'lib/main.dart':
    "import 'package:flutter/material.dart';\nimport 'package:my_app/screens/home.dart';\nimport 'dart:async';\nvoid main() {}\n",
  'lib/screens/home.dart':
    "import '../models/user.dart';\nimport 'package:http/http.dart';\npart 'home.g.dart';\nclass Home {}\n",
  // A generated part file (json_serializable-style) — folded into home.dart.
  'lib/screens/home.g.dart': "part of 'home.dart';\n// generated\nfinal x = 1;\nfinal y = 2;\n",
  // A freezed model that declares its own generated part.
  'lib/models/user.dart': "part 'user.freezed.dart';\nclass User {}\n",
  'lib/models/user.freezed.dart': "part of 'user.dart';\n// generated freezed\nabstract class _User {}\n",
  // A barrel that re-exports a model.
  'lib/api.dart': "export 'models/user.dart';\n",
};

describe('DartExtractor', () => {
  it('resolves package:<self> + relative imports, drops dart:, collapses externals', async () => {
    const g = await new DartExtractor().extract(await repo(FLUTTERish));
    const edges = internalEdges(g);
    // package:my_app/screens/home.dart → lib/screens/home.dart
    expect(edges.has('lib/main.dart -> lib/screens/home.dart')).toBe(true);
    // relative ../models/user.dart from lib/screens → lib/models/user.dart
    expect(edges.has('lib/screens/home.dart -> lib/models/user.dart')).toBe(true);
    // dart:async is substrate — no external, no edge.
    expect(externalIds(g).has('ext:dart')).toBe(false);
    // flutter + http are real deps → external nodes.
    expect(externalIds(g)).toEqual(new Set(['ext:flutter', 'ext:http']));
  });

  it('folds part / part-of files into their parent library node and sums loc', async () => {
    const g = await new DartExtractor().extract(await repo(FLUTTERish));
    const nodes = nodeIds(g);
    // The generated parts are NOT their own nodes.
    expect(nodes.has('lib/screens/home.g.dart')).toBe(false);
    expect(nodes.has('lib/models/user.freezed.dart')).toBe(false);
    // Their parents ARE.
    expect(nodes.has('lib/screens/home.dart')).toBe(true);
    expect(nodes.has('lib/models/user.dart')).toBe(true);
    // user.dart loc is SUMMED across the parent + its folded freezed part
    // (locOf counts split('\n').length like every adapter: 3 + 4 = 7).
    const user = g.files.find((f) => f.id === 'lib/models/user.dart')!;
    expect(user.loc).toBe(7);
  });

  it('treats `export` as an import-kind edge', async () => {
    const g = await new DartExtractor().extract(await repo(FLUTTERish));
    expect(internalEdges(g).has('lib/api.dart -> lib/models/user.dart')).toBe(true);
    // export edges are import-kind in the normalized graph.
    const e = g.edges.find((x) => x.from === 'lib/api.dart' && x.to === 'lib/models/user.dart');
    expect(e?.kind).toBe('import');
  });

  it('drops an unresolvable first-party package: ref rather than mislabeling it external', async () => {
    const g = await new DartExtractor().extract(
      await repo({
        'pubspec.yaml': 'name: my_app\n',
        'lib/main.dart': "import 'package:my_app/does_not_exist.dart';\n",
      }),
    );
    expect(externalIds(g).has('ext:my_app')).toBe(false);
    expect(internalEdges(g).size).toBe(0);
  });

  it('resolves cross-package package: imports in a melos monorepo', async () => {
    const g = await new DartExtractor().extract(
      await repo({
        'melos.yaml': 'name: mono\npackages:\n  - packages/**\n',
        'packages/core/pubspec.yaml': 'name: core\n',
        'packages/core/lib/core.dart': 'class Core {}\n',
        'packages/app/pubspec.yaml': 'name: app\ndependencies:\n  core:\n    path: ../core\n',
        'packages/app/lib/main.dart': "import 'package:core/core.dart';\nvoid main() {}\n",
      }),
    );
    expect(internalEdges(g).has('packages/app/lib/main.dart -> packages/core/lib/core.dart')).toBe(
      true,
    );
    // `core` is an internal package → NOT an external node.
    expect(externalIds(g).has('ext:core')).toBe(false);
  });

  it('is deterministic across runs', async () => {
    const dir = await repo(FLUTTERish);
    const a = await new DartExtractor().extract(dir);
    const b = await new DartExtractor().extract(dir);
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
  });

  it('emits an empty graph for a repo with no Dart files', async () => {
    const g = await new DartExtractor().extract(await repo({ 'pubspec.yaml': 'name: empty\n' }));
    expect(g.files).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});

describe('resolveDartUri (pure)', () => {
  const roots = new Map([['my_app', '']]);
  it('drops the dart: scheme', () => {
    expect(resolveDartUri('lib/a.dart', 'dart:async', roots)).toEqual({ kind: 'drop' });
  });
  it('resolves an internal package: to a lib path', () => {
    expect(resolveDartUri('lib/a.dart', 'package:my_app/x/y.dart', roots)).toEqual({
      kind: 'internal',
      target: 'lib/x/y.dart',
    });
  });
  it('collapses an external package: to its package node', () => {
    expect(resolveDartUri('lib/a.dart', 'package:http/http.dart', roots)).toEqual({
      kind: 'external',
      id: 'ext:http',
      specifier: 'http',
    });
  });
  it('resolves a relative uri against the importing file dir', () => {
    expect(resolveDartUri('lib/screens/home.dart', '../models/user.dart', roots)).toEqual({
      kind: 'internal',
      target: 'lib/models/user.dart',
    });
  });
});

describe('posixJoin (pure)', () => {
  it('normalizes . and ..', () => {
    expect(posixJoin('lib/screens', '../models/user.dart')).toBe('lib/models/user.dart');
    expect(posixJoin('lib', './helpers.dart')).toBe('lib/helpers.dart');
  });
  it('returns null when a path escapes the repo root', () => {
    expect(posixJoin('', '../escape.dart')).toBeNull();
  });
});
