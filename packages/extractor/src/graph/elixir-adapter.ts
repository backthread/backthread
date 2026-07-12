// Elixir structural extractor — the import-graph backbone.
//
// INSTALL-FREE + PURE-STATIC by construction, like the other adapters: a
// hand-rolled SYNTACTIC scanner (no native grammar, no tree-sitter, no repo-code
// execution) reads `defmodule`/`alias`/`import`/`require`/`use` directives, builds
// a repo module registry (`defmodule MyApp.Accounts.User` ⇔
// `lib/my_app/accounts/user.ex`), and resolves each directive to its target file
// id. Dependency modules (from `mix.lock`) collapse to `ext:<dep>` external nodes.
// Import edges are the backbone; call edges are out of scope for v1. The scanner
// skips `mix.exs` (a manifest, parsed for deps — not a graph node).
//
// This module is imported ONLY via the lazy `selectAdapter` branch in extract.ts,
// so a TS/Python/Ruby repo never loads the Elixir scanner. Being hand-rolled, it
// pulls in NO native dependency (nothing to add to the container).
//
// NOTE: this is the extractor SEAM. The scanner implementation lands in the next
// step; until then it emits an empty graph (an Elixir repo simply renders no
// structure rather than failing the ingest).

import { resolve } from 'node:path';
import type { GraphExtractor, NormalizedGraph } from './types.js';
import { graphFromState, type FileRecord } from './file-graph.js';

export class ElixirExtractor implements GraphExtractor {
  readonly language = 'elixir';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    const files: Record<string, FileRecord> = {};
    // headSha is irrelevant for a one-shot batch extract; graphFromState only
    // reads the per-file records.
    return graphFromState(root, { headSha: '', files });
  }
}
