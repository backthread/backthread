// Go dependency-manifest reading — the analogue of elixir-manifest.ts / kotlin-manifest.ts.
// Reads a Go module's own MODULE PATH (the first-party import prefix) and its DIRECT
// dependency module paths, from go.mod, WITHOUT installing or RUNNING anything. go.mod is a
// small declarative format (not code), so it's matched syntactically.
//
//   * `module <path>`         — the module's import prefix. An import that equals it or is
//                               nested under it is FIRST-PARTY (resolves to a repo dir).
//   * `require <path> <ver>`  — direct dependency module paths (single or in a `require (…)`
//     block), plus `replace … => <path> <ver>` targets. The module path is what the
//     extractor buckets externals by (longest declared-module prefix).
//
// PURE + never-throws (a missing/malformed go.mod degrades to '' / an empty set).
//
// v1 SCOPE: a single module whose go.mod is at the repo root (the overwhelming norm) — or a
// single nested module (one go.mod below the root), whose directory offset is tracked so
// import paths still map to the right dirs. A true multi-module repo (a go.work with several
// go.mod files) uses the FIRST (root-preferred) module for first-party resolution; the other
// modules' internal imports won't resolve (a documented degrade). Dependency bucketing still
// unions every go.mod's requires.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// `module github.com/foo/app` — the first `module` directive.
const MODULE_RE = /^\s*module\s+(\S+)/m;
// A `<module-path> v<version>` pair — matches every require-block entry, single `require`,
// and `replace … => <path> <ver>` target ANYWHERE in go.mod (matchAll finds them mid-line
// too, so a single-line `require x v1` is captured). The `module`/`go`/`toolchain`
// directives carry no `v<digit>` token, so they never match.
const REQUIRE_ENTRY_RE = /([^\s()=>]+)\s+v[0-9][\w.+-]*/g;

/** The module path from a go.mod text (the first `module` directive), or '' if none. */
export function parseGoModModule(text: string): string {
  const m = text.match(MODULE_RE);
  return m ? m[1] : '';
}

/** Direct-dependency module paths declared in a go.mod (require + replace targets). */
export function parseGoModRequires(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REQUIRE_ENTRY_RE)) out.push(m[1]);
  return out;
}

/** Read one file's text, or '' if absent/unreadable. */
function readOr(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

// Build/vendor/tool dirs the go.mod walk skips — mirrors GO_EXCLUDE_DIRS. None hold a
// first-party go.mod that declares the module's own dependencies.
const GO_WALK_SKIP = new Set<string>(['vendor', 'testdata', 'node_modules', '.git', 'dist', 'out']);
const GO_WALK_MAX_DEPTH = 8;

export interface GoModuleInfo {
  /** The module import prefix (`github.com/foo/app`), or '' if no go.mod found. */
  modulePath: string;
  /** Repo-relative posix dir of the go.mod ('' for the root module). */
  moduleDir: string;
}

/**
 * Find the module's go.mod (ROOT preferred; else the shallowest go.mod in a bounded walk)
 * and return its module path + the repo-relative dir it sits in. The moduleDir offset lets
 * the adapter map an import path to the right on-disk directory even when the module lives
 * in a subdir. Never throws.
 */
export function readGoModuleInfo(repoDir: string): GoModuleInfo {
  const rootMod = readOr(join(repoDir, 'go.mod'));
  if (rootMod) return { modulePath: parseGoModModule(rootMod), moduleDir: '' };
  // No root go.mod — a single nested module. Breadth-preferring bounded walk for the
  // shallowest go.mod (deterministic: entries sorted, shallowest wins).
  let best: GoModuleInfo | undefined;
  let bestDepth = Infinity;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > GO_WALK_MAX_DEPTH || depth >= bestDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'go.mod')) {
      const mp = parseGoModModule(readOr(join(dir, 'go.mod')));
      if (mp && depth < bestDepth) {
        best = { modulePath: mp, moduleDir: rel };
        bestDepth = depth;
      }
      return; // don't descend past a module root
    }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory() || e.name.startsWith('.') || GO_WALK_SKIP.has(e.name)) continue;
      walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk(repoDir, '', 0);
  return best ?? { modulePath: '', moduleDir: '' };
}

/**
 * The module path of the repo's primary module (root-preferred). Convenience over
 * `readGoModuleInfo(repoDir).modulePath`.
 */
export function readGoModule(repoDir: string): string {
  return readGoModuleInfo(repoDir).modulePath;
}

/**
 * The UNION of DIRECT dependency module paths declared by EVERY go.mod in the repo (bounded
 * walk) — the buckets the extractor collapses externals into. Unioning across modules is
 * safe (bucketing only uses membership). Never throws.
 */
export function readGoDeps(repoDir: string): Set<string> {
  const deps = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > GO_WALK_MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === 'go.mod') {
        for (const p of parseGoModRequires(readOr(join(dir, e.name)))) deps.add(p);
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || GO_WALK_SKIP.has(e.name)) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(repoDir, 0);
  return deps;
}
