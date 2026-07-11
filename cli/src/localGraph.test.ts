// localGraph.test.ts — the local structure-cache refresh: pure diff/shape
// helpers + the full/incremental/unchanged/invalidator/force decision logic,
// driven against a FAKE extractor over a real temp working tree (no ts-morph).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeDiff,
  buildStructureModulesEdges,
  refreshStructure,
  type ExtractorApi,
} from './localGraph.js';
import { readCache } from './localCache.js';

// --- pure helpers ------------------------------------------------------------

test('computeDiff classifies added / modified / deleted', () => {
  const diff = computeDiff(
    { 'a.ts': '1', 'b.ts': '1', 'gone.ts': '1' },
    { 'a.ts': '1', 'b.ts': '2', 'new.ts': '1' },
  );
  const byPath = Object.fromEntries(diff.map((d) => [d.path, d.status]));
  assert.equal(byPath['a.ts'], undefined, 'unchanged file emits nothing');
  assert.equal(byPath['b.ts'], 'M');
  assert.equal(byPath['new.ts'], 'A');
  assert.equal(byPath['gone.ts'], 'D');
});

test('buildStructureModulesEdges maps modules (subsystem/external/package) + edges', () => {
  const cluster = {
    modules: [
      { id: 'auth', kind: 'internal', godNode: true, loc: 40, fileCount: 2, fileIds: ['src/auth.ts', 'src/token.ts'], degree: 1 },
      { id: 'zod', kind: 'external', godNode: false, loc: 0, fileCount: 0, fileIds: [], degree: 3, externalSpecifier: 'zod' },
    ],
    fileModuleMap: {},
    moduleEdges: [{ source: 'auth', target: 'zod', weight: 2, kinds: ['import'] }],
  } as unknown as Parameters<typeof buildStructureModulesEdges>[0];
  const subs = new Map([['auth', { id: 'dir:src', name: 'Src' }]]) as unknown as Parameters<typeof buildStructureModulesEdges>[1];
  const { modules, edges } = buildStructureModulesEdges(cluster, subs);
  assert.equal(modules.length, 2);
  assert.deepEqual(modules[0].subsystem, { id: 'dir:src', name: 'Src' });
  assert.equal(modules[0].godNode, true);
  assert.equal(modules[1].subsystem, null);
  assert.equal(modules[1].externalSpecifier, 'zod');
  assert.deepEqual(edges, [{ source: 'auth', target: 'zod', kinds: ['import'] }]);
});

// --- fake extractor + real temp tree -----------------------------------------

function makeFakeExtractor(calls: string[]): ExtractorApi {
  const graph = { root: '/x', files: [], edges: [], externals: [] } as any;
  const cluster = {
    modules: [
      { id: 'auth', kind: 'internal', godNode: false, loc: 10, fileCount: 1, fileIds: ['src/auth.ts'], degree: 0 },
      { id: 'billing', kind: 'internal', godNode: false, loc: 12, fileCount: 1, fileIds: ['src/billing.ts'], degree: 0 },
    ],
    fileModuleMap: {},
    moduleEdges: [],
  } as any;
  class FakeInc {
    seedFull() { calls.push('seedFull'); return { graph }; }
    patchTo() { calls.push('patchTo'); return { graph }; }
    adoptCache() { calls.push('adoptCache'); return true; }
    toCachePayload() { return { version: 1, headSha: 'worktree', files: {} }; }
  }
  return {
    EXTRACTOR_PACKAGE_VERSION: '0.1.0',
    IncrementalExtractor: FakeInc as any,
    detectRepoLanguages: () => ['ts'],
    listSourceFiles: () => ['src/auth.ts', 'src/billing.ts'],
    isConfigInvalidatorPath: (p: string) => /(^|\/)(package\.json|tsconfig[^/]*\.json)$/.test(p),
    detectWorkspaceLayout: () => ({ packages: [{ root: '' }] }) as any,
    clusterGraph: () => cluster,
    detectFrameworkStack: async () => ({}),
    contributeFrameworkGraph: async () => ({}),
    computeSubsystems: () => new Map(),
    classifyDiff: (entries) => {
      const r = { invalidators: [] as string[], sourceAdded: [] as string[], sourceModified: [] as string[], sourceDeleted: [] as string[] };
      for (const e of entries) {
        const base = e.path.split('/').pop() ?? e.path;
        if (/^(package\.json|tsconfig[^/]*\.json)$/.test(base)) r.invalidators.push(e.path);
        if (!e.path.endsWith('.ts')) continue;
        if (e.status === 'A') r.sourceAdded.push(e.path);
        else if (e.status === 'M') r.sourceModified.push(e.path);
        else if (e.status === 'D') r.sourceDeleted.push(e.path);
      }
      return r;
    },
  };
}

function tmpTree(): string {
  const repo = mkdtempSync(join(tmpdir(), 'bt-graph-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'auth.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src', 'billing.ts'), 'export const b = 1;\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x' }));
  return repo;
}

test('refreshStructure returns `unavailable` (fail-open) when the extractor cannot load', async () => {
  const repo = tmpTree();
  const out = await refreshStructure(
    { cwd: repo },
    { loadExtractor: async () => { throw new Error('not installed'); }, resolveRepoRootImpl: () => repo },
  );
  assert.equal(out.status, 'unavailable');
  assert.equal(await readCache(repo), null, 'nothing written');
  rmSync(repo, { recursive: true, force: true });
});

test('first run does a FULL extract and writes the structure section', async () => {
  const repo = tmpTree();
  const calls: string[] = [];
  const out = await refreshStructure(
    { cwd: repo },
    { loadExtractor: async () => makeFakeExtractor(calls), resolveRepoRootImpl: () => repo },
  );
  assert.equal(out.status, 'refreshed-full');
  assert.ok(calls.includes('seedFull'));
  assert.ok(!calls.includes('patchTo'));
  const cache = await readCache(repo);
  assert.equal(cache!.structure!.modules.length, 2);
  assert.equal(cache!.structure!.extractorVersion, '0.1.0');
  assert.ok(Object.keys(cache!.structure!.fileHashes).length >= 3, 'source + package.json tracked');
  rmSync(repo, { recursive: true, force: true });
});

test('a re-run with no changes is a fast UNCHANGED no-op (no extraction)', async () => {
  const repo = tmpTree();
  await refreshStructure({ cwd: repo }, { loadExtractor: async () => makeFakeExtractor([]), resolveRepoRootImpl: () => repo });
  const calls: string[] = [];
  const out = await refreshStructure(
    { cwd: repo },
    { loadExtractor: async () => makeFakeExtractor(calls), resolveRepoRootImpl: () => repo },
  );
  assert.equal(out.status, 'unchanged');
  assert.deepEqual(calls, [], 'neither seedFull nor patchTo ran');
  rmSync(repo, { recursive: true, force: true });
});

test('a changed source file triggers an INCREMENTAL patch', async () => {
  const repo = tmpTree();
  await refreshStructure({ cwd: repo }, { loadExtractor: async () => makeFakeExtractor([]), resolveRepoRootImpl: () => repo });
  // Change content (size ⇒ signature differs even at same mtime ms).
  writeFileSync(join(repo, 'src', 'auth.ts'), 'export const a = 1; // changed and longer\n');
  const calls: string[] = [];
  const out = await refreshStructure(
    { cwd: repo },
    { loadExtractor: async () => makeFakeExtractor(calls), resolveRepoRootImpl: () => repo },
  );
  assert.equal(out.status, 'refreshed-incremental');
  assert.ok(calls.includes('adoptCache'));
  assert.ok(calls.includes('patchTo'));
  assert.ok(!calls.includes('seedFull'));
  assert.equal(out.changedFiles, 1);
  rmSync(repo, { recursive: true, force: true });
});

test('a changed invalidator (package.json) forces a FULL re-extract', async () => {
  const repo = tmpTree();
  await refreshStructure({ cwd: repo }, { loadExtractor: async () => makeFakeExtractor([]), resolveRepoRootImpl: () => repo });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0' }));
  const calls: string[] = [];
  const out = await refreshStructure(
    { cwd: repo },
    { loadExtractor: async () => makeFakeExtractor(calls), resolveRepoRootImpl: () => repo },
  );
  assert.equal(out.status, 'refreshed-full');
  assert.ok(calls.includes('seedFull'));
  assert.ok(!calls.includes('patchTo'));
  rmSync(repo, { recursive: true, force: true });
});

test('--force ignores a valid cache and re-extracts fully', async () => {
  const repo = tmpTree();
  await refreshStructure({ cwd: repo }, { loadExtractor: async () => makeFakeExtractor([]), resolveRepoRootImpl: () => repo });
  const calls: string[] = [];
  const out = await refreshStructure(
    { cwd: repo, force: true },
    { loadExtractor: async () => makeFakeExtractor(calls), resolveRepoRootImpl: () => repo },
  );
  assert.equal(out.status, 'refreshed-full');
  assert.ok(calls.includes('seedFull'));
  assert.ok(!calls.includes('adoptCache'));
  rmSync(repo, { recursive: true, force: true });
});
