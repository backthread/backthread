/**
 * `@backthread/ci` — the CI-extraction wire contract, its acceptance gate, and the
 * narrowing that decides what may cross.
 *
 * ONE DEFINITION, THREE CONSUMERS. The runner that produces a payload, the ingress
 * that accepts one, and every instrument that measures the difference all import
 * these exact functions. A second implementation on any side would be a second
 * definition of what a payload IS, and the two would drift for a reason no hash diff
 * could explain — which is the failure this package exists to make impossible rather
 * than merely unlikely.
 *
 * WHAT IS DELIBERATELY NOT HERE. `./env`, `./untrusted` and `./sanitize` are their
 * own entry points: the first touches `node:fs` and the other two are the
 * untrusted-input boundary. Keeping them off this barrel is what lets an edge runtime
 * import the contract and the gate without pulling a filesystem shim in behind them.
 */
export * from './errors.js';
export * from './narrow.js';
export * from './payload.js';
// Listed rather than starred: `./validate.js` re-exports the byte-budget constants
// from `./payload.js` (one ceiling, stated in two units, documented at its source),
// so a second `export *` would make every one of those names ambiguous and drop it
// from the public surface silently. Naming validate's OWN exports keeps the barrel
// total and makes an addition here a deliberate line rather than an accident.
export {
  MAX_EDGES_PER_FILE,
  MAX_EDGES_ABSOLUTE,
  MAX_EXTERNALS,
  MAX_STRING_BYTES,
  MAX_PATH_DEPTH,
  MAX_LOC,
  MAX_SPECIFIER_LEN,
  MAX_CHECKPOINT_SKEW_MS,
  KNOWN_LANGUAGES,
  isValidFileRecord,
  INFRA_MODULE_KIND_VALUES,
  INFRA_EDGE_KIND_VALUES,
  ROLE_MODULE_KIND_VALUES,
  MAX_JSON_DEPTH,
  MAX_WALK_STACK,
  exceedsDepth,
  isSafeFileId,
  isSafeSpecifier,
  WORKSPACE_MANIFEST_BASENAMES,
  isWorkspaceManifestBasename,
  isSafeInfraRef,
  isKnownEcosystemSpecifier,
  validateEnvServices,
  validateFrameworkContributions,
  validateInfraGraph,
  validateCiPayload,
  plausibilityWarnings,
} from './validate.js';
export type { CiRejection, CiValidation, PriorCiFacts } from './validate.js';
