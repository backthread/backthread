// shared bounded repo-walker tests.

import { describe, it, expect, beforeAll, afterAll } from '../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { walkRepo, findFiles, DEFAULT_SKIP_DIRS } from './walk.js';

let dir: string;
let linkTarget: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'backthread-walk-'));
  mkdirSync(join(dir, 'src', 'deep', 'deeper'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(dir, '.terraform'), { recursive: true });

  writeFileSync(join(dir, 'root.tf'), '');
  writeFileSync(join(dir, 'README.md'), '');
  writeFileSync(join(dir, 'src', 'a.tf'), '');
  writeFileSync(join(dir, 'src', 'deep', 'b.tf'), '');
  writeFileSync(join(dir, 'src', 'deep', 'deeper', 'c.tf'), '');
  // Inside skipped dirs — must never be reached.
  writeFileSync(join(dir, 'node_modules', 'pkg', 'noise.tf'), '');
  writeFileSync(join(dir, '.terraform', 'state.tf'), '');

  // A symlinked directory whose only path is through the symlink — used to
  // assert walkRepo does NOT follow symlinked dirs (preserving the old
  // readdirSync withFileTypes + e.isDirectory() semantics).
  linkTarget = mkdtempSync(join(tmpdir(), 'backthread-walk-target-'));
  writeFileSync(join(linkTarget, 'linked.tf'), '');
  symlinkSync(linkTarget, join(dir, 'linkdir'), 'dir');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(linkTarget, { recursive: true, force: true });
});

describe('walkRepo', () => {
  it('visits every file outside the default skip dirs', () => {
    const seen: string[] = [];
    walkRepo(dir, { onFile: (abs) => seen.push(relative(dir, abs)) });
    expect(seen).toContain('root.tf');
    expect(seen).toContain('README.md');
    expect(seen).toContain(join('src', 'deep', 'deeper', 'c.tf'));
    // node_modules is in DEFAULT_SKIP_DIRS; .terraform is not.
    expect(seen.some((p) => p.includes('node_modules'))).toBe(false);
    expect(seen).toContain(join('.terraform', 'state.tf'));
  });

  it('honors a custom skipDirs set', () => {
    const seen: string[] = [];
    walkRepo(dir, {
      skipDirs: [...DEFAULT_SKIP_DIRS, '.terraform'],
      onFile: (abs) => seen.push(relative(dir, abs)),
    });
    expect(seen.some((p) => p.includes('.terraform'))).toBe(false);
  });

  it('stops descending past maxDepth (root is depth 0)', () => {
    const seen: string[] = [];
    walkRepo(dir, { maxDepth: 1, onFile: (abs) => seen.push(relative(dir, abs)) });
    expect(seen).toContain('root.tf'); // depth 0
    expect(seen).toContain(join('src', 'a.tf')); // depth 1
    expect(seen).not.toContain(join('src', 'deep', 'b.tf')); // depth 2 — beyond bound
  });

  it('passes the Dirent so callers can match on name', () => {
    const names = new Set<string>();
    walkRepo(dir, { onFile: (_abs, e) => names.add(e.name) });
    expect(names.has('root.tf')).toBe(true);
    expect(names.has('README.md')).toBe(true);
  });

  it('tolerates an unreadable / non-existent root without throwing', () => {
    expect(() => walkRepo(join(dir, 'does-not-exist'), { onFile: () => {} })).not.toThrow();
  });

  it('does not descend into symlinked directories', () => {
    const seen: string[] = [];
    walkRepo(dir, { onFile: (_abs, e) => seen.push(e.name) });
    // The symlink is visited as a (non-directory) entry — old readdir semantics:
    // a symlink-to-dir Dirent reports isDirectory() === false.
    expect(seen).toContain('linkdir');
    // …but its target's contents are never reached (no following symlinked dirs).
    expect(seen).not.toContain('linked.tf');
  });
});

describe('findFiles', () => {
  it('collects predicate matches as sorted absolute paths', () => {
    const tf = findFiles(dir, (_abs, e) => e.name.endsWith('.tf'));
    const rels = tf.map((p) => relative(dir, p));
    expect(rels).toContain('root.tf');
    expect(rels).toContain(join('src', 'a.tf'));
    expect(rels).not.toContain('README.md');
    // Sorted (lexicographic) for deterministic output.
    expect([...tf]).toEqual([...tf].sort());
  });

  it('passes (absPath, dirent) to match — same order as walkRepo onFile', () => {
    const seenAbs: string[] = [];
    findFiles(dir, (abs, e) => {
      seenAbs.push(abs);
      expect(abs.endsWith(e.name)).toBe(true); // first arg is the path, second the Dirent
      return false;
    });
    expect(seenAbs.every((p) => p.startsWith(dir))).toBe(true);
  });

  it('forwards skipDirs + maxDepth options', () => {
    const shallow = findFiles(dir, (_abs, e) => e.name.endsWith('.tf'), { maxDepth: 0 });
    expect(shallow.map((p) => relative(dir, p))).toEqual(['root.tf']);
  });
});
