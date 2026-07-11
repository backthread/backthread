// localCache.test.ts — the repo-local two-tier cache: schema I/O + atomic,
// section-scoped, fail-open reads/writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHE_SCHEMA_VERSION,
  cacheDir,
  cachePath,
  readCache,
  writeCacheSection,
  resolveRepoRoot,
  type StructureSection,
  type DecisionsSection,
} from './localCache.js';

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), 'bt-cache-'));
}

const sampleStructure: StructureSection = {
  refreshedAt: '2026-07-11T00:00:00.000Z',
  root: '/x',
  extractorVersion: '0.1.0',
  fileHashes: { 'src/a.ts': '1:2' },
  fileGraph: { version: 3, headSha: 'worktree', files: {} },
  modules: [{ id: 'auth', kind: 'internal', godNode: false, loc: 10, fileCount: 1, fileIds: ['src/a.ts'], subsystem: null }],
  edges: [],
};

const sampleDecisions: DecisionsSection = {
  syncedAt: '2026-07-11T00:00:00.000Z',
  ttlHours: 6,
  repo: 'o/r',
  items: [],
};

test('readCache returns null when the file is absent', async () => {
  const repo = tmpRepo();
  assert.equal(await readCache(repo), null);
  rmSync(repo, { recursive: true, force: true });
});

test('readCache returns null on corrupt JSON', async () => {
  const repo = tmpRepo();
  mkdirSync(cacheDir(repo), { recursive: true });
  writeFileSync(cachePath(repo), '{ not json');
  assert.equal(await readCache(repo), null);
  rmSync(repo, { recursive: true, force: true });
});

test('readCache returns null on a mismatched schema version (→ rebuild)', async () => {
  const repo = tmpRepo();
  mkdirSync(cacheDir(repo), { recursive: true });
  writeFileSync(cachePath(repo), JSON.stringify({ schemaVersion: 999, repo: null, structure: null, decisions: null }));
  assert.equal(await readCache(repo), null);
  rmSync(repo, { recursive: true, force: true });
});

test('writeCacheSection creates the dir, a self-ignoring .gitignore, and the file', async () => {
  const repo = tmpRepo();
  await writeCacheSection(repo, { structure: sampleStructure, repo: 'o/r' });
  const gi = join(cacheDir(repo), '.gitignore');
  assert.ok(existsSync(gi), '.gitignore is written');
  assert.equal(readFileSync(gi, 'utf8'), '*\n', 'ignores the whole dir');
  const cache = await readCache(repo);
  assert.ok(cache);
  assert.equal(cache!.schemaVersion, CACHE_SCHEMA_VERSION);
  assert.equal(cache!.repo, 'o/r');
  assert.deepEqual(cache!.structure, sampleStructure);
  assert.equal(cache!.decisions, null);
  rmSync(repo, { recursive: true, force: true });
});

test('writeCacheSection is section-scoped: writing decisions preserves structure', async () => {
  const repo = tmpRepo();
  await writeCacheSection(repo, { structure: sampleStructure, repo: 'o/r' });
  await writeCacheSection(repo, { decisions: sampleDecisions });
  const cache = await readCache(repo);
  assert.ok(cache);
  assert.deepEqual(cache!.structure, sampleStructure, 'structure survived a decisions-only write');
  assert.deepEqual(cache!.decisions, sampleDecisions);
  assert.equal(cache!.repo, 'o/r', 'repo survived (not in the second patch)');
  rmSync(repo, { recursive: true, force: true });
});

test('writeCacheSection does not clobber an existing user .gitignore', async () => {
  const repo = tmpRepo();
  mkdirSync(cacheDir(repo), { recursive: true });
  const gi = join(cacheDir(repo), '.gitignore');
  writeFileSync(gi, '# custom\n');
  await writeCacheSection(repo, { decisions: sampleDecisions });
  assert.equal(readFileSync(gi, 'utf8'), '# custom\n', 'existing .gitignore left alone');
  rmSync(repo, { recursive: true, force: true });
});

test('resolveRepoRoot uses the injected git top-level, falling back to cwd', () => {
  assert.equal(resolveRepoRoot('/x/y/z', () => '/x'), '/x');
  assert.equal(resolveRepoRoot('/x/y/z', () => null), '/x/y/z', 'non-git cwd → cwd itself');
  assert.equal(resolveRepoRoot('/x/y/z', () => ''), '/x/y/z', 'empty top-level → cwd');
});
