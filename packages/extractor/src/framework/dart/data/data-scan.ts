// Pure, comment-aware scanner for Drift foreign-key references — the one piece the
// data adapter's association `calls` edges need beyond the shared class/annotation
// accessors. A Drift column declares a FK with `.references(OtherTable, #column)`;
// this captures the referenced TABLE class so the adapter can resolve it to a file.
// Best-effort + deterministic (reuses dart-scan's comment blanking, so a commented-out
// column never registers).

import { sourceLines } from '../../../graph/dart-scan.js';

// A Drift FK: `.references(Users, #id)` / `references(Categories, #id, …)`. Captures
// the referenced table CLASS (the first PascalCase arg).
const REFERENCES_RE = /\.\s*references\s*\(\s*([A-Z][A-Za-z0-9_]*)/g;

/** The Drift table classes a file references via `.references(Table, …)`, in source order. */
export function scanDriftReferences(text: string): string[] {
  const clean = sourceLines(text).join('\n');
  const out: string[] = [];
  for (const m of clean.matchAll(REFERENCES_RE)) out.push(m[1]);
  return out;
}
