// Ruby dependency-manifest reading — the analogue of python-manifest.ts's
// readPythonDeps. Reads the DIRECT gem dependencies a repo declares, from the
// three places Ruby projects declare them, WITHOUT installing or running anything
// (never-store-source; the framework adapters ask membership — "does this repo
// declare rails / sidekiq / graphql?"). PURE + never-throws: a malformed manifest
// degrades to whatever the others yield.
//
//   * Gemfile         — `gem 'name'` lines (Bundler DSL; grouped/platform gems too).
//   * *.gemspec       — `spec.add_dependency 'name'` (+ runtime/development variants).
//   * Gemfile.lock    — the DEPENDENCIES section (the resolved DIRECT deps).
//
// Regex-scanned rather than Prism-parsed: the shapes are simple + conventional,
// and detection must stay cheap (no WASM parser load just to read a dep list).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Read a file and hand its text to `cb`; silently skip an absent/unreadable file. */
function withText(path: string, cb: (text: string) => void): void {
  try {
    if (existsSync(path)) cb(readFileSync(path, 'utf8'));
  } catch {
    // unreadable — skip this source
  }
}

/** The DEPENDENCIES section of a Gemfile.lock (the direct deps, indented under
 *  the `DEPENDENCIES` header, each `  name (constraint)` optionally with a `!`). */
export function parseLockDependencies(text: string): string[] {
  const out: string[] = [];
  let inDeps = false;
  for (const line of text.split('\n')) {
    if (/^DEPENDENCIES\s*$/.test(line)) {
      inDeps = true;
      continue;
    }
    if (!inDeps) continue;
    if (line.trim() === '' || /^\S/.test(line)) break; // blank / next top-level section ends it
    const m = /^\s+([A-Za-z0-9._-]+)/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Every DIRECT gem dependency name (lowercased) a repo under `baseDir` declares,
 * across Gemfile + *.gemspec + Gemfile.lock. Never throws. Detection asks
 * membership (`deps.has('rails')`), so only names are returned.
 */
export function readRubyDeps(baseDir: string): Set<string> {
  const names = new Set<string>();
  const add = (n: string | undefined): void => {
    if (n) names.add(n.toLowerCase());
  };

  // Gemfile — `gem 'name'` (single or double quotes), anywhere (incl. group blocks).
  withText(join(baseDir, 'Gemfile'), (text) => {
    for (const m of text.matchAll(/^\s*gem\s+['"]([A-Za-z0-9._-]+)['"]/gm)) add(m[1]);
  });

  // *.gemspec — add_dependency / add_runtime_dependency / add_development_dependency.
  let entries: string[] = [];
  try {
    entries = readdirSync(baseDir);
  } catch {
    entries = [];
  }
  for (const f of entries) {
    if (!f.endsWith('.gemspec')) continue;
    withText(join(baseDir, f), (text) => {
      for (const m of text.matchAll(
        /\.add(?:_runtime|_development)?_dependency\s*\(?\s*['"]([A-Za-z0-9._-]+)['"]/g,
      )) {
        add(m[1]);
      }
    });
  }

  // Gemfile.lock — the resolved DIRECT deps (the DEPENDENCIES section).
  withText(join(baseDir, 'Gemfile.lock'), (text) => {
    for (const n of parseLockDependencies(text)) add(n);
  });

  return names;
}
