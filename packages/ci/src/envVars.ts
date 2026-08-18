// DQ.4 — env-var pattern detection (step 7).
//
// Some external services leave NO import fingerprint: a repo that calls Stripe
// over raw `fetch` never imports the `stripe` package, so the ts-morph
// extractor can't see it. But `.env.example` almost always does — a
// `STRIPE_SECRET_KEY` line is a near-certain tell that the app talks to Stripe.
//
// Two-stage, mirroring the rest of the phase: this module is the cheap
// deterministic heuristic (regex over credential-shaped keys → candidate
// service names). The LLM tiebreak that turns candidates into tiers lives in
// `externals-step.ts` (`classifyEnvVarPatterns`), which reuses classifyExternals
// so a service named `stripe` hits the same cache row whether we learned it
// from an import or an env var.
//
// This file is intentionally DEPENDENCY-FREE (only node:fs / node:path) so the
// pure parser can be unit-tested without dragging in the Supabase/Anthropic
// chain — vitest doesn't rewrite the `.js` import suffixes those modules use.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Example/templated env files that ship in the repo — never the real `.env`
// (which the never-store-source posture means we don't have anyway).
/**
 * Exported so the CI-Action runner can select the SAME four filenames out
 * of `git ls-files` instead of keeping a second list. A basename this list gains and
 * the runner does not would be a service the clone path sees and the CI path does
 * not — the divergence the whole issue is about, arriving through a copied constant.
 */
export const ENV_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];

// Key suffixes that mark a credential whose leading segment names a service.
// Ordered longest-first only matters for readability; we use the captured
// prefix regardless of which suffix matched.
const SECRET_SUFFIXES = [
  'SECRET_KEY',
  'ACCESS_KEY',
  'PRIVATE_KEY',
  'API_KEY',
  'API_TOKEN',
  'ACCESS_TOKEN',
  'AUTH_TOKEN',
  'API_SECRET',
  'SECRET',
  'TOKEN',
];

// Leading segments that are generic plumbing, not a service name. These would
// otherwise produce junk candidates (`AUTH`, `JWT`, `SESSION` …) that waste an
// LLM call and clutter the diagram.
const GENERIC_PREFIXES = new Set([
  'API', 'APP', 'SECRET', 'ACCESS', 'AUTH', 'PRIVATE', 'PUBLIC', 'SESSION',
  'JWT', 'ENCRYPTION', 'SIGNING', 'WEBHOOK', 'ADMIN', 'SERVICE', 'CLIENT',
  'SERVER', 'NODE', 'VITE', 'NEXT', 'DATABASE', 'DB', 'REDIS', 'CACHE',
  'PORT', 'HOST', 'URL', 'LOG', 'INTERNAL', 'DEFAULT', 'TEST', 'DEV',
]);

export interface EnvServiceCandidate {
  /** Lowercased service name derived from the key prefix (e.g. `stripe`). */
  service: string;
  /** The env var keys that produced this candidate (for provenance). */
  vars: string[];
}

function setInto(map: Map<string, Set<string>>, key: string): Set<string> {
  const s = new Set<string>();
  map.set(key, s);
  return s;
}

/**
 * Pure parser: extract service candidates from a `.env`-style file body.
 * Exposed for unit testing; `extractEnvServiceCandidates` reads the files.
 */
export function parseEnvServiceCandidates(content: string): EnvServiceCandidate[] {
  const byService = new Map<string, Set<string>>();
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const key = (eq === -1 ? line : line.slice(0, eq)).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;

    const matched = SECRET_SUFFIXES.some((s) => key === s || key.endsWith(`_${s}`));
    if (!matched) continue;

    const prefix = key.split('_')[0];
    if (!prefix || prefix.length < 3 || GENERIC_PREFIXES.has(prefix)) continue;

    const service = prefix.toLowerCase();
    (byService.get(service) ?? setInto(byService, service)).add(key);
  }
  return toSortedCandidates(byService);
}

function toSortedCandidates(byService: Map<string, Set<string>>): EnvServiceCandidate[] {
  return [...byService.entries()]
    .map(([service, vars]) => ({ service, vars: [...vars].sort() }))
    .sort((a, b) => a.service.localeCompare(b.service));
}

/**
 * Merge several env-file bodies into one candidate list.
 *
 * ⚠ EXTRACTED SO THE TWO PATHS SHARE THE MERGE, NOT JUST THE PARSER. The CI-Action
 * runner cannot use `extractEnvServiceCandidates` below: that function stats the four
 * filenames straight off the working directory, and on a runner the working directory
 * is not a git clone — an UNTRACKED or gitignored `.env.example` (a repo that
 * gitignores `.env*` with no `!.env.example` negation, or a workflow step that
 * materialises one) would produce service nodes the clone path can never see. Those
 * land in `assemble`'s `nodes`, which is inside `topologyHash`, so the two front doors
 * would diverge again — and by a file we should not have been reading at all.
 *
 * So the runner selects the four basenames out of `git ls-files` and calls THIS. The
 * merge is order-independent (a Map keyed by service, sorted on the way out), so the
 * two callers cannot disagree about the result even if they disagree about the order.
 */
export function mergeEnvServiceCandidates(contents: readonly string[]): EnvServiceCandidate[] {
  const merged = new Map<string, Set<string>>();
  for (const content of contents) {
    for (const c of parseEnvServiceCandidates(content)) {
      const set = merged.get(c.service) ?? setInto(merged, c.service);
      for (const v of c.vars) set.add(v);
    }
  }
  return toSortedCandidates(merged);
}

/** Read the repo's example env files and extract service candidates. */
export function extractEnvServiceCandidates(repoDir: string): EnvServiceCandidate[] {
  const contents: string[] = [];
  for (const f of ENV_FILES) {
    const p = resolve(repoDir, f);
    if (!existsSync(p)) continue;
    try {
      contents.push(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
  }
  return mergeEnvServiceCandidates(contents);
}
