// Swift dependency + SPM-target manifest reading — the analogue of
// elixir-manifest.ts / ruby-manifest.ts. Reads what a Swift repo DECLARES about its
// dependencies and its SwiftPM targets, WITHOUT installing or RUNNING anything.
//
//   * Package.swift    — SwiftPM's manifest. It IS Swift code, so it is NEVER
//                        EVALUATED (that would execute arbitrary repo code + need a
//                        Swift toolchain we don't ship). Instead the `.package(…)`
//                        and `.target(…)` DSL calls are matched SYNTACTICALLY: a
//                        `.package(url:/name:/id:)` names a dependency; a
//                        `.target(name:,path:)` (+ executable/test/macro/plugin
//                        variants) names a first-party module + its source dir. This
//                        is robust to conditional target lists (an `#if`-guarded
//                        target) — a regex captures both branches where an evaluator
//                        would run only one. Computed `targets:` arrays (a `.map`
//                        over a list) are missed → the adapter's feature-folder
//                        fallback covers them (a documented degrade).
//   * Package.resolved — the resolved dependency PINS (JSON: v1 `object.pins[].package`
//                        or v2 `pins[].identity`). Dep NAMES only.
//   * Podfile          — CocoaPods `pod 'Name'` lines. Dep NAMES only.
//
// Dep names feed FRAMEWORK DETECTION (does the repo declare `vapor`?). Target names
// feed the extractor (an `import <Target>` is a first-party cross-module edge, not an
// external) + subsystem grouping (target = subsystem). PURE + never-throws.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Balanced-paren helpers (shared by the .package / .target scanners).

/**
 * The substring of `text` inside the parentheses that OPEN at `openParenIdx`
 * (which must index a `(`), up to its matching `)`. Paren-balanced (nested `(`/`)`
 * counted); brackets/braces are passed through. Returns '' if unbalanced. Pure.
 */
function balancedParens(text: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return text.slice(openParenIdx + 1, i);
    }
  }
  return '';
}

/**
 * Find the string value of `label:` (e.g. `name`, `url`, `path`) at BRACKET-DEPTH 0
 * of `args` — i.e. a top-level argument of this DSL call, not one nested inside a
 * `dependencies: [.product(name: …)]` array/paren. Returns undefined when absent.
 */
function stringArgAtTop(args: string, label: string): string | undefined {
  let depth = 0;
  const re = new RegExp(`^${label}\\s*:\\s*"([^"]*)"`);
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && (c === label[0])) {
      const m = args.slice(i).match(re);
      if (m) return m[1];
    }
  }
  return undefined;
}

/** Every index in `text` where the token `call` (e.g. `.target(`) begins. */
function callSites(text: string, call: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(call, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + call.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependencies (framework detection).

/** The last path segment of a git URL, minus a trailing `.git` (`.../vapor.git` → `vapor`). */
function repoNameFromUrl(url: string): string {
  const noGit = url.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  const seg = noGit.split('/').pop() ?? noGit;
  return seg;
}

/** Dep identifiers declared by a Package.swift's `.package(url:/name:/id:/path:)` calls. */
export function parsePackageSwiftDeps(text: string): string[] {
  const out: string[] = [];
  for (const kind of ['.package(']) {
    for (const idx of callSites(text, kind)) {
      const open = idx + kind.length - 1;
      const args = balancedParens(text, open);
      // Skip a `.package(...)` that is really a `.product`/`.target` dependency
      // reference living inside a target — those don't have `url:`/`id:`; only the
      // top-level dependency declarations do. `name:`-only local packages count too.
      const url = stringArgAtTop(args, 'url');
      const id = stringArgAtTop(args, 'id');
      const name = stringArgAtTop(args, 'name');
      const path = stringArgAtTop(args, 'path');
      if (url) out.push(repoNameFromUrl(url));
      else if (id) out.push(id.split('.').pop() ?? id); // registry id `scope.name` → name
      else if (name) out.push(name);
      else if (path) out.push(repoNameFromUrl(path));
    }
  }
  return out;
}

/** Dep identities from a Package.resolved (v1 `object.pins[].package`, v2 `pins[].identity`). */
export function parsePackageResolvedDeps(text: string): string[] {
  try {
    const json = JSON.parse(text) as {
      pins?: Array<{ identity?: string; package?: string; location?: string }>;
      object?: { pins?: Array<{ package?: string; identity?: string; repositoryURL?: string }> };
    };
    const pins = json.pins ?? json.object?.pins ?? [];
    const out: string[] = [];
    for (const p of pins) {
      const id = p.identity ?? p.package;
      if (id) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

// A CocoaPods `pod 'Name'` / `pod "Name/Subspec"` line — the pod name (subspec dropped).
const POD_RE = /^\s*pod\s+['"]([^'"/]+)/gm;

/** Pod names declared by a Podfile. */
export function parsePodfileDeps(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(POD_RE)) out.push(m[1]);
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
 * The set of DIRECT dependency identifiers a repo declares — the union of
 * Package.swift `.package` calls, Package.resolved pins, and Podfile `pod` lines,
 * LOWERCASED (SwiftPM identities are case-insensitive; a Vapor detect checks
 * `deps.has('vapor')`). Membership is what the framework adapters gate on. Never
 * throws; a missing/malformed manifest degrades to whatever the others yield.
 */
export function readSwiftDeps(baseDir: string): Set<string> {
  const deps = new Set<string>();
  const add = (name: string): void => {
    const n = name.trim().toLowerCase();
    if (n) deps.add(n);
  };
  for (const name of parsePackageSwiftDeps(readOr(join(baseDir, 'Package.swift')))) add(name);
  for (const name of parsePackageResolvedDeps(readOr(join(baseDir, 'Package.resolved')))) add(name);
  for (const name of parsePodfileDeps(readOr(join(baseDir, 'Podfile')))) add(name);
  return deps;
}

// ---------------------------------------------------------------------------
// SPM targets (first-party modules + their source dirs).

/** A first-party SwiftPM target: its module NAME + the repo-relative posix dir its
 *  sources live under (SwiftPM convention or the explicit `path:`). */
export interface SwiftTarget {
  name: string;
  /** Repo-relative posix source dir (no trailing slash), '' only for a root path:. */
  dir: string;
}

// The target-declaring DSL calls (name-carrying + swift-source-bearing). `.macro`
// (SwiftSyntax compiler plugins) + `.plugin` carry swift sources; binaryTarget /
// systemLibrary don't, so they're excluded (no first-party swift to group).
const TARGET_CALLS: Array<{ call: string; testDir: boolean }> = [
  { call: '.target(', testDir: false },
  { call: '.executableTarget(', testDir: false },
  { call: '.testTarget(', testDir: true },
  { call: '.macro(', testDir: false },
  { call: '.plugin(', testDir: false },
];

/** Join two repo-relative posix path parts, dropping empties + a leading `./`. */
function joinPosix(a: string, b: string): string {
  const parts = [...a.split('/'), ...b.split('/')].filter((s) => s && s !== '.');
  return parts.join('/');
}

/**
 * Parse the SwiftPM targets from ONE Package.swift's text, resolved against
 * `pkgDir` (the manifest's repo-relative posix dir; '' for the root manifest). A
 * target's source dir is its explicit `path:` (relative to pkgDir) or the SwiftPM
 * convention `Sources/<name>` (`Tests/<name>` for a test target), also under
 * pkgDir. Never eval — pure syntactic scan of the `.target(…)` DSL.
 */
export function parsePackageSwiftTargets(text: string, pkgDir = ''): SwiftTarget[] {
  const out: SwiftTarget[] = [];
  const seen = new Set<string>();
  for (const { call, testDir } of TARGET_CALLS) {
    for (const idx of callSites(text, call)) {
      const open = idx + call.length - 1;
      const args = balancedParens(text, open);
      const name = stringArgAtTop(args, 'name');
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const explicitPath = stringArgAtTop(args, 'path');
      const rel = explicitPath ?? `${testDir ? 'Tests' : 'Sources'}/${name}`;
      out.push({ name, dir: joinPosix(pkgDir, rel) });
    }
  }
  return out;
}

// Build/vendor/tool + Xcode-container dirs the multi-manifest walk skips.
const WALK_SKIP = new Set<string>(['.build', 'Pods', 'DerivedData', 'Carthage', 'node_modules', '.git']);
const WALK_MAX_DEPTH = 8;

function isXcodeContainer(name: string): boolean {
  return (
    name.endsWith('.xcodeproj') ||
    name.endsWith('.xcworkspace') ||
    name.endsWith('.xcassets') ||
    name.endsWith('.playground')
  );
}

/**
 * Every first-party SwiftPM target in the repo — the UNION across the root
 * Package.swift AND every nested one (an SPM monorepo keeps sibling packages in
 * nested `Package.swift` files, e.g. under `Frameworks/Foo/`). A BOUNDED walk
 * (skips build/vendor + Xcode-container + dot dirs, depth-capped) finds each
 * Package.swift and parses its targets against that manifest's dir. NEVER throws (an
 * unreadable dir skips its subtree). Deterministic (dirs visited in sorted order).
 */
export function readSwiftTargets(repoDir: string): SwiftTarget[] {
  const out: SwiftTarget[] = [];
  const seenNames = new Set<string>();
  const walk = (absDir: string, relDir: string, depth: number): void => {
    if (depth > WALK_MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'Package.swift')) {
      const text = readOr(join(absDir, 'Package.swift'));
      for (const t of parsePackageSwiftTargets(text, relDir)) {
        if (seenNames.has(t.name)) continue; // first (sorted) manifest wins a dup name
        seenNames.add(t.name);
        out.push(t);
      }
    }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory() || e.name.startsWith('.') || WALK_SKIP.has(e.name) || isXcodeContainer(e.name)) {
        continue;
      }
      walk(join(absDir, e.name), joinPosix(relDir, e.name), depth + 1);
    }
  };
  walk(repoDir, '', 0);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
