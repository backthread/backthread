// Render adapter integration tests.
//
// buildRenderGraph is pure (RenderConfigEntry[] → InfraGraph); the adapter's
// detect/extract are exercised against a real tmp dir. No Supabase chain,
// so this collects clean under vitest.
//
// Fixtures mirror a realistic Render Blueprint topology (dogfood shape):
//   - web service + background worker + static site
//   - managed Postgres database
//   - managed Redis
//   - envVars with fromDatabase (→ stores-in) and fromService (→ calls)
//   - detect() hit + miss
//   - malformed render.yaml doesn't crash extract()

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRenderGraph, renderAdapter, type RenderConfigEntry } from './render.js';
import { parseRenderConfig } from './render-parse.js';

// ---------------------------------------------------------------------------
// Fixtures

/**
 * Full render.yaml covering every node kind and edge kind we emit.
 * Mirrors a realistic Baltic retail platform (Marola) deployment shape:
 *   - api:        web service (→ worker node)
 *   - jobs-worker: background worker (→ worker node)
 *   - web:         static site (→ static-site node)
 *   - marola-db:   managed Postgres (→ datastore)
 *   - session-cache: managed Redis (→ datastore)
 *   - edges:
 *       api → marola-db     : stores-in (fromDatabase)
 *       api → session-cache : stores-in (fromDatabase — Redis)
 *       api → jobs-worker   : calls     (fromService)
 *       jobs-worker → marola-db : stores-in (fromDatabase)
 */
const FULL_RENDER_YAML = `
services:
  - name: api
    type: web
    runtime: node
    buildCommand: npm ci && npm run build
    startCommand: npm start
    plan: starter
    branch: main
    autoDeploy: true
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: marola-db
          property: connectionString
      - key: REDIS_URL
        fromDatabase:
          name: session-cache
          property: connectionString
      - key: JOBS_URL
        fromService:
          name: jobs-worker
          type: worker
          property: host
      - key: NODE_ENV
        value: production

  - name: jobs-worker
    type: worker
    runtime: node
    startCommand: node worker.js
    plan: starter
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: marola-db
          property: connectionString

  - name: web
    type: static
    buildCommand: npm run build
    branch: main
    routes:
      - type: rewrite
        source: /*
        destination: /index.html

databases:
  - name: marola-db
    plan: free
    region: frankfurt
    postgresMajorVersion: 16
    databaseName: marola_prod
    user: marola_user

redis:
  - name: session-cache
    plan: free
    region: frankfurt
`;

/**
 * Minimal render.yaml — single web service, no datastores, no edges.
 */
const MINIMAL_YAML = `
services:
  - name: bare-api
    type: web
    runtime: python
`;

/**
 * Cron + private service render.yaml.
 */
const CRON_PSERV_YAML = `
services:
  - name: digest-cron
    type: cron
    runtime: node
    startCommand: node cron.js

  - name: internal-rpc
    type: pserv
    runtime: go
    startCommand: ./server
`;

/**
 * Malformed YAML — must not crash extract(); adapter swallows + warns.
 */
const MALFORMED_YAML = `
services:
  - name: broken
    type: [unclosed
    runtime: node
invalid: : :
`;

// ---------------------------------------------------------------------------
// Helper: build a config entry from a YAML string without touching the FS.
function entry(yamlText: string, file = '/repo/render.yaml'): RenderConfigEntry {
  return { config: parseRenderConfig(yamlText), file };
}

// ---------------------------------------------------------------------------
// buildRenderGraph — full fixture

describe('buildRenderGraph — full render.yaml', () => {
  const graph = buildRenderGraph([entry(FULL_RENDER_YAML)], '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits adapter name "render"', () => {
    expect(graph.adapter).toBe('render');
  });

  // ---- Node kinds ----

  it('emits the api web service as a worker-kind node', () => {
    const node = byId.get('service:api');
    expect(node?.kind).toBe('worker');
    expect(node?.label).toBe('api');
  });

  it('emits the jobs-worker as a worker-kind node', () => {
    const node = byId.get('service:jobs-worker');
    expect(node?.kind).toBe('worker');
  });

  it('emits the static site as a static-site-kind node', () => {
    const node = byId.get('service:web');
    expect(node?.kind).toBe('static-site');
  });

  it('emits managed Postgres as a datastore-kind node', () => {
    const db = byId.get('database:marola-db');
    expect(db?.kind).toBe('datastore');
    expect(db?.provenance).toBe('declared');
  });

  it('emits managed Redis as a datastore-kind node', () => {
    const redis = byId.get('redis:session-cache');
    expect(redis?.kind).toBe('datastore');
    expect(redis?.provenance).toBe('declared');
  });

  // ---- Service metadata ----

  it('carries serviceType in worker node metadata', () => {
    expect(byId.get('service:api')?.metadata?.serviceType).toBe('web');
    expect(byId.get('service:jobs-worker')?.metadata?.serviceType).toBe('worker');
    expect(byId.get('service:web')?.metadata?.serviceType).toBe('static');
  });

  it('carries runtime in worker node metadata', () => {
    expect(byId.get('service:api')?.metadata?.runtime).toBe('node');
    expect(byId.get('service:jobs-worker')?.metadata?.runtime).toBe('node');
  });

  // ---- Edge kinds ----

  it('emits a stores-in edge from api to marola-db (fromDatabase)', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'service:api',
        target: 'database:marola-db',
        kind: 'stores-in',
      }),
    );
  });

  it('emits a stores-in edge from api to session-cache Redis (fromDatabase)', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'service:api',
        target: 'redis:session-cache',
        kind: 'stores-in',
      }),
    );
  });

  it('emits a calls edge from api to jobs-worker (fromService)', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'service:api',
        target: 'service:jobs-worker',
        kind: 'calls',
      }),
    );
  });

  it('emits a stores-in edge from jobs-worker to marola-db', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'service:jobs-worker',
        target: 'database:marola-db',
        kind: 'stores-in',
      }),
    );
  });

  it('emits no edge from static site (no envVars)', () => {
    const staticEdges = graph.edges.filter((e) => e.source === 'service:web');
    expect(staticEdges).toHaveLength(0);
  });

  // ---- Invariants ----

  it('is all-declared provenance with no classifications needed (no LLM)', () => {
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
    expect(graph.classificationsNeeded).toEqual([]);
  });

  it('emits no forbidden edge kinds (imports/depends-on/uses)', () => {
    const forbidden = new Set(['imports', 'depends-on', 'uses']);
    expect(graph.edges.every((e) => !forbidden.has(e.kind))).toBe(true);
  });

  it('emits only the expected node kinds', () => {
    const kinds = [...new Set(graph.nodes.map((n) => n.kind))].sort();
    expect(kinds).toEqual(['datastore', 'static-site', 'worker']);
  });

  it('emits only the expected edge kinds', () => {
    const edgeKinds = [...new Set(graph.edges.map((e) => e.kind))].sort();
    expect(edgeKinds).toEqual(['calls', 'stores-in']);
  });
});

// ---------------------------------------------------------------------------
// buildRenderGraph — minimal fixture (no datastores, no edges)

describe('buildRenderGraph — minimal render.yaml', () => {
  const graph = buildRenderGraph([entry(MINIMAL_YAML)], '/repo');

  it('emits exactly one worker node', () => {
    const workers = graph.nodes.filter((n) => n.kind === 'worker');
    expect(workers).toHaveLength(1);
    expect(workers[0].label).toBe('bare-api');
  });

  it('emits no datastore nodes', () => {
    expect(graph.nodes.filter((n) => n.kind === 'datastore')).toHaveLength(0);
  });

  it('emits no edges', () => {
    expect(graph.edges).toHaveLength(0);
  });

  it('has empty classificationsNeeded', () => {
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildRenderGraph — cron + pserv service types

describe('buildRenderGraph — cron and pserv services', () => {
  const graph = buildRenderGraph([entry(CRON_PSERV_YAML)], '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits cron service as a worker-kind node', () => {
    const cron = byId.get('service:digest-cron');
    expect(cron?.kind).toBe('worker');
    expect(cron?.metadata?.serviceType).toBe('cron');
  });

  it('emits pserv as a worker-kind node', () => {
    const pserv = byId.get('service:internal-rpc');
    expect(pserv?.kind).toBe('worker');
    expect(pserv?.metadata?.serviceType).toBe('pserv');
  });
});

// ---------------------------------------------------------------------------
// buildRenderGraph — deduplication

describe('buildRenderGraph — deduplication across multiple configs', () => {
  it('dedupes a database node referenced by two configs', () => {
    const yaml1 = `
services:
  - name: svc-a
    type: web
    envVars:
      - key: DB
        fromDatabase:
          name: shared-db
          property: connectionString
databases:
  - name: shared-db
    plan: free
`;
    const yaml2 = `
services:
  - name: svc-b
    type: worker
    envVars:
      - key: DB
        fromDatabase:
          name: shared-db
          property: connectionString
databases:
  - name: shared-db
    plan: free
`;
    const g = buildRenderGraph(
      [entry(yaml1, '/repo/render.yaml'), entry(yaml2, '/repo/api/render.yaml')],
      '/repo',
    );
    expect(g.nodes.filter((n) => n.id === 'database:shared-db')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// renderAdapter detect + extract

describe('renderAdapter detect + extract', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-render-'));
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'render.yaml'), FULL_RENDER_YAML);
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:22-alpine\nCMD ["npm", "start"]');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc -b', start: 'node dist/index.js' } }),
    );
    // node_modules must NOT be descended into.
    mkdirSync(join(dir, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'some-pkg', 'render.yaml'), 'services:\n  - name: ignored\n    type: web\n');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a repo with render.yaml', async () => {
    expect(await renderAdapter.detect(dir)).toBe(true);
  });

  it('does NOT detect a repo with no render.yaml', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-render-empty-'));
    try {
      expect(await renderAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('extracts the full topology', async () => {
    const graph = await renderAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('service:api');
    expect(ids).toContain('service:jobs-worker');
    expect(ids).toContain('service:web');
    expect(ids).toContain('database:marola-db');
    expect(ids).toContain('redis:session-cache');
  });

  it('skips render.yaml inside node_modules', async () => {
    const graph = await renderAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).not.toContain('service:ignored');
  });

  it('picks up Dockerfile path in node metadata', async () => {
    const graph = await renderAdapter.extract(dir);
    const api = graph.nodes.find((n) => n.id === 'service:api');
    expect(api?.metadata?.dockerfile).toBe('Dockerfile');
  });

  it('picks up package.json build command in node metadata', async () => {
    const graph = await renderAdapter.extract(dir);
    const api = graph.nodes.find((n) => n.id === 'service:api');
    // render.yaml declares buildCommand; package.json build is a fallback.
    // api has its own buildCommand in the YAML, so that takes precedence.
    expect(typeof api?.metadata?.buildCommand).toBe('string');
  });

  it('emits stores-in and calls edges', async () => {
    const graph = await renderAdapter.extract(dir);
    expect(graph.edges.some((e) => e.kind === 'stores-in')).toBe(true);
    expect(graph.edges.some((e) => e.kind === 'calls')).toBe(true);
  });

  it('malformed render.yaml does NOT crash extract(); emits warn + returns empty-ish graph', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'backthread-render-bad-'));
    writeFileSync(join(badDir, 'render.yaml'), MALFORMED_YAML);
    try {
      const graph = await renderAdapter.extract(badDir);
      // Adapter swallowed the error — graph should still be a valid InfraGraph.
      expect(graph.adapter).toBe('render');
      expect(Array.isArray(graph.nodes)).toBe(true);
      expect(Array.isArray(graph.edges)).toBe(true);
      expect(graph.classificationsNeeded).toEqual([]);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Dangling fromDatabase — placeholder node created, no phantom edge (finding 1)

describe('buildRenderGraph — dangling fromDatabase creates placeholder node', () => {
  /**
   * Service references a database name that is declared in neither databases[]
   * nor redis[]. The adapter must create a placeholder datastore node so the
   * edge target always resolves (never a phantom id).
   */
  const DANGLING_DB_YAML = `
services:
  - name: api
    type: web
    envVars:
      - key: DB_URL
        fromDatabase:
          name: ghost-db
          property: connectionString
`;

  const graph = buildRenderGraph([entry(DANGLING_DB_YAML)], '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('creates a placeholder datastore node for the unknown database name', () => {
    const placeholder = byId.get('database:ghost-db');
    expect(placeholder).toBeDefined();
    expect(placeholder?.kind).toBe('datastore');
    expect(placeholder?.metadata?.placeholder).toBe(true);
  });

  it('emits a stores-in edge pointing to the placeholder (not a phantom id)', () => {
    const edge = graph.edges.find(
      (e) => e.source === 'service:api' && e.target === 'database:ghost-db',
    );
    expect(edge?.kind).toBe('stores-in');
    // The target node must exist in the graph.
    expect(byId.has('database:ghost-db')).toBe(true);
  });

  it('does not duplicate the placeholder if two services reference the same unknown db', () => {
    const DOUBLE_REF_YAML = `
services:
  - name: svc-a
    type: web
    envVars:
      - key: DB
        fromDatabase:
          name: mystery-db
          property: connectionString
  - name: svc-b
    type: worker
    envVars:
      - key: DB
        fromDatabase:
          name: mystery-db
          property: connectionString
`;
    const g = buildRenderGraph([entry(DOUBLE_REF_YAML)], '/repo');
    expect(g.nodes.filter((n) => n.id === 'database:mystery-db')).toHaveLength(1);
    expect(g.edges.filter((e) => e.target === 'database:mystery-db')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Unknown service type — warn + preserve raw type in metadata (finding 3)

describe('buildRenderGraph — unknown service type preserved in metadata', () => {
  /**
   * A future/undocumented service type should fall back to 'web' for the InfraNode
   * kind mapping (worker) but preserve the original string in metadata.serviceType.
   */
  const UNKNOWN_TYPE_YAML = `
services:
  - name: edge-fn
    type: background-worker
    runtime: node
    startCommand: node edge.js
`;

  it('maps an unknown type to worker InfraNode kind (safe fallback)', () => {
    const graph = buildRenderGraph([entry(UNKNOWN_TYPE_YAML)], '/repo');
    const node = graph.nodes.find((n) => n.id === 'service:edge-fn');
    expect(node?.kind).toBe('worker');
  });

  it('preserves the original unknown type string in metadata.serviceType', () => {
    const graph = buildRenderGraph([entry(UNKNOWN_TYPE_YAML)], '/repo');
    const node = graph.nodes.find((n) => n.id === 'service:edge-fn');
    // Must NOT be overwritten to 'web' — should be the actual declared value.
    expect(node?.metadata?.serviceType).toBe('background-worker');
  });
});

// ---------------------------------------------------------------------------
// buildRenderGraph — sourceRoots

describe('buildRenderGraph — sourceRoots', () => {
  const SOURCE_ROOTS_YAML = `
services:
  - name: api
    type: web
    runtime: node
    rootDir: apps/api
  - name: web
    type: web
    runtime: docker
    dockerfilePath: services/web/Dockerfile
  - name: worker
    type: worker
    runtime: docker
    dockerContext: services/ctx
    dockerfilePath: services/ctx/build/Dockerfile
  - name: bare
    type: web
    runtime: node
databases:
  - name: marola-db
    plan: starter
redis:
  - name: cache
    plan: starter
`;

  it('uses rootDir as the source root', () => {
    const graph = buildRenderGraph(
      [{ config: parseRenderConfig(SOURCE_ROOTS_YAML), file: '/repo/render.yaml' }],
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:api')?.sourceRoots).toEqual(['apps/api']);
  });

  it('falls back to the dockerfilePath dir for a Docker service without rootDir', () => {
    const graph = buildRenderGraph(
      [{ config: parseRenderConfig(SOURCE_ROOTS_YAML), file: '/repo/render.yaml' }],
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:web')?.sourceRoots).toEqual(['services/web']);
  });

  it('prefers an explicit dockerContext over the dockerfilePath dir', () => {
    const graph = buildRenderGraph(
      [{ config: parseRenderConfig(SOURCE_ROOTS_YAML), file: '/repo/render.yaml' }],
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:worker')?.sourceRoots).toEqual(['services/ctx']);
  });

  it('a bare service under a ROOT render.yaml gets NO source root (no catch-all)', () => {
    const graph = buildRenderGraph(
      [{ config: parseRenderConfig(SOURCE_ROOTS_YAML), file: '/repo/render.yaml' }],
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:bare')?.sourceRoots).toBeUndefined();
  });

  it('a bare service under a NESTED render.yaml uses the render.yaml dir', () => {
    const graph = buildRenderGraph(
      [{ config: parseRenderConfig(`services:\n  - name: solo\n    type: web\n    runtime: node\n`), file: '/repo/apps/solo/render.yaml' }],
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:solo')?.sourceRoots).toEqual(['apps/solo']);
  });

  it('datastore nodes (Postgres + Redis) never carry sourceRoots', () => {
    const graph = buildRenderGraph(
      [{ config: parseRenderConfig(SOURCE_ROOTS_YAML), file: '/repo/render.yaml' }],
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'database:marola-db')?.sourceRoots).toBeUndefined();
    expect(graph.nodes.find((n) => n.id === 'redis:cache')?.sourceRoots).toBeUndefined();
  });
});
