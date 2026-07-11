// Stage A — unit tests for the pure file-graph model: path policy,
// diff classification, the dependents closure, and (de)serialization.

import { describe, it, expect } from '../testkit.js';
import {
  isSourceFilePath,
  isConfigInvalidatorPath,
  classifyDiff,
  reexportClosure,
  computeCallPatchUnit,
  graphFromState,
  serializeFileGraph,
  deserializeFileGraph,
  diffFileGraphStates,
  isValidFileRecord,
  FILE_GRAPH_VERSION,
  EXTRACTOR_VERSION,
  type FileGraphState,
  type FileRecord,
} from './file-graph.js';

function rec(over: Partial<FileRecord> = {}): FileRecord {
  return { loc: 10, language: 'ts', imports: [], externals: [], calls: [], reexports: [], ...over };
}

describe('isSourceFilePath — mirrors the adapter glob', () => {
  it('accepts the extractor extensions', () => {
    for (const p of ['src/a.ts', 'b.tsx', 'c.js', 'd.jsx', 'e.mts', 'f.cts', 'g.mjs', 'h.cjs']) {
      expect(isSourceFilePath(p)).toBe(true);
    }
  });

  it('rejects non-source files', () => {
    for (const p of ['README.md', 'src/a.css', 'a.d.ts.map', 'wrangler.toml', 'x.tsv']) {
      expect(isSourceFilePath(p)).toBe(false);
    }
  });

  it('rejects excluded dirs (anywhere in the path)', () => {
    for (const p of ['node_modules/x/a.ts', 'pkg/node_modules/a.ts', 'dist/a.ts', 'deep/build/a.js']) {
      expect(isSourceFilePath(p)).toBe(false);
    }
  });

  it('rejects DOTTED segments — ts-morph globbing skips dot-dirs AND dot-files', () => {
    // Verified empirically: `.storybook/s.ts` and `src/.hidden.ts` are NOT
    // added by addSourceFilesAtPaths, so the diff classifier must skip them
    // too or patched vs full extracts would diverge.
    for (const p of ['.storybook/s.ts', 'src/.hidden.ts', 'a/.cache/b.ts']) {
      expect(isSourceFilePath(p)).toBe(false);
    }
  });

  it('python: accepts .py/.pyi, rejects .ts, and skips Python excludes', () => {
    for (const p of ['app/main.py', 'app/__init__.py', 'pkg/types.pyi']) {
      expect(isSourceFilePath(p, 'python')).toBe(true);
    }
    // a .ts file is not Python source; a .py file is not TS source
    expect(isSourceFilePath('src/index.ts', 'python')).toBe(false);
    expect(isSourceFilePath('app/main.py', 'ts')).toBe(false);
    // Python exclude dirs + dot-dirs are skipped
    for (const p of ['.venv/lib/dep.py', '__pycache__/x.py', '.tox/e/a.py', 'site-packages/z.py']) {
      expect(isSourceFilePath(p, 'python')).toBe(false);
    }
    // __init__.py is a `_`-prefixed name, NOT a dotted segment — must be kept
    expect(isSourceFilePath('pkg/__init__.py', 'python')).toBe(true);
  });
});

describe('isConfigInvalidatorPath — the full-extract valve (narrowed, )', () => {
  it('matches resolution-affecting configs at any depth', () => {
    for (const p of [
      'tsconfig.json',
      'tsconfig.base.json',
      'jsconfig.json',
      'package.json',
      'packages/web/package.json',
    ]) {
      expect(isConfigInvalidatorPath(p)).toBe(true);
    }
  });

  it('lockfiles + deno/workspace config are NOT invalidators ( 3a)', () => {
    // The install-free extractor never resolves into node_modules and ignores
    // deno config — what a lockfile pins is invisible to its output, so a
    // lockfile-touching merge must NOT pay a full extract anymore.
    for (const p of [
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'bun.lockb',
      'bun.lock',
      'deno.json',
      'deno.jsonc',
      'deno.lock',
      'packages/web/package-lock.json',
    ]) {
      expect(isConfigInvalidatorPath(p)).toBe(false);
    }
  });

  it('does not match source or unrelated config', () => {
    for (const p of ['src/tsconfig-reader.ts', 'wrangler.toml', 'package.json5', 'docs/package.md']) {
      expect(isConfigInvalidatorPath(p)).toBe(false);
    }
  });

  it('python: pyproject/setup.cfg/setup.py invalidate; requirements/Pipfile do NOT', () => {
    // These steer Pyright's first-party resolution (package-dir / src-layout /
    // namespace settings), so a diff touching them forces a full re-extract.
    for (const p of ['pyproject.toml', 'setup.cfg', 'setup.py', 'backend/pyproject.toml']) {
      expect(isConfigInvalidatorPath(p)).toBe(true);
    }
    // requirements*/Pipfile only pin third-party deps we never install — invisible
    // to the extractor, so (like TS lockfiles) they must NOT be invalidators.
    for (const p of ['requirements.txt', 'requirements-dev.txt', 'Pipfile', 'Pipfile.lock', 'poetry.lock']) {
      expect(isConfigInvalidatorPath(p)).toBe(false);
    }
  });
});

describe('EXTRACTOR_VERSION — the blob-cache key component ( Stage B)', () => {
  it('is a positive integer past the reserved Stage-A version 1', () => {
    expect(Number.isInteger(EXTRACTOR_VERSION)).toBe(true);
    expect(EXTRACTOR_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe('classifyDiff', () => {
  it('routes statuses + flags shape changes', () => {
    const cls = classifyDiff([
      { status: 'A', path: 'src/new.ts' },
      { status: 'M', path: 'src/mod.ts' },
      { status: 'D', path: 'src/old.ts' },
      { status: 'M', path: 'README.md' }, // non-source → ignored
    ]);
    expect(cls.sourceAdded).toEqual(['src/new.ts']);
    expect(cls.sourceModified).toEqual(['src/mod.ts']);
    expect(cls.sourceDeleted).toEqual(['src/old.ts']);
    expect(cls.invalidators).toEqual([]);
    expect(cls.shapeChanged).toBe(true);
  });

  it('content-only diffs do NOT flag a shape change (the cheap refresh path)', () => {
    const cls = classifyDiff([
      { status: 'M', path: 'src/a.ts' },
      { status: 'M', path: 'src/b.ts' },
    ]);
    expect(cls.shapeChanged).toBe(false);
  });

  it('collects invalidators even when they are not source files', () => {
    const cls = classifyDiff([
      { status: 'M', path: 'tsconfig.json' },
      { status: 'M', path: 'src/a.ts' },
    ]);
    expect(cls.invalidators).toEqual(['tsconfig.json']);
  });

  it('an exotic status (T) forces the rebuild path', () => {
    const cls = classifyDiff([{ status: 'T', path: 'src/a.ts' }]);
    expect(cls.shapeChanged).toBe(true);
  });

  it('an empty / docs-only diff classifies to nothing (zero parses downstream)', () => {
    const cls = classifyDiff([{ status: 'M', path: 'docs/notes.md' }]);
    expect(cls.sourceAdded).toEqual([]);
    expect(cls.sourceModified).toEqual([]);
    expect(cls.sourceDeleted).toEqual([]);
    expect(cls.shapeChanged).toBe(false);
    expect(cls.invalidators).toEqual([]);
  });
});

describe('reexportClosure', () => {
  it('expands through re-export chains to fixpoint', () => {
    // impl ← barrel ← superbarrel; changing impl must reach superbarrel.
    const reexports = new Map<string, readonly string[]>([
      ['barrel.ts', ['impl.ts']],
      ['superbarrel.ts', ['barrel.ts']],
      ['other.ts', []],
    ]);
    const closure = reexportClosure(new Set(['impl.ts']), reexports);
    expect(closure).toEqual(new Set(['impl.ts', 'barrel.ts', 'superbarrel.ts']));
  });

  it('no re-exporters → the closure is just the seeds', () => {
    const closure = reexportClosure(new Set(['a.ts']), new Map([['b.ts', []]]));
    expect(closure).toEqual(new Set(['a.ts']));
  });
});

describe('computeCallPatchUnit — the STEP-1 dependents rule', () => {
  const imports = (...tos: string[]) => tos.map((to) => ({ to, weight: 1 }));

  it('includes changed files + direct importers of a changed file (via re-export closure seeds)', () => {
    const unit = computeCallPatchUnit({
      added: [],
      modified: ['lib.ts'],
      deleted: [],
      freshImports: new Map([
        ['lib.ts', []],
        ['user.ts', imports('lib.ts')],
        ['unrelated.ts', imports('other.ts')],
        ['other.ts', []],
      ]),
      prevImports: new Map([
        ['lib.ts', []],
        ['user.ts', imports('lib.ts')],
        ['unrelated.ts', imports('other.ts')],
        ['other.ts', []],
      ]),
      reexports: new Map(),
    });
    expect(unit).toEqual(new Set(['lib.ts', 'user.ts']));
  });

  it('reaches importers of a BARREL that re-exports a changed file', () => {
    const unit = computeCallPatchUnit({
      added: [],
      modified: ['impl.ts'],
      deleted: [],
      freshImports: new Map([
        ['impl.ts', []],
        ['barrel.ts', imports('impl.ts')],
        ['user.ts', imports('barrel.ts')],
      ]),
      prevImports: new Map([
        ['impl.ts', []],
        ['barrel.ts', imports('impl.ts')],
        ['user.ts', imports('barrel.ts')],
      ]),
      reexports: new Map([['barrel.ts', ['impl.ts']]]),
    });
    // user.ts imports barrel.ts which is IN the closure of impl.ts.
    expect(unit).toEqual(new Set(['impl.ts', 'barrel.ts', 'user.ts']));
  });

  it('includes files whose import RESOLUTION moved (an added file shadows / a deleted target drops)', () => {
    const unit = computeCallPatchUnit({
      added: ['util.ts'],
      modified: [],
      deleted: [],
      freshImports: new Map([
        ['util.ts', []],
        // previously `./util` didn't resolve; now it does → targets changed.
        ['consumer.ts', imports('util.ts')],
        ['steady.ts', imports('other.ts')],
        ['other.ts', []],
      ]),
      prevImports: new Map([
        ['consumer.ts', []],
        ['steady.ts', imports('other.ts')],
        ['other.ts', []],
      ]),
      reexports: new Map(),
    });
    expect(unit.has('util.ts')).toBe(true);
    expect(unit.has('consumer.ts')).toBe(true); // resolution moved
    expect(unit.has('steady.ts')).toBe(false); // untouched, unchanged bindings
  });

  it('importers of a DELETED file re-extract (their call edges to it must drop)', () => {
    const unit = computeCallPatchUnit({
      added: [],
      modified: [],
      deleted: ['gone.ts'],
      freshImports: new Map([
        ['user.ts', []], // its `./gone` import no longer resolves
        ['other.ts', []],
      ]),
      prevImports: new Map([
        ['user.ts', imports('gone.ts')],
        ['other.ts', []],
      ]),
      reexports: new Map(),
    });
    expect(unit).toEqual(new Set(['user.ts']));
  });

  it('an empty diff yields an empty unit (docs-only merge: zero symbol work)', () => {
    const unit = computeCallPatchUnit({
      added: [],
      modified: [],
      deleted: [],
      freshImports: new Map([['a.ts', imports('b.ts')], ['b.ts', []]]),
      prevImports: new Map([['a.ts', imports('b.ts')], ['b.ts', []]]),
      reexports: new Map(),
    });
    expect(unit.size).toBe(0);
  });
});

describe('graphFromState', () => {
  it('assembles files (sorted), edges, and deduped externals', () => {
    const state: FileGraphState = {
      headSha: 'h',
      files: {
        'src/b.ts': rec({ imports: [{ to: 'src/a.ts', weight: 2 }], calls: [{ to: 'src/a.ts', weight: 1 }] }),
        'src/a.ts': rec({ externals: [{ id: 'ext:zod', specifier: 'zod', weight: 1 }] }),
      },
    };
    const g = graphFromState('/repo', state);
    expect(g.files.map((f) => f.id)).toEqual(['src/a.ts', 'src/b.ts']); // sorted
    expect(g.externals).toEqual([{ id: 'ext:zod', specifier: 'zod' }]);
    expect(g.edges).toContainEqual({ from: 'src/b.ts', to: 'src/a.ts', kind: 'import', external: false, weight: 2 });
    expect(g.edges).toContainEqual({ from: 'src/b.ts', to: 'src/a.ts', kind: 'call', external: false, weight: 1 });
    expect(g.edges).toContainEqual({ from: 'src/a.ts', to: 'ext:zod', kind: 'import', external: true, weight: 1 });
  });
});

describe('serialize / deserialize round-trip', () => {
  it('round-trips a state (with blob shas) and validates the shape', () => {
    const state: FileGraphState = {
      headSha: 'a'.repeat(40),
      files: { 'src/a.ts': rec({ imports: [{ to: 'src/b.ts', weight: 1 }] }), 'src/b.ts': rec() },
    };
    const ser = serializeFileGraph(state, new Map([['src/a.ts', 'blob1']]));
    expect(ser.version).toBe(FILE_GRAPH_VERSION);
    expect(ser.files['src/a.ts'].blobSha).toBe('blob1');
    const back = deserializeFileGraph(JSON.parse(JSON.stringify(ser)));
    expect(back).not.toBeNull();
    expect(back!.headSha).toBe(state.headSha);
    expect(back!.files['src/a.ts'].imports).toEqual([{ to: 'src/b.ts', weight: 1 }]);
  });

  it('rejects wrong versions / malformed payloads (→ full-extract fallback)', () => {
    expect(deserializeFileGraph(null)).toBeNull();
    expect(deserializeFileGraph({})).toBeNull();
    expect(deserializeFileGraph({ version: 999, headSha: 'a'.repeat(40), files: {} })).toBeNull();
    expect(deserializeFileGraph({ version: FILE_GRAPH_VERSION, headSha: 'a'.repeat(40), files: [] })).toBeNull();
    expect(
      deserializeFileGraph({
        version: FILE_GRAPH_VERSION,
        headSha: 'a'.repeat(40),
        files: { 'a.ts': { loc: 'NaN' } },
      }),
    ).toBeNull();
  });

  it('TOLERATES the Stage-B bootsSinceReconcile counter (older readers ignore it)', () => {
    const back = deserializeFileGraph({
      version: FILE_GRAPH_VERSION,
      headSha: 'a'.repeat(40),
      files: { 'src/a.ts': rec() },
      bootsSinceReconcile: 7,
    });
    expect(back).not.toBeNull();
    expect(back!.files['src/a.ts'].loc).toBe(10);
  });
});

describe('isValidFileRecord — the per-row blob-cache shape guard ( Stage B)', () => {
  it('accepts a well-formed record', () => {
    expect(isValidFileRecord(rec({ imports: [{ to: 'src/b.ts', weight: 1 }] }))).toBe(true);
  });

  it('rejects malformed records (each treated as a cache MISS, never an error)', () => {
    expect(isValidFileRecord(null)).toBe(false);
    expect(isValidFileRecord('nope')).toBe(false);
    expect(isValidFileRecord({ loc: 'NaN', language: 'ts' })).toBe(false);
    expect(isValidFileRecord(rec({ imports: [{ to: 1, weight: 1 }] as never }))).toBe(false);
    expect(isValidFileRecord({ ...rec(), reexports: [42] })).toBe(false);
    expect(isValidFileRecord({ ...rec(), externals: [{ id: 'ext:zod' }] })).toBe(false);
  });
});

describe('diffFileGraphStates — the reconciliation comparator ( Stage B)', () => {
  const state = (files: Record<string, FileRecord>): FileGraphState => ({ headSha: 'h', files });

  it('identical states diff to nothing', () => {
    const a = state({ 'src/a.ts': rec({ calls: [{ to: 'src/b.ts', weight: 2 }] }), 'src/b.ts': rec() });
    const b = state({ 'src/a.ts': rec({ calls: [{ to: 'src/b.ts', weight: 2 }] }), 'src/b.ts': rec() });
    expect(diffFileGraphStates(a, b)).toEqual([]);
  });

  it('array ORDER is not drift (extraction order is not semantics)', () => {
    const a = state({
      'src/a.ts': rec({
        imports: [
          { to: 'src/b.ts', weight: 1 },
          { to: 'src/c.ts', weight: 3 },
        ],
        reexports: ['src/b.ts', 'src/c.ts'],
      }),
    });
    const b = state({
      'src/a.ts': rec({
        imports: [
          { to: 'src/c.ts', weight: 3 },
          { to: 'src/b.ts', weight: 1 },
        ],
        reexports: ['src/c.ts', 'src/b.ts'],
      }),
    });
    expect(diffFileGraphStates(a, b)).toEqual([]);
  });

  it('blobSha differences are NOT drift (serialization tag, not extractor output)', () => {
    const a = state({ 'src/a.ts': { ...rec(), blobSha: 'blob1' } });
    const b = state({ 'src/a.ts': { ...rec(), blobSha: 'blob2' } });
    expect(diffFileGraphStates(a, b)).toEqual([]);
  });

  it('reports changed records, missing paths, and extra paths', () => {
    const a = state({
      'src/a.ts': rec({ calls: [{ to: 'src/b.ts', weight: 1 }] }),
      'src/gone.ts': rec(),
      'src/same.ts': rec(),
    });
    const b = state({
      'src/a.ts': rec({ calls: [{ to: 'src/b.ts', weight: 9 }] }), // weight drifted
      'src/new.ts': rec(),
      'src/same.ts': rec(),
    });
    expect(diffFileGraphStates(a, b)).toEqual(['src/a.ts', 'src/gone.ts', 'src/new.ts']);
  });
});
