// Ruby structural extractor — the Prism-driven GraphExtractor for Ruby repos.
//
// Mirrors the ts-morph (TS) and Pyright (Python) adapters: emit FileRecords, hand
// them to the shared graphFromState assembler, and let everything downstream
// (Louvain, subsystem/domain grouping, the whole enrich stage) consume the
// identical NormalizedGraph unchanged.
//
// This first cut establishes the SEAM: it enumerates the repo's first-party Ruby
// source files into graph nodes (with real loc), producing a valid — if edge-less
// — NormalizedGraph, and proves the lazy dispatch (graph/extract.ts) works without
// loading any Ruby parser for a TS/Python repo. The import backbone lands next:
// require / require_relative + Zeitwerk constant↔path resolution → import edges,
// and unresolved requires / gems → external `ext:<gem>` nodes. It will be driven
// by Prism (@ruby/prism — WASM/pure-JS, install-free, never executes repo code),
// exactly as the Python adapter is driven by Pyright.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphExtractor, NormalizedGraph } from './types.js';
import { graphFromState, type FileGraphState, type FileRecord } from './file-graph.js';
import { listSourceFiles } from './language.js';

/** The line-of-code count for one source file (a size/centrality signal). */
function locOf(absPath: string): number {
  try {
    const text = readFileSync(absPath, 'utf8');
    if (text.length === 0) return 0;
    return text.split('\n').length;
  } catch {
    return 0;
  }
}

export class RubyExtractor implements GraphExtractor {
  readonly language = 'ruby';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    const fileIds = listSourceFiles(root, 'ruby');
    const files: Record<string, FileRecord> = {};
    for (const id of fileIds) {
      files[id] = {
        loc: locOf(`${root}/${id}`),
        language: 'rb',
        // Edges land with the Prism backbone (next). A node-only graph is a valid
        // NormalizedGraph — deterministic (graphFromState sorts by path).
        imports: [],
        externals: [],
        calls: [],
        reexports: [],
      };
    }
    const state: FileGraphState = { headSha: '', files };
    return graphFromState(root, state);
  }
}
