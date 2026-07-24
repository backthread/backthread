// Stage A — the PURE file-level graph model behind diff-driven
// incremental extraction.
//
// The per-merge walk used to run a FULL ts-morph extract of the whole
// repo at EVERY checkpoint — O(repo) per merge, which blew the 10-min container
// watchdog on a busy repo. Stage A makes the walk carry a FILE-LEVEL
// graph in memory: seed it once (full extract, or the extraction_cache's
// serialized copy), then per checkpoint patch it from `git diff --name-status`
// — re-running the EXPENSIVE extraction (ts-morph symbol resolution for call
// edges) only on the files the merge actually touched (+ the dependents that
// can observe the change; see computeCallPatchUnit).
//
// This module is deliberately PURE (no git, no ts-morph, no fs): the state
// shape, the NormalizedGraph assembly, the diff classification, the dependents
// closure, and the (de)serialization that rides in extraction_cache. The impure
// engine that owns the ts-morph Project lives in incremental.ts.
//
// EQUIVALENCE CONTRACT (load-bearing): a patched state at commit N must produce
// the SAME NormalizedGraph a full extract at N would — guarded by the fixture
// test in incremental-equivalence.test.ts. If you change edge semantics here or
// in the adapter, change BOTH sides and re-run that test.

import type { NormalizedGraph, ExternalNode, GraphEdge } from './types.js';

// ---------------------------------------------------------------------------
// Source-path policy — MUST mirror each language adapter's glob semantics.

/**
 * The extractor languages the pipeline supports. The dispatch (graph/extract.ts)
 * picks ONE per repo; every source-path predicate below is parameterized by it so
 * a single implementation serves the ts-morph (TS), Pyright (Python), Prism
 * (Ruby), and the hand-rolled Elixir + Swift adapters. `ts` is the default
 * everywhere the caller can't yet supply a language (the incremental diff
 * classifier is TS-only today).
 */
export type SourceLang = 'ts' | 'python' | 'ruby' | 'elixir' | 'dart' | 'php' | 'kotlin' | 'swift' | 'java';

/** TS/JS source extensions the ts-morph adapter parses (mirror of its SOURCE_GLOBS). */
export const SOURCE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'] as const;

/** Python source extensions the Pyright adapter parses (module + stub files). */
export const PYTHON_SOURCE_EXTENSIONS = ['py', 'pyi'] as const;

/**
 * Ruby source extensions the Prism adapter parses: `.rb` modules, `.rake` tasks,
 * and `.ru` rackup files. A `Rakefile` (extension-less) is also Ruby source —
 * matched by RUBY_SOURCE_BASENAMES below. `Gemfile` / `*.gemspec` are MANIFESTS
 * (dependency declarations), not graph nodes, so they're deliberately excluded.
 */
export const RUBY_SOURCE_EXTENSIONS = ['rb', 'rake', 'ru'] as const;

/**
 * Elixir source extensions the hand-rolled Elixir scanner parses: compiled
 * modules (`.ex`), scripts / config / tests (`.exs`), and the EEx template family
 * (`.eex`/`.heex`/`.leex` — Phoenix views). All are plain-text Elixir the
 * syntactic scanner reads; no native grammar, no repo-code execution. `mix.exs`
 * matches `.exs` but is a MANIFEST (parsed for deps, never a graph node), so the
 * scanner skips it explicitly.
 */
export const ELIXIR_SOURCE_EXTENSIONS = ['ex', 'exs', 'eex', 'heex', 'leex'] as const;

/**
 * Dart source extension the hand-rolled Dart scanner parses. Just `.dart` — Dart
 * has one source extension (there is no `.dart`-adjacent template family). Generated
 * files (`*.g.dart`, `*.freezed.dart`) ARE `.dart` and are enumerated, but the
 * adapter folds each into its parent library node via the `part`/`part of` merge, so
 * they never surface as their own diagram box. `pubspec.yaml` / `pubspec.lock` are
 * MANIFESTS (dep declarations, not graph nodes) and are `.yaml`, so they never match.
 */
export const DART_SOURCE_EXTENSIONS = ['dart'] as const;

/**
 * PHP source extension the php-parser adapter parses: `.php`. Blade views
 * (`*.blade.php`) also END in `.php` but carry NO import backbone (they're
 * templates — edgeless leaves), so they're rejected by an explicit guard in
 * isSourceFilePath (the shipped Rails/Phoenix adapters exclude `.erb`/`.eex`
 * views the same way). Twig (`.twig`) and `.phtml` templates don't match `.php`
 * and are excluded for free.
 */
export const PHP_SOURCE_EXTENSIONS = ['php'] as const;

/**
 * Kotlin source extensions the hand-rolled Kotlin scanner parses: `.kt` compiled
 * modules ONLY. `.kts` script files (`build.gradle.kts`, `settings.gradle.kts`) are
 * Gradle BUILD SCRIPTS — read as manifests (dep coordinates + `include(...)`), never
 * graph nodes (the `mix.exs`-is-a-manifest precedent) — so `.kts` is deliberately
 * excluded. Plain-text Kotlin the syntactic scanner reads; no native grammar, no
 * repo-code execution.
 */
export const KOTLIN_SOURCE_EXTENSIONS = ['kt'] as const;

/**
 * Swift source extensions the hand-rolled Swift scanner parses: just `.swift`
 * (Swift has one source extension). Xcode's ObjC `.h`/`.m` bridging files are
 * deliberately NOT parsed (a documented v1 degrade). All plain-text Swift the
 * syntactic scanner reads; no native grammar, no repo-code execution. `Package.swift`
 * matches `.swift` but is a MANIFEST (parsed for targets/deps, never a graph node),
 * so the scanner skips it explicitly.
 */
export const SWIFT_SOURCE_EXTENSIONS = ['swift'] as const;

/**
 * Java source extension the hand-rolled Java scanner parses: just `.java`. The special
 * `module-info.java` (a JPMS module descriptor — `module { requires … }`, no type decls)
 * and `package-info.java` (package-level annotations/Javadoc, no type decls) match `.java`
 * but carry no import backbone worth a diagram box, so they're rejected by an explicit
 * guard in isSourceFilePath (the Blade/Package.swift precedent). All plain-text Java the
 * syntactic scanner reads; no native grammar, no JVM, no repo-code execution.
 */
export const JAVA_SOURCE_EXTENSIONS = ['java'] as const;

/** Directories the ts-morph adapter's glob excludes (mirror of the adapter's EXCLUDE_DIRS). */
export const EXCLUDE_DIRS = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.next',
  '.vite',
  '.turbo',
] as const;

/**
 * Directories the Python adapter's walk excludes: virtualenvs, tool caches, egg
 * builds, and vendored deps. Mirrors the TS EXCLUDE_DIRS role — none of these
 * hold first-party source, and walking them would (a) misclassify installed deps
 * as internal and (b) blow the install-free promise. `.`-prefixed dirs (`.venv`,
 * `.tox`, `.mypy_cache`) are also caught by the dot-segment skip below, but are
 * listed explicitly so the policy is self-contained.
 */
export const PYTHON_EXCLUDE_DIRS = [
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.eggs',
  'site-packages',
  '.git',
  'build',
  'dist',
  'node_modules',
] as const;

/**
 * Directories the Ruby adapter's walk excludes: Bundler's vendored gem tree,
 * runtime scratch (`tmp` / `log`), the local Bundler config, ActiveStorage's
 * on-disk root, and any JS-bundler deps. Mirrors the TS/Python EXCLUDE_DIRS role
 * — none hold first-party source, and walking `vendor/bundle` would misread
 * installed gems as internal (blowing the install-free promise). `.bundle` is
 * also caught by the dot-segment skip; listed explicitly so the policy is
 * self-contained.
 */
export const RUBY_EXCLUDE_DIRS = [
  'vendor',
  'tmp',
  'log',
  '.bundle',
  'storage',
  'node_modules',
  '.git',
] as const;

/**
 * Directories the Elixir scanner's walk excludes: Mix build artifacts (`_build`),
 * the vendored dependency tree (`deps` — the Elixir analogue of `node_modules` /
 * `vendor/bundle`; walking it would misread installed deps as first-party source),
 * the language-server cache (`.elixir_ls`), and coverage output (`cover`).
 * `.elixir_ls` is also caught by the dot-segment skip; listed explicitly so the
 * policy is self-contained. `node_modules` is kept because a Phoenix repo's
 * `assets/` ships a JS toolchain.
 */
export const ELIXIR_EXCLUDE_DIRS = [
  '_build',
  'deps',
  '.elixir_ls',
  'cover',
  'node_modules',
  '.git',
] as const;

/**
 * Directories the Dart scanner's walk excludes: the pub tool cache + build
 * artifacts (`.dart_tool` / `build`), the resolved-dependency cache (`.pub-cache` —
 * the Dart analogue of `node_modules`; walking it would misread installed packages
 * as first-party source), the Flutter version-manager cache (`.fvm`), the CocoaPods
 * symlink tree (`.symlinks`), and the native-platform host projects (`ios` /
 * `android` — Swift/Kotlin/ObjC/Java, not Dart, and `android/`'s Gradle tree can
 * hide vendored `.dart`). The dot-prefixed entries (`.dart_tool` / `.pub-cache` /
 * `.fvm` / `.symlinks`, plus the generated `.flutter-plugins*` FILES) are also
 * caught by the dot-segment skip in `isSourceFilePath`; listed explicitly so the
 * policy is self-contained. `node_modules` is kept because a Flutter `web/` build or
 * a polyglot repo can ship a JS toolchain.
 */
export const DART_EXCLUDE_DIRS = [
  '.dart_tool',
  'build',
  'ios',
  'android',
  '.pub-cache',
  '.symlinks',
  '.fvm',
  'node_modules',
  '.git',
] as const;

/**
 * Directories the PHP adapter's walk excludes: Composer's vendored dependency
 * tree (`vendor` — the PHP analogue of `node_modules` / `vendor/bundle`; walking
 * it would misread installed packages as first-party source, blowing the
 * install-free promise), the framework runtime scratch (`var` — Symfony's cache/
 * logs; `cache`; `storage` — Laravel's on-disk root incl. compiled Blade views),
 * and any JS-bundler deps. These are single dir-name segments. Built frontend
 * assets under `public/build` (Vite/Mix output) are a two-segment path — `public`
 * itself is NOT excluded (a legacy front controller can hold PHP), only its
 * `build/` output — so that one is handled by a path-prefix guard in
 * isSourceFilePath rather than this single-segment set.
 */
export const PHP_EXCLUDE_DIRS = [
  'vendor',
  'var',
  'cache',
  'storage',
  'node_modules',
  '.git',
] as const;

/**
 * Directories the Kotlin scanner's walk excludes: Gradle build output (`build`) + its
 * caches (`.gradle`, `.kotlin`), the IntelliJ project dir (`.idea`), and the Gradle
 * convention-plugin / build-logic dirs (`buildSrc`, `build-logic` — build TOOLING, not
 * application code; an accepted degrade). Mirrors the other languages' EXCLUDE_DIRS role
 * — none hold first-party application source. `.gradle`/`.idea`/`.kotlin` are also caught
 * by the dot-segment skip; listed explicitly so the policy is self-contained.
 * `node_modules` is kept because a KMP/Compose-web repo can ship a JS toolchain.
 */
export const KOTLIN_EXCLUDE_DIRS = [
  'build',
  '.gradle',
  '.idea',
  '.kotlin',
  'buildSrc',
  'build-logic',
  'node_modules',
  '.git',
] as const;

/**
 * Directories the Swift scanner's walk excludes: the SwiftPM build tree (`.build`,
 * the Swift analogue of `_build` / `node_modules` — vendored+built deps we never
 * read as first-party), CocoaPods' vendored pods (`Pods`), Xcode's build products
 * (`DerivedData`), and Carthage's checkouts (`Carthage`). `.build` is also caught
 * by the dot-segment skip; listed explicitly so the policy is self-contained.
 * `node_modules` is kept because a Swift repo may ship a JS toolchain (docs, a
 * companion web app). The Xcode CONTAINER dirs (`*.xcodeproj`/`*.xcworkspace`/
 * `*.xcassets`/`*.playground`) are SUFFIX-named, so they can't be exact-set
 * members — isSourceFilePath rejects files under them via SWIFT_EXCLUDE_SUFFIXES.
 */
export const SWIFT_EXCLUDE_DIRS = [
  '.build',
  'Pods',
  'DerivedData',
  'Carthage',
  'node_modules',
  '.git',
] as const;

/**
 * Directories the Java scanner's walk excludes: Maven's build output (`target`), Gradle's
 * build output + caches (`build`, `.gradle`), the IntelliJ project dir (`.idea`), the
 * Gradle convention-plugin dirs (`buildSrc`, `build-logic` — build TOOLING, not
 * application code; an accepted degrade), and any JS-bundler deps. Mirrors the other
 * languages' EXCLUDE_DIRS role — none hold first-party application source (Java source
 * lives under `src/`; `target`/`build` hold compiled `.class` + generated output, never
 * hand-written `.java`). `.gradle`/`.idea` are also caught by the dot-segment skip; listed
 * explicitly so the policy is self-contained. `node_modules` is kept because a Java repo
 * can ship a JS toolchain (a bundled frontend, docs). Eclipse's `bin/` is NOT excluded —
 * it holds `.class` (never enumerated) and the generic name would risk dropping a legit
 * `bin` package.
 */
export const JAVA_EXCLUDE_DIRS = [
  'target',
  'build',
  '.gradle',
  '.idea',
  'buildSrc',
  'build-logic',
  'node_modules',
  '.git',
] as const;

/**
 * Xcode CONTAINER directory suffixes — bundle-like dirs whose name ends with one of
 * these. They hold generated project metadata / assets / playground scratch, never
 * first-party Swift source, so any `.swift` under them is excluded. Suffix-matched
 * (not exact) because the prefix is the project/app name (`MyApp.xcodeproj`).
 */
export const SWIFT_EXCLUDE_SUFFIXES = ['.xcodeproj', '.xcworkspace', '.xcassets', '.playground'] as const;

const SOURCE_EXT_RE = new RegExp(`\\.(${SOURCE_EXTENSIONS.join('|')})$`);
const PYTHON_SOURCE_EXT_RE = new RegExp(`\\.(${PYTHON_SOURCE_EXTENSIONS.join('|')})$`);
const RUBY_SOURCE_EXT_RE = new RegExp(`\\.(${RUBY_SOURCE_EXTENSIONS.join('|')})$`);
const ELIXIR_SOURCE_EXT_RE = new RegExp(`\\.(${ELIXIR_SOURCE_EXTENSIONS.join('|')})$`);
const DART_SOURCE_EXT_RE = new RegExp(`\\.(${DART_SOURCE_EXTENSIONS.join('|')})$`);
const PHP_SOURCE_EXT_RE = new RegExp(`\\.(${PHP_SOURCE_EXTENSIONS.join('|')})$`);
const KOTLIN_SOURCE_EXT_RE = new RegExp(`\\.(${KOTLIN_SOURCE_EXTENSIONS.join('|')})$`);
const SWIFT_SOURCE_EXT_RE = new RegExp(`\\.(${SWIFT_SOURCE_EXTENSIONS.join('|')})$`);
const JAVA_SOURCE_EXT_RE = new RegExp(`\\.(${JAVA_SOURCE_EXTENSIONS.join('|')})$`);
const EXCLUDE_SET = new Set<string>(EXCLUDE_DIRS);
const PYTHON_EXCLUDE_SET = new Set<string>(PYTHON_EXCLUDE_DIRS);
const RUBY_EXCLUDE_SET = new Set<string>(RUBY_EXCLUDE_DIRS);
const ELIXIR_EXCLUDE_SET = new Set<string>(ELIXIR_EXCLUDE_DIRS);
const DART_EXCLUDE_SET = new Set<string>(DART_EXCLUDE_DIRS);
const PHP_EXCLUDE_SET = new Set<string>(PHP_EXCLUDE_DIRS);
const KOTLIN_EXCLUDE_SET = new Set<string>(KOTLIN_EXCLUDE_DIRS);
const SWIFT_EXCLUDE_SET = new Set<string>(SWIFT_EXCLUDE_DIRS);
const JAVA_EXCLUDE_SET = new Set<string>(JAVA_EXCLUDE_DIRS);

// A Blade view (`*.blade.php`) ends in `.php` but is a template with no import
// backbone — an edgeless leaf. Rejected outright so it never becomes a graph node.
const BLADE_RE = /\.blade\.php$/;
// Vite/Mix build output under public/ — an asset dir, not first-party PHP.
const PHP_PUBLIC_BUILD_RE = /(^|\/)public\/build\//;
// `module-info.java` (a JPMS module descriptor) / `package-info.java` (package-level
// annotations + Javadoc) match `.java` but declare no type and carry no import backbone
// worth a diagram box — rejected so neither becomes an edgeless leaf node.
const JAVA_NON_TYPE_RE = /(^|\/)(module-info|package-info)\.java$/;

// Extension-less Ruby source basenames. A `Rakefile` is Ruby; `config.ru` already
// matches the `.ru` extension. `Gemfile` is intentionally NOT here — it's a
// manifest, not a graph node.
const RUBY_SOURCE_BASENAMES = new Set<string>(['Rakefile']);

/**
 * Does a repo-relative posix path denote a file the extractor would include?
 * For `ts` this mirrors the ts-morph adapter's glob EXACTLY (verified empirically
 * + by the equivalence fixture): matching extension, no excluded-dir segment, and
 * NO dotted segment — ts-morph's globbing skips dot-directories AND dot-files by
 * default (`.storybook/x.ts`, `src/.hidden.ts` are not added), so the diff
 * classifier must skip them too or a patched graph would diverge from a full
 * extract. For `python` the same shape holds with `.py`/`.pyi` + the Python
 * exclude set; the dot-segment skip drops `.venv`/`.tox`/… while keeping
 * `__init__.py` (a `_`-prefixed name, not a dotted one). For `ruby` it's
 * `.rb`/`.rake`/`.ru` (plus the extension-less `Rakefile`) + the Ruby exclude set
 * (`vendor`/`tmp`/`log`/`storage`). For `elixir` it's `.ex`/`.exs`/`.eex`/`.heex`/
 * `.leex` + the Elixir exclude set (`_build`/`deps`/`.elixir_ls`/`cover`); the
 * dot-segment skip drops `.elixir_ls`/`.formatter.exs`. For `kotlin` it's `.kt` ONLY
 * (a `.kts` build script is NOT source) + the Kotlin exclude set
 * (`build`/`.gradle`/`.idea`/`.kotlin`/`buildSrc`/`build-logic`). For `swift` it's
 * `.swift` + the Swift exclude set (`.build`/`Pods`/`DerivedData`/`Carthage`) PLUS a
 * reject of any Xcode container-dir segment (`*.xcodeproj`/`*.xcassets`/…,
 * suffix-matched, since those are name-prefixed by the project). `Package.swift`
 * matches `.swift` here (it's the swift adapter that filters it out as a manifest,
 * mirroring the Elixir adapter's mix.exs skip).
 */
export function isSourceFilePath(path: string, lang: SourceLang = 'ts'): boolean {
  const extRe =
    lang === 'python'
      ? PYTHON_SOURCE_EXT_RE
      : lang === 'ruby'
        ? RUBY_SOURCE_EXT_RE
        : lang === 'elixir'
          ? ELIXIR_SOURCE_EXT_RE
          : lang === 'dart'
            ? DART_SOURCE_EXT_RE
            : lang === 'php'
              ? PHP_SOURCE_EXT_RE
              : lang === 'kotlin'
                ? KOTLIN_SOURCE_EXT_RE
                : lang === 'swift'
                  ? SWIFT_SOURCE_EXT_RE
                  : lang === 'java'
                    ? JAVA_SOURCE_EXT_RE
                    : SOURCE_EXT_RE;
  const excludes =
    lang === 'python'
      ? PYTHON_EXCLUDE_SET
      : lang === 'ruby'
        ? RUBY_EXCLUDE_SET
        : lang === 'elixir'
          ? ELIXIR_EXCLUDE_SET
          : lang === 'dart'
            ? DART_EXCLUDE_SET
            : lang === 'php'
              ? PHP_EXCLUDE_SET
              : lang === 'kotlin'
                ? KOTLIN_EXCLUDE_SET
                : lang === 'swift'
                  ? SWIFT_EXCLUDE_SET
                  : lang === 'java'
                    ? JAVA_EXCLUDE_SET
                    : EXCLUDE_SET;
  // Ruby has extension-less source files (a `Rakefile`); every other language —
  // and every other Ruby file — must match its language's source extension.
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (!extRe.test(path) && !(lang === 'ruby' && RUBY_SOURCE_BASENAMES.has(base))) return false;
  // PHP: Blade views end in `.php` but are edgeless templates, and public/build
  // holds bundled front-end assets — neither is a first-party PHP graph node.
  if (lang === 'php' && (BLADE_RE.test(path) || PHP_PUBLIC_BUILD_RE.test(path))) return false;
  // Java: module-info.java / package-info.java match `.java` but are not architectural types.
  if (lang === 'java' && JAVA_NON_TYPE_RE.test(path)) return false;
  for (const seg of path.split('/')) {
    if (seg.startsWith('.')) return false;
    if (excludes.has(seg)) return false;
    // Swift: reject a `.swift` file sitting inside an Xcode container bundle dir
    // (`MyApp.xcodeproj/…`, `Assets.xcassets/…`) — suffix-matched, since the dir is
    // name-prefixed by the project/app.
    if (lang === 'swift' && SWIFT_EXCLUDE_SUFFIXES.some((s) => seg.endsWith(s))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Config invalidators (the correctness valve).
//
// These files change MODULE RESOLUTION for the INSTALL-FREE extractor
// (tsconfig/jsconfig paths/baseUrl feed the Project's compilerOptions;
// package.json's `type`/`imports`/`exports` fields affect ts-morph's Bundler
// resolution). A diff touching any of them forces a FULL re-extract at that
// checkpoint — conservative and rare.
//
// NARROWED ( item 3a): lockfiles (package-lock.json, npm-shrinkwrap
// .json, yarn.lock, pnpm-lock.yaml, bun.lockb/bun.lock, deno.lock), deno.json/
// deno.jsonc, and pnpm-workspace.yaml PROVABLY cannot affect the extractor's
// output — it never resolves into node_modules (a bare specifier that doesn't
// resolve from source is an external by design) and it ignores deno config
// entirely, so what a lockfile pins is invisible to it. Treating them as
// invalidators cost a needless full extract on every lockfile-touching merge
// (~10-15% of merges on dep-heavy repos).

// TS side: tsconfig/jsconfig paths+baseUrl and package.json type/imports/exports.
// Python side: pyproject.toml / setup.cfg / setup.py declare package-dir
// + src-layout + namespace-package settings that steer Pyright's first-party
// resolution, so a diff touching them forces a full re-extract. requirements*.txt
// / Pipfile are deliberately NOT invalidators — like TS lockfiles they only pin
// third-party deps we never install, which are invisible to the extractor. The
// basenames are language-distinct, so matching all of them unconditionally never
// changes single-language behavior.
const INVALIDATOR_BASENAME_RE =
  /^(tsconfig[^/]*\.json|jsconfig[^/]*\.json|package\.json|pyproject\.toml|setup\.cfg|setup\.py)$/;

/** Does a repo-relative path name a resolution-affecting config file? */
export function isConfigInvalidatorPath(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return INVALIDATOR_BASENAME_RE.test(base);
}

/**
 * Stage B — the blob-cache KEY COMPONENT. A `file_parse_cache` row is
 * keyed (repo_id, blob_sha, extractor_version): blob-identical content can
 * only be reused while the per-file extraction SEMANTICS are unchanged. Bump
 * this whenever per-file extraction OUTPUT can change for the same blob:
 * adapter edge semantics (extractFileImportsRecord/extractFileCalls), the
 * source globs / EXCLUDE_DIRS policy, an invalidator-policy change that alters
 * output, or the FileRecord shape itself. A bump cleanly orphans every cached
 * row (all lookups miss → re-parse — the once-per-version cost; saveParseCache
 * GCs the orphaned versions best-effort). Version 1 is RESERVED for the
 * implicit Stage-A semantics and is never written to the table.
 *
 * v3: the Elixir adapter gained inline CALL edges (was import-only) — a change to
 * per-file extraction output for `.ex`/`.exs` blobs, so cached rows must re-parse.
 * v4: the PHP adapter's import resolution gained PSR-0 + a declared-class→file
 * index (classmap-equivalent) fallback after PSR-4 — more first-party `use`/
 * extends/implements/trait edges resolve for the same `.php` blob, so cached PHP
 * rows must re-parse.
 * v5: the PHP adapter gained inline CALL edges (static `X::m()` + typed-receiver
 * `$var->m()`), so per-file output changes for `.php` blobs — cached rows must
 * re-parse.
 * v6: the Swift adapter gained inline CALL edges (initializer `Foo(…)` + static
 * `Foo.member(…)` heads resolved through the type registry), so per-file output
 * changes for `.swift` blobs — cached rows must re-parse.
 */
export const EXTRACTOR_VERSION = 6;

// ---------------------------------------------------------------------------
// State shape.

/** A resolved internal edge out of a file (target = repo-relative file id). */
export interface FileEdgeRef {
  to: string;
  weight: number;
}

/** An external dependency referenced by a file (unresolved bare specifier). */
export interface FileExternalRef {
  id: string; // `ext:<package>`
  specifier: string;
  weight: number;
}

/** Everything the extractor derives from ONE source file (+ tree resolution). */
export interface FileRecord {
  loc: number;
  language: string;
  /** Resolved internal import/export-from targets (kind 'import'). */
  imports: FileEdgeRef[];
  /** External packages referenced (kind 'import', external). */
  externals: FileExternalRef[];
  /** Resolved internal call/new targets (kind 'call') — the EXPENSIVE part. */
  calls: FileEdgeRef[];
  /**
   * Resolved internal targets of `export … from` declarations — the re-export
   * surface a change can propagate THROUGH (see computeCallPatchUnit). Subset
   * of `imports` targets.
   */
  reexports: string[];
  /** Git blob sha at the state's head (serialization only; Stage-B cache key). */
  blobSha?: string;
}

/** The carried graph: a full-commit-sha head + one record per source file. */
export interface FileGraphState {
  /** FULL commit sha the state corresponds to (diff base for the next patch). */
  headSha: string;
  files: Record<string, FileRecord>;
}

// ---------------------------------------------------------------------------
// NormalizedGraph assembly (shared by the batch adapter + the engine, so a
// patched state and a full extract produce byte-identical downstream input).

/**
 * Assemble the NormalizedGraph the clustering layer consumes from a file-graph
 * state. Files are emitted in SORTED path order — deterministic across
 * platforms and identical between the batch and incremental paths (Louvain's
 * seeded RNG consumes node insertion order, so ordering is part of output
 * stability).
 */
export function graphFromState(root: string, state: FileGraphState): NormalizedGraph {
  const paths = Object.keys(state.files).sort();
  const files = paths.map((id) => ({
    id,
    loc: state.files[id].loc,
    language: state.files[id].language,
  }));

  const externals = new Map<string, ExternalNode>();
  const edges: GraphEdge[] = [];
  for (const id of paths) {
    const rec = state.files[id];
    for (const e of rec.imports) {
      edges.push({ from: id, to: e.to, kind: 'import', external: false, weight: e.weight });
    }
    for (const x of rec.externals) {
      externals.set(x.id, { id: x.id, specifier: x.specifier });
      edges.push({ from: id, to: x.id, kind: 'import', external: true, weight: x.weight });
    }
    for (const c of rec.calls) {
      edges.push({ from: id, to: c.to, kind: 'call', external: false, weight: c.weight });
    }
  }

  return { root, files, edges, externals: [...externals.values()] };
}

// ---------------------------------------------------------------------------
// Diff classification.

/** One `git diff --name-status --no-renames` entry (renames arrive as D+A). */
export interface DiffEntry {
  /** A=added, M=modified, D=deleted, T=type-change; anything else is rare. */
  status: string;
  path: string;
}

export interface ClassifiedDiff {
  /** Source files added at this checkpoint. */
  sourceAdded: string[];
  /** Source files whose content changed. */
  sourceModified: string[];
  /** Source files removed. */
  sourceDeleted: string[];
  /** Resolution-affecting config paths touched → force a FULL extract. */
  invalidators: string[];
  /**
   * Did the SOURCE-FILE SHAPE of the tree change (adds/deletes/type-changes)?
   * Shape changes can flip OTHER files' specifier resolution (a new file an
   * existing `./util` import now resolves to; a deleted target), so the engine
   * rebuilds its Project + re-resolves every file's imports. Content-only
   * (M) diffs can't move resolution and take the cheap refresh path.
   */
  shapeChanged: boolean;
}

/** Classify a checkpoint's diff entries into the engine's decision inputs. */
export function classifyDiff(entries: readonly DiffEntry[]): ClassifiedDiff {
  const sourceAdded: string[] = [];
  const sourceModified: string[] = [];
  const sourceDeleted: string[] = [];
  const invalidators: string[] = [];
  let oddStatus = false;

  for (const e of entries) {
    if (isConfigInvalidatorPath(e.path)) invalidators.push(e.path);
    if (!isSourceFilePath(e.path)) continue;
    switch (e.status) {
      case 'A':
        sourceAdded.push(e.path);
        break;
      case 'M':
        sourceModified.push(e.path);
        break;
      case 'D':
        sourceDeleted.push(e.path);
        break;
      default:
        // T (type change: file↔symlink) or an exotic status — treat as a shape
        // change so the engine rebuilds rather than guessing.
        oddStatus = true;
        sourceModified.push(e.path);
        break;
    }
  }

  return {
    sourceAdded,
    sourceModified,
    sourceDeleted,
    invalidators,
    shapeChanged: oddStatus || sourceAdded.length > 0 || sourceDeleted.length > 0,
  };
}

// ---------------------------------------------------------------------------
// The dependents closure — WHICH files need their (expensive) call edges
// re-extracted after a diff.
//
// STEP-1 finding: per-file IMPORT extraction is per-file-independent
// given tree resolution (a file's specifiers + the tree decide its import
// edges), but CALL-edge extraction is NOT — it resolves each call site's symbol
// through the type checker, so a file's call edges can change when a file it
// imports changes its exports (and, through `export … from` chains, when a
// transitively re-exported file changes). The patch unit is therefore:
//
//   (a) the changed files themselves (added + modified),
//   (b) any file whose freshly-resolved import TARGETS differ from the carried
//       state (its specifiers now bind elsewhere — covers added/deleted targets
//       and resolution shadowing uniformly, no path heuristics), and
//   (c) any file that imports a member of the REEXPORT CLOSURE of the changed/
//       deleted set (a barrel re-exporting a changed file propagates the
//       change one hop further; the closure follows those chains to fixpoint).
//
// KNOWN RESIDUAL (documented, accepted for Stage A): a call edge that resolves
// through a TYPE returned by an intermediary (f calls a method declared in h,
// reached via a type that g returns) can change when h changes without f
// importing h or any re-export chain connecting them. Healed by the config
// invalidators (full extract) and Stage B's periodic full-extract
// reconciliation; not representable in the import graph without a full
// type-dependency graph.

/**
 * Expand `seeds` (changed/deleted paths) through re-export chains: any file
 * whose `reexports` include a member of the closure joins it, to fixpoint.
 */
export function reexportClosure(
  seeds: ReadonlySet<string>,
  reexportsByFile: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const closure = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, targets] of reexportsByFile) {
      if (closure.has(file)) continue;
      if (targets.some((t) => closure.has(t))) {
        closure.add(file);
        grew = true;
      }
    }
  }
  return closure;
}

function importTargetsKey(edges: readonly FileEdgeRef[]): string {
  return edges
    .map((e) => `${e.to}|${e.weight}`)
    .sort()
    .join('\n');
}

/**
 * The set of files whose CALL edges must be re-extracted at this checkpoint.
 * All inputs reflect the CURRENT tree (post-diff): `freshImports` are the
 * just-re-resolved import edges, `prevImports` the carried ones (absent for
 * new files), `reexports` the fresh re-export targets per file.
 */
export function computeCallPatchUnit(args: {
  added: readonly string[];
  modified: readonly string[];
  deleted: readonly string[];
  /** Current files → freshly resolved import edges. */
  freshImports: ReadonlyMap<string, readonly FileEdgeRef[]>;
  /** Carried state's import edges (pre-diff), keyed by file. */
  prevImports: ReadonlyMap<string, readonly FileEdgeRef[]>;
  /** Current files → fresh re-export targets. */
  reexports: ReadonlyMap<string, readonly string[]>;
}): Set<string> {
  const unit = new Set<string>([...args.added, ...args.modified]);

  // (b) resolution moved — the file's specifiers bind to different targets now.
  for (const [file, fresh] of args.freshImports) {
    if (unit.has(file)) continue;
    const prev = args.prevImports.get(file);
    if (prev === undefined) {
      unit.add(file); // not in the carried state → treat as new
      continue;
    }
    if (importTargetsKey(fresh) !== importTargetsKey(prev)) unit.add(file);
  }

  // (c) imports a member of the re-export closure of the changed/deleted set.
  const seeds = new Set<string>([...args.added, ...args.modified, ...args.deleted]);
  const closure = reexportClosure(seeds, args.reexports as ReadonlyMap<string, readonly string[]>);
  for (const [file, fresh] of args.freshImports) {
    if (unit.has(file)) continue;
    if (fresh.some((e) => closure.has(e.to))) unit.add(file);
  }

  return unit;
}

// ---------------------------------------------------------------------------
// Serialization — the `fileGraph` payload extension of extraction_cache
// ( Stage A item 7). Written at the end of each boot, read as the next
// boot's seed (zero full extract when the head commit is still reachable).
//
// NOTE: this rides inside the existing jsonb `extraction_cache.payload` — fine
// at current scale (~100s of KB for a ~400-file repo). Stage B ADDS the
// content-addressed per-blob parse cache (`file_parse_cache`, keyed
// (repo_id, blob_sha, extractor_version)) as the fallback seed when this
// graph's head commit is unreachable in the clone — the two are complementary:
// this payload is the zero-parse fast path, the blob cache the O(misses)
// cold-boot path.

export const FILE_GRAPH_VERSION = 1;

export interface SerializedFileGraph {
  version: number;
  /** FULL commit sha the graph corresponds to. */
  headSha: string;
  files: Record<string, FileRecord>;
  /**
   * Stage B: boots since the last full-extract reconciliation pass
   * (container.ts), riding the fileGraph payload because it shares the graph's
   * exact lifecycle — persist_snapshot overwrites the whole extraction_cache
   * payload mid-boot, and the boot-end fileGraph save re-adds both together.
   * Optional + tolerated by deserializeFileGraph (older payloads lack it; the
   * container reads it off the RAW serialized object, defaulting 0).
   */
  bootsSinceReconcile?: number;
}

export function serializeFileGraph(
  state: FileGraphState,
  blobShaByPath?: ReadonlyMap<string, string>,
): SerializedFileGraph {
  const files: Record<string, FileRecord> = {};
  for (const [path, rec] of Object.entries(state.files)) {
    const blobSha = blobShaByPath?.get(path);
    files[path] = blobSha ? { ...rec, blobSha } : { ...rec };
  }
  return { version: FILE_GRAPH_VERSION, headSha: state.headSha, files };
}

function isEdgeRefArray(v: unknown): v is FileEdgeRef[] {
  return Array.isArray(v) && v.every((e) => e && typeof e.to === 'string' && typeof e.weight === 'number');
}

function isExternalRefArray(v: unknown): v is FileExternalRef[] {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        e && typeof e.id === 'string' && typeof e.specifier === 'string' && typeof e.weight === 'number',
    )
  );
}

/**
 * Validate ONE untrusted jsonb value as a FileRecord — the per-record half of
 * deserializeFileGraph's shape guard, exported ( Stage B) so the blob
 * parse-cache reader (assemble/parse-cache.ts) applies the SAME rigor per row
 * without duplicating it. A row failing this is treated as a cache miss, never
 * an error: a corrupt cached record must degrade to a re-parse.
 */
export function isValidFileRecord(v: unknown): v is FileRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.loc !== 'number' || typeof r.language !== 'string') return false;
  if (!isEdgeRefArray(r.imports) || !isEdgeRefArray(r.calls)) return false;
  if (!isExternalRefArray(r.externals)) return false;
  if (!Array.isArray(r.reexports) || !r.reexports.every((t) => typeof t === 'string')) return false;
  return true;
}

/**
 * Validate + adopt a serialized file graph. Returns null for anything not
 * usable as a seed (wrong version, missing head, malformed records) — the
 * caller then seeds with a full extract instead. NEVER throws: a corrupt cache
 * must degrade to a full extract, not fail the ingest. Unknown extra fields
 * (e.g. the Stage-B `bootsSinceReconcile` counter) are TOLERATED — older and
 * newer payloads must round-trip through each other's readers.
 */
export function deserializeFileGraph(v: unknown): FileGraphState | null {
  if (!v || typeof v !== 'object') return null;
  const g = v as Record<string, unknown>;
  if (g.version !== FILE_GRAPH_VERSION) return null;
  if (typeof g.headSha !== 'string' || g.headSha.length < 7) return null;
  if (!g.files || typeof g.files !== 'object' || Array.isArray(g.files)) return null;

  const files: Record<string, FileRecord> = {};
  for (const [path, raw] of Object.entries(g.files as Record<string, unknown>)) {
    if (!isValidFileRecord(raw)) return null;
    const r = raw as FileRecord & { blobSha?: unknown };
    files[path] = {
      loc: r.loc,
      language: r.language,
      imports: r.imports,
      externals: r.externals,
      calls: r.calls,
      reexports: r.reexports,
      ...(typeof r.blobSha === 'string' ? { blobSha: r.blobSha } : {}),
    };
  }
  return { headSha: g.headSha, files };
}

// ---------------------------------------------------------------------------
// State diffing — the Stage-B RECONCILIATION comparator ( Stage B).
//
// The walk's carried state is provably equivalent to a full extract EXCEPT for
// the documented residual (deep type-dispatch chains — see the dependents-
// closure block above). Every ~N boots the container runs a fresh full extract
// at the carried head and compares states with this helper; any drifted path
// is healed by adopting the ground truth + re-upserting its blob-cache row.

// Explicit field-by-field keys (NOT JSON.stringify of the objects): Postgres
// jsonb normalizes object key order, so a round-tripped record could stringify
// differently from a fresh one despite being identical.
function edgeRefsKey(v: readonly FileEdgeRef[]): string {
  return v
    .map((e) => `${e.to}|${e.weight}`)
    .sort()
    .join('\n');
}

function externalRefsKey(v: readonly FileExternalRef[]): string {
  return v
    .map((e) => `${e.id}|${e.specifier}|${e.weight}`)
    .sort()
    .join('\n');
}

/**
 * Paths whose records DIFFER between two states (union of both key sets — a
 * path present in only one side counts as drifted). Comparison is ORDER-
 * INSENSITIVE over the imports/externals/calls/reexports arrays (extraction
 * order is not semantics) and IGNORES blobSha (a serialization tag, not
 * extractor output). Pure; never throws.
 */
export function diffFileGraphStates(a: FileGraphState, b: FileGraphState): string[] {
  const recordKey = (rec: FileRecord): string =>
    [
      `loc:${rec.loc}`,
      `lang:${rec.language}`,
      `imports:${edgeRefsKey(rec.imports)}`,
      `externals:${externalRefsKey(rec.externals)}`,
      `calls:${edgeRefsKey(rec.calls)}`,
      `reexports:${[...rec.reexports].sort().join(',')}`,
    ].join('\x1f');

  const drifted: string[] = [];
  const allPaths = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  for (const path of [...allPaths].sort()) {
    const ra = a.files[path];
    const rb = b.files[path];
    if (!ra || !rb) {
      drifted.push(path);
      continue;
    }
    if (recordKey(ra) !== recordKey(rb)) drifted.push(path);
  }
  return drifted;
}
