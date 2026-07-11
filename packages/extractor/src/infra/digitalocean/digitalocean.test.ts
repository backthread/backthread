// DigitalOcean App Platform adapter tests.
//
// parseDoAppSpec + buildDigitalOceanGraph are pure; the adapter's detect/extract
// run against a real tmp dir. Mirrors cloudflare.test.ts. Also asserts the
// app.yaml/.do collision with GCP is harmless (no GCP regression).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  buildDigitalOceanGraph,
  digitaloceanAdapter,
  looksLikeDoSpec,
  parseDoAppSpec,
} from './digitalocean.js';
import { buildGcpGraph, gcpAdapter } from '../gcp/gcp.js';
import { parseGcpFile } from '../gcp/gcp-parse.js';

const APP_SPEC = `
name: marola-app
region: ams
services:
  - name: api
    source_dir: /services/api
    http_port: 8080
    envs:
      - key: DATABASE_URL
        value: \${db.DATABASE_URL}
static_sites:
  - name: web
    source_dir: apps/web
    build_command: npm run build
    output_dir: dist
workers:
  - name: consumer
    source_dir: /workers/consumer
jobs:
  - name: migrate
    source_dir: /db
    kind: PRE_DEPLOY
databases:
  - name: db
    engine: PG
    production: true
`;

describe('parseDoAppSpec', () => {
  const spec = parseDoAppSpec(parseYaml(APP_SPEC));

  it('reads each component array', () => {
    expect(spec.services.map((s) => s.name)).toEqual(['api']);
    expect(spec.staticSites.map((s) => s.name)).toEqual(['web']);
    expect(spec.workers.map((s) => s.name)).toEqual(['consumer']);
    expect(spec.jobs.map((s) => s.name)).toEqual(['migrate']);
    expect(spec.databases.map((d) => d.name)).toEqual(['db']);
  });

  it('captures source_dir + database env references', () => {
    expect(spec.services[0].sourceDir).toBe('/services/api');
    expect(spec.services[0].dbRefs).toEqual(['db']);
  });
});

describe('looksLikeDoSpec', () => {
  it('true for a spec with component arrays, false for unrelated yaml', () => {
    expect(looksLikeDoSpec({ services: [] })).toBe(true);
    expect(looksLikeDoSpec({ databases: [{ name: 'x' }] })).toBe(true);
    expect(looksLikeDoSpec({ runtime: 'nodejs20', service: 'default' })).toBe(false); // a GCP app.yaml shape
    expect(looksLikeDoSpec({ name: 'x' })).toBe(false);
  });
});

describe('buildDigitalOceanGraph', () => {
  const graph = buildDigitalOceanGraph(parseDoAppSpec(parseYaml(APP_SPEC)), '/repo', '.do/app.yaml');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('maps components onto InfraModuleKinds (service/worker/job → worker, static_site → static-site, db → datastore)', () => {
    expect(byId.get('service:api')?.kind).toBe('worker');
    expect(byId.get('worker:consumer')?.kind).toBe('worker');
    expect(byId.get('job:migrate')?.kind).toBe('worker');
    expect(byId.get('static:web')?.kind).toBe('static-site');
    expect(byId.get('database:db')?.kind).toBe('datastore');
  });

  it('preserves the DO component type in metadata (since InfraModuleKind has no service/job)', () => {
    expect(byId.get('service:api')?.metadata?.componentType).toBe('service');
    expect(byId.get('job:migrate')?.metadata?.componentType).toBe('job');
  });

  it('emits source_dir as sourceRoots (leading slash stripped); db has none', () => {
    expect(byId.get('service:api')?.sourceRoots).toEqual(['services/api']);
    expect(byId.get('static:web')?.sourceRoots).toEqual(['apps/web']);
    expect(byId.get('job:migrate')?.sourceRoots).toEqual(['db']);
    expect(byId.get('database:db')?.sourceRoots).toBeUndefined();
  });

  it('emits a stores-in edge from a component to a db it references via env binding', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'service:api', target: 'database:db', kind: 'stores-in' }),
    );
  });

  it('a source_dir of "/" yields no source root (not a catch-all)', () => {
    const g = buildDigitalOceanGraph(
      parseDoAppSpec({ services: [{ name: 'mono', source_dir: '/' }] }),
      '/repo',
      '.do/app.yaml',
    );
    expect(g.nodes.find((n) => n.id === 'service:mono')?.sourceRoots).toBeUndefined();
  });

  it('all declared, no classifications needed (no LLM)', () => {
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

describe('digitaloceanAdapter detect + extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-do-'));
    mkdirSync(join(dir, '.do'), { recursive: true });
    writeFileSync(join(dir, '.do', 'app.yaml'), APP_SPEC);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a .do/app.yaml app spec', async () => {
    expect(await digitaloceanAdapter.detect(dir)).toBe(true);
  });

  it('extracts the components', async () => {
    const graph = await digitaloceanAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['service:api', 'static:web', 'worker:consumer', 'job:migrate', 'database:db']));
  });

  it('does NOT detect on a bare app.yaml outside .do/ (that is GCP App Engine)', async () => {
    const gcpRepo = mkdtempSync(join(tmpdir(), 'backthread-do-gcp-'));
    try {
      writeFileSync(join(gcpRepo, 'app.yaml'), 'runtime: nodejs20\nservice: default\n');
      expect(await digitaloceanAdapter.detect(gcpRepo)).toBe(false);
    } finally {
      rmSync(gcpRepo, { recursive: true, force: true });
    }
  });
});

// --- GCP no-regression: the .do/app.yaml collision is harmless ---------------

describe('GCP/.do collision ( no-regression)', () => {
  it('a DO app spec produces ZERO GCP resources (no phantom GCP nodes)', () => {
    const resources = parseGcpFile(APP_SPEC, '/repo/.do/app.yaml');
    expect(resources).toEqual([]);
    expect(buildGcpGraph(resources, '/repo').nodes).toEqual([]);
  });

  it('a real GCP app.yaml still parses as App Engine (GCP detection not weakened)', () => {
    const resources = parseGcpFile('runtime: nodejs20\nservice: default\n', '/repo/app.yaml');
    expect(resources.map((r) => r.kind)).toEqual(['app-engine']);
  });

  it('the GCP adapter still detects a bare app.yaml (no regression)', async () => {
    const gcpRepo = mkdtempSync(join(tmpdir(), 'backthread-gcp-appyaml-'));
    try {
      writeFileSync(join(gcpRepo, 'app.yaml'), 'runtime: nodejs20\nservice: default\n');
      expect(await gcpAdapter.detect(gcpRepo)).toBe(true);
    } finally {
      rmSync(gcpRepo, { recursive: true, force: true });
    }
  });
});
