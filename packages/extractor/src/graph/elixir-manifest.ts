// Elixir dependency-manifest reading — the analogue of ruby-manifest.ts /
// python-manifest.ts. Reads the DIRECT dependencies a repo declares, from the two
// places Elixir projects declare them, WITHOUT installing or RUNNING anything. The
// framework adapters ask membership — "does this repo declare phoenix / ecto /
// oban?" — so only the names matter. PURE + never-throws.
//
//   * mix.exs      — the `deps/0` function's `{:name, ...}` tuples (Mix DSL).
//   * mix.lock     — the resolved dependency map's `"name" => {...}` keys.
//
// NEVER EVALUATED. mix.exs is Elixir code; running it would execute arbitrary repo
// code (violating never-store-source and the install-free promise) and requires an
// Elixir toolchain we don't ship. Instead the dep TUPLES are matched syntactically:
// a Mix dependency is always a `{:atom, ...}` tuple, a shape that appears in mix.exs
// essentially only in `deps/0`. This is deliberately robust to conditional deps
// (`if Mix.env() == :prod do [...] else [...] end`) — a regex captures the atoms in
// BOTH branches, where an evaluator would run only one.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// A Mix dependency tuple head: `{:phoenix,` / `{:jason}` / `{ :ecto_sql ,`.
const DEP_TUPLE_RE = /\{\s*:([a-z_][a-z0-9_]*)\s*[,}]/g;
// A mix.lock map entry key: `"phoenix" => {...}`.
const LOCK_KEY_RE = /"([a-z0-9_]+)"\s*=>/g;

/** Dependency atom names from a mix.exs's `deps/0` tuples (regex, never eval). */
export function parseMixExsDeps(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DEP_TUPLE_RE)) out.push(m[1]);
  return out;
}

/** Dependency names from a mix.lock map's keys. */
export function parseMixLockDeps(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LOCK_KEY_RE)) out.push(m[1]);
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

/**
 * The set of DIRECT dependency names a repo declares — the union of mix.exs
 * `deps/0` tuples and mix.lock keys. Names only (Elixir packages are snake_case
 * atoms). Membership is what the framework adapters gate on. Never throws; a
 * missing/malformed manifest degrades to whatever the other yields.
 */
export function readMixDeps(baseDir: string): Set<string> {
  const deps = new Set<string>();
  for (const name of parseMixExsDeps(readOr(join(baseDir, 'mix.exs')))) deps.add(name);
  for (const name of parseMixLockDeps(readOr(join(baseDir, 'mix.lock')))) deps.add(name);
  return deps;
}

// Build/vendor/tool dirs the repo-wide walk skips — mirrors findMixPackageDirs in
// cluster/workspaces.ts (EXCLUDE_DIRS ∪ ELIXIR_EXCLUDE_DIRS, minus the dot-dirs the
// dot-prefix skip already catches). None hold a first-party mix.exs; walking `deps/`
// or `_build/` would misread vendored/generated packages as the repo's own.
const DEEP_WALK_SKIP_DIRS = new Set<string>([
  'node_modules', // vendored JS (a Phoenix `assets/` ships a JS toolchain)
  'deps', // Mix's vendored dependency tree (the Elixir `node_modules`)
  '_build', // Mix build artifacts
  'cover', // coverage output
  'dist',
  'build',
  'out',
  'coverage',
]);

// Depth cap — a pathological/vendored tree must not turn detection into a full-disk
// crawl. Real Elixir apps live 1-3 levels deep (an umbrella's `apps/<child>`, a
// polyglot monorepo's `elixir/apps/<child>`); 8 is generous. Mirrors
// MAX_WALK_DEPTH in cluster/workspaces.ts.
const DEEP_WALK_MAX_DEPTH = 8;

/**
 * The UNION of DIRECT dependency names declared by EVERY mix.exs in the repo — the
 * root, umbrella children (`apps/<child>/mix.exs`), AND a deeply-nested Elixir app
 * in a polyglot monorepo (`elixir/apps/web/mix.exs`, the Firezone shape). A BOUNDED
 * walk (skips build/vendor dirs + dot-dirs, depth-capped) finds every mix.exs dir and
 * unions `readMixDeps` of each (its mix.exs `deps/0` tuples + the adjacent mix.lock
 * keys). Membership is what the framework adapters gate on.
 *
 * On a single-mix.exs repo this equals `readMixDeps(repoDir)`, so standard single-app
 * detection is unchanged — the adapters use this ONLY as a fallback, after a root +
 * shallow scan already missed. NEVER throws (an unreadable dir skips its subtree).
 */
export function readMixDepsDeep(repoDir: string): Set<string> {
  const deps = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > DEEP_WALK_MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir → skip subtree, never throw
    }
    // This dir declares deps iff it holds a mix.exs (root + every umbrella/nested app).
    if (entries.some((e) => e.isFile() && e.name === 'mix.exs')) {
      for (const name of readMixDeps(dir)) deps.add(name);
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || DEEP_WALK_SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(repoDir, 0);
  return deps;
}
