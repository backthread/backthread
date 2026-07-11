// grepContext.ts — the PreToolUse grep hook: inject the repo-local context for a
// Grep/Glob's search term BEFORE the tool runs.
//
// When Claude Code is about to run Grep or Glob, this hook reads the search
// term, joins it against the repo-local cache (structure from `backthread graph`
// + the merged decision "why" from `backthread sync`), and injects the ~300-token
// result as `additionalContext` — so the agent sees the relevant modules + the
// recorded WHY at the moment it goes looking, with NO per-grep network / LLM /
// billing. The why riding alongside the structure is the whole point (local
// structure alone would just be parity with a structure-graph tool).
//
// SYNCHRONOUS + FAIL-OPEN + FAST. Claude Code reads THIS command's stdout for
// `hookSpecificOutput.additionalContext`, so it must run inline (not detached).
// It does ONLY a fast local read (the JSON cache) + the pure join — no extractor,
// no network — so it can't meaningfully delay the grep. Every failure mode
// (no cache / bad payload / a diverged term that matches nothing / any throw)
// resolves to an EMPTY output `{}` = no injection, and the grep proceeds
// normally. It NEVER blocks the tool (never exits 2, never emits a
// permissionDecision).
//
// PLUGIN-ONLY, exactly like the SessionStart routing hook (ARP-763): a synchronous
// hook can't be a bare-`npx backthread` command without blocking every grep on
// npm's resolve, so it's registered in the plugin manifest (which runs the shipped
// self-contained bundle) — never written into the `~/.claude/settings.json`
// fallback.

import { buildLocalContext } from './localJoin.js';
import {
  resolveRepoRoot as defaultResolveRepoRoot,
  readCache as defaultReadCache,
  type LocalCache,
} from './localCache.js';

/** The PreToolUse hook output. `{}` = no injection (fail-open). */
export interface GrepContextOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    additionalContext: string;
  };
}

export interface GrepContextDeps {
  resolveRepoRootImpl?: (cwd: string) => string;
  readCacheImpl?: (repoRoot: string) => Promise<LocalCache | null>;
  /** Fallback cwd when the payload omits one. Defaults to process.cwd(). */
  cwd?: string;
}

/** Extract the search term from a Grep/Glob `tool_input`. Grep uses `pattern`,
 * Glob uses `glob`; `query` is a defensive extra. NO free-for-all fallback: the
 * ordered keys cover the real tools, and returning '' on an unknown shape just
 * means no injection (fail-open) — safer than injecting on a non-term field like
 * `output_mode`/`type`/`path`. */
export function extractTerm(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const ti = toolInput as Record<string, unknown>;
  for (const key of ['pattern', 'glob', 'query']) {
    if (typeof ti[key] === 'string' && ti[key]) return ti[key] as string;
  }
  return '';
}

/**
 * Build the PreToolUse hook output for a raw stdin payload. NEVER throws — any
 * problem yields `{}` (no injection; the grep proceeds). Returns the JSON object
 * the bin prints to stdout.
 */
export async function runGrepContext(rawStdin: string, deps: GrepContextDeps = {}): Promise<GrepContextOutput> {
  const resolveRoot = deps.resolveRepoRootImpl ?? defaultResolveRepoRoot;
  const readCacheImpl = deps.readCacheImpl ?? defaultReadCache;
  try {
    let payload: unknown;
    try {
      payload = JSON.parse(rawStdin);
    } catch {
      return {}; // unparseable payload → no injection
    }
    const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const term = extractTerm(rec.tool_input);
    if (!term) return {};

    const cwd = typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : (deps.cwd ?? process.cwd());
    const repoRoot = resolveRoot(cwd);
    const cache = await readCacheImpl(repoRoot).catch(() => null);
    if (!cache) return {}; // no cache yet (never `backthread graph`/`sync`'d) → fail-open

    const ctx = buildLocalContext(term, cache);
    if (ctx.empty) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: ctx.text,
      },
    };
  } catch {
    return {}; // belt-and-braces: any failure → no injection, grep proceeds
  }
}
