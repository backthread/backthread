// Language detection + source-file enumeration for the extractor dispatch
//. The pipeline runs ONE structural adapter per repo; this module
// decides which (ts-morph vs Pyright) and, for the Pyright path, hands it the
// explicit list of first-party source files to parse.
//
// IMPURE by design (reads the filesystem) — kept OUT of file-graph.ts, which is
// the pure source-path policy. This module composes that policy (isSourceFilePath,
// the exclude sets) with real fs walks.

import { readdirSync, existsSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import type { NormalizedGraph } from './types.js';
import {
  isSourceFilePath,
  PYTHON_EXCLUDE_DIRS,
  RUBY_EXCLUDE_DIRS,
  ELIXIR_EXCLUDE_DIRS,
  DART_EXCLUDE_DIRS,
  PHP_EXCLUDE_DIRS,
  EXCLUDE_DIRS,
  type SourceLang,
} from './file-graph.js';

const PYTHON_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'];
const TS_MANIFESTS = ['package.json', 'tsconfig.json', 'tsconfig.base.json', 'jsconfig.json'];
const RUBY_MANIFESTS = ['Gemfile', 'Gemfile.lock'];
// Mix is Elixir's build tool; `mix.exs` (the project file) + `mix.lock` (the
// resolved dep pins) are the unambiguous Elixir-repo manifests.
const ELIXIR_MANIFESTS = ['mix.exs', 'mix.lock'];
// Pub is Dart's package manager; `pubspec.yaml` (the project file) + `pubspec.lock`
// (the resolved dep pins) are the unambiguous Dart/Flutter-repo manifests.
const DART_MANIFESTS = ['pubspec.yaml', 'pubspec.lock'];
// Composer is PHP's package manager; `composer.json` (the project file) +
// `composer.lock` (the resolved dep pins) are the unambiguous PHP-repo manifests.
const PHP_MANIFESTS = ['composer.json', 'composer.lock'];

/**
 * Does the repo root declare a Ruby project? A `Gemfile` / `Gemfile.lock`, or any
 * top-level `*.gemspec` (a packaged gem). Cheap: existsSync + one shallow readdir.
 * Shared by the extractor's language detection AND the Gemfile-gated framework-fleet
 * registration (framework/register.ts), so the "is this Ruby?" answer has ONE source.
 */
export function hasRubyManifest(repoDir: string): boolean {
  if (RUBY_MANIFESTS.some((m) => existsSync(resolve(repoDir, m)))) return true;
  try {
    return readdirSync(repoDir).some((f) => f.endsWith('.gemspec'));
  } catch {
    return false;
  }
}

/**
 * Does the repo root declare an Elixir project? A `mix.exs` / `mix.lock`. A Phoenix
 * repo's only root manifest is `mix.exs` (its JS toolchain lives under `assets/`),
 * so this is decisive. Shared by the extractor's language detection AND the
 * mix.exs-gated framework-fleet registration (framework/register.ts), so the "is
 * this Elixir?" answer has ONE source.
 */
export function hasMixManifest(repoDir: string): boolean {
  return ELIXIR_MANIFESTS.some((m) => existsSync(resolve(repoDir, m)));
}

// Depth cap + skip set for the nested manifest probe — mirrors MAX_WALK_DEPTH /
// findMixPackageDirs in cluster/workspaces.ts (real Elixir apps sit 1-3 levels deep;
// 8 is generous). Skips build/vendor + dot dirs so a `deps/**/mix.exs` can't fake it.
const MIX_PROBE_MAX_DEPTH = 8;
const MIX_PROBE_SKIP = new Set<string>([...EXCLUDE_DIRS, ...ELIXIR_EXCLUDE_DIRS]);

/**
 * Does the repo declare an Elixir project ANYWHERE — the root OR a nested / umbrella
 * app? A polyglot monorepo commonly keeps its Phoenix app under a top-level `elixir/`
 * dir (`elixir/mix.exs`, or an umbrella's `elixir/apps/web/mix.exs`), which the
 * root-only `hasMixManifest` misses. A BOUNDED walk (skips build/dep + dot dirs,
 * depth-capped, EARLY-EXITS on the first mix.exs) finds it.
 *
 * The root-only `hasMixManifest` stays the graph-language selector (unchanged — a
 * nested-Elixir repo already extracts via the dominant-source-count path); this
 * broader probe gates the Elixir framework FLEET registration, so its adapters load +
 * run for a repo whose Elixir lives below the root instead of silently no-op-ing.
 * NEVER throws (an unreadable dir skips its subtree).
 */
export function hasMixManifestDeep(repoDir: string): boolean {
  if (hasMixManifest(repoDir)) return true; // cheap root check short-circuits
  const walk = (dir: string, depth: number): boolean => {
    if (depth > MIX_PROBE_MAX_DEPTH) return false;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false; // unreadable dir → skip subtree, never throw
    }
    if (entries.some((e) => e.isFile() && e.name === 'mix.exs')) return true;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || MIX_PROBE_SKIP.has(e.name)) continue;
      if (walk(join(dir, e.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(resolve(repoDir), 0);
}

/**
 * Does the repo root declare a Dart/Flutter project? A `pubspec.yaml` / `pubspec.lock`
 * — the unambiguous Dart-repo manifest (its native `ios/`/`android/` hosts carry
 * their own build files, so only pubspec is decisive). Shared by the extractor's
 * language detection AND the pubspec-gated framework-fleet registration
 * (framework/register.ts), so the "is this Dart?" answer has ONE source.
 */
export function hasDartManifest(repoDir: string): boolean {
  return DART_MANIFESTS.some((m) => existsSync(resolve(repoDir, m)));
}

/**
 * Does the repo root declare a PHP project? A `composer.json` / `composer.lock`.
 * Composer's `composer.json` is the single decisive PHP-repo manifest (a Laravel/
 * Symfony app's JS toolchain lives under a separate package.json for its bundler).
 * Shared by the extractor's language detection AND the composer.json-gated
 * framework-fleet registration (framework/register.ts), so the "is this PHP?"
 * answer — and the php-parser isolation gate — has ONE source. Cheap: existsSync.
 */
export function hasComposerManifest(repoDir: string): boolean {
  return PHP_MANIFESTS.some((m) => existsSync(resolve(repoDir, m)));
}

// Depth cap + skip set for the nested pubspec probe — mirrors MIX_PROBE_* above.
// Real Flutter apps sit 1-3 levels deep (a monorepo's `mobile/`/`app/`, a melos
// `packages/<child>`); 8 is generous. Skips build/vendor + dot dirs so a
// `.pub-cache/**/pubspec.yaml` can't fake it.
const PUB_PROBE_MAX_DEPTH = 8;
const PUB_PROBE_SKIP = new Set<string>([...EXCLUDE_DIRS, ...DART_EXCLUDE_DIRS]);

/**
 * Does the repo declare a Dart project ANYWHERE — the root OR a nested app / package?
 * A polyglot monorepo commonly keeps its Flutter app under a top-level `mobile/` /
 * `app/` dir (`mobile/pubspec.yaml`), which the root-only `hasDartManifest` misses. A
 * BOUNDED walk (skips build/vendor + dot dirs, depth-capped, EARLY-EXITS on the first
 * pubspec.yaml) finds it. Mirrors `hasMixManifestDeep`.
 *
 * The root-only `hasDartManifest` stays the graph-language selector (unchanged — a
 * nested-Dart repo already extracts via the dominant-source-count path); this broader
 * probe gates the Dart framework FLEET registration, so its adapters load + run for a
 * repo whose Dart lives below the root instead of silently no-op-ing. NEVER throws.
 */
export function hasDartManifestDeep(repoDir: string): boolean {
  if (hasDartManifest(repoDir)) return true; // cheap root check short-circuits
  const walk = (dir: string, depth: number): boolean => {
    if (depth > PUB_PROBE_MAX_DEPTH) return false;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false; // unreadable dir → skip subtree, never throw
    }
    if (entries.some((e) => e.isFile() && e.name === 'pubspec.yaml')) return true;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || PUB_PROBE_SKIP.has(e.name)) continue;
      if (walk(join(dir, e.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(resolve(repoDir), 0);
}

/**
 * Repo-relative POSIX paths of every source file for `lang` under `root`.
 * Walks the tree directly (the Pyright adapter needs an explicit file list; it
 * doesn't glob like ts-morph). Skips excluded + dot-prefixed directories and
 * never follows symlinks (a symlinked dir reports isDirectory() === false), so a
 * link into `.venv`/`site-packages` can't smuggle installed deps into the graph
 * or escape the repo — a load-bearing part of the install-free promise.
 */
export function listSourceFiles(root: string, lang: SourceLang): string[] {
  const absRoot = resolve(root);
  const excludes = new Set<string>(
    lang === 'python'
      ? PYTHON_EXCLUDE_DIRS
      : lang === 'ruby'
        ? RUBY_EXCLUDE_DIRS
        : lang === 'elixir'
          ? ELIXIR_EXCLUDE_DIRS
          : lang === 'dart'
            ? DART_EXCLUDE_DIRS
            : lang === 'php'
              ? PHP_EXCLUDE_DIRS
              : EXCLUDE_DIRS,
  );
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never fail the whole extraction
    }
    for (const ent of entries) {
      const abs = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || excludes.has(ent.name)) continue;
        walk(abs);
      } else if (ent.isFile()) {
        const id = relative(absRoot, abs).split(/[\\/]/).join('/');
        if (isSourceFilePath(id, lang)) out.push(id);
      }
      // symlinks (isDirectory/isFile both false) are intentionally skipped
    }
  };
  walk(absRoot);
  return out.sort();
}

/** Count source files per language under `root` (bounded walk short-circuits). */
function countSources(
  root: string,
  cap = 4000,
): { ts: number; python: number; ruby: number; elixir: number; dart: number; php: number } {
  let ts = 0;
  let python = 0;
  let ruby = 0;
  let elixir = 0;
  let dart = 0;
  let php = 0;
  const absRoot = resolve(root);
  const tsExcl = new Set<string>(EXCLUDE_DIRS);
  const pyExcl = new Set<string>(PYTHON_EXCLUDE_DIRS);
  const rbExcl = new Set<string>(RUBY_EXCLUDE_DIRS);
  const exExcl = new Set<string>(ELIXIR_EXCLUDE_DIRS);
  const dartExcl = new Set<string>(DART_EXCLUDE_DIRS);
  const phpExcl = new Set<string>(PHP_EXCLUDE_DIRS);
  const walk = (dir: string): void => {
    if (ts + python + ruby + elixir + dart + php >= cap) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ts + python + ruby + elixir + dart + php >= cap) return;
      const abs = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        // Skip a dir excluded by ANY language (or dot-prefixed) — the union keeps
        // the count cheap and can't misread vendored deps (node_modules, .venv,
        // vendor/bundle, deps/_build, .pub-cache) as source.
        if (
          ent.name.startsWith('.') ||
          tsExcl.has(ent.name) ||
          pyExcl.has(ent.name) ||
          rbExcl.has(ent.name) ||
          exExcl.has(ent.name) ||
          dartExcl.has(ent.name) ||
          phpExcl.has(ent.name)
        ) {
          continue;
        }
        walk(abs);
      } else if (ent.isFile()) {
        const id = relative(absRoot, abs).split(/[\\/]/).join('/');
        if (isSourceFilePath(id, 'ts')) ts++;
        else if (isSourceFilePath(id, 'python')) python++;
        else if (isSourceFilePath(id, 'ruby')) ruby++;
        else if (isSourceFilePath(id, 'elixir')) elixir++;
        else if (isSourceFilePath(id, 'dart')) dart++;
        else if (isSourceFilePath(id, 'php')) php++;
      }
    }
  };
  walk(absRoot);
  return { ts, python, ruby, elixir, dart, php };
}

/**
 * Pick the structural adapter language for `repoDir`. TS is the DEFAULT (the
 * pipeline's home turf); Python / Ruby / Elixir are selected only when the repo is
 * unambiguously that language. A single manifest with no competing manifest
 * decides cheaply (a Python-only manifest → Python, a Ruby-only manifest → Ruby, a
 * mix.exs-only repo → Elixir); a repo with several (a Rails app carries both a
 * Gemfile and a package.json for its JS bundler) or none falls back to a
 * source-file count, so the DOMINANT language wins — a Ruby-heavy Rails app or an
 * Elixir-heavy Phoenix app extracts as its own language even with a small JS
 * footprint.
 */
export function detectRepoLanguage(repoDir: string): SourceLang {
  const hasPy = PYTHON_MANIFESTS.some((m) => existsSync(resolve(repoDir, m)));
  const hasTs = TS_MANIFESTS.some((m) => existsSync(resolve(repoDir, m)));
  const hasRuby = hasRubyManifest(repoDir);
  const hasElixir = hasMixManifest(repoDir);
  const hasDart = hasDartManifest(repoDir);
  const hasPhp = hasComposerManifest(repoDir);
  if (hasPy && !hasTs && !hasRuby && !hasElixir && !hasDart && !hasPhp) return 'python';
  if (hasTs && !hasPy && !hasRuby && !hasElixir && !hasDart && !hasPhp) return 'ts';
  if (hasRuby && !hasTs && !hasPy && !hasElixir && !hasDart && !hasPhp) return 'ruby';
  if (hasElixir && !hasTs && !hasPy && !hasRuby && !hasDart && !hasPhp) return 'elixir';
  if (hasDart && !hasTs && !hasPy && !hasRuby && !hasElixir && !hasPhp) return 'dart';
  if (hasPhp && !hasTs && !hasPy && !hasRuby && !hasElixir && !hasDart) return 'php';
  return pickDominant(countSources(repoDir));
}

/**
 * The language with the most source files, ties resolving to the earliest of
 * [ts, python, ruby, elixir, dart] — so `ts` stays the default when nothing is
 * present (byte-identical to the pre-Ruby `python > ts ? 'python' : 'ts'`).
 */
function pickDominant(counts: {
  ts: number;
  python: number;
  ruby: number;
  elixir: number;
  dart: number;
  php: number;
}): SourceLang {
  const ranked: Array<[SourceLang, number]> = [
    ['ts', counts.ts],
    ['python', counts.python],
    ['ruby', counts.ruby],
    ['elixir', counts.elixir],
    ['dart', counts.dart],
    ['php', counts.php],
  ];
  let best: SourceLang = 'ts';
  let bestCount = -1;
  for (const [lang, n] of ranked) {
    if (n > bestCount) {
      best = lang;
      bestCount = n;
    }
  }
  return best;
}

// a language is only a FIRST-CLASS participant in the diagram when it has
// a MEANINGFUL presence — enough files (absolute) AND a big-enough share of the
// larger language. This keeps a TS repo shipping a couple of helper `.py` scripts
// (or a Python repo with a stray build script) extracting as a SINGLE language,
// byte-identical to before — only a genuinely polyglot repo (a TS frontend + a
// Python backend) triggers the multi-extract merge.
const MULTI_MIN_FILES = 5;
const MULTI_MIN_FRACTION = 0.15;

/**
 * The languages the pipeline should extract + merge for `repoDir`. Returns ONE
 * language for a single-language repo (identical to `detectRepoLanguage`, so no
 * behavior change), or BOTH — dominant first (deterministic) — for a genuinely
 * polyglot repo. The order is stable (count desc, then name) so the merged graph
 * is deterministic.
 */
export function detectRepoLanguages(repoDir: string): SourceLang[] {
  const { ts, python, ruby, elixir, dart, php } = countSources(repoDir);
  const all: Array<{ lang: SourceLang; count: number }> = [
    { lang: 'ts', count: ts },
    { lang: 'python', count: python },
    { lang: 'ruby', count: ruby },
    { lang: 'elixir', count: elixir },
    { lang: 'dart', count: dart },
    { lang: 'php', count: php },
  ];
  const counts = all.filter((l) => l.count > 0);
  if (counts.length <= 1) return [detectRepoLanguage(repoDir)];
  const max = Math.max(ts, python, ruby, elixir, dart, php);
  const present = counts.filter((l) => l.count >= MULTI_MIN_FILES && l.count / max >= MULTI_MIN_FRACTION);
  if (present.length <= 1) return [detectRepoLanguage(repoDir)];
  return present
    .sort((a, b) => b.count - a.count || (a.lang < b.lang ? -1 : 1))
    .map((l) => l.lang);
}

/** Per-file `language` tags the Elixir scanner emits (the extensions it parses). */
const ELIXIR_LANG_TAGS = new Set<string>(['ex', 'exs', 'eex', 'heex', 'leex']);

/** The language a NormalizedGraph was extracted in (derived from its file tags). */
export function graphLanguage(graph: NormalizedGraph): SourceLang {
  if (graph.files.some((f) => f.language === 'py' || f.language === 'pyi')) return 'python';
  if (graph.files.some((f) => f.language === 'rb')) return 'ruby';
  if (graph.files.some((f) => ELIXIR_LANG_TAGS.has(f.language))) return 'elixir';
  if (graph.files.some((f) => f.language === 'dart')) return 'dart';
  if (graph.files.some((f) => f.language === 'php')) return 'php';
  return 'ts';
}
