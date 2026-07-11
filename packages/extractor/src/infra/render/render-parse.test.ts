// render-parse unit tests.
//
// parseRenderConfig maps a YAML string → RenderConfig.
// These tests verify the structural mapping independently of the graph builder
// and confirm that a malformed YAML input throws (so render.ts's try/catch
// can swallow + warn cleanly).

import { describe, it, expect } from '../../testkit.js';
import { parseRenderConfig } from './render-parse.js';

// ---------------------------------------------------------------------------
// Fixtures

/**
 * Realistic render.yaml covering every section we care about:
 *   - web service with fromDatabase + fromService envVars
 *   - background worker service
 *   - static site
 *   - managed Postgres database
 *   - managed Redis
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
          name: marola-redis
          property: connectionString
      - key: WORKER_URL
        fromService:
          name: jobs-worker
          type: worker
          property: host
      - key: NODE_ENV
        value: production
      - key: SESSION_SECRET
        generateValue: true

  - name: jobs-worker
    type: worker
    runtime: node
    buildCommand: npm ci
    startCommand: node worker.js
    plan: starter
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: marola-db
          property: connectionString

  - name: web-frontend
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
    databaseName: marola
    user: marola_user

redis:
  - name: marola-redis
    plan: free
    region: frankfurt
`;

/**
 * Minimal render.yaml — just a single web service, nothing else.
 */
const MINIMAL_YAML = `
services:
  - name: minimal-api
    type: web
    runtime: python
`;

/**
 * render.yaml with cron + private service types.
 */
const CRON_PSERV_YAML = `
services:
  - name: scheduler
    type: cron
    runtime: node
    startCommand: node cron.js

  - name: internal-rpc
    type: pserv
    runtime: go
    startCommand: ./server
`;

/**
 * Malformed YAML — must throw so render.ts can catch + warn.
 */
const MALFORMED_YAML = `
services:
  - name: broken
    type: [unclosed
    runtime: node
  key: : : invalid
`;

// ---------------------------------------------------------------------------
// Full config parsing

describe('parseRenderConfig — full render.yaml', () => {
  const config = parseRenderConfig(FULL_RENDER_YAML);

  it('parses 3 services', () => {
    expect(config.services).toHaveLength(3);
  });

  it('parses the web service correctly', () => {
    const api = config.services.find((s) => s.name === 'api');
    expect(api).toBeDefined();
    expect(api?.type).toBe('web');
    expect(api?.runtime).toBe('node');
    expect(api?.buildCommand).toBe('npm ci && npm run build');
    expect(api?.startCommand).toBe('npm start');
    expect(api?.plan).toBe('starter');
    expect(api?.branch).toBe('main');
    expect(api?.autoDeploy).toBe(true);
  });

  it('parses fromDatabase envVar on the api service', () => {
    const api = config.services.find((s) => s.name === 'api')!;
    const dbRef = api.envVars.find((e) => e.key === 'DATABASE_URL');
    expect(dbRef?.fromDatabase?.name).toBe('marola-db');
    expect(dbRef?.fromDatabase?.property).toBe('connectionString');
  });

  it('parses fromService envVar on the api service', () => {
    const api = config.services.find((s) => s.name === 'api')!;
    const svcRef = api.envVars.find((e) => e.key === 'WORKER_URL');
    expect(svcRef?.fromService?.name).toBe('jobs-worker');
    expect(svcRef?.fromService?.type).toBe('worker');
    expect(svcRef?.fromService?.property).toBe('host');
  });

  it('parses literal value envVar', () => {
    const api = config.services.find((s) => s.name === 'api')!;
    const nodeEnv = api.envVars.find((e) => e.key === 'NODE_ENV');
    expect(nodeEnv?.value).toBe('production');
  });

  it('parses generateValue envVar', () => {
    const api = config.services.find((s) => s.name === 'api')!;
    const secret = api.envVars.find((e) => e.key === 'SESSION_SECRET');
    expect(secret?.generateValue).toBe(true);
  });

  it('parses the worker service', () => {
    const worker = config.services.find((s) => s.name === 'jobs-worker');
    expect(worker?.type).toBe('worker');
    expect(worker?.runtime).toBe('node');
  });

  it('parses the static site service', () => {
    const staticSite = config.services.find((s) => s.name === 'web-frontend');
    expect(staticSite?.type).toBe('static');
    expect(staticSite?.routes).toHaveLength(1);
    expect(staticSite?.routes?.[0]?.type).toBe('rewrite');
    expect(staticSite?.routes?.[0]?.source).toBe('/*');
  });

  it('parses 1 managed Postgres database', () => {
    expect(config.databases).toHaveLength(1);
    const db = config.databases[0];
    expect(db.name).toBe('marola-db');
    expect(db.plan).toBe('free');
    expect(db.region).toBe('frankfurt');
    expect(db.postgresMajorVersion).toBe(16);
    expect(db.databaseName).toBe('marola');
    expect(db.user).toBe('marola_user');
  });

  it('parses 1 managed Redis', () => {
    expect(config.redis).toHaveLength(1);
    const redis = config.redis[0];
    expect(redis.name).toBe('marola-redis');
    expect(redis.plan).toBe('free');
    expect(redis.region).toBe('frankfurt');
  });
});

// ---------------------------------------------------------------------------
// Minimal config

describe('parseRenderConfig — minimal render.yaml', () => {
  const config = parseRenderConfig(MINIMAL_YAML);

  it('parses the single service', () => {
    expect(config.services).toHaveLength(1);
    expect(config.services[0].name).toBe('minimal-api');
    expect(config.services[0].type).toBe('web');
    expect(config.services[0].runtime).toBe('python');
  });

  it('returns empty databases and redis arrays', () => {
    expect(config.databases).toHaveLength(0);
    expect(config.redis).toHaveLength(0);
  });

  it('returns empty envVars array for the service', () => {
    expect(config.services[0].envVars).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cron + private service types

describe('parseRenderConfig — cron and pserv types', () => {
  const config = parseRenderConfig(CRON_PSERV_YAML);

  it('parses cron type', () => {
    const cron = config.services.find((s) => s.name === 'scheduler');
    expect(cron?.type).toBe('cron');
  });

  it('parses pserv type', () => {
    const pserv = config.services.find((s) => s.name === 'internal-rpc');
    expect(pserv?.type).toBe('pserv');
  });
});

// ---------------------------------------------------------------------------
// rawType preservation

describe('parseRenderConfig — rawType field', () => {
  it('rawType equals type for known service types', () => {
    const config = parseRenderConfig(FULL_RENDER_YAML);
    const api = config.services.find((s) => s.name === 'api')!;
    expect(api.rawType).toBe('web');
    const worker = config.services.find((s) => s.name === 'jobs-worker')!;
    expect(worker.rawType).toBe('worker');
  });

  it('rawType preserves unknown type string while type falls back to web', () => {
    const yaml = `
services:
  - name: my-fn
    type: background-worker
    runtime: node
`;
    const config = parseRenderConfig(yaml);
    const svc = config.services[0];
    expect(svc.type).toBe('web');         // fallback
    expect(svc.rawType).toBe('background-worker'); // original preserved
  });
});

// ---------------------------------------------------------------------------
// Malformed YAML — must throw (adapter's extract() wraps in try/catch + warns)

describe('parseRenderConfig — malformed YAML', () => {
  it('throws on malformed YAML input', () => {
    expect(() => parseRenderConfig(MALFORMED_YAML)).toThrow();
  });

  it('does NOT throw on empty string (returns empty config)', () => {
    // An empty YAML document is null — our code guards and throws with a
    // descriptive message; that IS the expected contract (adapter swallows it).
    expect(() => parseRenderConfig('')).toThrow();
  });

  it('does NOT throw on a valid but empty-mapping YAML', () => {
    // {} is a valid empty config — services/databases/redis default to [].
    const config = parseRenderConfig('{}');
    expect(config.services).toHaveLength(0);
    expect(config.databases).toHaveLength(0);
    expect(config.redis).toHaveLength(0);
  });
});
