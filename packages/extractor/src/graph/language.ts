// Language detection + source-file enumeration for the extractor dispatch
//. The pipeline runs ONE structural adapter per repo; this module
// decides which (ts-morph vs Pyright) and, for the Pyright path, hands it the
// explicit list of first-party source files to parse.
//
// IMPURE by design (reads the filesystem) — kept OUT of file-graph.ts, which is
// the pure source-path policy. This module composes that policy (isSourceFilePath,
// the exclude sets) with real fs walks.

import { readdirSync, existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { NormalizedGraph } from './types.js';
import {
  isSourceFilePath,
  PYTHON_EXCLUDE_DIRS,
  RUBY_EXCLUDE_DIRS,
  ELIXIR_EXCLUDE_DIRS,
  EXCLUDE_DIRS,
  type SourceLang,
} from './file-graph.js';

const PYTHON_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'];
const TS_MANIFESTS = ['package.json', 'tsconfig.json', 'tsconfig.base.json', 'jsconfig.json'];
const RUBY_MANIFESTS = ['Gemfile', 'Gemfile.lock'];
// Mix is Elixir's build tool; `mix.exs` (the project file) + `mix.lock` (the
// resolved dep pins) are the unambiguous Elixir-repo manifests.
const ELIXIR_MANIFESTS = ['mix.exs', 'mix.lock'];

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
): { ts: number; python: number; ruby: number; elixir: number } {
  let ts = 0;
  let python = 0;
  let ruby = 0;
  let elixir = 0;
  const absRoot = resolve(root);
  const tsExcl = new Set<string>(EXCLUDE_DIRS);
  const pyExcl = new Set<string>(PYTHON_EXCLUDE_DIRS);
  const rbExcl = new Set<string>(RUBY_EXCLUDE_DIRS);
  const exExcl = new Set<string>(ELIXIR_EXCLUDE_DIRS);
  const walk = (dir: string): void => {
    if (ts + python + ruby + elixir >= cap) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ts + python + ruby + elixir >= cap) return;
      const abs = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        // Skip a dir excluded by ANY language (or dot-prefixed) — the union keeps
        // the count cheap and can't misread vendored deps (node_modules, .venv,
        // vendor/bundle, deps/_build) as source.
        if (
          ent.name.startsWith('.') ||
          tsExcl.has(ent.name) ||
          pyExcl.has(ent.name) ||
          rbExcl.has(ent.name) ||
          exExcl.has(ent.name)
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
      }
    }
  };
  walk(absRoot);
  return { ts, python, ruby, elixir };
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
  if (hasPy && !hasTs && !hasRuby && !hasElixir) return 'python';
  if (hasTs && !hasPy && !hasRuby && !hasElixir) return 'ts';
  if (hasRuby && !hasTs && !hasPy && !hasElixir) return 'ruby';
  if (hasElixir && !hasTs && !hasPy && !hasRuby) return 'elixir';
  return pickDominant(countSources(repoDir));
}

/**
 * The language with the most source files, ties resolving to the earliest of
 * [ts, python, ruby, elixir] — so `ts` stays the default when nothing is present
 * (byte-identical to the pre-Ruby `python > ts ? 'python' : 'ts'`).
 */
function pickDominant(counts: {
  ts: number;
  python: number;
  ruby: number;
  elixir: number;
}): SourceLang {
  const ranked: Array<[SourceLang, number]> = [
    ['ts', counts.ts],
    ['python', counts.python],
    ['ruby', counts.ruby],
    ['elixir', counts.elixir],
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
  const { ts, python, ruby, elixir } = countSources(repoDir);
  const all: Array<{ lang: SourceLang; count: number }> = [
    { lang: 'ts', count: ts },
    { lang: 'python', count: python },
    { lang: 'ruby', count: ruby },
    { lang: 'elixir', count: elixir },
  ];
  const counts = all.filter((l) => l.count > 0);
  if (counts.length <= 1) return [detectRepoLanguage(repoDir)];
  const max = Math.max(ts, python, ruby, elixir);
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
  return 'ts';
}
