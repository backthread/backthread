// the shared bounded repo-walker for infra adapters.
//
// Every adapter (cloudflare, supabase, terraform, vercel, fly, render,
// railway, aws, gcp, azure, opentofu, pulumi) used to re-implement the same
// `SKIP_DIRS` / `MAX_DEPTH` / `listDir` / recursive `walk` machinery — twelve
// near-identical copies (OpenTofu was a verbatim copy-paste of terraform.ts).
// This is the one walk: a depth-bounded, skip-dir-pruned, error-tolerant
// directory traversal that calls `onFile` for every file it reaches.
//
// The walk machinery is shared; the *policy* (which dirs to skip, how deep to
// go, which files to keep) stays with each adapter as call-site options, so
// migrating to this helper is a pure refactor with no behavior change — each
// adapter passes the exact `skipDirs`/`maxDepth` it always used.

import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * The skip-set shared by the majority of adapters (cloudflare, supabase, fly,
 * render). Adapters needing provider-specific extras (terraform → `.terraform`,
 * vercel → `.vercel`/`out`, pulumi → `.pulumi`, railway → `.nixpacks`, the
 * cloud adapters → `__pycache__`/`.venv`/`vendor`) pass their own `skipDirs`.
 */
export const DEFAULT_SKIP_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  '.wrangler',
  '.next',
  'build',
  'coverage',
];

/** Default recursion bound — deep enough for monorepo nesting, cheap enough to stay bounded. */
const DEFAULT_MAX_DEPTH = 8;

export interface WalkRepoOptions {
  /** Directory names pruned from the walk (matched on basename). Defaults to {@link DEFAULT_SKIP_DIRS}. */
  skipDirs?: Iterable<string>;
  /** Maximum recursion depth (root is depth 0). Defaults to 8. */
  maxDepth?: number;
  /** Invoked for every file reached. `dirent` is the file's Dirent (carries `.name`). */
  onFile: (absPath: string, dirent: Dirent) => void;
}

/**
 * Walk `repoDir` depth-first, pruning `skipDirs` and stopping past `maxDepth`,
 * invoking `onFile(absPath, dirent)` for each file. Unreadable directories are
 * skipped silently (a permission error on one subtree never aborts the walk).
 */
export function walkRepo(repoDir: string, opts: WalkRepoOptions): void {
  const skip = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS);
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(abs, depth + 1);
      } else {
        opts.onFile(abs, e);
      }
    }
  };
  walk(repoDir, 0);
}

/**
 * Convenience over {@link walkRepo} for the common "collect every file matching
 * a predicate" case. Returns absolute paths sorted lexicographically (the same
 * `found.sort()` every adapter applied for deterministic output).
 *
 * `match` takes `(absPath, dirent)` — the SAME argument order as
 * {@link WalkRepoOptions.onFile} — so a predicate can move between the two
 * helpers without silently rebinding its parameters.
 */
export function findFiles(
  repoDir: string,
  match: (absPath: string, dirent: Dirent) => boolean,
  opts?: { skipDirs?: Iterable<string>; maxDepth?: number },
): string[] {
  const found: string[] = [];
  walkRepo(repoDir, {
    skipDirs: opts?.skipDirs,
    maxDepth: opts?.maxDepth,
    onFile: (abs, e) => {
      if (match(abs, e)) found.push(abs);
    },
  });
  return found.sort();
}
