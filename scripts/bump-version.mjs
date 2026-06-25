#!/usr/bin/env node
// Bump the `backthread` cli version in LOCKSTEP across the four files the release CI
// checks, then rebuild the committed bundle — the two steps that otherwise fail CI
// when done by hand (version-lockstep tests + the bundle-in-sync check).
//
// Usage (from the repo root):
//   npm run bump -- <version>          e.g.  npm run bump -- 0.3.1
//   npm run bump -- patch|minor|major  e.g.  npm run bump -- patch
//
// It only edits files + rebuilds the bundle; it does NOT commit, tag, or push — you
// review, commit/PR/merge, then `git tag v<version> && git push origin v<version>`
// (the tag triggers the OIDC trusted-publishing Release workflow).

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Repo root = parent of this script's dir (scripts/).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The four version declarations the release lockstep tests assert are equal.
const FILES = [
  'cli/package.json',
  'cli/.claude-plugin/plugin.json',
  'extensions/gemini/gemini-extension.json',
  'extensions/codex/plugins/backthread/plugin.json',
];

const arg = process.argv[2];
if (!arg) {
  console.error('usage: npm run bump -- <version|patch|minor|major>');
  process.exit(1);
}

const current = JSON.parse(readFileSync(join(ROOT, 'cli/package.json'), 'utf8')).version;

function nextVersion(v, kind) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  if (kind === 'patch') return `${a}.${b}.${c + 1}`;
  return null;
}

const next = ['patch', 'minor', 'major'].includes(arg) ? nextVersion(current, arg) : arg;
if (!/^\d+\.\d+\.\d+$/.test(next ?? '')) {
  console.error(`invalid version: ${arg} (expected x.y.z or patch|minor|major)`);
  process.exit(1);
}
if (next === current) {
  console.error(`version is already ${current} — nothing to bump`);
  process.exit(1);
}

// Replace ONLY the version field that currently equals `current` (a regex anchored
// to the current version, so a manifest's unrelated version field is never touched).
// String-edit, not JSON.parse/stringify, so each file's formatting is preserved.
const currentRe = new RegExp(`("version"\\s*:\\s*)"${current.replace(/\./g, '\\.')}"`);
console.log(`bumping ${current} → ${next}`);
for (const rel of FILES) {
  const path = join(ROOT, rel);
  const src = readFileSync(path, 'utf8');
  if (!currentRe.test(src)) {
    console.error(`  ✗ ${rel}: no "version": "${current}" found — files are out of lockstep; fix manually`);
    process.exit(1);
  }
  writeFileSync(path, src.replace(currentRe, `$1"${next}"`));
  console.log(`  ✓ ${rel}`);
}

console.log('rebuilding the committed bundle (npm run bundle -w backthread)…');
execSync('npm run bundle -w backthread', { cwd: ROOT, stdio: 'inherit' });

console.log(`\nDone. ${current} → ${next} (4 version files + bundle). Next:`);
console.log(`  git checkout -b release-${next}`);
console.log(`  git commit -am "chore(release): backthread ${next}"`);
console.log(`  gh pr create  # CI must go green, then merge`);
console.log(`  git tag v${next} && git push origin v${next}   # triggers the OIDC publish`);
