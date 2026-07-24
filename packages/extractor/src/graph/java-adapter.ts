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
import { graphFromState, type FileRecord, type FileGraphState } from './file-graph.js';
import { listSourceFiles } from './language.js';
import { isJavaStdlib } from './java-stdlib.js';
import { readJavaDeps } from './java-manifest.js';
import { scanPackage, scanImports, scanTopLevelDecls, javaExternalId } from './java-scan.js';

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
 * Resolve ONE file's imports into internal import edges + external refs. Never throws.
 * `declToFile` is the FQN→file registry, `pkgToFiles` the package→files index (wildcard),
 * `internalPackages` the declared-package set (first-party-drop), `declaredGroups` the
 * dependency groups (external bucketing).
 */
export function extractFileRecord(
  fromId: string,
  text: string,
  declToFile: ReadonlyMap<string, string>,
  pkgToFiles: ReadonlyMap<string, readonly string[]>,
  internalPackages: ReadonlySet<string>,
  declaredGroups: ReadonlySet<string>,
): FileRecord {
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

  for (const imp of scanImports(text)) {
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
    calls: [], // v1: import-backbone only (no call edges — the locked scope)
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
    for (const id of fileIds) {
      const text = texts.get(id) ?? '';
      const pkg = scanPackage(text);
      internalPackages.add(pkg);
      (pkgToFiles.get(pkg) ?? pkgToFiles.set(pkg, []).get(pkg)!).push(id);
      for (const decl of scanTopLevelDecls(text)) {
        const fqn = qualify(pkg, decl);
        if (!declToFile.has(fqn)) declToFile.set(fqn, id);
      }
    }

    // Pass 2: per-file import resolution.
    for (const id of fileIds) {
      files[id] = extractFileRecord(
        id,
        texts.get(id) ?? '',
        declToFile,
        pkgToFiles,
        internalPackages,
        declaredGroups,
      );
    }

    const state: FileGraphState = { headSha: '', files };
    return graphFromState(root, state);
  }
}
