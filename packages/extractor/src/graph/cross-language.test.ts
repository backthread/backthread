// the unified full-stack diagram: multi-language merge + the
// cross-language frontend→backend API seam.
//
// The headline integration test builds a small polyglot repo (a TS frontend that
// calls a Python/FastAPI backend), runs the structural core of the pipeline
// (extract → cluster → framework/cross-language contributions), and asserts ONE
// merged graph with both languages AND a coarse frontend→backend edge. Plus unit
// tests for the linker's single-language no-op (the byte-identical guard).

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { extractGraph } from './extract.js';
import { clusterGraph } from '../cluster/louvain.js';
import { contributeFrameworkGraph } from '../framework/contribute-step.js';
import { crossLanguageApiEdges } from './cross-language.js';
import type { NormalizedGraph } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-xlang-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

// A TS frontend (generated-SDK URL literals) + a nested Python/FastAPI backend.
function polyglotFixture(): Record<string, string> {
  return {
    'frontend/package.json': '{"name":"web","dependencies":{"react":"18"}}',
    'frontend/src/main.tsx': "import { readUsers, readItems } from './client/sdk.gen';\nexport const boot = () => { readUsers(); readItems(); };\n",
    'frontend/src/client/sdk.gen.ts': [
      '// auto-generated',
      'export function readUsers() {',
      "  return __request(OpenAPI, { method: 'GET', url: '/api/v1/users/' });",
      '}',
      'export function readItems() {',
      "  return __request(OpenAPI, { method: 'GET', url: '/api/v1/items/' });",
      '}',
    ].join('\n'),
    'frontend/src/pages/users.tsx': "import { readUsers } from '../client/sdk.gen';\nexport const Users = () => { readUsers(); return null; };\n",
    'frontend/src/pages/items.tsx': "import { readItems } from '../client/sdk.gen';\nexport const Items = () => { readItems(); return null; };\n",
    'frontend/src/pages/home.tsx': 'export const Home = () => null;\n',
    'frontend/src/lib/util.ts': 'export const noop = () => {};\n',

    'backend/pyproject.toml': '[project]\nname = "be"\ndependencies = ["fastapi>=0.100"]\n',
    'backend/app/__init__.py': '',
    'backend/app/main.py': [
      'from fastapi import FastAPI',
      'from app.api.main import api_router',
      'app = FastAPI()',
      'app.include_router(api_router, prefix="/api/v1")',
    ].join('\n'),
    'backend/app/api/__init__.py': '',
    'backend/app/api/main.py': [
      'from fastapi import APIRouter',
      'from app.api.routes import users, items',
      'api_router = APIRouter()',
      'api_router.include_router(users.router)',
      'api_router.include_router(items.router)',
    ].join('\n'),
    'backend/app/api/routes/__init__.py': '',
    'backend/app/api/routes/users.py': [
      'from fastapi import APIRouter',
      'from app.models import User',
      'router = APIRouter(prefix="/users", tags=["users"])',
      '@router.get("/")',
      'def read_users() -> list[User]:',
      '    return []',
    ].join('\n'),
    'backend/app/api/routes/items.py': [
      'from fastapi import APIRouter',
      'router = APIRouter(prefix="/items", tags=["items"])',
      '@router.get("/")',
      'def read_items():',
      '    return []',
    ].join('\n'),
    'backend/app/models.py': 'class User:\n    pass\n',
  };
}

describe('unified full-stack diagram', () => {
  it('merges both languages into ONE graph and draws a frontend→backend API edge', async () => {
    const dir = await repo(polyglotFixture());

    const graph = await extractGraph(dir);
    const tsFiles = graph.files.filter((f) => ['ts', 'tsx'].includes(f.language));
    const pyFiles = graph.files.filter((f) => ['py', 'pyi'].includes(f.language));
    expect(tsFiles.length).toBeGreaterThan(0);
    expect(pyFiles.length).toBeGreaterThan(0);
    // Both a frontend and a backend file are present in the SAME merged graph.
    expect(graph.files.some((f) => f.id.startsWith('frontend/'))).toBe(true);
    expect(graph.files.some((f) => f.id.startsWith('backend/'))).toBe(true);

    const cluster = clusterGraph(graph);
    const fw = await contributeFrameworkGraph({ repoDir: dir, graph, cluster });

    // Resolve each module to its fileIds so we can classify an edge as frontend→backend.
    const filesByModule = new Map(cluster.modules.map((m) => [m.id, m.fileIds ?? []]));
    const isFrontend = (mod: string) => (filesByModule.get(mod) ?? []).some((f) => f.startsWith('frontend/'));
    const isBackend = (mod: string) => (filesByModule.get(mod) ?? []).some((f) => f.startsWith('backend/'));

    const seam = fw.edges.filter((e) => isFrontend(e.source as string) && isBackend(e.target as string));
    expect(seam.length).toBeGreaterThan(0);
    expect(seam.every((e) => e.kind === 'calls')).toBe(true);
  });

  it('is deterministic — a second full run yields the identical seam', async () => {
    const dir = await repo(polyglotFixture());
    const run = async () => {
      const graph = await extractGraph(dir);
      const cluster = clusterGraph(graph);
      const fw = await contributeFrameworkGraph({ repoDir: dir, graph, cluster });
      return fw.edges.map((e) => `${e.source}→${e.target}:${e.kind}`).sort();
    };
    expect(await run()).toEqual(await run());
  });
});

describe('crossLanguageApiEdges (unit — single-language no-op)', () => {
  const g = (langs: string[]): NormalizedGraph => ({
    root: '/x',
    files: langs.map((language, i) => ({ id: `f${i}.${language}`, loc: 1, language })),
    edges: [],
    externals: [],
  });

  it('returns [] for a TS-only graph (no seam → byte-identical single-language output)', () => {
    expect(crossLanguageApiEdges({ repoDir: '/x', graph: g(['ts', 'tsx', 'ts']) })).toEqual([]);
  });

  it('returns [] for a Python-only graph', () => {
    expect(crossLanguageApiEdges({ repoDir: '/x', graph: g(['py', 'py']) })).toEqual([]);
  });
});
