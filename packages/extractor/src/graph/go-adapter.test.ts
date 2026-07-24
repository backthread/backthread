// The Go import-graph extractor, over a small on-disk Go module fixture. Asserts the
// DIR-GRANULAR node model (a package directory = one node, files aggregated), first-party
// path→dir edges, stdlib drop, external module bucketing, `_test.go` exclusion, the
// module-root package id, and determinism across runs.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { GoExtractor, dirIdOf, importToDir } from './go-adapter.js';
import type { NormalizedGraph } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-go-ext-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

const GO_MOD = 'module github.com/acme/app\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.1\n';

// A Go module: a root `main` package + two internal packages, first-party imports, an
// external dep (gin), stdlib imports (dropped), a two-file package (aggregation), and a
// `_test.go` file that must be excluded.
const REPO: Record<string, string> = {
  'go.mod': GO_MOD,
  'main.go': [
    'package main',
    'import (',
    '\t"fmt"', // stdlib → dropped
    '\t"github.com/acme/app/internal/db"', // first-party → internal/db
    '\t"github.com/acme/app/internal/api"', // first-party → internal/api
    '\t"github.com/gin-gonic/gin"', // external → ext:github.com/gin-gonic/gin
    ')',
    'func main() { fmt.Println(db.Open(), api.New(), gin.Default()) }',
  ].join('\n'),
  'internal/db/db.go': 'package db\nimport "database/sql"\nfunc Open() *sql.DB { return nil }\n',
  'internal/db/conn.go': 'package db\nvar timeout = 30\n', // second file in the same package
  'internal/api/api.go':
    'package api\nimport "github.com/acme/app/internal/db"\nfunc New() any { return db.Open() }\n',
  'internal/api/api_test.go': 'package api\nimport "testing"\nfunc TestNew(t *testing.T) {}\n', // excluded
};

function internalEdges(g: NormalizedGraph): Set<string> {
  return new Set(g.edges.filter((e) => !e.external).map((e) => `${e.from} -> ${e.to}`));
}
function externalIds(g: NormalizedGraph): Set<string> {
  return new Set(g.externals.map((x) => x.id));
}

describe('dirIdOf / importToDir', () => {
  it('maps a file to its package dir; root files → "."', () => {
    expect(dirIdOf('internal/db/db.go')).toBe('internal/db');
    expect(dirIdOf('main.go')).toBe('.');
  });
  it('maps a first-party import path to a repo dir (with the module-dir offset)', () => {
    expect(importToDir('github.com/acme/app/internal/db', 'github.com/acme/app', '')).toBe('internal/db');
    expect(importToDir('github.com/acme/app', 'github.com/acme/app', '')).toBe('.'); // module root
    expect(importToDir('github.com/acme/app/db', 'github.com/acme/app', 'backend')).toBe('backend/db');
    expect(importToDir('github.com/other/x', 'github.com/acme/app', '')).toBe(null); // not first-party
  });
});

describe('GoExtractor', () => {
  it('builds dir-granular nodes with first-party dir→dir edges', async () => {
    const dir = await repo(REPO);
    const g = await new GoExtractor().extract(dir);
    // nodes are package DIRS (not files); api_test.go is excluded but internal/api survives
    expect(g.files.map((f) => f.id).sort()).toEqual(['.', 'internal/api', 'internal/db']);
    const edges = internalEdges(g);
    expect(edges.has('. -> internal/db')).toBe(true);
    expect(edges.has('. -> internal/api')).toBe(true);
    expect(edges.has('internal/api -> internal/db')).toBe(true);
  });

  it('aggregates a two-file package into one node (summed loc)', async () => {
    const dir = await repo(REPO);
    const g = await new GoExtractor().extract(dir);
    const db = g.files.find((f) => f.id === 'internal/db');
    expect(db).toBeDefined();
    // db.go (3 lines) + conn.go (2 lines) aggregated → loc > any single file
    expect(db!.loc).toBeGreaterThan(3);
  });

  it('buckets an external by declared module and drops stdlib', async () => {
    const dir = await repo(REPO);
    const g = await new GoExtractor().extract(dir);
    expect(externalIds(g)).toContain('ext:github.com/gin-gonic/gin');
    for (const x of externalIds(g)) {
      // stdlib (fmt, database/sql) and first-party refs never become externals
      expect(x.startsWith('ext:fmt')).toBe(false);
      expect(x.startsWith('ext:database')).toBe(false);
      expect(x.startsWith('ext:github.com/acme/app')).toBe(false);
    }
  });

  it('is deterministic across runs', async () => {
    const dir = await repo(REPO);
    const a = await new GoExtractor().extract(dir);
    const b = await new GoExtractor().extract(dir);
    expect(internalEdges(a)).toEqual(internalEdges(b));
    expect(externalIds(a)).toEqual(externalIds(b));
    expect(a.files.map((f) => f.id)).toEqual(b.files.map((f) => f.id));
  });

  it('returns an empty graph for a repo with no .go files', async () => {
    const dir = await repo({ 'go.mod': GO_MOD, 'README.md': '# hi' });
    const g = await new GoExtractor().extract(dir);
    expect(g.files).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});
