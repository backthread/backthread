// PHP dependency-manifest reading — the analogue of ruby-manifest.ts's readRubyDeps
// and python-manifest.ts's readPythonDeps. Reads the DIRECT Composer dependencies a
// repo declares, WITHOUT installing or running anything (never-store-source; the
// framework adapters ask membership — "does this repo require laravel/framework /
// symfony/framework-bundle / doctrine/orm?"). PURE + never-throws: a malformed
// manifest degrades to whatever the other source yields.
//
//   * composer.json — `require` + `require-dev` object KEYS (the declared deps).
//   * composer.lock — `packages[].name` + `packages-dev[].name` (the resolved set).
//
// composer.json is a proper JSON document (unlike the Ruby Gemfile DSL / Elixir
// mix.exs), so it's JSON.parse-d, never evaluated. Platform packages (`php`,
// `ext-*`, `lib-*`) are dropped — they pin a runtime, not a package.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlatformPackage } from './php-stdlib.js';

/** Parse a JSON file under `baseDir`, or `undefined` on any read/parse error. */
function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The parsed composer.json object (or `{}` when absent/malformed). Shared by the
 *  extractor (for the PSR-4 autoload map) and the dep reader. Never throws. */
export function readComposerJson(baseDir: string): unknown {
  return readJson(join(baseDir, 'composer.json')) ?? {};
}

/** The string KEYS of a composer require object (`{ "laravel/framework": "^11" }`). */
function requireKeys(section: unknown): string[] {
  if (!section || typeof section !== 'object') return [];
  return Object.keys(section as Record<string, unknown>);
}

/** The `name` fields of a composer.lock packages array. */
function lockPackageNames(packages: unknown): string[] {
  if (!Array.isArray(packages)) return [];
  const out: string[] = [];
  for (const p of packages) {
    if (p && typeof p === 'object' && typeof (p as Record<string, unknown>).name === 'string') {
      out.push((p as Record<string, string>).name);
    }
  }
  return out;
}

/**
 * Every DIRECT Composer dependency name (lowercased) a repo under `baseDir`
 * declares, across composer.json (`require` + `require-dev`) ∪ composer.lock
 * (`packages` + `packages-dev`). Platform packages are dropped. Never throws.
 * Detection asks membership (`deps.has('laravel/framework')`), so only names are
 * returned.
 */
export function readComposerDeps(baseDir: string): Set<string> {
  const names = new Set<string>();
  const add = (n: string): void => {
    const lower = n.toLowerCase();
    if (!isPlatformPackage(lower)) names.add(lower);
  };

  const composer = readJson(join(baseDir, 'composer.json'));
  if (composer && typeof composer === 'object') {
    const c = composer as Record<string, unknown>;
    for (const k of requireKeys(c['require'])) add(k);
    for (const k of requireKeys(c['require-dev'])) add(k);
  }

  const lock = readJson(join(baseDir, 'composer.lock'));
  if (lock && typeof lock === 'object') {
    const l = lock as Record<string, unknown>;
    for (const n of lockPackageNames(l['packages'])) add(n);
    for (const n of lockPackageNames(l['packages-dev'])) add(n);
  }

  return names;
}
