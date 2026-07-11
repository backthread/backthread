// docker-compose adapter tests.
//
// buildComposeGraph is pure (parsed config → InfraGraph); the adapter's
// detect/extract run against a real tmp dir. Mirrors cloudflare.test.ts.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildComposeGraph, dockerComposeAdapter } from './compose.js';
import { parseComposeConfig } from './compose-parse.js';

// A realistic microservices compose file: two built services, a postgres + kafka
// pulled image, and depends_on wiring — the typical ICP/marola shape.
const COMPOSE_YML = `
services:
  api-gateway:
    build: ./services/api-gateway
    depends_on:
      - orders
      - db
  orders:
    build:
      context: ./services/orders
      dockerfile: Dockerfile
    depends_on:
      db:
        condition: service_healthy
      bus:
        condition: service_started
  db:
    image: postgres:16-alpine
  bus:
    image: confluentinc/cp-kafka:7.5.0
`;

describe('buildComposeGraph', () => {
  const graph = buildComposeGraph(
    [{ config: parseComposeConfig(COMPOSE_YML), file: 'docker-compose.yml' }],
    '/repo',
  );
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits each built service as a container node', () => {
    expect(byId.get('service:api-gateway')?.kind).toBe('container');
    expect(byId.get('service:orders')?.kind).toBe('container');
  });

  it('classifies image-only services by role (postgres → datastore, kafka → queue)', () => {
    expect(byId.get('service:db')?.kind).toBe('datastore');
    expect(byId.get('service:bus')?.kind).toBe('queue');
  });

  it('emits sourceRoots from build.context (string + long form)', () => {
    expect(byId.get('service:api-gateway')?.sourceRoots).toEqual(['services/api-gateway']);
    expect(byId.get('service:orders')?.sourceRoots).toEqual(['services/orders']);
  });

  it('image-only services have NO sourceRoots (pulled image → not your code)', () => {
    expect(byId.get('service:db')?.sourceRoots).toBeUndefined();
    expect(byId.get('service:bus')?.sourceRoots).toBeUndefined();
  });

  it('depends_on edges pick the verb from the target kind', () => {
    // api-gateway depends_on orders (container → calls) + db (datastore → stores-in)
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'service:api-gateway', target: 'service:orders', kind: 'calls' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'service:api-gateway', target: 'service:db', kind: 'stores-in' }),
    );
    // orders depends_on db (stores-in) + bus (queue → publishes)
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'service:orders', target: 'service:db', kind: 'stores-in' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'service:orders', target: 'service:bus', kind: 'publishes' }),
    );
  });

  it('is all-declared provenance with no classifications needed (no LLM)', () => {
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

describe('buildComposeGraph — context resolution', () => {
  it('resolves build.context relative to the compose file dir (nested + ../)', () => {
    const yml = `
services:
  web:
    build: ../frontend
  api:
    build:
      context: .
`;
    const graph = buildComposeGraph(
      [{ config: parseComposeConfig(yml), file: 'deploy/docker-compose.yml' }],
      '/repo',
    );
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // deploy/ + ../frontend → frontend
    expect(byId.get('service:web')?.sourceRoots).toEqual(['frontend']);
    // deploy/ + . → deploy (the compose file's own dir)
    expect(byId.get('service:api')?.sourceRoots).toEqual(['deploy']);
  });

  it('a build context resolving to the repo root yields NO source root (not a catch-all)', () => {
    const yml = `
services:
  app:
    build: .
`;
    const graph = buildComposeGraph(
      [{ config: parseComposeConfig(yml), file: 'docker-compose.yml' }],
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:app')?.sourceRoots).toBeUndefined();
  });

  it('a service with build AND image is a container with source (build wins)', () => {
    const yml = `
services:
  worker:
    build: ./worker
    image: myorg/worker:latest
`;
    const graph = buildComposeGraph(
      [{ config: parseComposeConfig(yml), file: 'docker-compose.yml' }],
      '/repo',
    );
    const node = graph.nodes.find((n) => n.id === 'service:worker');
    expect(node?.kind).toBe('container');
    expect(node?.sourceRoots).toEqual(['worker']);
  });

  it('an unrecognized image-only service is a plain container (no source root)', () => {
    const yml = `
services:
  proxy:
    image: nginx:1.27
`;
    const graph = buildComposeGraph(
      [{ config: parseComposeConfig(yml), file: 'docker-compose.yml' }],
      '/repo',
    );
    const node = graph.nodes.find((n) => n.id === 'service:proxy');
    expect(node?.kind).toBe('container');
    expect(node?.sourceRoots).toBeUndefined();
  });
});

describe('buildComposeGraph — override merge', () => {
  it('a service redefined by an override file keeps its base node (first wins)', () => {
    const base = `
services:
  api:
    build: ./services/api
`;
    const override = `
services:
  api:
    image: prebuilt/api
  cache:
    image: redis:7
`;
    const graph = buildComposeGraph(
      [
        { config: parseComposeConfig(base), file: 'docker-compose.yml' },
        { config: parseComposeConfig(override), file: 'docker-compose.override.yml' },
      ],
      '/repo',
    );
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // base 'api' (container w/ source) wins over the override's image-only redefinition
    expect(byId.get('service:api')?.kind).toBe('container');
    expect(byId.get('service:api')?.sourceRoots).toEqual(['services/api']);
    // the override's new service is added
    expect(byId.get('service:cache')?.kind).toBe('datastore');
  });
});

describe('dockerComposeAdapter detect + extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-compose-'));
    mkdirSync(join(dir, 'services', 'api'), { recursive: true });
    writeFileSync(join(dir, 'compose.yaml'), `
services:
  api:
    build: ./services/api
  db:
    image: postgres:16
`);
    // node_modules must NOT be descended into.
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'docker-compose.yml'), 'services:\n  ignored:\n    build: .');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects the Compose Spec default filename (compose.yaml)', async () => {
    expect(await dockerComposeAdapter.detect(dir)).toBe(true);
  });

  it('extracts the topology and skips node_modules', async () => {
    const graph = await dockerComposeAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('service:api');
    expect(ids).toContain('service:db');
    expect(ids).not.toContain('service:ignored');
  });

  it('does not detect a repo with no compose file', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-nocompose-'));
    try {
      // a non-compose yaml must not trip detection
      writeFileSync(join(empty, 'composer.yaml'), 'name: x');
      expect(await dockerComposeAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
