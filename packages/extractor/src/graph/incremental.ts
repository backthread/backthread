// Stage A — the diff-driven incremental extraction ENGINE.
//
// Owns a ts-morph Project + a FileGraphState (file-graph.ts) across a merge
// walk's checkpoints. The walk seeds it ONCE (full extract, or the
// extraction_cache's serialized file graph with ZERO symbol work), then PATCHES
// it per checkpoint from `git diff --name-status` — re-running the expensive
// type-checker call-edge extraction only on the changed files + the dependents
// that can observe the change (computeCallPatchUnit), and re-resolving import
// specifiers fresh wherever the tree's shape moved.
//
// WHY the working tree stays checked out per checkpoint: import/call resolution
// is the ts-morph compiler's (Bundler resolution, tsconfig paths, extensionless
// + .js→.ts mapping). Re-implementing it against a bare tree index would risk
// silent divergence from a full extract — the one thing Stage A must not do.
// `git checkout` between adjacent merges only rewrites the changed paths, so
// the checkout itself is already O(diff); what this engine eliminates is the
// O(repo) parse + symbol-resolution per checkpoint.
//
// Patch modes per checkpoint:
//   * content-only diff (M) → refresh just those SourceFiles in the live
//     Project (no re-parse of anything else; resolution can't move when the
//     tree shape is unchanged).
//   * shape diff (A/D/T)    → rebuild the Project from disk (syntactic parse,
//     seconds) + re-resolve EVERY file's imports (cheap) — catching "an
//     existing `./util` import now resolves to the new file" exactly like a
//     full extract would. Call extraction still runs only on the patch unit.
//   * config invalidator    → the caller runs a FULL re-seed instead (the
//     correctness valve; tsconfig/package/lockfiles can move resolution
//     globally).
//
// EQUIVALENCE CONTRACT: at every checkpoint the patched graph must equal a
// fresh full extract of the same tree — guarded by incremental-equivalence
// fixture test. See file-graph.ts for the STEP-1 finding + the documented
// residual (deep type-dispatch chains), healed by invalidators + Stage B
// reconciliation.

import { resolve } from 'node:path';
import type { Project, SourceFile } from 'ts-morph';
import type { NormalizedGraph } from './types.js';
import {
  classifyDiff,
  computeCallPatchUnit,
  deserializeFileGraph,
  graphFromState,
  serializeFileGraph,
  type DiffEntry,
  type FileGraphState,
  type FileRecord,
  type SerializedFileGraph,
} from './file-graph.js';
import { filterNoise, summarizeNoise } from './noise-filter.js';
import {
  addAllSourceFiles,
  buildExtractionProject,
  extractFileCalls,
  extractFileImportsRecord,
  extractFileRecord,
  toId,
} from './ts-morph-adapter.js';

export interface PatchMetrics {
  /** How this checkpoint's graph was produced. */
  mode: 'seed-full' | 'seed-cache' | 'seed-blob-cache' | 'patch-refresh' | 'patch-rebuild';
  /** Source files whose content was (re)parsed this checkpoint. */
  parsedFiles: number;
  /** Files whose call edges were re-extracted (the expensive symbol work). */
  callExtracted: number;
  /** Files whose records were carried unchanged from the previous state. */
  carried: number;
  /** Total files in the graph after this checkpoint. */
  filesTotal: number;
}

export class IncrementalExtractor {
  private project: Project | null = null;
  private state: FileGraphState | null = null;
  /**
   * Stage B — paths whose records were (RE)COMPUTED this boot: exactly
   * the rows worth upserting into the blob parse-cache at boot end. Patch-unit
   * members + full-extract files only — NOT imports-only-refreshed files (their
   * cached record's stale-resolved imports only feed the moved-bindings check
   * on reuse, which re-validates against the live tree anyway; marking them
   * would upsert the whole repo every boot for nothing). Paths that leave the
   * state (deleted files) are dropped — their blobs aren't in the final tree.
   */
  private dirty = new Set<string>();

  /**
   * log the noise-filter policy at most ONCE per engine lifetime (=
   * once per boot). The filter runs on every seed/patch return (so the
   * clustering-bound graph is always clean), but a per-checkpoint log line would
   * spam the merge walk with the same drop every checkpoint. Logging once — at
   * the first checkpoint that drops anything, whether that's a seed or a patch —
   * keeps the house rule (never a silent cap) without the noise.
   */
  private noiseLogged = false;

  /**
   * drop tests/generated/build/config/stories/mocks/types from the
   * clustering-bound graph. Deterministic + pure; the carried FileGraphState is
   * left intact (filtering is an OUTPUT concern only — incremental patching, the
   * blob cache, and the Stage-A/B equivalence contract are unaffected).
   */
  private applyNoiseFilter(graph: NormalizedGraph): NormalizedGraph {
    const { graph: filtered, dropped } = filterNoise(graph);
    if (dropped.total > 0 && !this.noiseLogged) {
      console.log(`  ⊘ ${summarizeNoise(dropped)}`);
      this.noiseLogged = true;
    }
    return filtered;
  }

  /** Is there a carried state to patch from? */
  get hasState(): boolean {
    return this.state !== null;
  }

  /** The FULL commit sha the carried state corresponds to (diff base). */
  get headSha(): string | null {
    return this.state?.headSha ?? null;
  }

  /**
   * Adopt a serialized file graph (the extraction_cache seed) — ZERO parsing.
   * Returns false (and stays unseeded) when the payload isn't usable.
   */
  adoptCache(serialized: unknown): boolean {
    const state = deserializeFileGraph(serialized);
    if (!state) return false;
    this.state = state;
    this.project = null; // built lazily on the first patch
    this.dirty.clear(); // nothing recomputed — every record came from the cache
    return true;
  }

  /**
   * Adopt a ground-truth state DIRECTLY (the Stage-B reconciliation heal —
   * container.ts swaps in a fresh full extract's state when drift is found).
   * The caller marks the drifted paths dirty itself (markDirty) so the heal
   * reaches the blob cache; the engine's existing dirty set stays valid (non-
   * drifted records are identical by definition of the diff).
   */
  adoptState(state: FileGraphState): void {
    this.state = state;
    this.project = null; // rebuilt lazily on the next patch
    for (const path of this.dirty) {
      if (!(path in state.files)) this.dirty.delete(path);
    }
  }

  /** Paths whose records were (re)computed this boot — the blob-cache upserts. */
  dirtyPaths(): string[] {
    return [...this.dirty];
  }

  /** Forget the dirty set (call after a successful blob-cache upsert). */
  clearDirty(): void {
    this.dirty.clear();
  }

  /** Mark paths dirty (the reconciliation heal's drifted set). */
  markDirty(paths: readonly string[]): void {
    for (const p of paths) this.dirty.add(p);
  }

  /** The carried record for a path (blob-cache row material), or null. */
  recordFor(path: string): FileRecord | null {
    return this.state?.files[path] ?? null;
  }

  /** The carried state (reconciliation comparator input). Do not mutate. */
  stateSnapshot(): FileGraphState {
    if (!this.state) throw new Error('IncrementalExtractor.stateSnapshot before seed');
    return this.state;
  }

  /**
   * Full extract at the current working tree (the seed, or the config-
   * invalidator fallback). Same work as the batch adapter — kept for the
   * boot's FIRST checkpoint when no usable cache seed exists.
   */
  seedFull(repoDir: string, headSha: string): { graph: NormalizedGraph; metrics: PatchMetrics } {
    const root = resolve(repoDir);
    // release any prior Project BEFORE building its replacement so the
    // old ts-morph AST + resolution state is collectible during the (re)build,
    // instead of two full Projects coexisting. That transient ~2x heap is what
    // OOM-aborted the container (exit 134) when a large monorepo's window hit a
    // config invalidator and re-entered seedFull mid-walk.
    this.project = null;
    const project = buildExtractionProject(root);
    addAllSourceFiles(project, root);

    const sourceFiles = project.getSourceFiles();
    const internalIds = new Set<string>(sourceFiles.map((sf) => toId(root, sf.getFilePath())));
    const files: Record<string, FileRecord> = {};
    for (const sf of sourceFiles) {
      files[toId(root, sf.getFilePath())] = extractFileRecord(sf, root, internalIds);
    }

    this.project = project;
    this.state = { headSha, files };
    // Everything was recomputed → everything is blob-cache upsert material;
    // previously-dirty paths that left the tree drop with the new state.
    this.dirty = new Set(Object.keys(files));
    return {
      graph: this.applyNoiseFilter(graphFromState(root, this.state)),
      metrics: {
        mode: 'seed-full',
        parsedFiles: sourceFiles.length,
        callExtracted: sourceFiles.length,
        carried: 0,
        filesTotal: sourceFiles.length,
      },
    };
  }

  /**
   * Stage B — seed from the content-addressed BLOB PARSE-CACHE: the
   * cold-boot path when no carried graph exists (or its head commit is
   * unreachable in the clone) but per-blob records survive in
   * `file_parse_cache`. `cached` is keyed by repo-relative path and contains
   * ONLY records whose blobSha already matched the current tree — the CALLER
   * does the blob matching (container.ts joins lsTreeBlobs against the cache).
   *
   * CORRECTNESS (the patchTo argument with "diff = cache misses"): a cached
   * record's CALLS are reused only when
   *   (a) the content is blob-identical (the caller's join),
   *   (b) its freshly-resolved import bindings equal the cached ones (the
   *       moved-bindings check below — this also heals a blob that matched at
   *       a DIFFERENT path, where relative specifiers resolve elsewhere), and
   *   (c) no re-export chain connects it to a miss (the closure).
   * Imports/externals/reexports are re-resolved FRESH for every file (cheap;
   * resolution must reflect THIS tree). Same documented residual as Stage A
   * (deep type-dispatch chains), healed by the periodic reconciliation pass.
   */
  seedFromBlobCache(
    repoDir: string,
    headSha: string,
    cached: ReadonlyMap<string, FileRecord>,
  ): { graph: NormalizedGraph; metrics: PatchMetrics } {
    const root = resolve(repoDir);
    // 1. Syntactic parse of the whole tree — unavoidable on a cold boot
    //    (seconds); the expensive type-checker work below is O(misses + moved).
    const project = buildExtractionProject(root);
    addAllSourceFiles(project, root);
    const sourceFiles = project.getSourceFiles();
    const internalIds = new Set<string>(sourceFiles.map((sf) => toId(root, sf.getFilePath())));
    const sfById = new Map<string, SourceFile>(
      sourceFiles.map((sf) => [toId(root, sf.getFilePath()), sf]),
    );

    // 2. Misses = current source files without a blob-matched cached record.
    const misses: string[] = [];
    for (const id of internalIds) {
      if (!cached.has(id)) misses.push(id);
    }

    // 3. Fresh import resolution for EVERY file (must be current-tree).
    const freshImports = new Map<string, FileRecord>(); // calls EMPTY (filled below)
    for (const id of internalIds) {
      const sf = sfById.get(id);
      if (!sf) continue;
      freshImports.set(id, extractFileImportsRecord(sf, root, internalIds));
    }
    const importsView = new Map<string, FileRecord['imports']>();
    const reexportsView = new Map<string, readonly string[]>();
    for (const [id, rec] of freshImports) {
      importsView.set(id, rec.imports);
      reexportsView.set(id, rec.reexports);
    }
    // The "previous" import view = the cached records' (a miss has no entry →
    // computeCallPatchUnit treats it as new and pulls it into the unit).
    const prevImports = new Map<string, FileRecord['imports']>(
      [...cached].map(([id, rec]) => [id, rec.imports]),
    );

    // 4. The call patch unit: misses + moved bindings + re-export closure
    //    importers — exactly patchTo's rule with "diff = cache misses".
    const unit = computeCallPatchUnit({
      added: misses,
      modified: [],
      deleted: [],
      freshImports: importsView,
      prevImports,
      reexports: reexportsView,
    });

    // 5. Assemble: unit members pay the symbol work; the rest reuse cached
    //    calls (pruned to the current tree — a full extract could never emit
    //    an edge to a file that isn't here).
    const files: Record<string, FileRecord> = {};
    let callExtracted = 0;
    let carried = 0;
    for (const id of internalIds) {
      const sf = sfById.get(id)!;
      const base = freshImports.get(id) ?? extractFileImportsRecord(sf, root, internalIds);
      if (unit.has(id)) {
        files[id] = { ...base, calls: extractFileCalls(sf, root, internalIds) };
        callExtracted++;
      } else {
        // Non-unit ⇒ cached.has(id) by construction (every miss joined the unit).
        files[id] = {
          ...base,
          calls: (cached.get(id)?.calls ?? []).filter((c) => internalIds.has(c.to)),
        };
        carried++;
      }
    }

    this.project = project;
    this.state = { headSha, files };
    // Only the unit's records were (re)computed — those join the upsert set;
    // carried records already live in the blob cache (that's where they came
    // from). Paths no longer in the state drop (their blobs left the tree).
    for (const id of unit) this.dirty.add(id);
    for (const path of this.dirty) {
      if (!(path in files)) this.dirty.delete(path);
    }
    return {
      graph: this.applyNoiseFilter(graphFromState(root, this.state)),
      metrics: {
        mode: 'seed-blob-cache',
        parsedFiles: sourceFiles.length,
        callExtracted,
        carried,
        filesTotal: Object.keys(files).length,
      },
    };
  }

  /**
   * Patch the carried state to the tree currently checked out at `repoDir`
   * (commit `headSha`), given the name-status diff from the carried head to
   * this commit. The caller is responsible for the config-invalidator check
   * (classifyDiff(...).invalidators → call seedFull instead).
   */
  patchTo(repoDir: string, headSha: string, diff: readonly DiffEntry[]): { graph: NormalizedGraph; metrics: PatchMetrics } {
    if (!this.state) throw new Error('IncrementalExtractor.patchTo before seed');
    const root = resolve(repoDir);
    const cls = classifyDiff(diff);
    const seededFromCache = this.project === null;

    // --- 1. Bring the Project in line with the tree ------------------------
    let parsedFiles = 0;
    let rebuilt = false;
    if (this.project === null || cls.shapeChanged) {
      // Shape moved (or first patch after a cache seed) → rebuild from disk.
      // Syntactic parse of the tree (seconds); the expensive symbol work below
      // stays O(patch unit). A fresh Project also sidesteps any module-
      // resolution cache staleness across adds/deletes.
      // drop the prior Project BEFORE building the replacement (build
      // into a local, then assign) so the old ts-morph Project is collectible
      // during the rebuild instead of both coexisting — the 2x-heap transient
      // that OOM-aborted the container (exit 134) on a large monorepo whose
      // window hit a config invalidator. (seededFromCache was captured above.)
      this.project = null;
      const rebuiltProject = buildExtractionProject(root);
      addAllSourceFiles(rebuiltProject, root);
      this.project = rebuiltProject;
      parsedFiles = rebuiltProject.getSourceFiles().length;
      rebuilt = true;
    } else {
      // Content-only diff → refresh exactly the modified files in place.
      for (const path of cls.sourceModified) {
        const abs = `${root}/${path}`;
        const sf = this.project.getSourceFile(abs);
        if (sf) {
          sf.refreshFromFileSystemSync();
        } else {
          // Defensive: the carried project should contain it; add if not.
          this.project.addSourceFileAtPath(abs);
        }
        parsedFiles++;
      }
    }

    const project = this.project;
    const sourceFiles = project.getSourceFiles();
    const internalIds = new Set<string>(sourceFiles.map((sf) => toId(root, sf.getFilePath())));
    const sfById = new Map<string, SourceFile>(sourceFiles.map((sf) => [toId(root, sf.getFilePath()), sf]));

    // --- 2. Import/re-export/external resolution ---------------------------
    // Fresh wherever resolution can have moved: every file on a rebuild (tree
    // shape changed), only the modified files on a refresh (shape unchanged ⇒
    // unchanged files' specifiers bind identically). extractFileRecord also
    // produces the file's calls — for files OUTSIDE the call patch unit we
    // overwrite them with the carried ones below, so the expensive symbol pass
    // effectively runs only where needed... except extractFileRecord computes
    // calls inline. To keep symbol work O(patch unit), resolution-only files
    // get a cheap imports-only pass instead.
    const prevFiles = this.state.files;
    const freshImports = new Map<string, FileRecord>(); // imports/externals/reexports fresh; calls EMPTY (filled below)
    const importsOnlyTargets: string[] = rebuilt
      ? [...internalIds]
      : cls.sourceModified.filter((p) => internalIds.has(p));
    for (const id of importsOnlyTargets) {
      const sf = sfById.get(id);
      if (!sf) continue;
      freshImports.set(id, extractFileImportsRecord(sf, root, internalIds));
    }

    // Per-file import views for the patch-unit computation: fresh where
    // recomputed, carried otherwise (valid — resolution didn't move there).
    const importsView = new Map<string, FileRecord['imports']>();
    const reexportsView = new Map<string, readonly string[]>();
    for (const id of internalIds) {
      const fresh = freshImports.get(id);
      const prev = prevFiles[id];
      importsView.set(id, fresh ? fresh.imports : (prev?.imports ?? []));
      reexportsView.set(id, fresh ? fresh.reexports : (prev?.reexports ?? []));
    }
    const prevImports = new Map<string, FileRecord['imports']>(
      Object.entries(prevFiles).map(([id, rec]) => [id, rec.imports]),
    );

    // --- 3. The call patch unit (the expensive symbol work) ----------------
    const unit = computeCallPatchUnit({
      added: cls.sourceAdded.filter((p) => internalIds.has(p)),
      modified: cls.sourceModified.filter((p) => internalIds.has(p)),
      deleted: cls.sourceDeleted,
      freshImports: importsView,
      prevImports,
      reexports: reexportsView,
    });

    // --- 4. Assemble the new state -----------------------------------------
    const files: Record<string, FileRecord> = {};
    let callExtracted = 0;
    let carried = 0;
    for (const id of internalIds) {
      const sf = sfById.get(id)!;
      if (unit.has(id)) {
        // Full per-file extraction: reuse the fresh import half when it was
        // already computed above, add the expensive call half.
        const base = freshImports.get(id) ?? extractFileImportsRecord(sf, root, internalIds);
        files[id] = { ...base, calls: extractFileCalls(sf, root, internalIds) };
        callExtracted++;
        this.dirty.add(id); // (re)computed → blob-cache upsert material
        continue;
      }
      const prev = prevFiles[id];
      const freshNoCalls = freshImports.get(id);
      if (freshNoCalls) {
        // Imports re-resolved (rebuild path) but calls carried — the unit
        // computation proved this file's bindings didn't move. Prune any
        // carried call edge whose target left the tree (a full extract could
        // not produce it). NOT marked dirty: the record's call half came from
        // the carried state, and its imports-only refresh is re-validated on
        // every reuse anyway (the moved-bindings check).
        files[id] = {
          ...freshNoCalls,
          calls: (prev?.calls ?? []).filter((c) => internalIds.has(c.to)),
        };
        carried++;
      } else if (prev) {
        files[id] = {
          ...prev,
          calls: prev.calls.filter((c) => internalIds.has(c.to)),
          imports: prev.imports.filter((e) => internalIds.has(e.to)),
        };
        carried++;
      } else {
        // Shouldn't happen (a file neither carried nor in the unit) — extract
        // defensively rather than dropping it.
        files[id] = extractFileRecord(sf, root, internalIds);
        callExtracted++;
        this.dirty.add(id);
      }
    }

    this.state = { headSha, files };
    // Paths that left the state this patch are no longer upsert material.
    for (const path of this.dirty) {
      if (!(path in files)) this.dirty.delete(path);
    }
    return {
      graph: this.applyNoiseFilter(graphFromState(root, this.state)),
      metrics: {
        mode: seededFromCache ? 'seed-cache' : rebuilt ? 'patch-rebuild' : 'patch-refresh',
        parsedFiles,
        callExtracted,
        carried,
        filesTotal: Object.keys(files).length,
      },
    };
  }

  /** Serialize the carried state for the extraction_cache fileGraph payload. */
  toCachePayload(blobShaByPath?: ReadonlyMap<string, string>): SerializedFileGraph | null {
    if (!this.state) return null;
    return serializeFileGraph(this.state, blobShaByPath);
  }

  /**
   * The NormalizedGraph view of the carried state (test/diagnostic read).
   * RAW — deliberately NOT noise-filtered: this is the carried-state
   * view the equivalence tests assert against, not a clustering-bound return.
   */
  graphSnapshot(root: string): NormalizedGraph {
    if (!this.state) throw new Error('IncrementalExtractor.graphSnapshot before seed');
    return graphFromState(resolve(root), this.state);
  }
}

