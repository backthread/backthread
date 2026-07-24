// Java structural extractor — the import-graph backbone.
//
// INSTALL-FREE + PURE-STATIC by construction, like the other hand-rolled adapters: the
// syntactic scanner (java-scan.ts — no native grammar, no JVM, no repo-code execution)
// reads each file's `package`, its top-level TYPE declarations, and its `import`
// directives. Java's `package`/`import` is class-granular (Kotlin-like), so the backbone
// is a clean two-pass FQN registry — no AST needed for v1 (import edges only; no call
// edges — the locked scope):
//
//   1. REGISTRY — each file's top-level type is keyed `<package>.<Type> → file`
//      (`package com.foo` + `class Bar` → `com.foo.Bar`), and a `package → file ids`
//      index is built for wildcard imports. First (sorted-id) definition wins a
//      duplicate, so the mapping is deterministic. The set of declared packages is the
//      internal-package set pass 2 uses to tell a first-party reference from a dependency.
//   2. RESOLUTION — each `import` is resolved through the registry. `import com.foo.Bar;`
//      by LONGEST-PREFIX (a nested type `com.foo.Outer.Inner` resolves to `com.foo.Outer`);
//      `import com.foo.*;` to every file in that package; `import static com.foo.Bar.baz;`
//      and `import static com.foo.Bar.*;` by longest-prefix over the imported name (the
//      target class is a PREFIX of both static forms). A resolved target → an internal
//      import edge. An unresolved reference UNDER an internal package (a same-package
//      member, a top-level type we didn't register) is DROPPED, never mislabeled
//      external. A JDK/platform namespace (`java`/`sun`/`jdk`) is DROPPED (substrate).
//      Everything else is an `ext:<group>` external — the import's package bucketed by
//      longest declared-dependency-group prefix (Maven groupId / Gradle coordinate group).
//
// KNOWN degrades (documented, accepted): a same-package implicit reference (no `import`)
// is not an edge (import-only backbone; those files share a package → same Louvain
// community → same subsystem anyway, so the lost edges are intra-cluster). A wildcard
// `import pkg.*` draws an edge to EVERY file in the package (can slightly over-connect;
// weight 1). No call edges. `module-info.java` / `package-info.java` are excluded (not
// architectural types — see file-graph's isSourceFilePath).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphExtractor, NormalizedGraph } from './types.js';
import { graphFromState, type FileRecord, type FileGraphState, type FileEdgeRef } from './file-graph.js';
import { listSourceFiles } from './language.js';
import { isJavaStdlib } from './java-stdlib.js';
import { readJavaDeps } from './java-manifest.js';
import {
  scanPackage,
  scanImports,
  scanTopLevelDecls,
  scanCallSites,
  javaExternalId,
  type JavaImport,
} from './java-scan.js';

// A DETERMINISTIC per-file bound on inline call resolution, so a pathological generated
// god-file (thousands of call sites) can't dominate the extract. Bounds by COUNT in the
// (stable) source order — a time budget would break snapshot determinism. A capped file is
// LOGGED (no silent caps) and degrades to import-only. Mirrors the Swift/Elixir/PHP
// adapters' MAX_CALL_SITES_PER_FILE.
const MAX_CALL_SITES_PER_FILE = 2500;

/** Lines of code for one source file (a size/centrality signal). */
function locOf(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/** Qualify a top-level type by its file's package (`com.foo` + `Bar` → `com.foo.Bar`). */
function qualify(pkg: string, decl: string): string {
  return pkg ? `${pkg}.${decl}` : decl;
}

/** The package part of a non-wildcard import FQN (`com.foo.Bar` → `com.foo`), or ''. */
function packageOf(fqn: string): string {
  const i = fqn.lastIndexOf('.');
  return i >= 0 ? fqn.slice(0, i) : '';
}

/**
 * Is `fqn` first-party — equal to or nested under a declared internal package? Tests
 * each dotted ancestor of `fqn` (and `fqn` itself, for a wildcard package) against the
 * internal-package set, so `com.myapp.feature.Detail` is internal iff any of `com`,
 * `com.myapp`, `com.myapp.feature`, or the full name is a declared package.
 */
function isUnderInternalPackage(fqn: string, internalPackages: ReadonlySet<string>): boolean {
  let idx = fqn.indexOf('.');
  while (idx >= 0) {
    if (internalPackages.has(fqn.slice(0, idx))) return true;
    idx = fqn.indexOf('.', idx + 1);
  }
  return internalPackages.has(fqn);
}

/**
 * Resolve an import FQN to its defining file by LONGEST prefix over the registry: try the
 * full name, then drop trailing segments (a nested type resolves to its top-level
 * enclosing type; a static member `a.b.C.member` resolves to the class `a.b.C`). Stops
 * before a single (dot-less) segment — Java can't import from the unnamed package, so a
 * real import is always ≥2 segments. Undefined = miss.
 */
function resolveByPrefix(fqn: string, declToFile: ReadonlyMap<string, string>): string | undefined {
  let prefix = fqn;
  while (prefix.includes('.')) {
    const hit = declToFile.get(prefix);
    if (hit !== undefined) return hit;
    prefix = prefix.slice(0, prefix.lastIndexOf('.'));
  }
  return undefined;
}

/**
 * Resolve a call-site head (a SIMPLE UpperCamelCase type name as written in the code body)
 * to its declaring in-repo file, mirroring how javac resolves an unqualified type name —
 * through the SAME FQN registry the import backbone uses:
 *   (1) SAME-PACKAGE  — `<filePkg>.<head>`. A same-package type needs no `import`, so this
 *       is the edge the import backbone can't see — the PRIMARY value of Java call edges
 *       (Java is file-granular, so this is a net-new file→file edge).
 *   (2) SINGLE-TYPE IMPORT — a non-static, non-wildcard `import a.b.<head>` (resolved by
 *       longest-prefix, so a nested-type import resolves to its top-level enclosing file).
 *   (3) WILDCARD IMPORT — `import a.b.*` where `a.b.<head>` is a registered type.
 * ACCURACY GATE (no guessed edge): return a target ONLY when the union of these candidates
 * is EXACTLY ONE distinct in-repo file that is not `fromId`. Zero candidates (external /
 * JDK / unresolved) OR ≥2 distinct candidates (genuinely ambiguous without full type
 * resolution — e.g. a same-package type shadowed by a wildcard import of the same simple
 * name) OR the sole candidate being the file itself (a self-reference) → drop.
 */
function resolveCallHead(
  head: string,
  fromId: string,
  filePkg: string,
  imports: readonly JavaImport[],
  declToFile: ReadonlyMap<string, string>,
): string | undefined {
  const candidates = new Set<string>();
  const samePkg = declToFile.get(filePkg ? `${filePkg}.${head}` : head);
  if (samePkg !== undefined) candidates.add(samePkg);
  for (const imp of imports) {
    if (imp.static) continue; // a static import brings a MEMBER, not a resolvable type head
    if (imp.wildcard) {
      const hit = declToFile.get(`${imp.fqn}.${head}`);
      if (hit !== undefined) candidates.add(hit);
      continue;
    }
    // A single-type import whose simple name (last segment) IS this head.
    if (imp.fqn.slice(imp.fqn.lastIndexOf('.') + 1) === head) {
      const hit = resolveByPrefix(imp.fqn, declToFile);
      if (hit !== undefined) candidates.add(hit);
    }
  }
  if (candidates.size !== 1) return undefined; // none, or ambiguous → drop
  const only = candidates.values().next().value as string;
  return only === fromId ? undefined : only; // no self-edges
}

/**
 * Resolve one file's call-site heads into internal `call` edge refs (target file id → call
 * count). Each head is resolved through the FQN registry by `resolveCallHead`; an
 * unresolvable / external / ambiguous / self head is dropped — the same registry the import
 * backbone keys on, so its accuracy is inherited (no guessed edge). A file whose call-site
 * count exceeds the cap degrades to import-only (LOGGED, never a silent cap). Head→target
 * resolution is memoized per file (a head recurs across call sites). Sorted for a stable
 * record.
 */
export function extractFileCalls(
  fromId: string,
  callSites: readonly string[],
  filePkg: string,
  imports: readonly JavaImport[],
  declToFile: ReadonlyMap<string, string>,
): FileEdgeRef[] {
  if (callSites.length > MAX_CALL_SITES_PER_FILE) {
    console.log(
      `  [java] ${fromId}: ${callSites.length} call sites exceed the ${MAX_CALL_SITES_PER_FILE} cap — ` +
        `call edges skipped for this file (import-only)`,
    );
    return [];
  }
  const cache = new Map<string, string | null>(); // head → resolved file (null = unresolved)
  const weights = new Map<string, number>();
  for (const head of callSites) {
    let target = cache.get(head);
    if (target === undefined) {
      target = resolveCallHead(head, fromId, filePkg, imports, declToFile) ?? null;
      cache.set(head, target);
    }
    if (target === null) continue;
    weights.set(target, (weights.get(target) ?? 0) + 1);
  }
  return [...weights]
    .map(([to, weight]) => ({ to, weight }))
    .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/**
 * Resolve ONE file's imports into internal import edges + external refs + inline `call`
 * edges. Never throws. `declToFile` is the FQN→file registry, `pkgToFiles` the
 * package→files index (wildcard), `internalPackages` the declared-package set
 * (first-party-drop), `declaredGroups` the dependency groups (external bucketing). `pkg`
 * is the file's declared package — the caller passes the value pass 1 already computed so
 * the file isn't re-scanned; omitted (tests), it falls back to a scan.
 */
export function extractFileRecord(
  fromId: string,
  text: string,
  declToFile: ReadonlyMap<string, string>,
  pkgToFiles: ReadonlyMap<string, readonly string[]>,
  internalPackages: ReadonlySet<string>,
  declaredGroups: ReadonlySet<string>,
  pkg?: string,
): FileRecord {
  const filePkg = pkg ?? scanPackage(text);
  const importWeights = new Map<string, number>();
  const externalWeights = new Map<string, { specifier: string; weight: number }>();
  const addInternal = (target: string): void => {
    if (target === fromId) return; // no self-edges
    importWeights.set(target, (importWeights.get(target) ?? 0) + 1);
  };
  const addExternal = (pkg: string): void => {
    const ext = javaExternalId(pkg, declaredGroups);
    const existing = externalWeights.get(ext.id);
    if (existing) existing.weight += 1;
    else externalWeights.set(ext.id, { specifier: ext.specifier, weight: 1 });
  };

  const imports = scanImports(text);
  for (const imp of imports) {
    if (!imp.fqn.includes('.')) continue; // a real Java import is always ≥2 segments

    if (imp.static) {
      // A static import's target CLASS is a PREFIX of the imported name (a member for
      // `import static a.b.C.m`, or the class itself for `import static a.b.C.*`) — so
      // both static forms resolve by longest-prefix uniformly.
      const target = resolveByPrefix(imp.fqn, declToFile);
      if (target !== undefined) {
        addInternal(target);
        continue;
      }
      if (isUnderInternalPackage(imp.fqn, internalPackages)) continue; // first-party → drop
      if (isJavaStdlib(imp.fqn)) continue; // substrate
      addExternal(imp.fqn); // bucketed by leading segments (family)
      continue;
    }

    if (imp.wildcard) {
      const files = pkgToFiles.get(imp.fqn);
      if (files) {
        for (const target of files) addInternal(target);
        continue;
      }
      if (isUnderInternalPackage(imp.fqn, internalPackages)) continue; // first-party parent → drop
      if (isJavaStdlib(imp.fqn)) continue;
      addExternal(imp.fqn);
      continue;
    }

    const target = resolveByPrefix(imp.fqn, declToFile);
    if (target !== undefined) {
      addInternal(target);
      continue;
    }
    if (isUnderInternalPackage(imp.fqn, internalPackages)) continue; // first-party, unresolved → drop
    if (isJavaStdlib(imp.fqn)) continue; // substrate
    addExternal(packageOf(imp.fqn));
  }

  return {
    loc: locOf(text),
    language: 'java',
    imports: [...importWeights].map(([to, weight]) => ({ to, weight })),
    externals: [...externalWeights].map(([id, v]) => ({ id, specifier: v.specifier, weight: v.weight })),
    // v2: constructor (`new Foo(…)`) + static (`Foo.member(…)`) call-site heads resolved
    // through the FQN registry — file→file edges the import backbone misses (esp.
    // same-package calls, which need no `import`).
    calls: extractFileCalls(fromId, scanCallSites(text), filePkg, imports, declToFile),
    reexports: [],
  };
}

export class JavaExtractor implements GraphExtractor {
  readonly language = 'java';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    const fileIds = listSourceFiles(root, 'java');
    const files: Record<string, FileRecord> = {};
    if (fileIds.length === 0) return graphFromState(root, { headSha: '', files });

    // The declared dependency groups — the buckets externals collapse into (Maven
    // pom.xml `<groupId>`s + any Gradle coordinate groups, unioned across the repo).
    // Manifests only; never executes a build script.
    const declaredGroups = readJavaDeps(root);

    // Read every file once (text reused across both passes). Unreadable → empty text
    // (no decls, no edges) — never fails the extraction.
    const texts = new Map<string, string>();
    for (const id of fileIds) {
      try {
        texts.set(id, readFileSync(`${root}/${id}`, 'utf8'));
      } catch {
        texts.set(id, '');
      }
    }

    // Pass 1: the FQN registry (`<pkg>.<Type>` → file), the package→files index, and the
    // internal-package set. First (sorted-id) definition wins a duplicate.
    const declToFile = new Map<string, string>();
    const pkgToFiles = new Map<string, string[]>();
    const internalPackages = new Set<string>();
    const pkgByFile = new Map<string, string>(); // reused in pass 2 (no re-scan)
    for (const id of fileIds) {
      const text = texts.get(id) ?? '';
      const pkg = scanPackage(text);
      pkgByFile.set(id, pkg);
      internalPackages.add(pkg);
      (pkgToFiles.get(pkg) ?? pkgToFiles.set(pkg, []).get(pkg)!).push(id);
      for (const decl of scanTopLevelDecls(text)) {
        const fqn = qualify(pkg, decl);
        if (!declToFile.has(fqn)) declToFile.set(fqn, id);
      }
    }

    // Pass 2: per-file import + call resolution (pass-1 package handed in, not re-scanned).
    for (const id of fileIds) {
      files[id] = extractFileRecord(
        id,
        texts.get(id) ?? '',
        declToFile,
        pkgToFiles,
        internalPackages,
        declaredGroups,
        pkgByFile.get(id) ?? '',
      );
    }

    const state: FileGraphState = { headSha: '', files };
    return graphFromState(root, state);
  }
}
