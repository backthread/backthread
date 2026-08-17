#!/usr/bin/env node
// The one place that answers "which workspaces have a <script>?".
//
// Two callers need that answer and must not be allowed to disagree with each other:
//   • scripts/check-test-matrix.mjs — asserts CI's test matrix lists every workspace that
//     has a `test` script, so adding a workspace can't silently go untested.
//   • .github/workflows/ci.yml's Typecheck job — typechecks every workspace that has a
//     `typecheck` script, and keeps going after one fails.
//
// Dependency-free on purpose: the matrix guard runs in the CI job that does NO install, so
// nothing here may import from node_modules.
//
// Usage:  node scripts/workspaces.mjs <script-name>   # prints one package NAME per line

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every workspace directory, expanding the one `pkg/*` glob form this repo uses. */
export function workspaceDirs() {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const patterns = root.workspaces ?? [];
  if (patterns.length === 0) {
    throw new Error('root package.json declares no "workspaces" — refusing to report an empty list');
  }
  const dirs = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = join(ROOT, pattern.slice(0, -2));
      for (const entry of readdirSync(base)) {
        if (existsSync(join(base, entry, 'package.json'))) dirs.push(join(base, entry));
      }
    } else if (pattern.includes('*')) {
      // Only `dir/*` is understood. Anything else would be silently dropped, and a silently
      // dropped workspace is exactly the hole this file exists to close.
      throw new Error(`unsupported workspace pattern ${pattern} — teach scripts/workspaces.mjs about it`);
    } else if (existsSync(join(ROOT, pattern, 'package.json'))) {
      dirs.push(join(ROOT, pattern));
    }
  }
  return dirs;
}

/** The package NAMES of every workspace that defines `scriptName`. */
export function workspacesWithScript(scriptName) {
  const names = [];
  for (const dir of workspaceDirs()) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg.scripts?.[scriptName]) names.push(pkg.name);
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
