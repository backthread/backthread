// the Supabase InfraAdapter (v0).
//
// Surfaces the managed-backend topology the code-import graph can't see: the
// Postgres datastore (with its table inventory), the edge functions, and the
// auth/storage/realtime sub-services — plus the app→datastore read/write edges
// that come from grepping `supabase.from('table')` call sites.
//
// Evidence-gated, never hallucinated (the DoD): a sub-service node is emitted
// only when config.toml enables it OR a source grep proves the app uses it.
// backthread's repo has no config.toml, so the dogfood path is pure source evidence.
//
// Kind mapping (respecting the locked 8-kind InfraModuleKind enum — we map onto
// it, never weaken it):
//   Postgres / Storage → datastore   (the enum's "DB, blob store, cache")
//   Edge function      → worker       (serverless compute)
//   Realtime           → queue        (pub/sub message bus)
//   Auth               → external-api (a managed identity service you call)
//
// v0 scope: tables live on the datastore node's metadata (per-table child nodes
// are a later refinement); app→datastore edges carry the table in edge metadata
// but resolve at datastore granularity.

import { readFileSync, readdirSync, existsSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { walkRepo } from '../walk.js';
import { parseTomlSubset } from '../cloudflare/wrangler-parse.js';
import {
  parseTableNames,
  parseSupabaseUsage,
  mergeUsage,
  readSubServiceFlags,
  type SubServiceFlags,
  type SupabaseUsage,
} from './supabase-parse.js';

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const supabaseDir = (repoDir: string) => join(repoDir, 'supabase');

function hasSupabaseLayout(repoDir: string): boolean {
  const dir = supabaseDir(repoDir);
  if (!existsSync(dir)) return false;
  return (
    existsSync(join(dir, 'config.toml')) ||
    existsSync(join(dir, 'migrations')) ||
    existsSync(join(dir, 'functions'))
  );
}

function listDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Concatenate every migration SQL file's table declarations. */
function collectTables(repoDir: string): string[] {
  const dir = join(supabaseDir(repoDir), 'migrations');
  if (!existsSync(dir)) return [];
  const tables = new Set<string>();
  for (const e of listDir(dir)) {
    if (e.isFile() && e.name.endsWith('.sql')) {
      try {
        for (const t of parseTableNames(readFileSync(join(dir, e.name), 'utf8'))) tables.add(t);
      } catch {
        /* skip unreadable migration */
      }
    }
  }
  return [...tables].sort();
}

/** Each immediate subdirectory of supabase/functions is one edge function. */
function collectFunctions(repoDir: string): string[] {
  const dir = join(supabaseDir(repoDir), 'functions');
  if (!existsSync(dir)) return [];
  return listDir(dir)
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

function readConfigFlags(repoDir: string): SubServiceFlags {
  const cfg = join(supabaseDir(repoDir), 'config.toml');
  if (!existsSync(cfg)) return {};
  try {
    return readSubServiceFlags(parseTomlSubset(readFileSync(cfg, 'utf8')));
  } catch {
    return {};
  }
}

/** Walk repo source files and grep each for Supabase usage. */
function grepUsage(repoDir: string): SupabaseUsage {
  const scans: SupabaseUsage[] = [];
  walkRepo(repoDir, {
    onFile: (abs, e) => {
      if (!SOURCE_EXT.test(e.name)) return;
      let content: string;
      try {
        content = readFileSync(abs, 'utf8');
      } catch {
        return;
      }
      if (!content.includes('.from(') && !content.includes('.auth') && !content.includes('.storage') && !content.includes('.channel') && !content.includes('.realtime')) {
        return; // cheap pre-filter
      }
      const rel = relative(repoDir, abs).split('\\').join('/');
      scans.push(parseSupabaseUsage(content, rel));
    },
  });
  return mergeUsage(scans);
}

const DB_ID = 'db';

/**
 * Pure graph builder. Separated from the fs/grep IO so it's unit-testable with
 * synthetic inputs.
 */
export function buildSupabaseGraph(args: {
  tables: string[];
  functions: string[];
  flags: SubServiceFlags;
  usage: SupabaseUsage;
  root: string;
}): InfraGraph {
  const { tables, functions, flags, usage, root } = args;
  const nodes: InfraNode[] = [];
  const edges: InfraEdge[] = [];

  // The Postgres datastore — the always-present anchor. Table inventory lives
  // on its metadata.
  nodes.push({
    id: DB_ID,
    label: 'Supabase Postgres',
    kind: 'datastore',
    provenance: 'declared',
    metadata: { provider: 'supabase', tables: tables.slice(0, 50), tableCount: tables.length },
  });

  // Sub-services — evidence-gated. config.toml flag OR source grep proves use.
  const subServices: Array<[string, string, InfraNode['kind'], boolean]> = [
    ['auth', 'Supabase Auth', 'external-api', flags.auth === true || usage.usesAuth],
    ['storage', 'Supabase Storage', 'datastore', flags.storage === true || usage.usesStorage],
    ['realtime', 'Supabase Realtime', 'queue', flags.realtime === true || usage.usesRealtime],
  ];
  for (const [id, label, kind, present] of subServices) {
    if (!present) continue;
    const node: InfraNode = { id, label, kind, provenance: 'declared', metadata: { provider: 'supabase' } };
    nodes.push(node);
  }

  // Edge functions → worker nodes. each function deploys the code under
  // `supabase/functions/<name>`, so its source attributes to the Supabase box.
  for (const fn of functions) {
    nodes.push({
      id: `function:${fn}`,
      label: `${fn} (edge function)`,
      kind: 'worker',
      provenance: 'declared',
      metadata: { provider: 'supabase', function: fn },
      sourceRoots: [`supabase/functions/${fn}`],
    });
  }

  // App→datastore read/write edges. Source is a repo-relative file path the
  // assemble join resolves to a code module via fileModuleMap; unresolved refs
  // (e.g. Deno edge-function files outside the TS cluster) drop there. Dedupe to
  // one edge per (file, op) — the table set rides along in metadata.
  const edgeKey = new Map<string, InfraEdge>();
  for (const r of usage.tableRefs) {
    const key = `${r.file} ${r.op}`;
    const existing = edgeKey.get(key);
    if (existing) {
      const tablesMeta = (existing.metadata!.tables as string[]);
      if (!tablesMeta.includes(r.table)) tablesMeta.push(r.table);
      continue;
    }
    edgeKey.set(key, {
      source: r.file,
      target: DB_ID,
      kind: r.op,
      metadata: { tables: [r.table], via: 'supabase-js' },
    });
  }
  edges.push(...edgeKey.values());

  return { root, adapter: 'supabase', nodes, edges, classificationsNeeded: [] };
}

export const supabaseAdapter: InfraAdapter = {
  name: 'supabase',
  async detect(repoDir: string): Promise<boolean> {
    return hasSupabaseLayout(repoDir);
  },
  // this adapter greps ANY app source file (SOURCE_EXT) for
  // `.from(`/`.auth`/`.storage`/`.channel`/`.realtime` to build app→Postgres
  // edges and gate the Auth/Storage/Realtime sub-service nodes. So a change to
  // any such source path can change the infra graph and MUST force a re-extract
  // in the diff-driven hosted walk — the dogfood target (example-app, no
  // config.toml) derives its ENTIRE Supabase topology from this source grep.
  scansSourcePath(path: string): boolean {
    return SOURCE_EXT.test(path);
  },
  async extract(repoDir: string): Promise<InfraGraph> {
    return buildSupabaseGraph({
      tables: collectTables(repoDir),
      functions: collectFunctions(repoDir),
      flags: readConfigFlags(repoDir),
      usage: grepUsage(repoDir),
      root: repoDir,
    });
  },
};
