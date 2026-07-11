// the FrameworkAdapter contract.
//
// A SIBLING of the InfraAdapter seam (scripts/ingest/infra/types.ts), not a
// reuse of it (founder-ratified 2026-06-26, see the  contract comment).
// The infra registry runs at `extractInfra` — AFTER clusterGraph + enrich — and
// only emits brand-new InfraNodes, so it can natively express only 2 of the 4
// framework contributions:
//   (a) detect ✅
//   (b) syntheticEdges (post-cluster, render-only) ✅
//   (c) groupingPrior   ❌ — must feed clusterGraph, which runs BEFORE infra
//   (d) roleTags on existing code modules ❌ — infra emits new nodes, it can't
//       annotate a module the code extractor already produced
// (c) and (d) are exactly what makes a framework diagram legible, so they're
// load-bearing — hence a sibling contract with multi-stage hooks.
//
// This contract mirrors the infra seam's proven discipline (cheap `detect`,
// registration-order priority, namespaced ids, `classificationsNeeded`
// deferral, `scansSourcePath` source-declaration) but exposes the four hooks.
//
// SLICE 1 ships ONLY `detect` + the React Native / Expo adapter. The
// `groupingPrior` / `syntheticEdges` / `roleTags` / `classificationsNeeded`
// hooks are DECLARED here so the contract is frozen for the parallel adapter
// fan-out (/723/…), but every adapter leaves them unimplemented this
// slice. RN's grouping/edges/roles land in .

import type { EdgeKind, ModuleKind } from '../types.js';
import type { NormalizedGraph } from '../graph/types.js';

// ---------------------------------------------------------------------------
// detect()

/**
 * Input to `detect()`. Cheap by construction — an adapter reads package.json
 * deps + config-file EXISTENCE only, never source content (never-store-source;
 * the trust claim covers the extractor too).
 */
export interface FrameworkDetectContext {
  /** Absolute repo dir. */
  repoDir: string;
  /**
   * Optional absolute path to a workspace package within the repo. When set,
   * `detect()` scopes its manifest/config reads to this package — the
   * per-package fan-out. Absent ⇒ scan the repo root (the thin
   * single-root pass this slice ships).
   */
  packageDir?: string;
}

/**
 * One adapter's positive detection. `null` (not this type) means "no match —
 * fall through to generic-TS behavior."
 */
export interface DetectMatch {
  /**
   * The adapter that produced this match (e.g. 'react-native'). The registry
   * stamps this from the adapter's `name` so manifest consumers can trust it
   * regardless of what the adapter set.
   */
  adapter: string;
  /**
   * 0–1 DETERMINISTIC confidence — a fixed per-adapter rubric, NOT an LLM score.
   * A primary signal (the framework dep in package.json) scores high; a weak /
   * secondary signal (only a config file, no dep) scores lower.
   */
  confidence: number;
  /**
   * The repo-relative posix root this match applies to ('' = repo root).
   * Per-workspace capable: a monorepo with an Expo app under `apps/mobile`
   * reports `rootPath: 'apps/mobile'`. The thin single-root pass this slice
   * ships always reports '' (repo root); per-package fan-out is .
   */
  rootPath: string;
  /**
   * Adapter-specific shape — which signals fired, the framework variant
   * (Expo vs bare RN), etc. Not consumed downstream yet; feeds the detection
   * log + debugging. Keep small (< ~500 bytes).
   */
  metadata?: Record<string, unknown>;
}

/**
 * The detected-stack manifest for a repo (or a workspace package). Multiple
 * adapters co-apply (a Turborepo with a Next app + a Nest API + an Expo app),
 * so `matches` is an ORDERED list (registration order = priority). Empty ⇒ no
 * framework detected → generic-TS fallthrough, byte-for-byte unchanged.
 */
export interface FrameworkManifest {
  /** Absolute repo dir the manifest was detected from (provenance). */
  root: string;
  /** Matched stacks in registration order. Empty ⇒ generic TS. */
  matches: DetectMatch[];
}

// ---------------------------------------------------------------------------
// The post-detect contribution hooks (DECLARED now; unimplemented for RN).

/**
 * A POST-CLUSTER view of the clustering result, the seam between file-id space
 * (where a framework hook works — it greps source) and module-id space (what
 * the diagram renders).  firmed this onto the context (Slice 1 deferred
 * it): the `syntheticEdges`/`roleTags` hooks emit contributions in the graph
 * FILE-ID space (repo-relative posix paths), and the contribution step
 * (contribute-step.ts) resolves them to MODULE ids through `fileModuleMap`. The
 * view is carried on the context so a hook that wants module-level precision
 * (a future grouping-aware adapter) can resolve itself; the RN adapter does NOT
 * need it (it stays in file-id space and lets the step resolve).
 */
export interface FrameworkClusterView {
  /** fileId (repo-relative posix) → moduleId — the post-cluster join key. */
  fileModuleMap: Readonly<Record<string, string>>;
  /** Every materialized module id (internal + external + infra-namespaced). */
  moduleIds: ReadonlySet<string>;
}

/**
 * Context for the multi-stage contribution hooks. Carries the detect match +
 * repo (so a hook can re-read config), the structural code graph the
 * contributions reference (file ids = repo-relative posix paths), and the
 * POST-CLUSTER module view so the step + any module-aware hook can
 * resolve file ids to modules. Slice 1's comment promised the shape "firms up
 * as + implements the first real hooks" — `cluster` is that firming.
 */
export interface FrameworkContext {
  repoDir: string;
  /** The repo-relative posix root this adapter matched (DetectMatch.rootPath). */
  rootPath: string;
  /** The detect match that selected this adapter. */
  match: DetectMatch;
  /** The structural code graph (file ids = repo-relative posix paths). */
  graph: NormalizedGraph;
  /** the post-cluster file→module view (the render-side join key). */
  cluster: FrameworkClusterView;
}

/**
 * A pre-cluster grouping hint: a named group of code FILE ids the clustering
 * step should keep together (a framework's natural module boundary — an Expo
 * Router route tree, a NestJS @Module). Feeds `clusterGraph` BEFORE Louvain
 * runs, so it's a PRIOR, not a post-hoc relabel — which is why this is a
 * sibling of (not a reuse of) the infra seam.
 *
 * `id` is NAMESPACED by adapter when consumed downstream (`<adapter>:<id>`),
 * mirroring the infra registry's id discipline, so two adapters' groups never
 * collide. It MUST be deterministic (the snapshot-stability invariant — module
 * ids must not reshuffle across snapshots), so it derives from the path/route,
 * never a Louvain index.
 */
export interface FrameworkGroup {
  id: string;
  /** Humanized group name (feeds the subsystem label). */
  label: string;
  /** Repo-relative posix file ids (graph file-id space) in this group. */
  fileIds: string[];
}

export interface FrameworkGroupingPrior {
  groups: FrameworkGroup[];
  /**
   * Any label a hook cannot statically map is DEFERRED here, never resolved by
   * an inline LLM call (mirror the infra `classificationsNeeded` pattern). The
   * cost-optimal rule: adapters are deterministic; the only LLM touch is a
   * deferred, cached, batched classification.
   */
  classificationsNeeded?: FrameworkClassificationRef[];
}

/**
 * A framework-derived edge the structural import/call graph can't see — a
 * navigation edge (a screen `calls` another via React Navigation), an
 * RSC→client boundary, a Route Handler → service call.
 *
 * `source`/`target` are CODE module/file ids (the graph file-id space =
 * repo-relative posix paths), and `kind` is the 8-verb `EdgeKind` from
 * src/types. The taxonomy is law: NEVER `imports` / `depends-on` / `uses` — a
 * framework edge is still one of the eight verbs.
 */
export interface FrameworkEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  metadata?: Record<string, unknown>;
}

/**
 * A framework ROLE annotation for an EXISTING code module/file — 'screen',
 * 'route-handler', 'server-action', 'navigator', etc.
 *
 * It is METADATA, NOT a new Module-kind. The locked discipline ("fix the
 * classifier, never weaken the enum") holds: a screen maps onto `frontend`, a
 * controller/route handler onto `gateway`/`service`, a queue/cron worker onto
 * `job`. The finer role lives in `role`; `kind` MUST be a value from the locked
 * `MODULE_KINDS` enum — never a new one. The renderer surfaces `role` via the
 * label/metadata; the module's `kind` is unchanged.
 */
export interface RoleTag {
  role: string;
  kind: ModuleKind;
  /**
   * deterministic collapse priority (higher wins) for the two places a
   * role must collapse to a single value: (1) one FILE matching several role
   * detectors, and (2) several files of different roles landing in one MODULE
   * after clustering. The contribution step keeps the highest-priority role per
   * module, lexical role tiebreak, and LOGS a collapse — no silent pick. Absent
   * ⇒ 0. The merge stays GENERIC (driven by this number), so the step needs no
   * per-framework role knowledge.
   */
  priority?: number;
  metadata?: Record<string, unknown>;
}

/**
 * A deferred classification (mirror infra's ClassificationRef). The registry
 * collects these from every adapter, dedupes, and runs them through the
 * cached/batched classifier — so a non-deterministic label is decided ONCE,
 * globally, never by an inline per-adapter LLM call.
 */
export interface FrameworkClassificationRef {
  /** The classification domain (e.g. 'react-native/screen-role'). */
  provider: string;
  /** The thing to classify (a role/group the adapter can't statically map). */
  subject: string;
  /** The code module/file id whose attribute this classification will populate. */
  forId: string;
}

// ---------------------------------------------------------------------------
// The adapter.

/**
 * A discovery + contribution surface for one framework/runtime stack.
 * Implementations live next to their detector (e.g.
 * scripts/ingest/framework/react-native/).
 *
 * `detect()` is cheap + deterministic (manifest deps + config-file existence),
 * runs first against every registered adapter, and yields the detected-stack
 * manifest. The four optional hooks are the framework's contributions to the
 * diagram; each adapter implements only what its stack needs, and a stack that
 * only narrows extraction (no graph contribution) may implement `detect` alone.
 */
export interface FrameworkAdapter {
  readonly name: string; // 'react-native' | 'next' | 'nest' | …

  /** Cheap, deterministic. Reads package.json deps + config existence ONLY. */
  detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null>;

  /**
   * PRE-CLUSTER grouping prior fed to `clusterGraph` (RN's lands in ).
   * Declared now; unimplemented for every adapter this slice.
   */
  groupingPrior?(ctx: FrameworkContext): Promise<FrameworkGroupingPrior>;

  /**
   * POST-CLUSTER synthetic edges (8-verb, code-module endpoints). The render-
   * only contribution the infra seam could already express; here so framework
   * nav/boundary edges share one contract. Declared now; unimplemented.
   */
  syntheticEdges?(ctx: FrameworkContext): Promise<FrameworkEdge[]>;

  /**
   * Role tags annotating EXISTING code modules/files — metadata, NO new
   * Module-kind values. Keyed by module-or-file id. Declared now; unimplemented.
   */
  roleTags?(ctx: FrameworkContext): Promise<Map<string, RoleTag>>;

  /**
   * Deferred classifications a hook couldn't statically resolve — never an
   * inline LLM call. Mirror infra. Declared now; unimplemented.
   */
  classificationsNeeded?(ctx: FrameworkContext): Promise<FrameworkClassificationRef[]>;

  /**
   * Mirror of InfraAdapter.scansSourcePath: does any hook read application
   * SOURCE content (not just config/manifest)? `detect()` never does — but a
   * future `groupingPrior`/`syntheticEdges` that greps source MUST declare the
   * paths it reads here so the diff-driven hosted walk re-runs it on a relevant
   * source change instead of carrying a stale contribution. Absent ⇒ the
   * adapter reads only config/manifest.
   */
  scansSourcePath?(path: string): boolean;
}
