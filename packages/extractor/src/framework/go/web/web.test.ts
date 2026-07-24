// The Go web FrameworkAdapter — gateway role tagging for handler/router packages, route
// edges to cross-package handlers, detection (framework dep + net/http source).

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { goWebAdapter, gatherGoWebSignal, scoreGoWeb } from './web.js';
import type { FrameworkContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-goweb-'));
  dirs.push(dir);
  for (const [rel, c] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, c);
  }
  return dir;
}
/** A dir-granular FrameworkContext: graph nodes are package DIRECTORIES. */
function ctx(repoDir: string, dirNodes: string[]): FrameworkContext {
  const graph: NormalizedGraph = {
    root: repoDir,
    files: dirNodes.map((id) => ({ id, loc: 10, language: 'go' })),
    edges: [],
    externals: [],
  };
  return { repoDir, rootPath: '', match: { adapter: 'go-web', confidence: 1, rootPath: '' }, graph, cluster: { fileModuleMap: {}, moduleIds: new Set() } };
}

const GO_MOD = 'module github.com/acme/app\n\nrequire github.com/gin-gonic/gin v1.9.1\n';
const REPO: Record<string, string> = {
  'go.mod': GO_MOD,
  'internal/handlers/users.go':
    'package handlers\nimport "github.com/gin-gonic/gin"\nfunc ListUsers(c *gin.Context) {}\nfunc GetUser(c *gin.Context) {}\n',
  'internal/router/router.go':
    'package router\nimport (\n\t"github.com/gin-gonic/gin"\n\t"github.com/acme/app/internal/handlers"\n)\nfunc Setup(r *gin.Engine) {\n\tr.GET("/users", handlers.ListUsers)\n\tr.POST("/users", handlers.GetUser)\n}\n',
  'internal/db/db.go': 'package db\nimport "database/sql"\nfunc Open() *sql.DB { return nil }\n', // not web
};

describe('detection', () => {
  it('detects via a web-framework go.mod dep', async () => {
    const dir = await repo({ 'go.mod': GO_MOD });
    expect(gatherGoWebSignal(dir)).toBe(true);
    expect(scoreGoWeb(true)?.adapter).toBe('go-web');
  });
  it('detects via a net/http server pattern in source', async () => {
    const dir = await repo({
      'go.mod': 'module x\n',
      'main.go': 'package main\nimport "net/http"\nfunc main() { http.ListenAndServe(":8080", nil) }\n',
    });
    expect(gatherGoWebSignal(dir)).toBe(true);
  });
  it('does not detect a Go repo with no web signal', async () => {
    const dir = await repo({ 'go.mod': 'module x\n', 'main.go': 'package main\nfunc main() {}\n' });
    expect(gatherGoWebSignal(dir)).toBe(false);
    expect(scoreGoWeb(false)).toBeNull();
  });
});

describe('roleTags + route edges (dir-granular)', () => {
  it('tags handler/router packages gateway; edges router→handlers package', async () => {
    const dir = await repo(REPO);
    const c = ctx(dir, ['internal/handlers', 'internal/router', 'internal/db']);
    const roles = await goWebAdapter.roleTags!(c);
    expect(roles.get('internal/handlers')?.kind).toBe('gateway'); // gin.Context handlers
    expect(roles.get('internal/router')?.kind).toBe('gateway'); // r.GET route registration
    expect(roles.has('internal/db')).toBe(false); // not web
    const edges = await goWebAdapter.syntheticEdges!(c);
    expect(edges).toContainEqual(
      expect.objectContaining({ source: 'internal/router', target: 'internal/handlers', kind: 'calls' }),
    );
  });
});
