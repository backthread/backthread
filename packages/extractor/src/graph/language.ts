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
  EXCLUDE_DIRS,
  type SourceLang,
} from './file-graph.js';

const PYTHON_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'];
const TS_MANIFESTS = ['package.json', 'tsconfig.json', 'tsconfig.base.json', 'jsconfig.json'];

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
  const excludes = new Set<string>(lang === 'python' ? PYTHON_EXCLUDE_DIRS : EXCLUDE_DIRS);
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
function countSources(root: string, cap = 4000): { ts: number; python: number } {
  let ts = 0;
  let python = 0;
  const absRoot = resolve(root);
  const tsExcl = new Set<string>(EXCLUDE_DIRS);
  const pyExcl = new Set<string>(PYTHON_EXCLUDE_DIRS);
  const walk = (dir: string): void => {
    if (ts + python >= cap) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ts + python >= cap) return;
      const abs = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        // Skip a dir excluded by EITHER language (or dot-prefixed) — the union
        // keeps the count cheap and can't misread vendored deps as source.
        if (ent.name.startsWith('.') || tsExcl.has(ent.name) || pyExcl.has(ent.name)) continue;
        walk(abs);
      } else if (ent.isFile()) {
        const id = relative(absRoot, abs).split(/[\\/]/).join('/');
        if (isSourceFilePath(id, 'ts')) ts++;
        else if (isSourceFilePath(id, 'python')) python++;
      }
    }
  };
  walk(absRoot);
  return { ts, python };
}

/**
 * Pick the structural adapter language for `repoDir`. TS is the DEFAULT (the
 * pipeline's home turf); Python is selected only when the repo is unambiguously
 * Python. Manifests decide the clear cases cheaply (a Python-only manifest with
 * no TS manifest → Python, and vice versa); a repo with both (or neither) falls
 * back to a source-file count, so a TS app that merely ships a helper `.py`
 * script still extracts as TS.
 */
export function detectRepoLanguage(repoDir: string): SourceLang {
  const hasPy = PYTHON_MANIFESTS.some((m) => existsSync(resolve(repoDir, m)));
  const hasTs = TS_MANIFESTS.some((m) => existsSync(resolve(repoDir, m)));
  if (hasPy && !hasTs) return 'python';
  if (hasTs && !hasPy) return 'ts';
  const { ts, python } = countSources(repoDir);
  return python > ts ? 'python' : 'ts';
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
  const { ts, python } = countSources(repoDir);
  const all: Array<{ lang: SourceLang; count: number }> = [
    { lang: 'ts', count: ts },
    { lang: 'python', count: python },
  ];
  const counts = all.filter((l) => l.count > 0);
  if (counts.length <= 1) return [detectRepoLanguage(repoDir)];
  const max = Math.max(ts, python);
  const present = counts.filter((l) => l.count >= MULTI_MIN_FILES && l.count / max >= MULTI_MIN_FRACTION);
  if (present.length <= 1) return [detectRepoLanguage(repoDir)];
  return present
    .sort((a, b) => b.count - a.count || (a.lang < b.lang ? -1 : 1))
    .map((l) => l.lang);
}

/** The language a NormalizedGraph was extracted in (derived from its file tags). */
export function graphLanguage(graph: NormalizedGraph): SourceLang {
  return graph.files.some((f) => f.language === 'py' || f.language === 'pyi') ? 'python' : 'ts';
}
