// The normalized graph interface (/325) — the pluggable seam of the
// extraction architecture.
//
//   per-language extractor adapter → [NormalizedGraph] → clustering → LLM → DB
//
// EVERY extractor targets this shape and EVERY downstream layer (Louvain
// clustering, LLM naming, persistence) consumes only this shape. That's what
// makes multilingual support (P4: Python/Go/… adapters) ADDITIVE — a new
// adapter, not a rewrite. Structure here is DERIVED deterministically; the LLM
// never authors it (the locked /325 split).

// A source file = the atomic node the graph is built from. `id` (repo-relative
// posix path) is the stable join key the file→module map keys on —
// this is the "file→module map slot" the interface reserves.
export interface GraphFile {
  id: string;
  loc: number; // lines of code — a size/centrality signal for god-node detection
  language: string; // 'ts' | 'tsx' | 'js' | 'jsx' | …
}

// Structural edge kind. This is the DETERMINISTIC kind (does an import/call
// exist, and in which direction). The LLM later supplies the *semantic* edge
// kind (calls/reads/writes/webhook); it never invents the edge.
export type EdgeKind = 'import' | 'call';

export interface GraphEdge {
  from: string; // GraphFile.id
  to: string; // GraphFile.id (internal) OR ExternalNode.id (external === true)
  kind: EdgeKind;
  external: boolean; // true when `to` is an external dependency node
  weight: number; // reference count — weights Louvain + feeds god-node degree
}

// An external dependency the repo depends on but doesn't own (an unresolved
// bare specifier: `stripe`, `@supabase/supabase-js`). Sub-path imports collapse
// to the package node.
export interface ExternalNode {
  id: string; // `ext:<package>`
  specifier: string; // the package name
}

export interface NormalizedGraph {
  root: string; // absolute repo dir the graph was extracted from (provenance)
  files: GraphFile[];
  edges: GraphEdge[];
  externals: ExternalNode[];
}

// The contract a per-language adapter implements. P3 ships the ts-morph TS
// adapter; P4 adds best-available-per-language adapters behind this same seam.
export interface GraphExtractor {
  readonly language: string;
  extract(repoDir: string): Promise<NormalizedGraph>;
}

// Collapse a bare specifier to its package node id: `@scope/pkg/sub` →
// `ext:@scope/pkg`, `pkg/sub` → `ext:pkg`. Strips Deno-style `jsr:`/`npm:`
// registry prefixes (e.g. `jsr:@supabase/functions-js` → `ext:@supabase/functions-js`).
export function externalIdFor(specifier: string): { id: string; specifier: string } {
  const bare = specifier.replace(/^(jsr:|npm:|node:)/, '');
  const parts = bare.split('/');
  const withVersion = bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  // Deno-style specifiers pin a version on the package itself
  // (`npm:@supabase/supabase-js@2`, `npm:lodash@4`). Strip it so the node is the
  // package, not the package+version — otherwise the `@2` is an invalid
  // package-name char and the classifier's fail-loud boundary rejects it.
  // The leading `@` of a scope is preserved; only a version `@` (after the name)
  // is dropped.
  const pkg = stripPackageVersion(withVersion);
  return { id: `ext:${pkg}`, specifier: pkg };
}

// `@scope/name@1.2.3` → `@scope/name`; `lodash@4` → `lodash`.
function stripPackageVersion(pkg: string): string {
  const m = pkg.startsWith('@')
    ? pkg.match(/^(@[^/]+\/[^/@]+)/)
    : pkg.match(/^([^/@]+)/);
  return m ? m[1] : pkg;
}

// Is a module specifier internal (relative/absolute path) vs a bare package?
export function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

// Collapse a Python DOTTED module name to its distribution node id —
// the analogue of externalIdFor for the Pyright adapter. Python imports are
// dotted, not slash-separated: `sqlalchemy.orm` and `google.cloud.storage` both
// belong to their TOP-LEVEL import package (`sqlalchemy`, `google`), mirroring how
// `@scope/pkg/sub` collapses to `@scope/pkg` on the npm side. The top-level import
// name (what appears in source) is used as the id; the import-name→PyPI-dist alias
// (`cv2`→opencv-python, `yaml`→PyYAML) is a metadata-fetch concern, not a node id.
// A relative import (leading dot) must NEVER reach here — it's always first-party.
export function pythonExternalIdFor(moduleName: string): { id: string; specifier: string } {
  const top = moduleName.replace(/^\.+/, '').split('.')[0];
  return { id: `ext:${top}`, specifier: top };
}
