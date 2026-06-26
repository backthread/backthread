// detectAgents.test.ts — agent detection by user-global config-dir presence.
//
// Uses a real temp $HOME (mkdtemp + mkdir the agent dirs) — no real ~ is touched, and
// no DI is needed because the module is a pure existsSync sweep. Mirrors the temp-dir
// isolation in config.test.ts / firstRun.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInstalledAgents } from './detectAgents.js';

async function withTempHome(dirs: string[], fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'backthread-detect-'));
  try {
    for (const d of dirs) await mkdir(join(home, d), { recursive: true });
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('detects nothing in an empty home', async () => {
  await withTempHome([], async (home) => {
    assert.deepEqual(detectInstalledAgents(home), []);
  });
});

test('detects exactly the agent whose config dir exists', async () => {
  await withTempHome(['.cursor'], async (home) => {
    assert.deepEqual(detectInstalledAgents(home), ['cursor']);
  });
});

test('detects multiple agents in canonical order (codex, cursor, gemini)', async () => {
  await withTempHome(['.gemini', '.codex', '.cursor'], async (home) => {
    assert.deepEqual(detectInstalledAgents(home), ['codex', 'cursor', 'gemini']);
  });
});

test('an unrelated dotdir is not mistaken for an agent', async () => {
  await withTempHome(['.config', '.backthread'], async (home) => {
    assert.deepEqual(detectInstalledAgents(home), []);
  });
});

test('a non-existent home yields [] (never throws)', () => {
  assert.deepEqual(detectInstalledAgents('/no/such/home/path/xyz'), []);
});
