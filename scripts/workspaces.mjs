#!/usr/bin/env node
// The one place that answers "which workspaces are there, and which have a <script>?".
//
// Two callers need that answer and must not be allowed to disagree with each other:
//   • scripts/check-test-matrix.mjs — asserts CI's test matrix lists every workspace that has a
//     `test` script, and that the scripts it finds actually run something.
//   • .github/workflows/ci.yml's Typecheck job — typechecks every workspace that has a
//     `typecheck` script, and keeps going after one fails.
//
// Dependency-free on purpose: the matrix guard runs in the CI job that does NO install, so
// nothing here may import from node_modules.
//
// Usage:  node scripts/workspaces.mjs <script-name>   # prints one package NAME per line

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every workspace directory, expanding the one `pkg/*` glob form this repo uses.
 * Anything it cannot expand, and anything declared but missing from disk, THROWS — a silently
 * dropped workspace is exactly the hole this file exists to close, and a comment claiming so
 * while the code quietly `continue`s is worse than no comment at all.
 */
export function workspaceDirs() {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const patterns = root.workspaces ?? [];
  if (patterns.length === 0) {
    throw new Error('root package.json declares no "workspaces" — refusing to report an empty list');
  }
  const dirs = [];
  for (const pattern of patterns) {
    // Checked BEFORE the `dir/*` branch: `tools/*/*` also ends with `/*`, and treating it as a
    // single-level glob produced a raw ENOENT on a literal `tools/*` instead of saying why.
    const supported = /^[^*]+\/\*$/.test(pattern) || !pattern.includes('*');
    if (!supported) {
      throw new Error(
        `unsupported workspace pattern "${pattern}" — scripts/workspaces.mjs only understands ` +
          'a literal path or a single-level `dir/*`. Teach it this form before using it.',
      );
    }
    if (pattern.endsWith('/*')) {
      const base = join(ROOT, pattern.slice(0, -2));
      if (!existsSync(base)) {
        throw new Error(`workspace pattern "${pattern}" points at a directory that does not exist`);
      }
      for (const entry of readdirSync(base)) {
        const abs = join(base, entry);
        // A directory with no package.json is not a workspace to npm either, so skipping it
        // matches `npm query .workspace` rather than hiding anything.
        if (statSync(abs).isDirectory() && existsSync(join(abs, 'package.json'))) dirs.push(abs);
      }
    } else {
      const abs = join(ROOT, pattern);
      if (!existsSync(join(abs, 'package.json'))) {
        throw new Error(
          `workspace "${pattern}" is declared in root package.json but has no package.json on ` +
            'disk — npm ignores it silently, so nothing would test or typecheck it',
        );
      }
      dirs.push(abs);
    }
  }
  return dirs;
}

/**
 * Whether a workspace ships any test file at all, so "has tests but no test script" can be
 * called out. Walks the WHOLE workspace, not just `src/`: an earlier version looked only under
 * `src/`, which made a perfectly ordinary `test/` or `tests/` layout invisible — and a workspace
 * with tests there and no `test` script would then have passed the very check this feeds.
 */
export function hasTestFiles(dir) {
  const IGNORED = new Set(['node_modules', 'dist', 'dist-bundle', 'coverage', 'build']);
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (IGNORED.has(entry) || entry.startsWith('.')) continue;
      const abs = join(d, entry);
      if (statSync(abs).isDirectory()) {
        if (walk(abs)) return true;
      } else if (/\.test\.[cm]?[jt]sx?$/.test(entry)) {
        return true;
      }
    }
    return false;
  };
  return walk(dir);
}

/**
 * The package NAMES of every workspace that defines `scriptName`.
 * A nameless workspace throws rather than being reported as `undefined`: callers compare these
 * names against a hand-written list, and "workspace undefined is missing" is a puzzle where
 * "packages/x has no name" is an instruction. A whitespace-only name throws for the same reason
 * plus a sharper one — the CI loop word-splits this output, so `" "` would vanish silently.
 */
export function workspacesWithScript(scriptName) {
  const names = [];
  for (const dir of workspaceDirs()) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (!pkg.scripts?.[scriptName]) continue;
    if (typeof pkg.name !== 'string' || pkg.name.trim() === '') {
      throw new Error(
        `${dir}/package.json has a "${scriptName}" script but no usable "name" — npm cannot ` +
          'address it as a workspace',
      );
    }
    if (/\s/.test(pkg.name)) {
      throw new Error(`${dir}/package.json's "name" contains whitespace, which CI cannot iterate`);
    }
    names.push(pkg.name);
  }
  return names;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const script = process.argv[2];
  if (!script) {
    console.error('usage: node scripts/workspaces.mjs <script-name>');
    process.exit(2);
  }
  for (const name of workspacesWithScript(script)) console.log(name);
}
