// Adapter selection. The registry is the seam:
// everything downstream consumes the NormalizedGraph contract, so adding a
// per-language extractor is ADDITIVE — no downstream change. P3 shipped the
// ts-morph (TS) adapter;  added the Pyright (Python) adapter;  runs
// BOTH on a polyglot repo and MERGES their graphs into ONE unified full-stack
// diagram (a TS frontend + a Python backend as a single connected system).

import { resolve } from 'node:path';
import { TsMorphExtractor } from './ts-morph-adapter.js';
import { filterNoise, summarizeNoise } from './noise-filter.js';
import { detectRepoLanguages } from './language.js';
import type { SourceLang } from './file-graph.js';
import type { ExternalNode, GraphExtractor, NormalizedGraph } from './types.js';

export async function extractGraph(repoDir: string): Promise<NormalizedGraph> {
  const languages = detectRepoLanguages(repoDir);
  if (languages.length === 1) {
    // Single-language repo — byte-identical to the pre behavior.
    return extractOne(repoDir, languages[0]);
  }
  // polyglot repo. Extract each language independently (each adapter +
  // its own noise filter), then MERGE. Downstream (Louvain, enrich, assemble) is
  // language-neutral (the /967 contract), so it consumes the union with no
  // change; cross-language files have no import edges to each other, so they
  // cluster into their own communities and the cross-language seam is drawn later
  // (contribute-step's crossLanguageApiEdges).
  console.log(`→ polyglot repo detected: ${languages.join(' + ')} — extracting + merging`);
  const graphs: NormalizedGraph[] = [];
  for (const lang of languages) graphs.push(await extractOne(repoDir, lang));
  const merged = mergeGraphs(resolve(repoDir), graphs);
  console.log(
    `  ⇒ merged: ${merged.files.length} files · ${merged.edges.length} edges · ${merged.externals.length} external deps`,
  );
  return merged;
}

/** Extract + noise-filter ONE language's graph (the original single-language path). */
async function extractOne(repoDir: string, language: SourceLang): Promise<NormalizedGraph> {
  const adapter = await selectAdapter(language);
  console.log(`→ extracting structure with the ${adapter.language} adapter (install-free) …`);
  const raw = await adapter.extract(repoDir);
  // drop tests/generated/build/config/stories/mocks/types BEFORE
  // clustering so connected repos render fewer, denser DOMAIN boxes. Applied
  // here (not in the adapter / graphFromState) so the raw extract + the
  // equivalence-test ground truth stay unfiltered; deterministic + logged.
  const { graph, dropped } = filterNoise(raw);
  if (dropped.total > 0) console.log(`  ⊘ ${summarizeNoise(dropped)}`);
  console.log(
    `  ${graph.files.length} files · ${graph.edges.length} edges · ${graph.externals.length} external deps`,
  );
  return graph;
}

/**
 * Merge several single-language NormalizedGraphs into one. File ids are
 * repo-relative posix paths, globally unique across languages (a TS frontend and
 * a Python backend never share a path), so the union is a plain concatenation —
 * with two determinism guarantees: files are re-sorted by id (Louvain's seeded
 * RNG consumes node insertion order), and externals dedupe by id (a package name
 * shared across ecosystems collapses to one external node, which is the desired
 * rendering). Edges are concatenated in the fixed graph order the caller passes.
 */
export function mergeGraphs(root: string, graphs: readonly NormalizedGraph[]): NormalizedGraph {
  const files = graphs.flatMap((g) => g.files).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = graphs.flatMap((g) => g.edges);
  const externals = new Map<string, ExternalNode>();
  for (const g of graphs) {
    for (const x of g.externals) if (!externals.has(x.id)) externals.set(x.id, x);
  }
  return { root, files, edges, externals: [...externals.values()] };
}

/**
 * Pick the structural adapter for a detected language. The Python + Ruby adapters
 * are LAZILY imported so a TS ingest never loads `@zzzen/pyright-internal` or
 * `@ruby/prism` (keeps the TS path — and the worker's TS bundle — free of the
 * other-language toolchains; only a Python/Ruby repo pays for its parser). TS
 * stays the default + eager (the pipeline's home turf).
 */
async function selectAdapter(language: SourceLang): Promise<GraphExtractor> {
  if (language === 'python') {
    const { PythonExtractor } = await import('./python-adapter.js');
    return new PythonExtractor();
  }
  if (language === 'ruby') {
    const { RubyExtractor } = await import('./ruby-adapter.js');
    return new RubyExtractor();
  }
  return new TsMorphExtractor();
}
