// localGraph.ts — `backthread graph`: extract the WORKING TREE's structural graph
// locally and write it to the `structure` section of the repo-local cache
// (localCache.ts), incrementally.
//
// This is the STRUCTURE half of the two-tier grep-time context hook. It runs
// @backthread/extractor (AST → communities → god-nodes → framework roles →
// subsystems) on the dev's actual checkout — exact, offline, zero-LLM — so the
// grep hook can join local structure with the synced decision "why" without a
// per-grep network/LLM hop. Beats a structure-only tool because the why rides
// alongside it (the join, localJoin.ts); on its own this is just parity.
//
// LAZY + FAIL-OPEN. The extractor pulls a heavy dep tree (ts-morph + Pyright),
// so it is imported DYNAMICALLY, only on this path — capture / session-start /
// mcp never touch it and stay light (verified: the esbuild bundle marks
// `@backthread/extractor` external, so the light commands carry none of it).
// The package is resolved at RUNTIME from wherever node can find it — the OSS
// workspace symlink today; when it's published + promoted from devDependencies
// to dependencies, npx/plugin installs light it up too. When it can't be
// resolved (published fleet, pre-publish) we return `unavailable` and write
// nothing — never an error, never a crash.
//
// INCREMENTAL. A first run does a full extract and serializes the extractor's
// file-graph state into the cache. A re-run stat-signatures every tracked file
// (mtime+size — cheap, no content read), and if any changed, seeds the
// IncrementalExtractor from the cached state and PATCHES only the dirty files
// (re-parsing the whole tree syntactically is seconds; the expensive
// type-checker call-edge work stays O(dirty)). A resolution-affecting config
// change (tsconfig/package.json/pyproject) forces a full re-extract (it can move
// import resolution globally). Nothing changed → a fast no-op.

import { statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  NormalizedGraph,
  ClusterResult,
  ClusteredModule,
  DiffEntry,
  Subsystem,
  SourceLang,
  WorkspaceLayout,
} from '@backthread/extractor';
import {
  resolveRepoRoot as defaultResolveRepoRoot,
  readCache as defaultReadCache,
  writeCacheSection as defaultWriteCacheSection,
  type LocalCache,
  type StructureSection,
  type CachedModule,
  type CachedEdge,
} from './localCache.js';
import { resolveGitContext, type GitRunner } from './repo.js';

/** The subset of IncrementalExtractor's surface this module drives — structural
 * so the real class AND a test fake both satisfy it (the real class carries
 * private fields, which would otherwise make it nominally un-fakeable). */
export interface IncrementalEngine {
  seedFull(repoDir: string, headSha: string): { graph: NormalizedGraph };
  patchTo(repoDir: string, headSha: string, diff: readonly DiffEntry[]): { graph: NormalizedGraph };
  adoptCache(serialized: unknown): boolean;
  toCachePayload(): unknown;
}

// The subset of the extractor's API this module uses, as a structural type so
// the loader (and tests) can supply it without the concrete package. Mirrors the
// real exports; the dynamic import satisfies it at runtime.
export interface ExtractorApi {
  EXTRACTOR_PACKAGE_VERSION: string;
  IncrementalExtractor: new () => IncrementalEngine;
  detectRepoLanguages: (repoDir: string) => SourceLang[];
  listSourceFiles: (root: string, lang: SourceLang) => string[];
  isConfigInvalidatorPath: (path: string) => boolean;
  detectWorkspaceLayout: (repoDir: string) => WorkspaceLayout;
  clusterGraph: (
    graph: NormalizedGraph,
    overrides: Record<string, unknown>,
    opts: { layout?: WorkspaceLayout; priorModules?: ReadonlyArray<Pick<ClusteredModule, 'id' | 'kind' | 'fileIds'>> },
  ) => ClusterResult;
  detectFrameworkStack: (repoDir: string) => Promise<unknown>;
  contributeFrameworkGraph: (args: { repoDir: string; graph: NormalizedGraph; cluster: ClusterResult }) => Promise<unknown>;
  computeSubsystems: (modules: ReadonlyArray<ClusteredModule>) => Map<string, Subsystem>;
  classifyDiff: (entries: readonly DiffEntry[]) => { invalidators: string[]; sourceAdded: string[]; sourceModified: string[]; sourceDeleted: string[] };
}

export interface RefreshStructureOptions {
  /** The session cwd; the repo root is resolved from it (git top-level). */
  cwd?: string;
  /** Force a full re-extract, ignoring the incremental cache. */
  force?: boolean;
}

export type RefreshStructureStatus =
  | 'refreshed-full' // wrote a fresh full extract
  | 'refreshed-incremental' // patched only the changed files
  | 'unchanged' // nothing changed since the last refresh — fast no-op
  | 'unavailable' // the extractor couldn't be loaded (fail-open; wrote nothing)
  | 'error'; // an unexpected failure (swallowed; never thrown)

export interface RefreshStructureOutcome {
  status: RefreshStructureStatus;
  detail: string;
  repoRoot?: string;
  moduleCount?: number;
  edgeCount?: number;
  changedFiles?: number;
}

export interface RefreshStructureDeps {
  /** Load the extractor (dynamic import by default). Injectable for tests. */
  loadExtractor?: () => Promise<ExtractorApi>;
  resolveRepoRootImpl?: (cwd: string) => string;
  readCacheImpl?: (repoRoot: string) => Promise<LocalCache | null>;
  writeCacheSectionImpl?: typeof defaultWriteCacheSection;
  /** Clock seam (structure.refreshedAt). Defaults to real time. */
  now?: () => Date;
  /** git runner seam for the head-sha label. */
  runGit?: GitRunner;
}

/** Default runtime loader: import the (external) extractor package. Isolated so
 * a resolution failure (unpublished / not installed) is a clean `unavailable`. */
async function defaultLoadExtractor(): Promise<ExtractorApi> {
  // The specifier is resolved relative to THIS module's on-disk location at
  // runtime — the workspace symlink in dev/dogfood; absent (→ throw → unavailable)
  // in a pre-publish npx/plugin install.
  const mod = (await import('@backthread/extractor')) as unknown as ExtractorApi;
  return mod;
}

/** A per-file change signature: mtime+size (stat-only — no content read, so the
 * unchanged fast-path stays cheap on a large repo). null when unstattable. */
function fileSignature(abs: string): string | null {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/** Repo-relative posix ids of the resolution-affecting config files at the repo
 * root and each workspace-package root (a shallow, bounded scan — a nested
 * tsconfig is rare and, if it changes with source, that source change already
 * re-parses those files). Mirrors the extractor's invalidator predicate exactly. */
function scanInvalidators(root: string, ext: ExtractorApi, layout: WorkspaceLayout): string[] {
  const dirs = new Set<string>(['']); // repo root scope
  for (const pkg of layout.packages) if (pkg.root) dirs.add(pkg.root);
  const out: string[] = [];
  for (const rel of dirs) {
    const abs = rel ? join(root, rel) : root;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ext.isConfigInvalidatorPath(ent.name)) continue;
      out.push(rel ? `${rel}/${ent.name}` : ent.name);
    }
  }
  return out;
}

/** Every tracked file's change signature (source files across all detected
 * languages + resolution-affecting config), repo-relative posix keyed. */
export function collectSignatures(
  root: string,
  ext: ExtractorApi,
  layout: WorkspaceLayout,
): Record<string, string> {
  const ids = new Set<string>();
  for (const lang of ext.detectRepoLanguages(root)) {
    for (const id of ext.listSourceFiles(root, lang)) ids.add(id);
  }
  for (const id of scanInvalidators(root, ext, layout)) ids.add(id);

  const sigs: Record<string, string> = {};
  for (const id of ids) {
    const sig = fileSignature(join(root, id));
    if (sig !== null) sigs[id] = sig;
  }
  return sigs;
}

/** Diff two signature maps into the extractor's DiffEntry shape (A/M/D). Pure. */
export function computeDiff(
  prev: Record<string, string>,
  curr: Record<string, string>,
): DiffEntry[] {
  const diff: DiffEntry[] = [];
  for (const [path, sig] of Object.entries(curr)) {
    const before = prev[path];
    if (before === undefined) diff.push({ status: 'A', path });
    else if (before !== sig) diff.push({ status: 'M', path });
  }
  for (const path of Object.keys(prev)) {
    if (!(path in curr)) diff.push({ status: 'D', path });
  }
  return diff;
}

/** Map a ClusterResult (+ subsystems) into the cache's structural shape. Pure. */
export function buildStructureModulesEdges(
  cluster: ClusterResult,
  subsystems: Map<string, Subsystem>,
): { modules: CachedModule[]; edges: CachedEdge[] } {
  const modules: CachedModule[] = cluster.modules.map((m) => {
    const sub = subsystems.get(m.id);
    return {
      id: m.id,
      kind: m.kind,
      godNode: m.godNode,
      loc: m.loc,
      fileCount: m.fileCount,
      fileIds: m.fileIds,
      subsystem: sub ? { id: sub.id, name: sub.name } : null,
      ...(m.externalSpecifier !== undefined ? { externalSpecifier: m.externalSpecifier } : {}),
      ...(m.packageName !== undefined ? { packageName: m.packageName ?? null } : {}),
    };
  });
  const edges: CachedEdge[] = cluster.moduleEdges.map((e) => ({
    source: e.source,
    target: e.target,
    kinds: [...e.kinds],
  }));
  return { modules, edges };
}

/** A synthetic head label for the file-graph state (the local path never diffs
 * FROM git — it passes an explicit diff — so this is purely a stored tag; it must
 * be ≥7 chars to round-trip the extractor's state (de)serialization). */
function headLabel(root: string, runGit?: GitRunner): string {
  const ctx = resolveGitContext(root, runGit);
  return ctx.headSha ?? 'worktree';
}

/**
 * Refresh the structure section of the repo-local cache. NEVER throws — every
 * failure resolves to a `RefreshStructureOutcome` (the caller — the `graph`
 * command / the grep-hook refresh — logs it). Fail-open: an unloadable extractor
 * or any hiccup leaves the existing cache untouched.
 */
export async function refreshStructure(
  opts: RefreshStructureOptions = {},
  deps: RefreshStructureDeps = {},
): Promise<RefreshStructureOutcome> {
  const load = deps.loadExtractor ?? defaultLoadExtractor;
  const resolveRoot = deps.resolveRepoRootImpl ?? defaultResolveRepoRoot;
  const readCacheImpl = deps.readCacheImpl ?? defaultReadCache;
  const writeSection = deps.writeCacheSectionImpl ?? defaultWriteCacheSection;
  const now = deps.now ?? (() => new Date());

  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = resolveRoot(cwd);

  let ext: ExtractorApi;
  try {
    ext = await load();
  } catch {
    return {
      status: 'unavailable',
      detail:
        'the structural extractor is not available here — local structure is skipped (the decision "why" cache still works).',
      repoRoot,
    };
  }

  try {
    const prior = await readCacheImpl(repoRoot).catch(() => null);
    const layout = ext.detectWorkspaceLayout(repoRoot);
    const signatures = collectSignatures(repoRoot, ext, layout);

    // Decide full vs incremental vs no-op.
    const priorStructure = opts.force ? null : (prior?.structure ?? null);
    const canIncrement =
      priorStructure !== null &&
      priorStructure.extractorVersion === ext.EXTRACTOR_PACKAGE_VERSION &&
      priorStructure.fileGraph != null;

    let graph: NormalizedGraph;
    let inc: IncrementalEngine;
    let mode: 'full' | 'incremental';
    let changedFiles = 0;
    const head = headLabel(repoRoot, deps.runGit);

    if (canIncrement) {
      const diff = computeDiff(priorStructure!.fileHashes ?? {}, signatures);
      const cls = ext.classifyDiff(diff);
      const sourceChanged =
        cls.sourceAdded.length + cls.sourceModified.length + cls.sourceDeleted.length;
      if (cls.invalidators.length > 0) {
        // A resolution-affecting config moved → full re-extract (correctness valve).
        inc = new ext.IncrementalExtractor();
        graph = inc.seedFull(repoRoot, head).graph;
        mode = 'full';
        changedFiles = diff.length;
      } else if (sourceChanged === 0) {
        return {
          status: 'unchanged',
          detail: 'no tracked files changed since the last refresh.',
          repoRoot,
          moduleCount: priorStructure!.modules?.length,
          edgeCount: priorStructure!.edges?.length,
          changedFiles: 0,
        };
      } else {
        inc = new ext.IncrementalExtractor();
        if (!inc.adoptCache(priorStructure!.fileGraph)) {
          // Unusable cached state (schema drift / corruption) → full.
          graph = inc.seedFull(repoRoot, head).graph;
          mode = 'full';
        } else {
          graph = inc.patchTo(repoRoot, head, diff).graph;
          mode = 'incremental';
        }
        changedFiles = sourceChanged;
      }
    } else {
      inc = new ext.IncrementalExtractor();
      graph = inc.seedFull(repoRoot, head).graph;
      mode = 'full';
      changedFiles = Object.keys(signatures).length;
    }

    // Cluster + framework enrichment + subsystems (cheap relative to the AST).
    await ext.detectFrameworkStack(repoRoot); // registers the framework adapters
    const priorModules =
      mode === 'incremental'
        ? (priorStructure!.modules ?? []).map((m) => ({ id: m.id, kind: m.kind, fileIds: m.fileIds }))
        : undefined;
    const cluster = ext.clusterGraph(graph, {}, { layout, priorModules });
    // Folds framework edges/roles + mutates cluster.modules' grouping in place.
    await ext.contributeFrameworkGraph({ repoDir: repoRoot, graph, cluster });
    const subsystems = ext.computeSubsystems(cluster.modules);
    const { modules, edges } = buildStructureModulesEdges(cluster, subsystems);

    const structure: StructureSection = {
      refreshedAt: now().toISOString(),
      root: repoRoot,
      extractorVersion: ext.EXTRACTOR_PACKAGE_VERSION,
      fileHashes: signatures,
      fileGraph: inc.toCachePayload(),
      modules,
      edges,
    };
    await writeSection(repoRoot, { structure, repo: prior?.repo ?? null });

    return {
      status: mode === 'full' ? 'refreshed-full' : 'refreshed-incremental',
      detail:
        mode === 'full'
          ? `full extract — ${modules.length} modules, ${edges.length} edges.`
          : `incremental — ${changedFiles} file(s) changed; ${modules.length} modules, ${edges.length} edges.`,
      repoRoot,
      moduleCount: modules.length,
      edgeCount: edges.length,
      changedFiles,
    };
  } catch (e) {
    return {
      status: 'error',
      detail: `structure refresh failed (swallowed): ${(e as Error).message}`,
      repoRoot,
    };
  }
}
