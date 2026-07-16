// Dart dependency-manifest reading — the analogue of elixir-manifest.ts /
// ruby-manifest.ts / python-manifest.ts. Reads the DIRECT dependencies a repo
// declares + the self package `name:` (which anchors `package:<self>/…` URI
// resolution), WITHOUT installing or RUNNING anything. Two sources:
//
//   * pubspec.yaml  — `name:` (this package's own name) + the `dependencies:` /
//                     `dev_dependencies:` map KEYS (the direct deps).
//   * pubspec.lock  — the resolved `packages:` map keys (direct + transitive).
//
// Parsed with the ALREADY-BUNDLED `yaml` package (a root dep, loaded eagerly by
// cluster/workspaces.ts) — NOT a hand-rolled indent scan and NOT a new dependency.
// pubspec is plain YAML (unlike mix.exs, which is executable Elixir), so a real parse
// is both safe and correct. The framework adapters gate on dep MEMBERSHIP, so only
// the names matter. PURE + never-throws (a malformed/absent manifest degrades to
// whatever the other yields, or empty).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EXCLUDE_DIRS, DART_EXCLUDE_DIRS } from './file-graph.js';

/** Read one file's text, or '' if absent/unreadable. Never throws. */
function readOr(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/** Parse YAML into a plain object, or null on absence/any failure. Never throws. */
function parseYamlObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const doc: unknown = parseYaml(text);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The `name:` a pubspec.yaml declares (this package's own name), or null. */
export function parsePubspecName(text: string): string | null {
  const doc = parseYamlObject(text);
  const n = doc?.name;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

/** Direct dependency names from a pubspec.yaml's `dependencies` ∪ `dev_dependencies`. */
export function parsePubspecDeps(text: string): string[] {
  const doc = parseYamlObject(text);
  if (!doc) return [];
  const out: string[] = [];
  for (const field of ['dependencies', 'dev_dependencies']) {
    const d = doc[field];
    if (d && typeof d === 'object' && !Array.isArray(d)) out.push(...Object.keys(d));
  }
  return out;
}

/** Resolved dependency names from a pubspec.lock's `packages:` map keys. */
export function parsePubLockDeps(text: string): string[] {
  const doc = parseYamlObject(text);
  const pkgs = doc?.packages;
  return pkgs && typeof pkgs === 'object' && !Array.isArray(pkgs) ? Object.keys(pkgs) : [];
}

/** The self package `name:` declared by the pubspec.yaml at `baseDir`, or null. */
export function readPubspecName(baseDir: string): string | null {
  return parsePubspecName(readOr(join(baseDir, 'pubspec.yaml')));
}

/**
 * The set of DIRECT dependency names a repo (or package dir) declares — the union of
 * pubspec.yaml `dependencies`/`dev_dependencies` keys and pubspec.lock `packages`
 * keys. Membership is what the framework adapters gate on. Never throws; a missing or
 * malformed manifest degrades to whatever the other yields.
 */
export function readPubDeps(baseDir: string): Set<string> {
  const deps = new Set<string>();
  for (const name of parsePubspecDeps(readOr(join(baseDir, 'pubspec.yaml')))) deps.add(name);
  for (const name of parsePubLockDeps(readOr(join(baseDir, 'pubspec.lock')))) deps.add(name);
  return deps;
}

// Build/vendor/tool dirs the repo-wide pubspec walk skips — the union of the JS and
// Dart excludes (none hold a first-party pubspec; a vendored `.pub-cache/**/pubspec.
// yaml` must never be read as the repo's own). Dot-dirs are also caught by the
// dot-prefix skip; listed via the sets so the policy is self-contained.
const DEEP_WALK_SKIP_DIRS = new Set<string>([...EXCLUDE_DIRS, ...DART_EXCLUDE_DIRS]);
// Real Dart packages live 1-3 levels deep (a melos monorepo's `packages/<child>`, a
// polyglot repo's `mobile/`/`app/`); 8 is generous. Mirrors readMixDepsDeep.
const DEEP_WALK_MAX_DEPTH = 8;

/**
 * The UNION of DIRECT dependency names declared by EVERY pubspec.yaml in the repo —
 * the root AND every nested package (a melos monorepo's `packages/<child>/pubspec.
 * yaml`, or a Flutter app under `mobile/`/`app/` in a polyglot repo). A BOUNDED walk
 * (skips build/vendor + dot dirs, depth-capped) finds every pubspec dir and unions
 * `readPubDeps` of each. On a single-pubspec repo this equals `readPubDeps(repoDir)`.
 * The framework adapters use this as the repo-wide fallback. NEVER throws.
 */
export function readPubDepsDeep(repoDir: string): Set<string> {
  const deps = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > DEEP_WALK_MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir → skip subtree, never throw
    }
    if (entries.some((e) => e.isFile() && e.name === 'pubspec.yaml')) {
      for (const name of readPubDeps(dir)) deps.add(name);
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || DEEP_WALK_SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(repoDir, 0);
  return deps;
}

/**
 * Map every internal package's declared `name:` → its repo-relative posix dir (the
 * dir HOLDING its pubspec.yaml; '' = repo root). This is what anchors
 * `package:<name>/x/y.dart` URI resolution to a real path: `<name>` → `<dir>/lib/x/
 * y.dart`. Covers the single-package repo (one root pubspec) AND a melos / pub-
 * workspace monorepo (each member's own pubspec `name:` scopes its own
 * `package:<self>`). A BOUNDED walk (build/vendor/dot dirs skipped, depth-capped);
 * first (root-sorted) claimant wins a duplicate name. NEVER throws.
 */
export function dartPackageRoots(repoDir: string): Map<string, string> {
  const found: Array<{ name: string; dir: string }> = [];
  const walk = (relDir: string, depth: number): void => {
    if (depth > DEEP_WALK_MAX_DEPTH) return;
    const abs = relDir === '' ? repoDir : join(repoDir, relDir);
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'pubspec.yaml')) {
      const name = readPubspecName(abs);
      if (name) found.push({ name, dir: relDir });
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || DEEP_WALK_SKIP_DIRS.has(e.name)) continue;
      walk(relDir === '' ? e.name : `${relDir}/${e.name}`, depth + 1);
    }
  };
  walk('', 0);
  // Root-sorted so a duplicate name resolves to the shallowest/first dir deterministically.
  found.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const map = new Map<string, string>();
  for (const { name, dir } of found) if (!map.has(name)) map.set(name, dir);
  return map;
}
