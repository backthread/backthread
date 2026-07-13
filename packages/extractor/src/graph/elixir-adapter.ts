// Elixir structural extractor — the import-graph backbone.
//
// INSTALL-FREE + PURE-STATIC by construction, like the other adapters: the
// hand-rolled syntactic scanner (elixir-scan.ts — no native grammar, no
// tree-sitter, no repo-code execution) reads `defmodule`/`alias`/`import`/`require`/
// `use` directives. Two passes:
//
//   1. REGISTRY — every module a file defines (`defmodule MyApp.Accounts.User`) is
//      mapped to that file id. A file with several modules maps them all to itself;
//      the file is the graph node (its loc is the real line count).
//   2. RESOLUTION — each file's directives are resolved through the registry. A
//      target module defined in the repo → an internal import edge; a target under
//      an internal top-namespace but with no exact `defmodule` (a parent namespace,
//      a macro-generated module) → dropped, never mislabeled external; an Elixir
//      stdlib namespace → dropped (substrate); anything else → an `ext:<dep>`
//      external node (dependency families collapse to their top namespace).
//
// Import edges are the reliable backbone. CALL edges (v2) ride on top: inline
// qualified calls (`X.fn(...)`, `MyApp.X.fn(...)`, `arg |> X.fn(...)`) are resolved
// through the file's `alias` scope + the module registry to internal `call` edges,
// but ONLY when the callee module resolves UNAMBIGUOUSLY to an in-repo file —
// accuracy over recall (a wrong call edge teaches a false mental model, ARP-325).
// Anything dynamic (`apply/3`, `Kernel.apply`, `Module.concat`, a behaviour callback)
// or unresolvable is dropped: dynamic dispatch never yields a literal `Module.fn`
// callee that resolves in the registry, so the accuracy bar falls out for free. A
// per-file call-site cap (mirroring the Python adapter) degrades a god-file to
// import-only. `mix.exs` matches the `.exs` extension but is a MANIFEST (dep
// declarations, not a graph node), so it is skipped.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphExtractor, NormalizedGraph } from './types.js';
import { graphFromState, type FileRecord, type FileGraphState, type FileEdgeRef } from './file-graph.js';
import { listSourceFiles } from './language.js';
import { ELIXIR_STDLIB } from './elixir-stdlib.js';
import {
  scanModuleDefs,
  scanDirectives,
  scanAliasScope,
  scanCallSites,
  aliasExpand,
  topNamespace,
  elixirExternalId,
} from './elixir-scan.js';

// A DETERMINISTIC per-file bound on inline call resolution, so a pathological
// god-file (thousands of call sites) can't dominate the extract. Set high enough that
// no ordinary file is capped; a capped file is LOGGED (no silent caps) and degrades to
// import-only. Bounds by COUNT in the (stable) source order — a time budget would
// break snapshot determinism. Mirrors the Python adapter's MAX_CALL_SITES_PER_FILE.
const MAX_CALL_SITES_PER_FILE = 2500;

/**
 * Resolve a file's inline qualified calls into internal `call` edge refs (target file
 * id → call count). Each `Module.fn` callee token is alias-expanded then looked up in
 * the registry; a token that resolves to an in-repo file (other than `fromId`) becomes
 * a weighted edge. Unresolvable / external / stdlib / dynamic callees are dropped. A
 * file whose call-site count exceeds the cap degrades to import-only (logged). Returns
 * the edge refs sorted by target for a stable, readable record.
 */
export function extractFileCalls(
  fromId: string,
  text: string,
  moduleToFile: ReadonlyMap<string, string>,
): FileEdgeRef[] {
  const callSites = scanCallSites(text);
  if (callSites.length > MAX_CALL_SITES_PER_FILE) {
    console.log(
      `  [elixir] ${fromId}: ${callSites.length} call sites exceed the ${MAX_CALL_SITES_PER_FILE} cap — call edges skipped for this file (import-only)`,
    );
    return [];
  }
  const aliasScope = scanAliasScope(text);
  const weights = new Map<string, number>();
  for (const token of callSites) {
    const target = moduleToFile.get(aliasExpand(token, aliasScope));
    if (target === undefined || target === fromId) continue; // unresolved / external / self
    weights.set(target, (weights.get(target) ?? 0) + 1);
  }
  return [...weights]
    .map(([to, weight]) => ({ to, weight }))
    .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

// `mix.exs` at the repo root OR an umbrella child (`apps/foo/mix.exs`).
const MIX_EXS_RE = /(^|\/)mix\.exs$/;

/** Lines of code for one source file (a size/centrality signal). */
function locOf(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/** The per-file `language` tag = its extension (`ex`/`exs`/`eex`/`heex`/`leex`). */
function langTag(id: string): string {
  return id.slice(id.lastIndexOf('.') + 1);
}

/**
 * Resolve ONE file's directives into internal import edges + external refs. Never
 * throws. `internalNamespaces` are the top-level segments of every in-repo module,
 * so a reference to an internal-but-unresolved module (a parent namespace, a
 * macro-generated module) is DROPPED rather than mislabeled as an external
 * `ext:<app>`.
 */
export function extractFileRecord(
  fromId: string,
  text: string,
  moduleToFile: ReadonlyMap<string, string>,
  internalNamespaces: ReadonlySet<string>,
): FileRecord {
  const importWeights = new Map<string, number>();
  const externalWeights = new Map<string, { specifier: string; weight: number }>();

  for (const directive of scanDirectives(text)) {
    for (const mod of directive.targets) {
      const target = moduleToFile.get(mod);
      if (target !== undefined) {
        if (target === fromId) continue; // no self-edges
        importWeights.set(target, (importWeights.get(target) ?? 0) + 1);
        continue;
      }
      const top = topNamespace(mod);
      // Internal namespace but no exact defmodule → first-party, unresolved: drop
      // (never leak an internal app as an external node).
      if (internalNamespaces.has(top)) continue;
      // Stdlib → substrate, dropped.
      if (ELIXIR_STDLIB.has(top)) continue;
      // A real dependency.
      const ext = elixirExternalId(mod);
      const existing = externalWeights.get(ext.id);
      if (existing) existing.weight += 1;
      else externalWeights.set(ext.id, { specifier: ext.specifier, weight: 1 });
    }
  }

  return {
    loc: locOf(text),
    language: langTag(fromId),
    imports: [...importWeights].map(([to, weight]) => ({ to, weight })),
    externals: [...externalWeights].map(([id, v]) => ({ id, specifier: v.specifier, weight: v.weight })),
    // v2: inline qualified calls resolved through the alias scope + module registry.
    calls: extractFileCalls(fromId, text, moduleToFile),
    reexports: [],
  };
}

export class ElixirExtractor implements GraphExtractor {
  readonly language = 'elixir';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    // mix.exs is a manifest, not a graph node — skip it (root + umbrella children).
    const fileIds = listSourceFiles(root, 'elixir').filter((id) => !MIX_EXS_RE.test(id));
    const files: Record<string, FileRecord> = {};
    if (fileIds.length === 0) return graphFromState(root, { headSha: '', files });

    // Read every file once (text reused across both passes). A file we can't read
    // degrades to empty text (no modules, no edges) — never fails the extraction.
    const texts = new Map<string, string>();
    for (const id of fileIds) {
      try {
        texts.set(id, readFileSync(`${root}/${id}`, 'utf8'));
      } catch {
        texts.set(id, '');
      }
    }

    // Pass 1: module registry (name → defining file). First in sorted-id order wins
    // a duplicate definition, so the mapping is deterministic. Also collect the
    // internal top-namespaces (MyApp, MyAppWeb, …) so pass 2 can tell an internal
    // reference from a real dependency.
    const moduleToFile = new Map<string, string>();
    const internalNamespaces = new Set<string>();
    for (const id of fileIds) {
      for (const mod of scanModuleDefs(texts.get(id) ?? '')) {
        if (!moduleToFile.has(mod)) moduleToFile.set(mod, id);
        internalNamespaces.add(topNamespace(mod));
      }
    }

    // Pass 2: per-file directive resolution (imports) + inline call resolution.
    for (const id of fileIds) {
      files[id] = extractFileRecord(id, texts.get(id) ?? '', moduleToFile, internalNamespaces);
    }

    // Positive signal for validation (mirrors the framework fleet's log discipline).
    let callEdges = 0;
    let filesWithCalls = 0;
    for (const id of fileIds) {
      const n = files[id].calls.length;
      if (n > 0) {
        callEdges += n;
        filesWithCalls += 1;
      }
    }
    if (callEdges > 0) {
      console.log(`  [elixir] ${callEdges} call edge(s) across ${filesWithCalls} file(s)`);
    }

    const state: FileGraphState = { headSha: '', files };
    return graphFromState(root, state);
  }
}
