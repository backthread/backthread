// Kamal adapter tests.
//
// kamalAppSourceRoots / buildKamalGraph are pure; the adapter's detect/extract
// run against a real tmp dir. Mirrors compose.test.ts / render.test.ts.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildKamalGraph, kamalAdapter, kamalAppSourceRoots } from './kamal.js';
import { parseKamalConfig, type KamalConfig } from './kamal-parse.js';
import type { DockerfileIndex } from '../image-resolve.js';

const cfg = (over: Partial<KamalConfig> = {}): KamalConfig => ({ accessories: [], ...over });

describe('kamalAppSourceRoots', () => {
  it('uses builder.context as a direct source root', () => {
    expect(kamalAppSourceRoots(cfg({ builder: { context: 'app' } }))).toEqual(['app']);
  });

  it('uses builder.dockerfile dir as a direct source root', () => {
    expect(kamalAppSourceRoots(cfg({ builder: { dockerfile: 'docker/app.Dockerfile' } }))).toEqual(['docker']);
  });

  it('falls back to the image resolver when there is no direct builder signal', () => {
    const index: DockerfileIndex = { dockerfiles: [{ dockerfile: 'svc/Dockerfile', context: 'svc' }], pairings: [] };
    expect(kamalAppSourceRoots(cfg({ image: 'myorg/svc:latest' }), index)).toEqual(['svc']);
  });

  it('a repo-root builder.context (".") is dropped → falls through to the resolver', () => {
    const index: DockerfileIndex = { dockerfiles: [{ dockerfile: 'api/Dockerfile', context: 'api' }], pairings: [] };
    expect(kamalAppSourceRoots(cfg({ builder: { context: '.' }, image: 'myorg/api' }), index)).toEqual(['api']);
  });

  it('honest "Other": a root-Dockerfile monolith (context "") yields no source root', () => {
    // the only Dockerfile builds from the repo root → resolver drops it → []
    const index: DockerfileIndex = { dockerfiles: [{ dockerfile: 'Dockerfile', context: '' }], pairings: [] };
    expect(kamalAppSourceRoots(cfg({ image: 'myorg/app' }), index)).toEqual([]);
  });
});

describe('buildKamalGraph', () => {
  const DEPLOY = `
    service: shop
    image: myorg/shop
    builder:
      context: app
    accessories:
      db:
        image: postgres:16
      cache:
        image: redis:7
      broker:
        image: rabbitmq:3
      sidekiq:
        image: myorg/sidekiq
  `;
  const graph = buildKamalGraph({ config: parseKamalConfig(DEPLOY), configFile: 'config/deploy.yml' }, '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits the app container with builder.context as its source root', () => {
    const app = byId.get('app:shop');
    expect(app?.kind).toBe('container');
    expect(app?.provenance).toBe('declared');
    expect(app?.sourceRoots).toEqual(['app']);
  });

  it('classifies accessories by image role (datastore / queue / container)', () => {
    expect(byId.get('accessory:db')?.kind).toBe('datastore');
    expect(byId.get('accessory:cache')?.kind).toBe('datastore'); // redis
    expect(byId.get('accessory:broker')?.kind).toBe('queue'); // rabbitmq
    expect(byId.get('accessory:sidekiq')?.kind).toBe('container'); // custom image
    // accessories run pulled images → no source root
    expect(byId.get('accessory:db')?.sourceRoots).toBeUndefined();
  });

  it('emits app→accessory edges with the verb keyed by accessory kind', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'app:shop', target: 'accessory:db', kind: 'stores-in' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'app:shop', target: 'accessory:broker', kind: 'publishes' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'app:shop', target: 'accessory:sidekiq', kind: 'calls' }),
    );
  });

  it('no classifications needed (no LLM)', () => {
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

describe('kamalAdapter detect + extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-kamal-'));
    mkdirSync(join(dir, 'config'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    // an in-repo Dockerfile so the app image ref resolves by name-convention
    writeFileSync(join(dir, 'api', 'Dockerfile'), 'FROM ruby:3.3\n');
    writeFileSync(
      join(dir, 'config', 'deploy.yml'),
      `service: api
image: myorg/api
accessories:
  db:
    image: postgres:16
`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects config/deploy.yml', async () => {
    expect(await kamalAdapter.detect(dir)).toBe(true);
  });

  it('extracts the app container (image→resolver source root) + the datastore accessory', async () => {
    const graph = await kamalAdapter.extract(dir);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('app:api')?.kind).toBe('container');
    expect(byId.get('app:api')?.sourceRoots).toEqual(['api']); // image "myorg/api" → api/ Dockerfile
    expect(byId.get('accessory:db')?.kind).toBe('datastore');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'app:api', target: 'accessory:db', kind: 'stores-in' }),
    );
  });

  it('does not detect a repo with no Kamal config', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-kamal-empty-'));
    try {
      mkdirSync(join(empty, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(empty, '.github', 'workflows', 'deploy.yml'), 'name: deploy\n'); // NOT config/deploy.yml
      expect(await kamalAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('does not declare scansSourcePath (config-only adapter)', () => {
    expect(kamalAdapter.scansSourcePath).toBeUndefined();
  });
});
