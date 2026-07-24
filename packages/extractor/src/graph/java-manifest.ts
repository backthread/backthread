// Java dependency-manifest reading — the analogue of kotlin-manifest.ts / php-manifest.ts.
// Reads the DIRECT dependency GROUPS a Java repo declares, WITHOUT installing or RUNNING
// anything (never-store-source; we ship no JVM/Maven/Gradle).
//
//   * Maven pom.xml — every `<groupId>…</groupId>` value (regex-scanned; XML, never
//     eval). A Maven multi-module project declares deps in each module's pom.xml, so the
//     walk UNIONS every pom.xml in the tree. A `${property}`-placeholder groupId is
//     skipped (unresolved). The GROUP (Maven groupId, dotted) is what we keep — a
//     dependency FAMILY, the bucket the extractor collapses externals into. The project's
//     OWN groupId is captured too; that's harmless — a first-party reference is dropped by
//     the adapter's internal-package check BEFORE external bucketing ever runs.
//   * Gradle build.gradle(.kts) + gradle/libs.versions.toml — a Gradle-based Java repo
//     declares its dependency coordinates EXACTLY as a Kotlin/Gradle repo does (Gradle
//     is a JVM build tool, not a Kotlin one), so the language-agnostic JVM coordinate
//     reader (`readGradleDepsDeep`) is reused here rather than duplicated.
//
// Groups only (Maven groups are dotted: `org.springframework` / `com.google.guava`).
// PURE + never-throws (a missing/malformed manifest degrades to whatever the others yield).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readGradleDepsDeep } from './kotlin-manifest.js';

// `<groupId>org.springframework.boot</groupId>` — captures the dotted group, tolerant of
// whitespace/newlines inside the tag. `[^<>\s]` keeps the capture to a single token; a
// `${…}` placeholder or a non-coordinate value is filtered by the caller.
const GROUP_ID_RE = /<groupId>\s*([^<>\s]+?)\s*<\/groupId>/g;
// A well-formed Maven/Gradle coordinate group: dotted lowercase-ish segments.
const COORD_GROUP_RE = /^[A-Za-z0-9_.-]+$/;

/** Maven groupIds from one pom.xml text (regex, never eval). Skips `${property}` refs. */
export function parsePomGroups(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(GROUP_ID_RE)) {
    const g = m[1];
    if (g.includes('$')) continue; // unresolved ${project.groupId}-style placeholder
    if (COORD_GROUP_RE.test(g)) out.push(g);
  }
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

// Build/vendor/tool dirs the repo-wide pom walk skips — mirrors JAVA_EXCLUDE_DIRS. None
// hold a first-party pom.xml that declares application dependencies.
const POM_WALK_SKIP = new Set<string>([
  'target',
  'build',
  '.gradle',
  '.idea',
  'node_modules',
  'out',
  '.git',
]);
const POM_WALK_MAX_DEPTH = 8;

/**
 * The UNION of Maven groupIds declared by EVERY pom.xml in the repo — a multi-module
 * Maven project declares its deps per-module (`service/pom.xml`), so a root-only read can
 * miss a submodule-only dep. A BOUNDED walk (skips build/vendor + dot dirs, depth-capped).
 * NEVER throws.
 */
export function readPomGroupsDeep(repoDir: string): Set<string> {
  const groups = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > POM_WALK_MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir → skip subtree, never throw
    }
    for (const e of entries) {
      if (e.isFile() && e.name === 'pom.xml') {
        for (const g of parsePomGroups(readOr(join(dir, e.name)))) groups.add(g);
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || POM_WALK_SKIP.has(e.name)) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(repoDir, 0);
  return groups;
}

/**
 * The set of DIRECT dependency GROUPS a Java project declares at `repoDir` — the union of
 * its pom.xml groupIds (Maven) and its Gradle coordinate groups (build.gradle(.kts) +
 * `gradle/libs.versions.toml`). Membership is the longest-group-prefix bucket the
 * extractor collapses externals into. Never throws.
 */
export function readJavaDeps(repoDir: string): Set<string> {
  const groups = readPomGroupsDeep(repoDir);
  for (const g of readGradleDepsDeep(repoDir)) groups.add(g);
  return groups;
}
