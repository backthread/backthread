#!/usr/bin/env node
// Guard: nothing we ship may carry an internal reference.
//
// The `backthread` npm package is installed by strangers and its files are read by
// people who will never see our tracker. An internal issue id, a tracker URL, an
// internal-only repository name or a company email address in a shipped file is at
// best noise the reader can't act on, and at worst a small information leak.
//
// This check scans the SHIPPED SURFACE only. Two things reach a stranger:
//   • the npm tarballs — for EVERY publishable workspace, the exact file set `npm pack`
//     puts in it (`files` in that package's package.json, plus package.json itself), and
//   • the bundles installed straight from git — the Claude Code plugin marketplace
//     manifest and the Gemini / Codex extension directories under extensions/.
// Source files that never reach either are deliberately out of scope; the built bundle
// IS in scope, so any comment esbuild carries into `dist-bundle/backthread.js` is caught.
//
// ⚠ IT USED TO SCAN `cli/` AND NOTHING ELSE, while its own first paragraph said "nothing
// we ship". Every other publishable workspace — the extractor, and now the CI package —
// was outside it, so a package could be published carrying every id in the list and this
// gate would report OK. The set of packages is now DERIVED from the workspace list rather
// than written down, because a hand-written list is the same defect one release later.
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
import { workspaceDirs } from './workspaces.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What must never appear in a shipped file, and why, so a failure explains itself. */
const FORBIDDEN = [
  { name: 'issue tracker id', re: /\bARP-\d{3,4}\b/g },
  { name: 'issue tracker url', re: /linear\.app/gi },
  { name: 'private repository name', re: /backthread-app/gi },
  { name: 'retired private domain', re: /useclew/gi },
  { name: 'company email domain', re: /katanamrp/gi },
  { name: 'internal account handle', re: /jevgenibogatyrjov/gi },
  // ⚠ AN INFRASTRUCTURE IDENTIFIER, ADDED AFTER A REVIEWER FOUND IT SHIPPING. A public
  // package carried our Cloudflare ACCOUNT ID in eight places — inside prose explaining
  // that an account id is exactly what must never cross the wire, and once as a literal
  // in a test fixture. None of the six rules above matched it, because every one of them
  // is about a NAME and this is a number.
  //
  // ⚠ AND THE OBVIOUS SIBLING RULE IS DELIBERATELY ABSENT. A Supabase project ref was
  // added here at the same time and immediately failed the build on
  // `cli/dist-bundle/backthread.js` — because it is the host part of
  // `DEFAULT_FUNCTIONS_URL`, the endpoint the published CLI has to call. A service
  // address that every user's traffic reaches is not a leak, and a guard that refuses
  // one teaches people to disable the guard. The distinction this list draws is
  // between an ADDRESS a client must know and an IDENTIFIER that only names us: the
  // account id below appears in prose and nowhere in any request.
  { name: 'cloudflare account id', re: /183986778ae[0-9a-f]*/gi },
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
 *
 * ⚠ AN ABSENT `files` ENTRY FALLS BACK TO `src/`, AND SAYS SO. This guard runs in the
 * CI job that does NO install, so a package whose shipped surface is a COMPILED `dist`
 * has nothing on disk to read — and the old behaviour was to skip it silently and
 * report OK, which is how an already-published package came to ship an issue id that a
 * green gate had been asserting was absent. Comments survive compilation, so the
 * sources a missing `dist` is built FROM are a superset of what it would have carried:
 * scanning them cannot miss a reference the built output would have had. A package that
 * ships its `src` directly (or whose `dist` is committed) never reaches this path.
 */
function shippedFiles(pkgDir) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  // ⚠ NO `files` FIELD MEANS npm SHIPS THE WHOLE DIRECTORY, NOT THREE FILES. Without
  // this branch the loop below saw an empty declared set, scanned only package.json,
  // README and LICENSE, and reported OK — measured: a planted issue id in `src/` was
  // missed entirely. That is the same silent-skip this guard was widened to close,
  // reachable by deleting one line from a package manifest.
  if (manifest.files === undefined) {
    const out = new Set(walk(pkgDir).filter((f) => !f.split(sep).includes('node_modules')));
    console.log(
      `  ${relative(ROOT, pkgDir)}: declares no "files" — npm would publish the whole ` +
        `directory, so the whole directory is scanned (${out.size} file(s))`,
    );
    return [...out].sort();
  }
  const names = [...new Set([...manifest.files, 'package.json', 'README.md', 'LICENSE'])];
  const out = new Set();
  const absent = [];
  for (const name of names) {
    const abs = join(pkgDir, name);
    if (!existsSync(abs)) {
      // Only the DECLARED set is worth reporting: npm always ships README/LICENSE if
      // present, so their absence is ordinary rather than a gap in what we scanned.
      if (manifest.files.includes(name)) absent.push(name);
      continue;
    }
    if (statSync(abs).isDirectory()) walk(abs).forEach((f) => out.add(f));
    else out.add(abs);
  }
  const src = join(pkgDir, 'src');
  if (absent.length > 0 && existsSync(src)) {
    console.log(
      `  ${relative(ROOT, pkgDir)}: ${absent.join(', ')} not built — scanning src/ instead ` +
        '(comments survive compilation, so src is a superset of what dist would carry)',
    );
    walk(src).forEach((f) => out.add(f));
  } else if (absent.length > 0) {
    console.error(
      `::error::${relative(ROOT, pkgDir)} declares files [${absent.join(', ')}] that are not on ` +
        'disk and has no src/ to read instead — this package would be scanned as if it were ' +
        'empty. Build it before running this guard, or ship a directory that exists.',
    );
    process.exit(2);
  }
  return [...out].sort();
}

/** Distributed from git rather than npm: the plugin marketplace + the agent extensions. */
const GIT_DISTRIBUTED = ['.claude-plugin/marketplace.json', 'extensions'];

/**
 * Every workspace npm would actually publish. `private: true` packages cannot be
 * published at all, so scanning them would be noise; everything else is a tarball a
 * stranger can `npm install`.
 *
 * Finding NONE is a FAILURE, not a clean run: "there was nothing to check" and "what I
 * checked was clean" must not share an exit code, and this guard runs in the CI job that
 * does no install, where a resolver that quietly returns [] is exactly the shape that
 * turns a gate into decoration.
 */
function publishableWorkspaces() {
  const dirs = workspaceDirs().filter((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return pkg.private !== true;
  });
  if (dirs.length === 0) {
    console.error(
      'no publishable workspace found — refusing to report a clean scan that scanned nothing',
    );
    process.exit(2);
  }
  return dirs;
}

const dirArg = process.argv.indexOf('--dir');
const explicit = dirArg === -1 ? null : process.argv[dirArg + 1];
const base = explicit ?? ROOT;
const targets = explicit ? [explicit] : publishableWorkspaces();
for (const target of targets) {
  if (!existsSync(join(target, 'package.json'))) {
    console.error(`no package.json under ${target} — pass a package directory with --dir`);
    process.exit(2);
  }
}

const files = targets.flatMap((target) => shippedFiles(target));
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

const scope = explicit
  ? base
  : `${targets.length} publishable workspace(s): ${targets.map((d) => relative(ROOT, d)).join(', ')}`;
console.log(`scanned ${files.length} distributed file(s) under ${scope}`);
if (findings.length === 0) {
  console.log('OK — no internal references in anything we distribute.');
  process.exit(0);
}
console.error(`\nFAIL — ${findings.length} internal reference(s) in files we distribute:\n`);
for (const f of findings) console.error(`  ${f.rel}:${f.line}  ${f.match}  (${f.kind})`);
console.error('\nRewrite the text to say what it means without the internal reference.');
process.exit(1);
