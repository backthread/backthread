// Supabase adapter tests. buildSupabaseGraph is pure; the
// adapter's detect/extract run against a tmp dir mirroring backthread's supabase/.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSupabaseGraph, supabaseAdapter } from './supabase.js';

describe('buildSupabaseGraph', () => {
  const graph = buildSupabaseGraph({
    tables: ['repos', 'snapshots', 'changelog'],
    functions: ['delete-account'],
    flags: {},
    usage: {
      tableRefs: [
        { file: 'src/data.ts', table: 'repos', op: 'reads' },
        { file: 'src/data.ts', table: 'snapshots', op: 'writes' },
      ],
      usesAuth: true,
      usesStorage: false,
      usesRealtime: true,
    },
    root: '/repo',
  });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('always emits the Postgres datastore with the table inventory', () => {
    const db = byId.get('db')!;
    expect(db.kind).toBe('datastore');
    expect(db.metadata?.tables).toEqual(['repos', 'snapshots', 'changelog']);
  });

  it('emits only evidence-backed sub-services (auth+realtime, not storage)', () => {
    expect(byId.get('auth')?.kind).toBe('external-api');
    expect(byId.get('realtime')?.kind).toBe('queue');
    expect(byId.has('storage')).toBe(false);
  });

  it('emits edge functions as worker nodes', () => {
    expect(byId.get('function:delete-account')?.kind).toBe('worker');
  });

  it('an edge function deploys its supabase/functions/<name> source', () => {
    expect(byId.get('function:delete-account')?.sourceRoots).toEqual(['supabase/functions/delete-account']);
  });

  it('emits app→datastore read/write edges keyed by file path (cross-graph)', () => {
    const reads = graph.edges.find((e) => e.kind === 'reads');
    const writes = graph.edges.find((e) => e.kind === 'writes');
    expect(reads).toMatchObject({ source: 'src/data.ts', target: 'db' });
    expect(writes).toMatchObject({ source: 'src/data.ts', target: 'db' });
    expect(reads?.metadata?.tables).toEqual(['repos']);
  });

  it('needs no LLM classification', () => {
    expect(graph.classificationsNeeded).toEqual([]);
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
  });
});

describe('supabaseAdapter detect + extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-sb-'));
    mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true });
    mkdirSync(join(dir, 'supabase', 'functions', 'delete-account'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'supabase', 'migrations', '001_init.sql'),
      `create table public.repos (id uuid); create table snapshots (id text);`,
    );
    writeFileSync(join(dir, 'supabase', 'functions', 'delete-account', 'index.ts'), `// fn`);
    writeFileSync(
      join(dir, 'src', 'data.ts'),
      `export const x = () => supabase.from('repos').select('*');\nsupabase.auth.getUser();`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects the supabase/ layout', async () => {
    expect(await supabaseAdapter.detect(dir)).toBe(true);
  });

  it('extracts tables, the edge function, the auth sub-service, and a read edge', async () => {
    const graph = await supabaseAdapter.extract(dir);
    const db = graph.nodes.find((n) => n.id === 'db')!;
    expect(db.metadata?.tables).toEqual(['repos', 'snapshots']);
    expect(graph.nodes.find((n) => n.id === 'function:delete-account')).toBeTruthy();
    expect(graph.nodes.find((n) => n.id === 'auth')).toBeTruthy();
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'src/data.ts', target: 'db', kind: 'reads' }),
    );
  });

  it('does not detect a repo without a supabase/ dir', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-noSb-'));
    try {
      expect(await supabaseAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
