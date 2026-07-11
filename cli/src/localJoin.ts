// localJoin.ts — the PURE, zero-LLM term-keyed retrieval join over the repo-local
// cache. Given a search term, it returns the local structural neighborhood of the
// matching modules PLUS the term-matched decisions ("why"), ranked and bounded to
// ~300 tokens. This is what the PreToolUse grep hook (localGraph structure +
// localDecisions why) injects before a Grep/Glob runs.
//
// KEYED OFF THE TERM, NOT NODE IDENTITY. Modules and decisions are each matched
// independently against the TERM's tokens — a decision is surfaced by its own text
// (title / why / flow names / module ids), never by resolving its module ids into
// the local graph. So when the working tree has diverged from merged main (a
// renamed local file, a not-yet-merged module), a keyword match still lands and
// nothing is mis-attributed to a node that no longer exists locally.
//
// PURE + DETERMINISTIC — no I/O, no network, no clock. Same cache + term ⇒ same
// output. Unit-tested as a pure helper.

import type { LocalCache, CachedModule, CachedEdge, CachedDecision } from './localCache.js';

// --- ranked result shapes ----------------------------------------------------

export interface JoinModule {
  id: string;
  kind: string;
  godNode: boolean;
  subsystem: string | null;
  /** A representative repo-relative path (the term-matching file, else the first). */
  pathHint: string | null;
  fileCount: number;
  /** 1-hop neighbor module ids (what this module connects to), capped. */
  neighbors: string[];
  score: number;
}

export interface JoinDecision {
  id: string;
  title: string;
  why: string | null;
  flowNames: string[];
  decidedAt: string | null;
  score: number;
}

export interface LocalContext {
  term: string;
  /** No structure/decision matched → the hook injects nothing. */
  empty: boolean;
  modules: JoinModule[];
  decisions: JoinDecision[];
  /** The ~300-token formatted block the grep hook injects. '' when empty. */
  text: string;
}

export interface JoinOptions {
  maxModules?: number;
  maxDecisions?: number;
  maxNeighbors?: number;
  /** Hard char budget for the rendered text (~4 chars/token). */
  charBudget?: number;
}

const DEFAULTS = { maxModules: 4, maxDecisions: 5, maxNeighbors: 4, charBudget: 1400 };
const WHY_MAX = 160;

// --- tokenization ------------------------------------------------------------

/** Break a search term (a grep pattern / glob / phrase) into lowercased match
 * tokens: word-split on non-alphanumerics AND camelCase sub-words, deduped,
 * length ≥ 3 (so a 1-2 char fragment can't match half the repo). Exported for
 * testing. */
export function tokenize(term: string): string[] {
  const raw = (term ?? '').trim();
  if (!raw) return [];
  const toks = new Set<string>();
  for (const w of raw.split(/[^A-Za-z0-9]+/)) {
    if (!w) continue;
    for (const part of w.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      const t = part.toLowerCase();
      if (t.length >= 3) toks.add(t);
    }
    const whole = w.toLowerCase();
    if (whole.length >= 3) toks.add(whole);
  }
  return [...toks];
}

/** Split a string into lowercased alphanumeric words (non-alnum + camelCase
 * boundaries). camelCase is split on the ORIGINAL case, then lowercased. */
function splitWords(s: string): string[] {
  const out: string[] = [];
  for (const w of s.split(/[^A-Za-z0-9]+/)) {
    if (!w) continue;
    for (const part of w.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      const t = part.toLowerCase();
      if (t) out.push(t);
    }
  }
  return out;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Does a haystack WORD match a token? Stem-aware so a term surfaces its
 * morphological kin (invoice↔invoicing, auth↔authenticate) that a bare substring
 * would miss — the recall the whole join exists for. Matches on equality, the
 * token containing the word (≥3 chars), or a strong shared prefix (≥4 chars AND
 * covering all-but-two of the shorter word). */
function wordMatch(word: string, token: string): boolean {
  if (word === token) return true;
  if (word.length >= 3 && token.includes(word)) return true;
  const n = commonPrefixLen(word, token);
  return n >= 4 && n >= Math.min(word.length, token.length) - 2;
}

/** Does a field contain the token — by direct substring OR a stem-matched word? */
function matches(hay: string | null | undefined, tok: string): boolean {
  if (typeof hay !== 'string' || !hay) return false;
  if (hay.toLowerCase().includes(tok)) return true; // fast path (multi-word substrings too)
  for (const w of splitWords(hay)) if (wordMatch(w, tok)) return true;
  return false;
}

// --- scoring -----------------------------------------------------------------

/** Score one module against the tokens; also pick the best path hint (a file
 * that matched a token, else the first). Weights: id > subsystem/package/path. */
function scoreModule(m: CachedModule, tokens: string[]): { score: number; pathHint: string | null } {
  let score = 0;
  let pathHint: string | null = null;
  for (const tok of tokens) {
    if (matches(m.id, tok)) score += 3;
    if (matches(m.subsystem?.name ?? null, tok)) score += 2;
    if (matches(m.packageName ?? null, tok)) score += 2;
    if (matches(m.externalSpecifier ?? null, tok)) score += 2;
    const hit = m.fileIds.find((f) => matches(f, tok));
    if (hit) {
      score += 2;
      if (!pathHint) pathHint = hit;
    }
  }
  return { score, pathHint: pathHint ?? m.fileIds[0] ?? null };
}

/** Score one decision against the tokens. Weights: title > flow names > why >
 * module ids/problem/risk. */
function scoreDecision(d: CachedDecision, tokens: string[]): number {
  let score = 0;
  for (const tok of tokens) {
    if (matches(d.title, tok)) score += 4;
    if (d.flowNames.some((n) => matches(n, tok))) score += 3;
    if (matches(d.why, tok)) score += 2;
    if (d.moduleIds.some((id) => matches(id, tok))) score += 2;
    if (matches(d.problem, tok)) score += 1;
    if ([...d.tradeoffs, ...d.assumptions, ...d.limitations].some((t) => matches(t, tok))) score += 1;
  }
  return score;
}

/** 1-hop neighbor module ids for `id` (both edge directions), deduped + capped. */
function neighborsOf(id: string, edges: CachedEdge[], cap: number): string[] {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.source === id) out.add(e.target);
    else if (e.target === id) out.add(e.source);
    if (out.size >= cap) break;
  }
  return [...out].slice(0, cap);
}

// --- render ------------------------------------------------------------------

function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + '…';
}

/** Clamp to a char budget on a line boundary (keeps whole lines). */
function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join('\n');
}

function renderContext(term: string, modules: JoinModule[], decisions: JoinDecision[], budget: number): string {
  const lines: string[] = [`Backthread — local context for "${term}":`];
  if (modules.length) {
    lines.push('Structure:');
    for (const m of modules) {
      const tags = [m.kind, m.godNode ? 'god-node' : null, m.subsystem ? `subsystem: ${m.subsystem}` : null]
        .filter(Boolean)
        .join(', ');
      const path = m.pathHint ? ` — ${m.pathHint}` : '';
      const nb = m.neighbors.length ? ` → ${m.neighbors.join(', ')}` : '';
      lines.push(`  • ${m.id}${tags ? ` [${tags}]` : ''}${path}${nb}`);
    }
  }
  if (decisions.length) {
    lines.push('Why (from the decision log):');
    for (const d of decisions) {
      const date = d.decidedAt ? ` [${d.decidedAt.slice(0, 10)}]` : '';
      const why = d.why ? ` — ${truncate(d.why, WHY_MAX)}` : '';
      lines.push(`  • ${truncate(d.title, 120)}${why}${date}`);
    }
  }
  return clampText(lines.join('\n'), budget);
}

// --- the join ----------------------------------------------------------------

/**
 * Build the ~300-token local context for a search term from the repo-local
 * cache. Pure + deterministic. Returns `empty: true` (and `text: ''`) when the
 * term matches nothing / the cache has neither section — the hook then injects
 * nothing.
 */
export function buildLocalContext(
  term: string,
  cache: Pick<LocalCache, 'structure' | 'decisions'> | null,
  opts: JoinOptions = {},
): LocalContext {
  const o = { ...DEFAULTS, ...opts };
  const tokens = tokenize(term);
  const emptyResult: LocalContext = { term, empty: true, modules: [], decisions: [], text: '' };
  if (tokens.length === 0 || !cache) return emptyResult;

  const structure = cache.structure;
  const edges = structure?.edges ?? [];

  const modules: JoinModule[] = [];
  for (const m of structure?.modules ?? []) {
    const { score, pathHint } = scoreModule(m, tokens);
    if (score <= 0) continue;
    modules.push({
      id: m.id,
      kind: m.kind,
      godNode: m.godNode,
      subsystem: m.subsystem?.name ?? null,
      pathHint,
      fileCount: m.fileCount,
      neighbors: neighborsOf(m.id, edges, o.maxNeighbors),
      score,
    });
  }
  // score desc; deterministic tiebreak: god-node first, then more files, then id.
  modules.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.godNode) - Number(a.godNode) ||
      b.fileCount - a.fileCount ||
      a.id.localeCompare(b.id),
  );

  const decisions: JoinDecision[] = [];
  for (const d of cache.decisions?.items ?? []) {
    const score = scoreDecision(d, tokens);
    if (score <= 0) continue;
    decisions.push({ id: d.id, title: d.title, why: d.why, flowNames: d.flowNames, decidedAt: d.decidedAt, score });
  }
  // score desc; tiebreak: newer decided-at first, then title, for stability.
  decisions.sort(
    (a, b) =>
      b.score - a.score ||
      (Date.parse(b.decidedAt ?? '') || 0) - (Date.parse(a.decidedAt ?? '') || 0) ||
      a.title.localeCompare(b.title),
  );

  const topModules = modules.slice(0, o.maxModules);
  const topDecisions = decisions.slice(0, o.maxDecisions);
  if (topModules.length === 0 && topDecisions.length === 0) return emptyResult;

  return {
    term,
    empty: false,
    modules: topModules,
    decisions: topDecisions,
    text: renderContext(term, topModules, topDecisions, o.charBudget),
  };
}
