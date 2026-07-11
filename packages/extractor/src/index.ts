// @backthread/extractor — deterministic, install-free structural extraction for
// TypeScript and Python codebases.
//
// Turns a working tree into a structural graph: modules (with kinds, god-node
// flags, and path-derived subsystems), edges, communities, framework roles, and
// infrastructure — with ZERO LLM, database, or network. AST via ts-morph (TS)
// and Pyright's NoAccessHost (Python, pure-static, never executes repo code);
// Louvain community detection; a framework-adapter fleet; and static
// infra-config readers.
//
// The one-shot `extract()` is the convenience surface; every granular stage is
// exported too, so a host can interleave its own steps (e.g. an incremental
// diff-driven re-extract, or a warm-started cluster) between them.

// ── Composed one-shot ──
export { extract } from './extract.js';
export type { ExtractOptions, ExtractResult } from './extract.js';

// ── Version (for the container↔CLI version-lockstep guard) ──
export { EXTRACTOR_PACKAGE_VERSION } from './version.js';

// ── Structural type vocabulary (the domain types) ──
export {
  ShortSha,
  ModuleId,
  parseModuleKind,
  parseEdgeKind,
  coerceEdgeKind,
  INFRA_MODULE_KINDS,
  MODULE_KINDS,
  EDGE_KINDS,
  FORBIDDEN_EDGE_KINDS,
} from './types.js';
export type {
  ModuleKind,
  InfraModuleKind,
  NodeProvenance,
  PackageRole,
  EdgeKind,
  ForbiddenEdgeKind,
  Edge,
} from './types.js';

// ── Graph: AST → normalized code graph ──
export { extractGraph, mergeGraphs } from './graph/extract.js';
export { externalIdFor, isRelativeSpecifier, pythonExternalIdFor } from './graph/types.js';
export type {
  GraphFile,
  GraphEdge,
  ExternalNode,
  NormalizedGraph,
  GraphExtractor,
} from './graph/types.js';
export { IncrementalExtractor } from './graph/incremental.js';
export type { PatchMetrics } from './graph/incremental.js';
export {
  SOURCE_EXTENSIONS,
  PYTHON_SOURCE_EXTENSIONS,
  EXCLUDE_DIRS,
  PYTHON_EXCLUDE_DIRS,
  isSourceFilePath,
  isConfigInvalidatorPath,
  EXTRACTOR_VERSION,
  graphFromState,
  classifyDiff,
  reexportClosure,
  computeCallPatchUnit,
  FILE_GRAPH_VERSION,
  serializeFileGraph,
  isValidFileRecord,
  deserializeFileGraph,
  diffFileGraphStates,
} from './graph/file-graph.js';
export type {
  SourceLang,
  FileEdgeRef,
  FileExternalRef,
  FileRecord,
  FileGraphState,
  DiffEntry,
  ClassifiedDiff,
  SerializedFileGraph,
} from './graph/file-graph.js';
export {
  listSourceFiles,
  detectRepoLanguage,
  detectRepoLanguages,
  graphLanguage,
} from './graph/language.js';
export { NOISE_CATEGORIES, NOISE_RULES, classifyNoise, filterNoise, summarizeNoise } from './graph/noise-filter.js';
export type { NoiseCategory, NoiseRule, DroppedNoise } from './graph/noise-filter.js';
export { crossLanguageApiEdges } from './graph/cross-language.js';

// ── Cluster: Louvain → modules, god-nodes, subsystems ──
export {
  clusterGraph,
  stabilizeModuleIds,
  detectGodNodes,
  betweenness,
  PackagePartitionCache,
} from './cluster/louvain.js';
export type { ClusteredModule, ModuleEdge, ClusterResult, ClusterOptions } from './cluster/louvain.js';
export { isWorkspaceManifestPath, detectWorkspaceLayout } from './cluster/workspaces.js';
export type { WorkspacePackage, WorkspaceLayout } from './cluster/workspaces.js';
export { compileMatchers, slugify } from './cluster/overrides.js';
export type { AssignRule, LabelOverride, OverrideMap } from './cluster/overrides.js';
export {
  EXTERNAL_SUBSYSTEM_ID,
  DIR_SUBSYSTEM_PREFIX,
  PKG_SUBSYSTEM_PREFIX,
  DOMAIN_SUBSYSTEM_PREFIX,
  RESERVED_SUBSYSTEM_PREFIXES,
  bareSubsystemSlug,
  dominantTopLevelDir,
  humanizeDir,
  computeSubsystems,
  distinctSubsystems,
} from './cluster/subsystem.js';
export type { Subsystem } from './cluster/subsystem.js';
export {
  moduleSignature,
  mintGroupId,
  namespaceModelIds,
  selectPending,
  buildFullModel,
  buildIncrementalModel,
  reconcileGroupIds,
  finalizeModel,
  groupToSubsystem,
} from './cluster/domain-grouping.js';
export type {
  DomainGroup,
  ModuleAssignment,
  GroupingModel,
  ProposedGroup,
  LlmGrouping,
  ModuleSignal,
} from './cluster/domain-grouping.js';
export {
  LAYER_NAMES,
  GATE_THRESHOLDS,
  isFrameworkSubsystemId,
  evaluateGroupingGate,
} from './cluster/grouping-gate.js';
export type { GateModule, GroupingGateResult } from './cluster/grouping-gate.js';

// ── Framework adapters ──
export { detectFrameworkStack } from './framework/detect-step.js';
export { contributeFrameworkGraph } from './framework/contribute-step.js';
export type { FrameworkContributions } from './framework/contribute-step.js';
export {
  registerFrameworkAdapter,
  listFrameworkAdapters,
  clearFrameworkAdapters,
  detectFrameworks,
} from './framework/registry.js';
export { registerBuiltinFrameworkAdapters } from './framework/register.js';
export type {
  FrameworkDetectContext,
  DetectMatch,
  FrameworkManifest,
  FrameworkClusterView,
  FrameworkContext,
  FrameworkGroup,
  FrameworkGroupingPrior,
  FrameworkEdge,
  RoleTag,
  FrameworkClassificationRef,
  FrameworkAdapter,
} from './framework/types.js';

// ── Infra adapters (static config reads only) ──
export { extractInfra } from './infra/infra-step.js';
export type {
  ResourceTypeRef,
  ResourceTypeResult,
  ResourceTypeClassifier,
  InfraStepResult,
} from './infra/infra-step.js';
export {
  registerInfraAdapter,
  listInfraAdapters,
  activeSourceScanners,
  clearInfraAdapters,
  runInfraAdapters,
  mergeInfraGraphs,
  validateMergedGraph,
} from './infra/registry.js';
export { registerBuiltinInfraAdapters } from './infra/register.js';
export { isInfraRelevantPath, diffTouchesInfra, diffTouchesInfraWithSources } from './infra/relevance.js';
export type {
  InfraAdapter,
  InfraNode,
  InfraEdge,
  ClassificationRef,
  InfraGraph,
  MergedInfraGraph,
} from './infra/types.js';

// ── Safety: pre-extraction source-budget guard ──
export { DEFAULT_BUDGET, enforceSourceBudget } from './safety.js';
export type { SafetyBudget } from './safety.js';
