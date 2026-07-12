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
// Import edges are the reliable backbone. Call edges (fully-qualified inline calls)
// are OUT OF SCOPE for v1 — `calls` is always empty, an explicit, documented
// import-only degrade that mirrors the Python adapter's stance. `mix.exs` matches
// the `.exs` extension but is a MANIFEST (dep declarations, not a graph node), so it
// is skipped.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphExtractor, NormalizedGraph } from './types.js';
import { graphFromState, type FileRecord, type FileGraphState } from './file-graph.js';
import { listSourceFiles } from './language.js';
import { ELIXIR_STDLIB } from './elixir-stdlib.js';
import { scanModuleDefs, scanDirectives, topNamespace, elixirExternalId } from './elixir-scan.js';

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
    calls: [], // import-only degrade — call edges are out of scope for v1
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

    // Pass 2: per-file directive resolution.
    for (const id of fileIds) {
      files[id] = extractFileRecord(id, texts.get(id) ?? '', moduleToFile, internalNamespaces);
    }

    const state: FileGraphState = { headSha: '', files };
    return graphFromState(root, state);
  }
}
