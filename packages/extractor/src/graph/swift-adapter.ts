// Swift structural extractor — the type-reference-graph backbone.
//
// INSTALL-FREE + PURE-STATIC by construction, like the other adapters: the
// hand-rolled syntactic scanner (swift-scan.ts — no native grammar, no tree-sitter,
// no repo-code execution) reads imports, primary type declarations, and type
// references. Swift `import` is MODULE-level, so a single-module iOS app has ~no
// intra-repo import edges; the real backbone is the TYPE-REFERENCE RESOLVER (the
// Zeitwerk analogue). Three passes:
//
//   1. REGISTRY   — every PRIMARY type a file declares (`class`/`struct`/`enum`/
//                   `protocol`/`actor`/`typealias Name`) maps to that file id. A name
//                   declared in ≥2 DIFFERENT files is AMBIGUOUS → dropped from the
//                   registry (accuracy over recall — a wrong edge teaches a false
//                   mental model, /325; no guess). A name declared several times in
//                   ONE file is not ambiguous (one file). `extension` is NOT a
//                   declaration — it's a reference (so a type + N extension files
//                   never self-cancel into ambiguity).
//   2. TARGETS    — SwiftPM targets (Package.swift `.target(name:,path:)`, unioned
//                   across a monorepo's manifests, never eval) give the first-party
//                   MODULE names + each target's source dir. An `import <Target>` is
//                   then a first-party cross-module dependency (not an external);
//                   files map to targets by longest source-dir prefix.
//   3. RESOLUTION — per file: (a) each type-REFERENCE token → the file that uniquely
//                   declares it (other than itself) → an internal `import`-kind edge
//                   (this is the connective tissue, intra- AND cross-module); (b)
//                   each first-party module `import <Target>` → a module-boundary
//                   edge to that target's representative (lexicographically-first)
//                   file, so a module dependency used only via free functions still
//                   renders as a target→target edge; (c) each remaining `import M` →
//                   `ext:M` (the MODULE name — external ≠ SPM package name, a
//                   documented degrade), Apple-SDK / stdlib modules dropped.
//
// No CALL edges in v1 (dynamic dispatch makes them weak; the type-reference backbone
// alone gives a legible Map — the import-first stance every language shipped with).
// `Package.swift` matches the `.swift` extension but is a MANIFEST (targets/deps, not
// a graph node), so it is skipped. Everything is deterministic (sorted outputs,
// ids derived from paths/names; run-twice is byte-identical).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphExtractor, NormalizedGraph } from './types.js';
import { graphFromState, type FileRecord, type FileEdgeRef } from './file-graph.js';
import { listSourceFiles } from './language.js';
import { scanSwiftFile, type SwiftFileScan } from './swift-scan.js';
import { readSwiftTargets, type SwiftTarget } from './swift-manifest.js';
import { isAppleSdkModule } from './swift-apple-sdk.js';

// `Package.swift` at the repo root OR a nested SPM package dir.
const PACKAGE_SWIFT_RE = /(^|\/)Package\.swift$/;

/** Lines of code for one source file (a size/centrality signal). */
function locOf(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/**
 * Assign each file to the SwiftPM target whose source dir is the LONGEST prefix of
 * the file id (a file under `Sources/Foo/Bar/` belongs to target Foo, not a shorter
 * sibling). Returns fileId→targetName + targetName→sorted-fileIds. Files under no
 * target dir (a pure-Xcode app, or files outside `Sources/`) belong to no target.
 */
export function assignFilesToTargets(
  fileIds: readonly string[],
  targets: readonly SwiftTarget[],
): { fileToTarget: Map<string, string>; filesByTarget: Map<string, string[]> } {
  // Longest dir first so the most specific target wins.
  const byDirLen = [...targets].sort((a, b) => b.dir.length - a.dir.length || (a.name < b.name ? -1 : 1));
  const fileToTarget = new Map<string, string>();
  const filesByTarget = new Map<string, string[]>();
  for (const id of fileIds) {
    for (const t of byDirLen) {
      if (t.dir !== '' && (id === t.dir || id.startsWith(`${t.dir}/`))) {
        fileToTarget.set(id, t.name);
        (filesByTarget.get(t.name) ?? filesByTarget.set(t.name, []).get(t.name)!).push(id);
        break;
      }
    }
  }
  for (const files of filesByTarget.values()) files.sort();
  return { fileToTarget, filesByTarget };
}

/** The resolution context every file's record is built against. */
export interface SwiftResolution {
  /** Type name → its unique declaring file (ambiguous names omitted). */
  nameToFile: ReadonlyMap<string, string>;
  /** First-party SwiftPM module (target) names. */
  targetNames: ReadonlySet<string>;
  /** fileId → the target it belongs to (for skipping same-target imports). */
  fileToTarget: ReadonlyMap<string, string>;
  /** target name → its representative (lexicographically-first) file id. */
  reprByTarget: ReadonlyMap<string, string>;
}

/**
 * Resolve ONE file's scan into internal import edges (type-references +
 * first-party cross-module imports) + external refs. Never throws.
 */
export function extractFileRecord(
  fromId: string,
  scan: SwiftFileScan,
  res: SwiftResolution,
  loc: number,
): FileRecord {
  const importWeights = new Map<string, number>();
  const externalWeights = new Map<string, { specifier: string; weight: number }>();
  const addImport = (to: string): void => {
    if (to === fromId) return; // no self-edges
    importWeights.set(to, (importWeights.get(to) ?? 0) + 1);
  };

  // (a) Type-reference edges — the backbone (intra- + cross-module).
  for (const token of scan.references) {
    const target = res.nameToFile.get(token);
    if (target !== undefined) addImport(target);
  }

  // (b/c) Module imports — first-party cross-module edge OR external node.
  const ownTarget = res.fileToTarget.get(fromId);
  for (const mod of scan.imports) {
    if (res.targetNames.has(mod)) {
      // First-party module dependency. Draw a module-boundary edge to the imported
      // target's representative file (collapses to the correct target→target edge).
      if (mod === ownTarget) continue; // a file can't import its own module
      const repr = res.reprByTarget.get(mod);
      if (repr !== undefined) addImport(repr);
      continue;
    }
    if (isAppleSdkModule(mod)) continue; // Apple SDK / stdlib substrate → dropped
    const id = `ext:${mod}`;
    const existing = externalWeights.get(id);
    if (existing) existing.weight += 1;
    else externalWeights.set(id, { specifier: mod, weight: 1 });
  }

  const imports: FileEdgeRef[] = [...importWeights]
    .map(([to, weight]) => ({ to, weight }))
    .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return {
    loc,
    language: 'swift',
    imports,
    externals: [...externalWeights]
      .map(([id, v]) => ({ id, specifier: v.specifier, weight: v.weight }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    calls: [], // no call edges in v1
    reexports: [],
  };
}

export class SwiftExtractor implements GraphExtractor {
  readonly language = 'swift';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    // Package.swift is a manifest, not a graph node — skip it (root + nested).
    const fileIds = listSourceFiles(root, 'swift').filter((id) => !PACKAGE_SWIFT_RE.test(id));
    const files: Record<string, FileRecord> = {};
    if (fileIds.length === 0) return graphFromState(root, { headSha: '', files });

    // Read + scan every file once.
    const scans = new Map<string, SwiftFileScan>();
    const locs = new Map<string, number>();
    for (const id of fileIds) {
      let text = '';
      try {
        text = readFileSync(`${root}/${id}`, 'utf8');
      } catch {
        // unreadable — degrade to an empty scan (a node with no edges).
      }
      scans.set(id, scanSwiftFile(text));
      locs.set(id, locOf(text));
    }

    // Pass 1: the type-declaration registry. A name declared in ≥2 DIFFERENT files
    // is ambiguous → omitted (accuracy over recall). First (sorted-id) order is
    // irrelevant to the omit decision but keeps logging deterministic.
    const declFiles = new Map<string, Set<string>>();
    for (const id of [...fileIds].sort()) {
      for (const name of scans.get(id)!.decls) {
        (declFiles.get(name) ?? declFiles.set(name, new Set()).get(name)!).add(id);
      }
    }
    const nameToFile = new Map<string, string>();
    const ambiguous: string[] = [];
    for (const [name, set] of declFiles) {
      if (set.size === 1) nameToFile.set(name, [...set][0]);
      else ambiguous.push(name);
    }

    // Pass 2: SwiftPM targets → first-party module names + file↔target maps.
    const targets = readSwiftTargets(root);
    const targetNames = new Set(targets.map((t) => t.name));
    const { fileToTarget, filesByTarget } = assignFilesToTargets(fileIds, targets);
    const reprByTarget = new Map<string, string>();
    for (const [name, tFiles] of filesByTarget) if (tFiles.length) reprByTarget.set(name, tFiles[0]);

    const res: SwiftResolution = { nameToFile, targetNames, fileToTarget, reprByTarget };

    // Pass 3: per-file resolution.
    for (const id of fileIds) files[id] = extractFileRecord(id, scans.get(id)!, res, locs.get(id) ?? 0);

    // Positive signal for validation (mirrors the framework fleet's log discipline).
    let internalEdges = 0;
    let externalEdges = 0;
    for (const id of fileIds) {
      internalEdges += files[id].imports.length;
      externalEdges += files[id].externals.length;
    }
    console.log(
      `  [swift] ${nameToFile.size} type(s) registered · ${internalEdges} internal edge(s) · ` +
        `${externalEdges} external ref(s) · ${targetNames.size} SPM target(s)`,
    );
    // No silent caps (locked): report ambiguous type names that were dropped.
    if (ambiguous.length > 0) {
      console.log(
        `  [swift] ${ambiguous.length} ambiguous type name(s) declared in ≥2 files — dropped from resolution ` +
          `(accuracy>recall): ${ambiguous.sort().slice(0, 10).join(', ')}`,
      );
    }

    return graphFromState(root, { headSha: '', files });
  }
}
