// Kotlin structural extractor — the import-graph backbone.
//
// INSTALL-FREE + PURE-STATIC by construction, like the other adapters: the hand-rolled
// syntactic scanner (kotlin-scan.ts — no native grammar, no tree-sitter, no repo-code
// execution) reads each file's `package`, its top-level declarations, and its `import`
// directives. Kotlin's `package`/`import` is class-granular (Java-like), so the backbone
// is a clean two-pass FQN registry — no AST needed for v1 (import edges only; no call
// edges — the locked scope):
//
//   1. REGISTRY — each file's top-level declaration is keyed `<package>.<Decl> → file`
//      (`package com.foo` + `class Bar` → `com.foo.Bar`), and a `package → file ids`
//      index is built for wildcard imports. First (sorted-id) definition wins a
//      duplicate, so the mapping is deterministic. The set of declared packages is the
//      internal-package set pass 2 uses to tell a first-party reference from a dependency.
//   2. RESOLUTION — each `import` is resolved through the registry. `import com.foo.Bar`
//      by LONGEST-PREFIX (so a nested type `com.foo.Outer.Inner` resolves to `com.foo.
//      Outer`); `import com.foo.*` to every file in that package; `import com.foo.Bar as
//      X` by the FQN (the rename doesn't affect resolution). A resolved target → an
//      internal import edge. An unresolved reference UNDER an internal package (a
//      same-package member, a top-level fun we didn't register) is DROPPED, never
//      mislabeled external. A Kotlin/JVM stdlib namespace (`java`/`javax`/`kotlin`/
//      `kotlinx`) is DROPPED (substrate). Everything else is an `ext:<group>` external —
//      the import's package bucketed by longest declared-dependency-group prefix.
//
// KNOWN degrades (documented, accepted): a same-package implicit reference (no `import`)
// is not an edge (import-only backbone; those files share a package → same Louvain
// community → same subsystem anyway, so the lost edges are intra-cluster). A wildcard
// `import pkg.*` draws an edge to EVERY file in the package (can slightly over-connect;
// weight 1). No call edges. `.kts` build scripts (`build.gradle.kts`) match no `.kt`
// source and are read as manifests, never graph nodes.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphExtractor, NormalizedGraph } from './types.js';
import { graphFromState, type FileRecord, type FileGraphState } from './file-graph.js';
import { listSourceFiles } from './language.js';
import { isKotlinStdlib } from './kotlin-stdlib.js';
import { readGradleDepsDeep } from './kotlin-manifest.js';
import { scanPackage, scanImports, scanTopLevelDecls, kotlinExternalId } from './kotlin-scan.js';

/** Lines of code for one source file (a size/centrality signal). */
function locOf(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/** Qualify a top-level declaration by its file's package (`com.foo` + `Bar` → `com.foo.Bar`). */
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
 * Resolve a non-wildcard import FQN to its defining file by LONGEST prefix over the
 * registry: try the full name, then drop trailing segments (a nested type resolves to
 * its top-level enclosing type). Stops before a single (dot-less) segment — Kotlin can't
 * import from the root package, so a real import is always ≥2 segments. Undefined = miss.
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
    const ext = kotlinExternalId(pkg, declaredGroups);
    const existing = externalWeights.get(ext.id);
    if (existing) existing.weight += 1;
    else externalWeights.set(ext.id, { specifier: ext.specifier, weight: 1 });
  };

  for (const imp of scanImports(text)) {
    if (!imp.fqn.includes('.')) continue; // a real Kotlin import is always ≥2 segments

    if (imp.wildcard) {
      const files = pkgToFiles.get(imp.fqn);
      if (files) {
        for (const target of files) addInternal(target);
        continue;
      }
      // Not an internal package with direct members.
      if (isUnderInternalPackage(imp.fqn, internalPackages)) continue; // first-party parent → drop
      if (isKotlinStdlib(imp.fqn)) continue;
      addExternal(imp.fqn);
      continue;
    }

    const target = resolveByPrefix(imp.fqn, declToFile);
    if (target !== undefined) {
      addInternal(target);
      continue;
    }
    if (isUnderInternalPackage(imp.fqn, internalPackages)) continue; // first-party, unresolved → drop
    if (isKotlinStdlib(imp.fqn)) continue; // substrate
    addExternal(packageOf(imp.fqn));
  }

  return {
    loc: locOf(text),
    language: 'kt',
    imports: [...importWeights].map(([to, weight]) => ({ to, weight })),
    externals: [...externalWeights].map(([id, v]) => ({ id, specifier: v.specifier, weight: v.weight })),
    calls: [], // v1: import-backbone only (no call edges — the locked scope)
    reexports: [],
  };
}

export class KotlinExtractor implements GraphExtractor {
  readonly language = 'kotlin';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    // Graph source = `.kt` ONLY (`.kts` build scripts are read as manifests, not nodes).
    const fileIds = listSourceFiles(root, 'kotlin');
    const files: Record<string, FileRecord> = {};
    if (fileIds.length === 0) return graphFromState(root, { headSha: '', files });

    // The declared dependency groups — the buckets externals collapse into (a
    // multi-module repo declares deps per module + a root version catalog, so union
    // across the whole repo). Manifests only; never executes a build script.
    const declaredGroups = readGradleDepsDeep(root);

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

    // Pass 1: the FQN registry (`<pkg>.<Decl>` → file), the package→files index, and the
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
