// Convex adapter tests.
//
// buildConvexGraph is pure; the adapter's detect/extract run against a real tmp
// dir. Mirrors netlify.test.ts / supabase.test.ts.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConvexGraph, convexAdapter, type ConvexFacts } from './convex.js';

const facts = (over: Partial<ConvexFacts> = {}): ConvexFacts => ({
  functionsDir: 'convex',
  functionsDirExists: true,
  tables: [],
  hasHttpRouter: false,
  functionFileCount: 0,
  usesDb: false,
  ...over,
});

describe('buildConvexGraph', () => {
  it('emits the functions worker with the functions dir as its source root', () => {
    const graph = buildConvexGraph(facts({ tables: ['messages', 'users'], usesDb: true }), '/repo');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('functions')?.kind).toBe('worker');
    expect(byId.get('functions')?.provenance).toBe('declared');
    expect(byId.get('functions')?.sourceRoots).toEqual(['convex']);
  });

  it('emits the datastore with the table inventory', () => {
    const graph = buildConvexGraph(facts({ tables: ['messages', 'users'] }), '/repo');
    const db = graph.nodes.find((n) => n.id === 'db');
    expect(db?.kind).toBe('datastore');
    expect(db?.metadata).toMatchObject({ tableCount: 2, tables: ['messages', 'users'] });
    expect(db?.sourceRoots).toBeUndefined(); // datastores run no code of yours
  });

  it('emits worker→datastore stores-in when ctx.db is used', () => {
    const graph = buildConvexGraph(facts({ usesDb: true }), '/repo');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'functions', target: 'db', kind: 'stores-in' }),
    );
  });

  it('emits stores-in from a declared schema even without a ctx.db hit', () => {
    const graph = buildConvexGraph(facts({ tables: ['t'], usesDb: false }), '/repo');
    const edge = graph.edges.find((e) => e.kind === 'stores-in');
    expect(edge?.metadata).toMatchObject({ via: 'schema' });
  });

  it('no db evidence (no tables, no ctx.db) → no stores-in edge', () => {
    const graph = buildConvexGraph(facts({ tables: [], usesDb: false }), '/repo');
    expect(graph.edges).toEqual([]);
  });

  it('graceful degradation: no functions dir → datastore only, no worker, no source root', () => {
    const graph = buildConvexGraph(facts({ functionsDirExists: false }), '/repo');
    expect(graph.nodes.map((n) => n.id)).toEqual(['db']);
    expect(graph.edges).toEqual([]);
  });

  it('a functions dir that resolves to the repo root → worker with NO source root (never a catch-all)', () => {
    const graph = buildConvexGraph(facts({ functionsDir: '' }), '/repo');
    const fn = graph.nodes.find((n) => n.id === 'functions');
    expect(fn).toBeDefined();
    expect(fn?.sourceRoots).toBeUndefined();
  });

  it('honors a configured (non-default) functions dir as the source root', () => {
    const graph = buildConvexGraph(facts({ functionsDir: 'src/convex', usesDb: true }), '/repo');
    expect(graph.nodes.find((n) => n.id === 'functions')?.sourceRoots).toEqual(['src/convex']);
  });

  it('no classifications needed (no LLM)', () => {
    expect(buildConvexGraph(facts({ usesDb: true }), '/repo').classificationsNeeded).toEqual([]);
  });
});

describe('convexAdapter detect + extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-convex-'));
    mkdirSync(join(dir, 'convex', '_generated'), { recursive: true });
    writeFileSync(
      join(dir, 'convex', 'schema.ts'),
      `import { defineSchema, defineTable } from "convex/server";\nexport default defineSchema({ messages: defineTable({}), users: defineTable({}) });`,
    );
    writeFileSync(
      join(dir, 'convex', 'messages.ts'),
      `import { query } from "./_generated/server";\nexport const list = query(async (ctx) => ctx.db.query("messages").collect());`,
    );
    writeFileSync(join(dir, 'convex', 'http.ts'), `import { httpRouter } from "convex/server";\nexport default httpRouter();`);
    // generated code must NOT count toward functionFiles
    writeFileSync(join(dir, 'convex', '_generated', 'api.d.ts'), `export {};`);
    writeFileSync(join(dir, 'convex.json'), JSON.stringify({ functions: 'convex/' }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a convex/ dir', async () => {
    expect(await convexAdapter.detect(dir)).toBe(true);
  });

  it('extracts the datastore (with tables) + the functions worker (with source root)', async () => {
    const graph = await convexAdapter.extract(dir);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('db')?.metadata).toMatchObject({ tableCount: 2 });
    expect(byId.get('functions')?.sourceRoots).toEqual(['convex']);
    expect(byId.get('functions')?.metadata).toMatchObject({ hasHttpRouter: true });
    // schema.ts + the _generated dir are excluded; only messages.ts + http.ts count.
    expect(byId.get('functions')?.metadata?.functionFiles).toBe(2);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'functions', target: 'db', kind: 'stores-in' }),
    );
  });

  it('detects a repo with only convex.json (no convex/ dir) and degrades to datastore-only', async () => {
    const cfgOnly = mkdtempSync(join(tmpdir(), 'backthread-convex-cfg-'));
    try {
      writeFileSync(join(cfgOnly, 'convex.json'), JSON.stringify({ functions: 'backend' }));
      expect(await convexAdapter.detect(cfgOnly)).toBe(true);
      const graph = await convexAdapter.extract(cfgOnly);
      expect(graph.nodes.map((n) => n.id)).toEqual(['db']);
      expect(graph.nodes[0].metadata).toMatchObject({ tableCount: 0 });
    } finally {
      rmSync(cfgOnly, { recursive: true, force: true });
    }
  });

  it('detects a repo via the convex package dep alone', async () => {
    const depOnly = mkdtempSync(join(tmpdir(), 'backthread-convex-dep-'));
    try {
      writeFileSync(join(depOnly, 'package.json'), JSON.stringify({ dependencies: { convex: '^1.0.0' } }));
      expect(await convexAdapter.detect(depOnly)).toBe(true);
    } finally {
      rmSync(depOnly, { recursive: true, force: true });
    }
  });

  it('a no-schema convex repo still extracts (datastore tableCount 0 + worker)', async () => {
    const noSchema = mkdtempSync(join(tmpdir(), 'backthread-convex-noschema-'));
    try {
      mkdirSync(join(noSchema, 'convex'), { recursive: true });
      writeFileSync(join(noSchema, 'convex', 'ping.ts'), `export const ping = () => "pong";`);
      const graph = await convexAdapter.extract(noSchema);
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      expect(byId.get('db')?.metadata).toMatchObject({ tableCount: 0 });
      expect(byId.get('functions')?.sourceRoots).toEqual(['convex']);
      expect(graph.edges).toEqual([]); // no tables, no ctx.db → no phantom edge
    } finally {
      rmSync(noSchema, { recursive: true, force: true });
    }
  });

  it('a repo-root functions dir ("functions": ".") emits a worker with NO source root and does not deep-scan the repo', async () => {
    const rootFns = mkdtempSync(join(tmpdir(), 'backthread-convex-root-'));
    try {
      writeFileSync(join(rootFns, 'convex.json'), JSON.stringify({ functions: '.' }));
      // sibling source that must NOT be counted/grepped as a Convex function
      writeFileSync(join(rootFns, 'unrelated.ts'), `const db = orm; db.query("x");`);
      const graph = await convexAdapter.extract(rootFns);
      const fn = graph.nodes.find((n) => n.id === 'functions');
      expect(fn).toBeDefined();
      expect(fn?.sourceRoots).toBeUndefined();
      expect(fn?.metadata?.functionFiles).toBe(0);
      expect(graph.edges).toEqual([]); // no whole-repo ctx.db false positive
    } finally {
      rmSync(rootFns, { recursive: true, force: true });
    }
  });

  it('does not detect a repo with no Convex signal', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-convex-empty-'));
    try {
      writeFileSync(join(empty, 'package.json'), JSON.stringify({ dependencies: { react: '^18' } }));
      expect(await convexAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('scansSourcePath matches convex source files but not other source', () => {
    expect(convexAdapter.scansSourcePath?.('convex/messages.ts')).toBe(true);
    expect(convexAdapter.scansSourcePath?.('convex/schema.ts')).toBe(true);
    expect(convexAdapter.scansSourcePath?.('src/App.tsx')).toBe(false);
    expect(convexAdapter.scansSourcePath?.('convex/README.md')).toBe(false);
  });
});
