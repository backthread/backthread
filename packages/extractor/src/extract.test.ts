// Smoke test for the composed one-shot `extract()`: proves the full deterministic
// pipeline (AST → cluster → framework → infra) runs end-to-end on a real on-disk
// tree and returns a structural graph, offline and repeatably.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test, expect, afterEach } from './testkit.js';
import { extract } from './extract.js';
import { EXTRACTOR_PACKAGE_VERSION } from './version.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bt-extract-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const REPO = {
  'package.json': JSON.stringify({ name: 'demo', type: 'module' }),
  'src/api.ts': "import { load } from './store.js';\nexport const handler = () => load();\n",
  'src/store.ts': "import { CACHE } from './cache.js';\nexport const load = () => CACHE.get('k');\n",
  'src/cache.ts': 'export const CACHE = new Map<string, unknown>();\n',
};

test('extract() returns a structural graph for a real on-disk repo', async () => {
  const dir = fixture(REPO);
  const result = await extract(dir);

  // Provenance + version stamp (the container↔CLI lockstep key).
  expect(result.root).toBe(dir);
  expect(result.version).toBe(EXTRACTOR_PACKAGE_VERSION);
  expect(typeof result.version).toBe('string');
  expect(result.version.length).toBeGreaterThan(0);

  // The code graph saw every source file and at least one internal import edge.
  const fileIds = result.graph.files.map((f) => f.id).sort();
  expect(fileIds).toContain('src/api.ts');
  expect(fileIds).toContain('src/store.ts');
  expect(fileIds).toContain('src/cache.ts');
  expect(result.graph.edges.some((e) => e.kind === 'import' && !e.external)).toBe(true);

  // Clustering produced at least one internal module covering the sources.
  const internal = result.cluster.modules.filter((m) => m.kind === 'internal');
  expect(internal.length).toBeGreaterThan(0);
  const covered = new Set(internal.flatMap((m) => m.fileIds));
  expect(covered.has('src/api.ts')).toBe(true);

  // Structural adjuncts are present (empty is fine for this repo).
  expect(Array.isArray(result.infra.nodes)).toBe(true);
  expect(Array.isArray(result.infra.edges)).toBe(true);
  expect(Array.isArray(result.frameworks.matches)).toBe(true);
  expect(result.layout.packages.length).toBeGreaterThan(0);
});

test('extract() is deterministic — same tree yields the same module ids', async () => {
  const dir = fixture(REPO);
  const a = await extract(dir);
  const b = await extract(dir);
  const ids = (r: typeof a) => r.cluster.modules.map((m) => m.id).sort();
  expect(ids(a)).toEqual(ids(b));
});

test('extract() runs offline with no injected classifier (pure structural)', async () => {
  const dir = fixture(REPO);
  // No classifyResourceTypes callback → no LLM/network path is taken.
  const result = await extract(dir, {});
  expect(result.cluster.modules.length).toBeGreaterThan(0);
});
