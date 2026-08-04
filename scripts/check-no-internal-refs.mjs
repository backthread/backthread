#!/usr/bin/env node
// Guard: nothing we ship may carry an internal reference.
//
// The `backthread` npm package is installed by strangers and its files are read by
// people who will never see our tracker. An internal issue id, a tracker URL, an
// internal-only repository name or a company email address in a shipped file is at
// best noise the reader can't act on, and at worst a small information leak.
//
// This check scans the SHIPPED SURFACE only — the exact file set `npm pack` puts in
// the tarball (`files` in cli/package.json, plus package.json itself). Source files
// that never reach the tarball are deliberately out of scope; the bundle is in scope,
// so any comment that esbuild carries into `dist-bundle/backthread.js` is caught here.
//
// Usage:
//   node scripts/check-no-internal-refs.mjs            # scan the working tree's shipped files
//   node scripts/check-no-internal-refs.mjs --dir DIR  # scan an extracted tarball (`package/`)
//
// Exits 1 and prints every hit when something is found; exits 0 and prints OK when clean.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What must never appear in a shipped file, and why, so a failure explains itself. */
const FORBIDDEN = [
  { name: 'issue tracker id', re: /\bARP-\d{3,4}\b/g },
  { name: 'issue tracker url', re: /linear\.app/gi },
  { name: 'private repository name', re: /backthread-app/gi },
  { name: 'retired private domain', re: /useclew/gi },
  { name: 'company email domain', re: /katanamrp/gi },
  { name: 'internal account handle', re: /jevgenibogatyrjov/gi },
];

/** Files whose bytes we do not read (no text to inspect, and huge). */
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.tgz']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (st.isFile()) out.push(abs);
  }
  return out;
}

/**
 * The shipped file set of a package directory: everything named by `files` in its
 * package.json (a directory entry means the whole directory), plus package.json.
 * npm also always ships README/LICENSE, so include them if present.
 */
function shippedFiles(pkgDir) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const names = [...(manifest.files ?? []), 'package.json', 'README.md', 'LICENSE'];
  const out = new Set();
  for (const name of names) {
    const abs = join(pkgDir, name);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) walk(abs).forEach((f) => out.add(f));
    else out.add(abs);
  }
  return [...out].sort();
}

const dirArg = process.argv.indexOf('--dir');
const target = dirArg === -1 ? join(ROOT, 'cli') : process.argv[dirArg + 1];
if (!target || !existsSync(join(target, 'package.json'))) {
  console.error(`no package.json under ${target} — pass a package directory with --dir`);
  process.exit(2);
}

const files = shippedFiles(target);
const findings = [];
for (const abs of files) {
  const ext = abs.slice(abs.lastIndexOf('.'));
  if (SKIP_EXT.has(ext)) continue;
  const rel = relative(target, abs).split(sep).join('/');
  const lines = readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { name, re } of FORBIDDEN) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        findings.push({ rel, line: i + 1, name, match: m[0], col: m.index ?? 0 });
      }
    }
  });
}

console.log(`scanned ${files.length} shipped file(s) under ${target}`);
if (findings.length === 0) {
  console.log('OK — no internal references in the shipped surface.');
  process.exit(0);
}
console.error(`\nFAIL — ${findings.length} internal reference(s) in files we publish:\n`);
for (const f of findings) console.error(`  ${f.rel}:${f.line}  ${f.match}  (${f.name})`);
console.error('\nRewrite the text to say what it means without the internal reference.');
process.exit(1);
