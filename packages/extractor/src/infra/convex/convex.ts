// the Convex InfraAdapter (net-new infra coverage, child of ).
//
// Convex is the reactive TS backend AI builders (v0 / Cursor / Lovable) scaffold
// onto — squarely the vibecoder / rescue-mode persona, so it's the highest-ICP
// adapter of the SST/Convex/Kamal epic. It is SOURCE-based (functions ARE your
// code), so unlike the image-referencing adapters it needs NO image resolver.
//
// A Convex app deploys as ONE backend: every file under the functions dir
// (`convex/` by default, or convex.json's `functions`) is pushed to Convex's
// serverless runtime as a single unit, and the app's tables live in Convex's
// managed datastore. So we model two nodes — not one-per-file (which would split
// `sourceRoots` across N units all claiming the same dir and tie attribution):
//
// Kind mapping (locked 8-kind InfraModuleKind enum — map onto it, never weaken):
//   the functions deployment (queries/mutations/actions/httpActions, incl. the
//     convex/http.ts router)        → worker     (serverless compute = your code)
//   the Convex database (schema tables) → datastore  (managed persistent storage)
//
// sourceRoots: the functions dir IS the deploy unit's source — so the
// worker carries `sourceRoots: [functionsDir]` and convex/ code attributes to the
// Convex zone instead of "Other". The datastore runs no code of yours → no
// sourceRoots. A functions dir that resolves to the repo root ('') is dropped
// (never a catch-all that swallows siblings — the shared adapter guard).
//
// Graceful degradation: a repo that trips detect() only on a `convex` dep (no
// functions dir) emits just the datastore anchor — no worker, no sourceRoots, so
// its code honestly stays in "Other (not deployed)." NEVER guess a source root.
//
// Evidence-gated edge (the Supabase `.from()`-grep discipline): worker→datastore
// `stores-in` is emitted only when a function actually uses `ctx.db` OR a schema
// declares tables — both are honest proof the backend stores data. No phantom edge.
//
// Zone label: "Convex" (PROVIDER_ZONE_LABEL['convex'] in assemble/zones.ts).
// Entirely declared/inferred provenance; no LLM (classificationsNeeded: []).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { walkRepo, DEFAULT_SKIP_DIRS } from '../walk.js';
import { parseConvexSchema, parseConvexFunctionsDir, usesConvexDb } from './convex-parse.js';

const DEFAULT_FUNCTIONS_DIR = 'convex';
const CONFIG_NAME = 'convex.json';
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// Convex's codegen dir — generated, never authored, so excluded from the
// function-file count and the ctx.db grep (it's not the app's own functions).
const GENERATED_DIR = '_generated';

const DB_ID = 'db';
const FUNCTIONS_ID = 'functions';

// ---------------------------------------------------------------------------
// Pure graph builder. fs-derived facts injected so it's unit-testable with no
// real repo (the netlify/supabase split).

export interface ConvexFacts {
  /** Repo-relative, normalized functions dir ('' = repo root → no source root). */
  functionsDir: string;
  /** Does `<functionsDir>` exist? (false ⇒ no worker, datastore-only) */
  functionsDirExists: boolean;
  /** Table names from `<functionsDir>/schema.ts` (sorted, deduped; [] = schemaless). */
  tables: string[];
  /** Does `<functionsDir>/http.ts` (or .js) exist? (the httpActions router) */
  hasHttpRouter: boolean;
  /** Count of authored function source files (excl. _generated, schema, tests). */
  functionFileCount: number;
  /** Did any function file use `ctx.db`? (gates the stores-in edge) */
  usesDb: boolean;
}

export function buildConvexGraph(facts: ConvexFacts, root: string): InfraGraph {
  const { functionsDir, functionsDirExists, tables, hasHttpRouter, functionFileCount, usesDb } = facts;
  const nodes: InfraNode[] = [];
  const edges: InfraEdge[] = [];

  // The Convex managed datastore — the always-present anchor (a Convex app always
  // has the managed DB, even when schemaless). Table inventory on its metadata,
  // mirroring Supabase's Postgres node.
  nodes.push({
    id: DB_ID,
    label: 'Convex Database',
    kind: 'datastore',
    provenance: 'declared',
    metadata: { provider: 'convex', tables: tables.slice(0, 50), tableCount: tables.length },
  });

  // The functions deployment → a worker. Only when the functions dir exists (it's
  // the deploy unit); its dir is the sourceRoot (dropped if it's the repo root).
  if (functionsDirExists) {
    const node: InfraNode = {
      id: FUNCTIONS_ID,
      label: 'Convex functions',
      kind: 'worker',
      provenance: 'declared',
      metadata: {
        provider: 'convex',
        functionsDir,
        functionFiles: functionFileCount,
        hasHttpRouter,
      },
      ...(functionsDir ? { sourceRoots: [functionsDir] } : {}),
    };
    nodes.push(node);

    // worker → datastore `stores-in`, evidence-gated: a real `ctx.db` use OR a
    // declared schema (tables can't exist without something storing in them).
    if (usesDb || tables.length > 0) {
      edges.push({
        source: FUNCTIONS_ID,
        target: DB_ID,
        kind: 'stores-in',
        metadata: { via: usesDb ? 'ctx.db' : 'schema' },
      });
    }
  }

  return { root, adapter: 'convex', nodes, edges, classificationsNeeded: [] };
}

// ---------------------------------------------------------------------------
// fs helpers for extract().

/** The configured functions dir (convex.json `functions`) or the `convex` default. */
function resolveFunctionsDir(repoDir: string): string {
  const cfg = join(repoDir, CONFIG_NAME);
  if (existsSync(cfg)) {
    try {
      const dir = parseConvexFunctionsDir(readFileSync(cfg, 'utf8'));
      if (dir !== undefined) return dir;
    } catch {
      /* unreadable convex.json — fall through to the default */
    }
  }
  return DEFAULT_FUNCTIONS_DIR;
}

/** Read the table inventory from `<functionsDir>/schema.ts` (or schema.js). */
function collectTables(repoDir: string, functionsDir: string): string[] {
  for (const name of ['schema.ts', 'schema.js']) {
    const p = join(repoDir, functionsDir, name);
    if (existsSync(p)) {
      try {
        return parseConvexSchema(readFileSync(p, 'utf8'));
      } catch {
        return [];
      }
    }
  }
  return [];
}

/** Walk the functions dir: count authored function files + detect ctx.db usage. */
function scanFunctions(repoDir: string, functionsDir: string): { functionFileCount: number; usesDb: boolean } {
  // A repo-root functions dir ('', from convex.json `"functions": "."`) would make
  // `dir === repoDir` and scan the ENTIRE repo — inflating the file count and
  // risking a false ctx.db hit. The worker emits no sourceRoots in that case
  // anyway (repo-root guard), so the deep scan buys nothing: skip it.
  if (!functionsDir) return { functionFileCount: 0, usesDb: false };
  const dir = join(repoDir, functionsDir);
  if (!existsSync(dir)) return { functionFileCount: 0, usesDb: false };
  let functionFileCount = 0;
  let usesDb = false;
  walkRepo(dir, {
    skipDirs: [...DEFAULT_SKIP_DIRS, GENERATED_DIR],
    onFile: (abs, e) => {
      if (!SOURCE_EXT.test(e.name)) return;
      if (e.name.endsWith('.d.ts') || e.name.endsWith('.test.ts')) return;
      // schema.ts is config, not a deployed function — don't count it as one.
      const isSchema = e.name === 'schema.ts' || e.name === 'schema.js';
      if (!isSchema) functionFileCount += 1;
      if (!usesDb) {
        try {
          if (usesConvexDb(readFileSync(abs, 'utf8'))) usesDb = true;
        } catch {
          /* unreadable file — skip */
        }
      }
    },
  });
  return { functionFileCount, usesDb };
}

function hasConvexDep(repoDir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.convex || pkg.devDependencies?.convex);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Adapter.

export const convexAdapter: InfraAdapter = {
  name: 'convex',

  async detect(repoDir: string): Promise<boolean> {
    // Primary: the convex/ dir or a convex.json. Secondary: a `convex` dep (a
    // project mid-setup before its functions dir exists).
    return (
      existsSync(join(repoDir, DEFAULT_FUNCTIONS_DIR)) ||
      existsSync(join(repoDir, CONFIG_NAME)) ||
      hasConvexDep(repoDir)
    );
  },

  // Convex derives its topology from ordinary source under the functions
  // dir — schema.ts (tables) + the `ctx.db` grep (the stores-in edge). So a change
  // to a `convex/**` source file can change the infra graph and MUST force a
  // re-extract in the diff-driven hosted walk rather than reuse a stale carry.
  // (Default `convex/` convention; a convex.json-relocated functions dir is a v0
  // limitation — the same coarse detect()/extract() mismatch the Pulumi adapter notes.)
  scansSourcePath(path: string): boolean {
    const p = path.replace(/\\/g, '/');
    return (p === DEFAULT_FUNCTIONS_DIR || p.startsWith(`${DEFAULT_FUNCTIONS_DIR}/`)) && SOURCE_EXT.test(p);
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const functionsDir = resolveFunctionsDir(repoDir);
    const functionsDirExists = existsSync(join(repoDir, functionsDir));
    const tables = collectTables(repoDir, functionsDir);
    const hasHttpRouter =
      existsSync(join(repoDir, functionsDir, 'http.ts')) || existsSync(join(repoDir, functionsDir, 'http.js'));
    const { functionFileCount, usesDb } = scanFunctions(repoDir, functionsDir);
    return buildConvexGraph(
      { functionsDir, functionsDirExists, tables, hasHttpRouter, functionFileCount, usesDb },
      repoDir,
    );
  },
};
