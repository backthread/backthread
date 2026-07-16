// unit tests for the deterministic noise filter (the gate): a fixture
// graph mixing legitimate source with test/generated/build/config/stories/mocks/
// types files → noise nodes excluded, drop logged by category, source retained,
// edges to dropped nodes removed cleanly, deterministic across runs.

import { describe, it, expect } from '../testkit.js';
import { classifyNoise, filterNoise, summarizeNoise, NOISE_CATEGORIES } from './noise-filter.js';
import type { NormalizedGraph } from './types.js';

describe('classifyNoise — path → category', () => {
  it('classifies each noise category', () => {
    const cases: [string, string][] = [
      ['src/auth/login.test.ts', 'test'],
      ['src/auth/login.spec.tsx', 'test'],
      ['src/__tests__/util.ts', 'test'],
      ['src/api/__generated__/schema.ts', 'generated'],
      ['src/api/types.gen.ts', 'generated'],
      ['src/api/graphql.generated.ts', 'generated'],
      ['src/ui/Button.stories.tsx', 'stories'],
      ['src/ui/Button.story.jsx', 'stories'],
      ['src/__mocks__/fs.ts', 'mocks'],
      ['test/__fixtures__/repo.ts', 'mocks'],
      ['src/db/seed.mock.ts', 'mocks'],
      ['src/db/user.fixture.ts', 'mocks'],
      ['vite.config.ts', 'config'],
      ['jest.config.js', 'config'],
      ['src/types/global.d.ts', 'types'],
      ['src/types/env.d.mts', 'types'],
      ['dist/index.js', 'build'],
      ['packages/web/build/main.js', 'build'],
      ['coverage/lcov.ts', 'build'],
    ];
    for (const [path, cat] of cases) {
      expect(classifyNoise(path)).toBe(cat);
    }
  });

  it('keeps legitimate source (returns null)', () => {
    for (const p of [
      'src/auth/login.ts',
      'src/api/client.ts',
      'src/ui/Button.tsx',
      'src/db/user.ts',
      'src/lib/config.ts', // a module literally named "config" is NOT *.config.*
      'src/generated.ts', // bare "generated" basename, no .gen./.generated. infix
      'src/testing/harness.ts', // a "testing" domain dir is not __tests__
      'index.ts',
    ]) {
      expect(classifyNoise(p)).toBeNull();
    }
  });

  it('does not mistake substrings for noise', () => {
    // "distance", "outbox", "buildings" share a prefix with build dirs but are
    // file basenames / non-dir segments, never matched as build OUTPUT dirs.
    expect(classifyNoise('src/distance.ts')).toBeNull();
    expect(classifyNoise('src/outbox/queue.ts')).toBeNull();
    expect(classifyNoise('src/buildings/model.ts')).toBeNull();
  });

  it('classifies Python noise', () => {
    const cases: [string, string][] = [
      ['tests/test_login.py', 'test'],
      ['app/test/helpers.py', 'test'],
      ['test_main.py', 'test'],
      ['app/auth_test.py', 'test'],
      ['app/conftest.py', 'test'],
      ['app/migrations/0001_initial.py', 'generated'],
      ['setup.py', 'config'],
      ['backend/setup.py', 'config'],
    ];
    for (const [path, cat] of cases) expect(classifyNoise(path)).toBe(cat);
  });

  it('keeps legitimate Python source', () => {
    for (const p of [
      'app/main.py',
      'app/services/auth.py',
      'app/__init__.py', // package marker, not noise
      'app/latest.py', // "test" substring but not a test_ / _test file
      'app/contest.py', // NOT conftest
    ]) {
      expect(classifyNoise(p)).toBeNull();
    }
  });

  it('classifies Swift noise (SwiftPM Tests/ + *Tests.swift / *Spec.swift)', () => {
    const cases: [string, string][] = [
      ['Tests/AppFeatureTests/HomeTests.swift', 'test'],
      ['Tests/AppFeatureTests/Support.swift', 'test'], // any file under Tests/
      ['MyAppUITests/LoginUITests.swift', 'test'], // Xcode dir, plural suffix
      ['Sources/App/AuthSpec.swift', 'test'], // Quick spec
    ];
    for (const [path, cat] of cases) expect(classifyNoise(path)).toBe(cat);
  });

  it('keeps legitimate Swift source (no over-match on Test/Spec substrings)', () => {
    for (const p of [
      'Sources/App/HomeView.swift',
      'Sources/App/Manifest.swift', // ends in "fest", not "Tests"
      'Sources/App/ABTest.swift', // singular Test → a feature, not a unit test
      'Sources/App/Latest.swift', // lowercase "test" substring
    ]) {
      expect(classifyNoise(p)).toBeNull();
    }
  });
});

// A fixture graph: 3 legitimate source files + one of each noise kind, with
// edges crossing the boundary and an external referenced ONLY by a test file.
function fixture(): NormalizedGraph {
  return {
    root: '/repo',
    files: [
      { id: 'src/auth/login.ts', loc: 50, language: 'ts' },
      { id: 'src/api/client.ts', loc: 40, language: 'ts' },
      { id: 'src/ui/Button.tsx', loc: 30, language: 'tsx' },
      { id: 'src/auth/login.test.ts', loc: 80, language: 'ts' }, // test
      { id: 'src/api/__generated__/schema.ts', loc: 200, language: 'ts' }, // generated
      { id: 'src/ui/Button.stories.tsx', loc: 60, language: 'tsx' }, // stories
      { id: 'vite.config.ts', loc: 20, language: 'ts' }, // config
      { id: 'src/types/env.d.ts', loc: 10, language: 'ts' }, // types
      { id: 'dist/bundle.js', loc: 999, language: 'js' }, // build
      { id: 'src/__mocks__/api.ts', loc: 25, language: 'ts' }, // mocks
    ],
    edges: [
      // legit → legit (kept)
      { from: 'src/ui/Button.tsx', to: 'src/api/client.ts', kind: 'import', external: false, weight: 1 },
      // legit → external (kept)
      { from: 'src/api/client.ts', to: 'ext:zod', kind: 'import', external: true, weight: 1 },
      // test → legit (dropped: from is noise)
      { from: 'src/auth/login.test.ts', to: 'src/auth/login.ts', kind: 'import', external: false, weight: 1 },
      // legit → generated (dropped: to is noise)
      { from: 'src/api/client.ts', to: 'src/api/__generated__/schema.ts', kind: 'import', external: false, weight: 1 },
      // test → external-only (dropped + external pruned)
      { from: 'src/auth/login.test.ts', to: 'ext:vitest', kind: 'import', external: true, weight: 1 },
    ],
    externals: [
      { id: 'ext:zod', specifier: 'zod' },
      { id: 'ext:vitest', specifier: '../testkit.js' },
    ],
  };
}

describe('filterNoise', () => {
  it('excludes noise nodes, keeps legitimate source', () => {
    const { graph } = filterNoise(fixture());
    expect(graph.files.map((f) => f.id).sort()).toEqual([
      'src/api/client.ts',
      'src/auth/login.ts',
      'src/ui/Button.tsx',
    ]);
  });

  it('logs the drop by category (never a silent cap)', () => {
    const { dropped } = filterNoise(fixture());
    expect(dropped.total).toBe(7);
    expect(dropped.byCategory).toEqual({
      test: 1,
      generated: 1,
      stories: 1,
      mocks: 1,
      config: 1,
      types: 1,
      build: 1,
    });
    // the queryable side list records path + category for every drop
    expect(dropped.files).toContainEqual({ path: 'vite.config.ts', category: 'config' });
    expect(dropped.files.length).toBe(7);
    expect(summarizeNoise(dropped)).toContain('noise filter dropped 7 file(s)');
    expect(summarizeNoise(dropped)).toContain('test: 1');
    expect(summarizeNoise(dropped)).toContain('+ 3 edge(s)');
  });

  it('removes edges to/from dropped nodes cleanly (no dangling endpoints)', () => {
    const { graph, dropped } = filterNoise(fixture());
    const keep = new Set(graph.files.map((f) => f.id));
    for (const e of graph.edges) {
      expect(keep.has(e.from)).toBe(true);
      if (!e.external) expect(keep.has(e.to)).toBe(true);
    }
    // 3 edges removed: test→legit, legit→generated, test→ext:vitest
    expect(dropped.edgesDropped).toBe(3);
    expect(graph.edges).toContainEqual({
      from: 'src/ui/Button.tsx',
      to: 'src/api/client.ts',
      kind: 'import',
      external: false,
      weight: 1,
    });
  });

  it('prunes externals referenced only by dropped files; keeps the rest', () => {
    const { graph } = filterNoise(fixture());
    expect(graph.externals).toEqual([{ id: 'ext:zod', specifier: 'zod' }]);
  });

  it('is a no-op (same object) when there is no noise', () => {
    const clean: NormalizedGraph = {
      root: '/repo',
      files: [
        { id: 'src/a.ts', loc: 10, language: 'ts' },
        { id: 'src/b.ts', loc: 10, language: 'ts' },
      ],
      edges: [{ from: 'src/a.ts', to: 'src/b.ts', kind: 'import', external: false, weight: 1 }],
      externals: [],
    };
    const { graph, dropped } = filterNoise(clean);
    expect(graph).toBe(clean); // referential stability
    expect(dropped.total).toBe(0);
    expect(dropped.edgesDropped).toBe(0);
    for (const c of NOISE_CATEGORIES) expect(dropped.byCategory[c]).toBe(0);
  });

  it('is deterministic — two runs produce identical output', () => {
    const a = filterNoise(fixture());
    const b = filterNoise(fixture());
    expect(JSON.stringify(a.graph)).toBe(JSON.stringify(b.graph));
    expect(JSON.stringify(a.dropped)).toBe(JSON.stringify(b.dropped));
  });

  it('is idempotent — filtering an already-filtered graph drops nothing', () => {
    const once = filterNoise(fixture()).graph;
    const twice = filterNoise(once);
    expect(twice.dropped.total).toBe(0);
    expect(twice.graph).toBe(once); // unchanged → same object
  });
});
