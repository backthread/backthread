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

import { existsSync, readFileSync } from 'node:fs';
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
