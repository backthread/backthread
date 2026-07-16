// Dart structural extractor — the import-graph backbone.
//
// INSTALL-FREE + PURE-STATIC by construction, like the other adapters: the
// hand-rolled syntactic scanner (dart-scan.ts — no native grammar, no tree-sitter,
// no repo-code execution) reads Dart's line-anchored directives (`import`/`export`/
// `part`/`part of`/`library`).
//
// Dart is the SIMPLEST backbone of any shipped language: imports are FILE-granular
// URIs, so resolution is PURE PATH-ARITHMETIC — no class registry needed (that's
// built separately for the framework adapters, framework/dart/analyze.ts).
//
//   * `import 'package:<self>/x/y.dart'` — `<self>` is an internal package's own
//      pubspec `name:`, so it resolves to `<pkgDir>/lib/x/y.dart` (root pkg → `lib/…`).
//   * `import 'package:<other>/…'`       — `<other>` is a real dependency → `ext:<other>`.
//   * a relative URI (`./x.dart`, `../y/z.dart`, `sub/w.dart`) → posix-joined against
//      the importing file's dir.
//   * `export '…'`                        — an import-KIND reexport edge (same resolution).
//   * `import '…' if (cond) '…'`           — the DEFAULT URI only (dart-scan drops the tail).
//   * `dart:<core>`                        — the whole `dart:` scheme is SUBSTRATE, dropped.
//
// PART MERGE: a `part 'x.g.dart'` (or a `part of` back-reference) folds the part file
// INTO its parent library node — the part is not its own diagram box; its loc sums
// into the parent and its (rare, legacy) directives resolve as the parent's. This
// folds most codegen (`.g.dart` / `.freezed.dart`) for free. A `part of` we can't
// resolve (a library-name form with no matching `library` declaration) degrades to
// its own node (rare) — logged, never silently mislabeled.
//
// Import edges are the reliable backbone; there are NO call edges in v1 (dynamic
// dispatch makes them weak — the locked import-first stance every language shipped).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphExtractor, NormalizedGraph } from './types.js';
import { graphFromState, type FileRecord, type FileGraphState } from './file-graph.js';
import { listSourceFiles } from './language.js';
import { dartPackageRoots } from './dart-manifest.js';
import { scanDartDirectives } from './dart-scan.js';
import { isDartCoreUri } from './dart-stdlib.js';

/** The repo-relative posix dir of a file id ('' for a root file). */
function dirOf(id: string): string {
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(0, i) : '';
}

/** Lines of code for one source file (a size/centrality signal). */
function locOf(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/**
 * Posix-join a base dir with a relative URI, normalizing `.` / `..`. Returns null
 * if the path escapes the repo root (a `..` above the top). Pure.
 */
export function posixJoin(baseDir: string, rel: string): string | null {
  const segs = baseDir ? baseDir.split('/') : [];
  for (const s of rel.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (segs.length === 0) return null;
      segs.pop();
    } else {
      segs.push(s);
    }
  }
  return segs.join('/');
}

/** The result of resolving one import/export URI against the package layout. */
export type DartUriResolution =
  | { kind: 'internal'; target: string } // a first-party file id (pre part-merge)
  | { kind: 'external'; id: string; specifier: string }
  | { kind: 'drop' }; // dart: core, an escaping path, or an unresolvable internal ref

/**
 * Resolve ONE directive URI (from the file `fromId`) to an internal target file id,
 * an external package node, or a drop. `packageRoots` maps every internal package's
 * `name:` → its repo-relative dir. Pure; the caller then checks internal targets
 * against the real file set + maps them through the part-merge to a library node.
 */
export function resolveDartUri(
  fromId: string,
  uri: string,
  packageRoots: ReadonlyMap<string, string>,
): DartUriResolution {
  if (isDartCoreUri(uri)) return { kind: 'drop' }; // dart:core / dart:async / … → substrate
  if (uri.startsWith('package:')) {
    const body = uri.slice('package:'.length);
    const slash = body.indexOf('/');
    const pkg = slash >= 0 ? body.slice(0, slash) : body;
    const rest = slash >= 0 ? body.slice(slash + 1) : '';
    const pkgDir = packageRoots.get(pkg);
    if (pkgDir === undefined) {
      // A real (external) dependency — collapse to the package node.
      return { kind: 'external', id: `ext:${pkg}`, specifier: pkg };
    }
    // First-party package: `<pkgDir>/lib/<rest>`. A pathless `package:<self>` is malformed → drop.
    if (!rest) return { kind: 'drop' };
    const target = pkgDir === '' ? `lib/${rest}` : `${pkgDir}/lib/${rest}`;
    return { kind: 'internal', target };
  }
  // A relative URI — resolve against the importing file's dir.
  const target = posixJoin(dirOf(fromId), uri);
  if (target === null) return { kind: 'drop' }; // escaped the repo root
  return { kind: 'internal', target };
}

export class DartExtractor implements GraphExtractor {
  readonly language = 'dart';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    const fileIds = listSourceFiles(root, 'dart');
    const files: Record<string, FileRecord> = {};
    if (fileIds.length === 0) return graphFromState(root, { headSha: '', files });

    const fileSet = new Set(fileIds);
    const packageRoots = dartPackageRoots(root);

    // Read every file once (text reused across passes). An unreadable file degrades to
    // empty text (no directives, no edges) — never fails the extraction.
    const texts = new Map<string, string>();
    for (const id of fileIds) {
      try {
        texts.set(id, readFileSync(`${root}/${id}`, 'utf8'));
      } catch {
        texts.set(id, '');
      }
    }

    // Pass 1 — directives per file + the `library <name>` registry (name → file).
    const directives = new Map(fileIds.map((id) => [id, scanDartDirectives(texts.get(id) ?? '')]));
    const libraryNameToFile = new Map<string, string>();
    for (const id of fileIds) {
      const lib = directives.get(id)!.library;
      if (lib && !libraryNameToFile.has(lib)) libraryNameToFile.set(lib, id);
    }

    // Pass 2 — the part merge: map each part CHILD → its parent library node. The
    // parent's `part 'child'` directive is authoritative (a literal relative URI);
    // the child's `part of` is the fallback (URI form → path, name form → the
    // `library` registry). An unresolved `part of` leaves the child its own node.
    const parentByChild = new Map<string, string>();
    // (a) parent-declared parts (authoritative).
    for (const id of fileIds) {
      for (const partUri of directives.get(id)!.parts) {
        const childId = posixJoin(dirOf(id), partUri);
        if (childId && fileSet.has(childId) && childId !== id && !parentByChild.has(childId)) {
          parentByChild.set(childId, id);
        }
      }
    }
    // (b) child-declared `part of` (fallback for children the parent didn't list).
    let unresolvedPartOf = 0;
    for (const id of fileIds) {
      if (parentByChild.has(id)) continue;
      const po = directives.get(id)!.partOf;
      if (!po) continue;
      let parent: string | null | undefined;
      if (po.uri) parent = posixJoin(dirOf(id), po.uri);
      else if (po.name) parent = libraryNameToFile.get(po.name);
      if (parent && parent !== id && fileSet.has(parent)) parentByChild.set(id, parent);
      else unresolvedPartOf++; // library-name with no `library` decl, or a missing parent → own node
    }

    // The ultimate library node a file id belongs to (follow part→parent to a fixpoint).
    const libNode = (id: string): string => {
      let cur = id;
      let guard = 0;
      while (parentByChild.has(cur) && guard++ < 64) cur = parentByChild.get(cur)!;
      return cur;
    };

    // Group each library node's constituent files (itself + its merged parts) so
    // directives resolve with the RIGHT importing dir (a legacy part's relative import
    // is relative to the part, not the parent) while edges attribute to the library.
    const constituents = new Map<string, string[]>();
    for (const id of fileIds) {
      const node = libNode(id);
      (constituents.get(node) ?? constituents.set(node, []).get(node)!).push(id);
    }

    // Pass 3 — build one FileRecord per library node (sum loc; union + resolve the
    // directives of every constituent; edges retargeted through the part merge).
    let mergedParts = 0;
    for (const [node, members] of constituents) {
      if (members.length > 1) mergedParts += members.length - 1;
      const importWeights = new Map<string, number>();
      const externalWeights = new Map<string, { specifier: string; weight: number }>();
      const reexports = new Set<string>();
      let loc = 0;

      for (const memberId of members) {
        loc += locOf(texts.get(memberId) ?? '');
        const dir = directives.get(memberId)!;
        const resolveOne = (uri: string, isExport: boolean): void => {
          const res = resolveDartUri(memberId, uri, packageRoots);
          if (res.kind === 'drop') return;
          if (res.kind === 'external') {
            const existing = externalWeights.get(res.id);
            if (existing) existing.weight += 1;
            else externalWeights.set(res.id, { specifier: res.specifier, weight: 1 });
            return;
          }
          // Internal — the target must be a real .dart file; retarget to its library node.
          if (!fileSet.has(res.target)) return; // first-party but unresolved (filtered/generated) → drop
          const targetNode = libNode(res.target);
          if (targetNode === node) return; // self-edge (an intra-library part reference)
          importWeights.set(targetNode, (importWeights.get(targetNode) ?? 0) + 1);
          if (isExport) reexports.add(targetNode);
        };
        for (const uri of dir.imports) resolveOne(uri, false);
        for (const uri of dir.exports) resolveOne(uri, true);
      }

      files[node] = {
        loc,
        language: 'dart',
        imports: [...importWeights].map(([to, weight]) => ({ to, weight })),
        externals: [...externalWeights].map(([id, v]) => ({ id, specifier: v.specifier, weight: v.weight })),
        calls: [], // v1: import backbone only, no call edges
        reexports: [...reexports].sort(),
      };
    }

    // Positive signal for validation (mirrors the other adapters' log discipline).
    const nodeCount = Object.keys(files).length;
    let edgeCount = 0;
    let externalRefs = 0;
    for (const rec of Object.values(files)) {
      edgeCount += rec.imports.length;
      externalRefs += rec.externals.length;
    }
    console.log(
      `  [dart] ${nodeCount} library node(s) · ${edgeCount} import edge(s) · ${externalRefs} external ref(s)` +
        (mergedParts > 0 ? ` · ${mergedParts} part file(s) folded into parents` : '') +
        (packageRoots.size > 0 ? ` · ${packageRoots.size} internal package(s)` : ''),
    );
    if (unresolvedPartOf > 0) {
      console.log(
        `  [dart] degraded: ${unresolvedPartOf} unresolvable \`part of\` file(s) kept as own node(s) (logged, not silently merged)`,
      );
    }

    const state: FileGraphState = { headSha: '', files };
    return graphFromState(root, state);
  }
}
