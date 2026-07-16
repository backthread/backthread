// Kotlin/Gradle dependency-manifest reading — the analogue of elixir-manifest.ts /
// ruby-manifest.ts. Reads the DIRECT dependencies a Gradle repo declares, WITHOUT
// installing or RUNNING anything. Gradle build scripts are Groovy / Kotlin DSL (code);
// running them would execute arbitrary repo code (violating never-store-source) and
// needs a JVM + Gradle we don't ship — so coordinates are matched SYNTACTICALLY.
//
//   * build.gradle / build.gradle.kts — dependency-coordinate string literals
//     (`"io.ktor:ktor-server-core:2.3.0"`, Groovy or Kotlin DSL), regex-scanned. The
//     GROUP (the part before the first `:`) is what we keep — a dependency FAMILY, the
//     bucket the extractor collapses externals into and the token framework adapters
//     gate on. `project(':core')` internal deps are stripped first (not third-party).
//   * gradle/libs.versions.toml `[libraries]` — the Gradle version catalog, parsed with
//     `smol-toml` (already a dep). Each entry names a coordinate (string shorthand,
//     `{ module = "g:a" }`, or `{ group = "g", name = "a" }`); its group is kept. On a
//     multi-module repo the root catalog lists every library, so reading it at the root
//     already captures the whole declared-dependency set.
//
// Groups only (Maven groups are dotted, `io.ktor` / `androidx.room`). Membership is what
// the framework adapters gate on and the longest-group-prefix bucket the extractor uses.
// PURE + never-throws (a missing/malformed manifest degrades to whatever the others yield).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

// A dependency coordinate string literal `"group:artifact[:version]"` (Groovy `'…'` or
// Kotlin `"…"`). Captures the GROUP. `[\w.-]` covers dotted groups + hyphenated
// artifacts; a leading `:` (a `project(':core')` path) can't match (needs a word char
// before the first `:`), and project() deps are stripped before this runs anyway.
const COORD_RE = /["']([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::[^"']*)?["']/g;
// A `project(':core:common')` / `project(path: ':x')` internal dependency — stripped so
// its `:core:common` module path is never misread as a `group:artifact` coordinate.
const PROJECT_DEP_RE = /project\s*\([^)]*\)/g;

/** Dependency-coordinate groups from a build.gradle(.kts) text (regex, never eval). */
export function parseGradleBuildGroups(text: string): string[] {
  const out: string[] = [];
  const cleaned = text.replace(PROJECT_DEP_RE, ' ');
  for (const m of cleaned.matchAll(COORD_RE)) out.push(m[1]);
  return out;
}

/** Dependency-coordinate groups from a gradle/libs.versions.toml `[libraries]` table. */
export function parseVersionCatalogGroups(text: string): string[] {
  if (text.trim() === '') return [];
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch {
    return []; // malformed catalog → contribute nothing
  }
  const libs = (doc as Record<string, unknown> | null)?.['libraries'];
  if (!libs || typeof libs !== 'object' || Array.isArray(libs)) return [];
  const out: string[] = [];
  for (const entry of Object.values(libs as Record<string, unknown>)) {
    const g = catalogEntryGroup(entry);
    if (g) out.push(g);
  }
  return out;
}

/** The group of one `[libraries]` entry: string shorthand, `{module}`, or `{group}`. */
function catalogEntryGroup(entry: unknown): string | undefined {
  if (typeof entry === 'string') {
    // "group:artifact:version" shorthand
    const parts = entry.split(':');
    return parts.length >= 2 && parts[0] ? parts[0] : undefined;
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const o = entry as Record<string, unknown>;
    if (typeof o.group === 'string' && o.group.trim()) return o.group.trim();
    if (typeof o.module === 'string') {
      const g = o.module.split(':')[0];
      return g ? g : undefined;
    }
  }
  return undefined;
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
 * The set of DIRECT dependency GROUPS a Gradle project declares at `baseDir` — the
 * union of its build.gradle(.kts) coordinate groups and its `gradle/libs.versions.toml`
 * `[libraries]` groups. Membership is what the framework adapters gate on; the extractor
 * buckets externals by longest matching group. Never throws.
 */
export function readGradleDeps(baseDir: string): Set<string> {
  const groups = new Set<string>();
  for (const f of ['build.gradle', 'build.gradle.kts']) {
    for (const g of parseGradleBuildGroups(readOr(join(baseDir, f)))) groups.add(g);
  }
  for (const g of parseVersionCatalogGroups(readOr(join(baseDir, 'gradle/libs.versions.toml')))) {
    groups.add(g);
  }
  return groups;
}

// Build/vendor/tool dirs the repo-wide walk skips — mirrors KOTLIN_EXCLUDE_DIRS. None
// hold a first-party build script that declares app dependencies.
const DEEP_WALK_SKIP_DIRS = new Set<string>([
  'build',
  '.gradle',
  '.idea',
  '.kotlin',
  'buildSrc',
  'build-logic',
  'node_modules',
  'dist',
  'out',
]);
const DEEP_WALK_MAX_DEPTH = 8;

/**
 * The UNION of DIRECT dependency groups declared by EVERY build.gradle(.kts) in the repo
 * (+ the root version catalog) — a Gradle multi-module project declares its deps in each
 * module's build script (`feature/foo/build.gradle.kts`), so the root-only read can miss
 * a submodule-only dep. A BOUNDED walk (skips build/vendor + dot dirs, depth-capped).
 * On a single-module repo this equals `readGradleDeps(repoDir)`, so adapters use it only
 * as a fallback after a root scan misses. NEVER throws.
 */
export function readGradleDepsDeep(repoDir: string): Set<string> {
  const groups = new Set<string>();
  // The root catalog lists every library in a multi-module project — read it once.
  for (const g of parseVersionCatalogGroups(readOr(join(repoDir, 'gradle/libs.versions.toml')))) {
    groups.add(g);
  }
  const walk = (dir: string, depth: number): void => {
    if (depth > DEEP_WALK_MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir → skip subtree, never throw
    }
    for (const e of entries) {
      if (e.isFile() && (e.name === 'build.gradle' || e.name === 'build.gradle.kts')) {
        for (const g of parseGradleBuildGroups(readOr(join(dir, e.name)))) groups.add(g);
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || DEEP_WALK_SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(repoDir, 0);
  return groups;
}

// A Gradle module path declared as a LEADING-COLON quoted token — `":feature:foo"` /
// `":app"`. The leading `:` is the reliable module-path marker (Gradle `include(":a:b")`
// and Groovy `include ':a:b'` both use it), which disambiguates a module from a settings
// script's other quoted strings (`rootProject.name = "x"`, a plugin id `"com.foo"`) —
// none of which carry a leading colon. `:feature:foo` → `feature/foo`.
const INCLUDE_MODULE_RE = /["']:([A-Za-z0-9_.:-]+)["']/g;

/**
 * The module paths a `settings.gradle(.kts)` declares — every leading-colon quoted token
 * (`":feature:foo"`), mapped to the repo-relative dir `feature/foo` (drop the leading
 * colon, remaining colons → slashes). Handles the Kotlin `include(":a:b")` and Groovy
 * `include ':a:b'` forms, single- or multi-line `include(...)` blocks alike (the scan is
 * whole-text, keyed off the leading colon rather than the `include` keyword). Regex,
 * never eval. Deduped + sorted for determinism. A `project(':x').projectDir = …` remap
 * (rare) is not followed (accepted degrade).
 */
export function parseSettingsIncludes(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(INCLUDE_MODULE_RE)) {
    const path = m[1].split(':').filter(Boolean).join('/');
    if (path) out.add(path);
  }
  return [...out].sort();
}
