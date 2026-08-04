#!/usr/bin/env node
// Guard: nothing we ship may carry an internal reference.
//
// The `backthread` npm package is installed by strangers and its files are read by
// people who will never see our tracker. An internal issue id, a tracker URL, an
// internal-only repository name or a company email address in a shipped file is at
// best noise the reader can't act on, and at worst a small information leak.
//
// This check scans the SHIPPED SURFACE only. Two things reach a stranger:
//   • the npm tarball — the exact file set `npm pack` puts in it (`files` in
//     cli/package.json, plus package.json itself), and
//   • the bundles installed straight from git — the Claude Code plugin marketplace
//     manifest and the Gemini / Codex extension directories under extensions/.
// Source files that never reach either are deliberately out of scope; the built bundle
// IS in scope, so any comment esbuild carries into `dist-bundle/backthread.js` is caught.
//
// Usage:
//   node scripts/check-no-internal-refs.mjs            # scan everything we distribute
//   node scripts/check-no-internal-refs.mjs --dir DIR  # scan an extracted tarball (`package/`)
//                                                      # — that mode checks only that package
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

/** Distributed from git rather than npm: the plugin marketplace + the agent extensions. */
const GIT_DISTRIBUTED = ['.claude-plugin/marketplace.json', 'extensions'];

const dirArg = process.argv.indexOf('--dir');
const explicit = dirArg === -1 ? null : process.argv[dirArg + 1];
const base = explicit ?? ROOT;
const target = explicit ?? join(ROOT, 'cli');
if (!existsSync(join(target, 'package.json'))) {
  console.error(`no package.json under ${target} — pass a package directory with --dir`);
  process.exit(2);
}

const files = shippedFiles(target);
// Only when scanning the repo — an extracted tarball contains the npm package alone.
if (!explicit) {
  for (const rel of GIT_DISTRIBUTED) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) files.push(...walk(abs));
    else files.push(abs);
  }
}

const findings = [];
for (const abs of files) {
  const name = abs.slice(abs.lastIndexOf(sep) + 1);
  const dot = name.lastIndexOf('.');
  if (dot > 0 && SKIP_EXT.has(name.slice(dot))) continue;
  const rel = relative(base, abs).split(sep).join('/');
  const lines = readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of FORBIDDEN) {
      for (const m of line.matchAll(rule.re)) {
        findings.push({ rel, line: i + 1, kind: rule.name, match: m[0] });
      }
    }
  });
}

console.log(`scanned ${files.length} distributed file(s) under ${base}`);
if (findings.length === 0) {
  console.log('OK — no internal references in anything we distribute.');
  process.exit(0);
}
console.error(`\nFAIL — ${findings.length} internal reference(s) in files we distribute:\n`);
for (const f of findings) console.error(`  ${f.rel}:${f.line}  ${f.match}  (${f.kind})`);
console.error('\nRewrite the text to say what it means without the internal reference.');
process.exit(1);
