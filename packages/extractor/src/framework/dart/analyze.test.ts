// The shared Dart scope layer: the class-name → file-id registry (buildDartBindings)
// the FL2/FL3/FL4 syntheticEdges hooks resolve type references through, and the
// one-pass parseDartScope.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildDartBindings, parseDartScope, inScope } from './analyze.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('buildDartBindings', () => {
  it('maps every declared class/mixin/enum to its file (first sorted-id wins)', () => {
    const texts = new Map([
      ['lib/counter.dart', 'class Counter {}\nclass CounterState {}\n'],
      ['lib/home.dart', 'class Home extends StatelessWidget {}\n'],
      ['lib/z_dup.dart', 'class Counter {}\n'], // duplicate — loses to counter.dart (sorted first)
    ]);
    const idx = buildDartBindings(texts);
    expect(idx.get('Counter')).toBe('lib/counter.dart');
    expect(idx.get('CounterState')).toBe('lib/counter.dart');
    expect(idx.get('Home')).toBe('lib/home.dart');
  });
});

describe('inScope', () => {
  it('scopes to a workspace root path', () => {
    expect(inScope('mobile/lib/x.dart', '')).toBe(true);
    expect(inScope('mobile/lib/x.dart', 'mobile')).toBe(true);
    expect(inScope('server/x.dart', 'mobile')).toBe(false);
  });
});

describe('parseDartScope', () => {
  it('pre-scans each in-scope Dart file once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bt-dart-scope-'));
    dirs.push(dir);
    const files = {
      'lib/main.dart': "import 'package:flutter/material.dart';\n@override\nvoid main() {}\n",
      'lib/home.dart': 'class Home extends StatelessWidget {}\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
    const graph: NormalizedGraph = {
      root: dir,
      files: [
        { id: 'lib/main.dart', loc: 3, language: 'dart' },
        { id: 'lib/home.dart', loc: 1, language: 'dart' },
      ],
      edges: [],
      externals: [],
    };
    const ctx: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'dart', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set() },
    };
    const scope = parseDartScope(ctx);
    expect(scope.dartFiles.sort()).toEqual(['lib/home.dart', 'lib/main.dart']);
    expect(scope.resolve('Home')).toBe('lib/home.dart');
    expect(scope.parsed.get('lib/main.dart')?.functions).toContain('main');
    expect(scope.parsed.get('lib/main.dart')?.directives.imports).toEqual([
      'package:flutter/material.dart',
    ]);
  });
});
