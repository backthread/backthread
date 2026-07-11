// Hand-correction override map — same posture as a manual cluster correction.
// Unsupervised Louvain is imperfect on a clean repo; a caller-supplied per-repo
// override lets you fix mis-clusters, drop noise (tests/config), and pin display
// labels without touching code.
//
// This module carries the override VOCABULARY (types) and the pure matcher/slug
// helpers the clustering pass consumes. Loading a per-repo override document from
// disk is a host concern (it's host-curated data) — the host loads it and passes
// the resulting OverrideMap into clusterGraph().

import type { ModuleKind } from '../types.js';

export interface AssignRule {
  pattern: string; // glob over file ids (repo-relative)
  moduleId: string; // force matching files into this module
}

export interface LabelOverride {
  label?: string;
  summary?: string;
  kind?: ModuleKind;
}

export interface OverrideMap {
  // Globs excluded from the graph entirely (e.g. **/*.test.ts, scripts/**).
  drop?: string[];
  // Force file(s) into a named module (wins over Louvain).
  assign?: AssignRule[];
  // Hand-authored display labels, keyed by module id — override LLM output.
  labels?: Record<string, LabelOverride>;
  // Louvain resolution (default 1). Higher → more, smaller modules; lower →
  // fewer, larger. Tune when the default clustering is too coarse/fine.
  resolution?: number;
}

// Compile glob patterns into a single matcher. Supports `**` (any path span),
// `*` (within a segment) and literal text — enough for drop/assign rules.
export function compileMatchers(patterns: string[]): (id: string) => boolean {
  if (patterns.length === 0) return () => false;
  const regexes = patterns.map((p) => {
    const re = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, ' ')
      .replace(/\*/g, '[^/]*')
      // eslint-disable-next-line no-control-regex -- intentional NUL sentinel: real globs never contain \x00
      .replace(/ /g, '.*');
    return new RegExp(`^${re}$`);
  });
  return (id: string) => regexes.some((re) => re.test(id));
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
