// localCache.ts — the on-disk, repo-local two-tier retrieval cache (`backthread.json`).
//
// This is the SHARED schema + I/O for the grep-time local context hook (the
// two-tier retrieval design): a single JSON file at the repo root holding
//   • `structure` — the deterministic structural graph of the WORKING TREE,
//     computed locally by `backthread graph` (localGraph.ts) via
//     @backthread/extractor. Exact, offline, zero-LLM, incrementally refreshed.
//   • `decisions` — the merged decision log ("why") synced DOWN from the server
//     (localDecisions.ts), merge-gated so it rarely changes intra-session.
// A pure, zero-LLM term-keyed join over the two (localJoin.ts) is what the
// PreToolUse grep hook injects (~300 tokens) before a Grep/Glob runs.
//
// WHERE it lives: `<repoRoot>/.backthread/cache.json`, alongside a self-ignoring
// `<repoRoot>/.backthread/.gitignore` (`*`) so the cache never enters the user's
// git history WITHOUT us having to mutate their tracked `.gitignore` (which would
// produce a spurious diff / merge-conflict surface). `rm -rf .backthread` is a
// clean reset. The repo root is the git top-level so the path is stable from any
// cwd inside the repo (both the `graph` refresh and the grep hook resolve it the
// same way).
//
// FAIL-OPEN by construction: every reader tolerates a missing / malformed / stale
// file by returning null (→ the caller degrades to "no local context", never an
// error). Writes are ATOMIC (temp file + rename) and SECTION-SCOPED
// (read-merge-write) so the two independently-scheduled writers — `graph`
// (structure, on demand / git-hook) and the decision sync (session-start) — don't
// clobber each other's section. The two rarely run concurrently; a torn interleave
// would at worst revert the OTHER section to its just-read value, which self-heals
// on that section's next refresh.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/** Bump when the on-disk shape changes incompatibly → older caches are ignored
 * (treated as absent) and rebuilt from scratch, never mis-read. */
export const CACHE_SCHEMA_VERSION = 1;

// --- structure section (owned by localGraph.ts / ARP-1088) -------------------

/** One clustered module in the local structural graph. `id` doubles as the
 * human-ish label (the extractor's dir-derived slug — LLM labels are a
 * server-side enrichment we don't have locally). `fileIds` are repo-relative
 * posix paths (the richest term-match surface — see localJoin.ts). */
export interface CachedModule {
  id: string;
  kind: 'internal' | 'external';
  godNode: boolean;
  loc: number;
  fileCount: number;
  fileIds: string[];
  /** Semantic-zoom grouping (directory/domain-derived), or null when ungrouped. */
  subsystem: { id: string; name: string } | null;
  /** Bare package specifier for external modules (kind === 'external'). */
  externalSpecifier?: string;
  /** Workspace package name, when the module belongs to a named package. */
  packageName?: string | null;
}

/** One module→module edge with the structural kinds present on it. */
export interface CachedEdge {
  source: string;
  target: string;
  kinds: string[];
}

export interface StructureSection {
  /** ISO timestamp of the last structure refresh. */
  refreshedAt: string;
  /** Absolute repo dir the graph was extracted from (provenance). */
  root: string;
  /** EXTRACTOR_PACKAGE_VERSION at write time — a version change forces a full
   * re-extract (the incremental seed is only valid for its own extractor). */
  extractorVersion: string;
  /** repo-relative path → content hash (sha256 hex, truncated) of every tracked
   * file (source + resolution-affecting config). The incremental diff base. */
  fileHashes: Record<string, string>;
  /** The extractor's serialized file-graph state (SerializedFileGraph) — the
   * incremental re-extract seed. Opaque here so this light module never imports
   * the (heavy, Pyright-pulling) extractor. */
  fileGraph: unknown;
  modules: CachedModule[];
  edges: CachedEdge[];
}

// --- decisions section (owned by localDecisions.ts / ARP-1089) ---------------

/** One merged Decision's redacted, derived rationale — exactly what the app
 * already shows (safe to persist locally). */
export interface CachedDecision {
  id: string;
  title: string;
  why: string | null;
  problem: string | null;
  moduleIds: string[];
  flowNames: string[];
  decidedAt: string | null;
  significance: number | null;
  tradeoffs: string[];
  assumptions: string[];
  limitations: string[];
}

export interface DecisionsSection {
  /** ISO timestamp of the last successful decision sync. */
  syncedAt: string;
  /** TTL (hours) after which a session-start sync refreshes (merge-gated ⇒ long). */
  ttlHours: number;
  /** The `owner/name` slug the decisions were synced for (scoping guard). */
  repo: string;
  items: CachedDecision[];
}

// --- the file -----------------------------------------------------------------

export interface LocalCache {
  schemaVersion: number;
  /** `owner/name` the cache is scoped to, or null when unresolved. */
  repo: string | null;
  structure: StructureSection | null;
  decisions: DecisionsSection | null;
}

/** A section-scoped patch — only the provided keys are overwritten. */
export type CachePatch = Partial<Pick<LocalCache, 'repo' | 'structure' | 'decisions'>>;

const CACHE_DIR = '.backthread';
const CACHE_FILE = 'cache.json';

/** The `.backthread` dir for a repo root. */
export function cacheDir(repoRoot: string): string {
  return join(repoRoot, CACHE_DIR);
}

/** The cache file path for a repo root. */
export function cachePath(repoRoot: string): string {
  return join(cacheDir(repoRoot), CACHE_FILE);
}

/** The git-toplevel reader seam — shells out by default, injectable for tests. */
export type TopLevelReader = (cwd: string) => string | null;

const defaultTopLevelReader: TopLevelReader = (cwd) => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // not a git repo → caller falls back to cwd
  }
};

/**
 * Resolve the repo ROOT the cache lives at — the git top-level, so the path is
 * stable from any cwd inside the repo. Falls back to the resolved cwd when the
 * dir isn't a git repo (the cache still works; it's just anchored at cwd).
 */
export function resolveRepoRoot(cwd: string, readTopLevel: TopLevelReader = defaultTopLevelReader): string {
  const top = readTopLevel(cwd);
  return top && top.length > 0 ? resolve(top) : resolve(cwd);
}

/** An empty, well-formed cache (the base every write merges onto). */
function emptyCache(): LocalCache {
  return { schemaVersion: CACHE_SCHEMA_VERSION, repo: null, structure: null, decisions: null };
}

/**
 * Read + parse the cache for a repo root. Returns a well-formed LocalCache, or
 * null when the file is absent / unparseable / a different schema version (all
 * "rebuild from scratch" cases — never an error). NEVER throws.
 */
export async function readCache(repoRoot: string): Promise<LocalCache | null> {
  let raw: string;
  try {
    raw = await readFile(cachePath(repoRoot), 'utf8');
  } catch {
    return null; // absent / unreadable
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null; // corrupt
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  if (rec.schemaVersion !== CACHE_SCHEMA_VERSION) return null; // stale schema → rebuild
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    repo: typeof rec.repo === 'string' ? rec.repo : null,
    // Sections are trusted structurally-shallow here; each consumer defends its
    // own fields. A wholesale-malformed section is tolerated as present-but-junk
    // (the join filters at use). Absent/non-object → null.
    structure: isObject(rec.structure) ? (rec.structure as unknown as StructureSection) : null,
    decisions: isObject(rec.decisions) ? (rec.decisions as unknown as DecisionsSection) : null,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Ensure `.backthread/` exists with a self-ignoring `.gitignore` (`*`). Best-
 * effort: a write failure here never fails the caller (fail-open). */
async function ensureCacheDir(repoRoot: string): Promise<void> {
  const dir = cacheDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  // Only write once — never clobber a user edit. `*` ignores the whole dir,
  // including itself, so the cache is invisible to git without touching the
  // repo's root .gitignore.
  if (!existsSync(ignore)) {
    await writeFile(ignore, '*\n').catch(() => {});
  }
}

/**
 * Atomically merge a section-scoped patch into the cache. Read-merge-write:
 * reads the current cache (or an empty one), overwrites ONLY the patched
 * sections, and renames a temp file into place (atomic on POSIX). Ensures the
 * self-ignoring `.backthread/.gitignore`. Returns the written cache.
 *
 * The temp path carries the pid so two processes writing concurrently don't
 * fight over the SAME temp file (they still race on the final rename — last
 * writer wins per section, which is the accepted, self-healing behavior above).
 */
export async function writeCacheSection(repoRoot: string, patch: CachePatch): Promise<LocalCache> {
  await ensureCacheDir(repoRoot);
  const current = (await readCache(repoRoot)) ?? emptyCache();
  const next: LocalCache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    repo: 'repo' in patch ? (patch.repo ?? null) : current.repo,
    structure: 'structure' in patch ? (patch.structure ?? null) : current.structure,
    decisions: 'decisions' in patch ? (patch.decisions ?? null) : current.decisions,
  };
  const finalPath = cachePath(repoRoot);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n');
  await rename(tmpPath, finalPath);
  return next;
}
