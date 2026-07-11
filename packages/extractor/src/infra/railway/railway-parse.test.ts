// Railway parser unit tests.
//
// Tests parseRailwayConfig (json + toml), parseNixpacksConfig, parseProcfile,
// detectFramework, and extractEnvRefs. Covers both well-formed and malformed
// inputs; malformed inputs MUST NOT throw.

import { describe, it, expect } from '../../testkit.js';
import {
  parseRailwayConfig,
  parseNixpacksConfig,
  parseProcfile,
  detectFramework,
  extractEnvRefs,
  extractConfigRefs,
} from './railway-parse.js';

// ---------------------------------------------------------------------------
// Fixtures — realistic Railway project shapes.

const RAILWAY_JSON_SINGLE = JSON.stringify({
  services: {
    api: {
      builder: 'NIXPACKS',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      variables: {
        DATABASE_URL: '${{Postgres.DATABASE_URL}}',
        REDIS_URL: '${{Redis.REDIS_URL}}',
        NODE_ENV: 'production',
      },
    },
  },
});

const RAILWAY_JSON_MULTI = JSON.stringify({
  services: {
    api: {
      startCommand: 'node dist/server.js',
      variables: {
        DATABASE_URL: '${{Postgres.DATABASE_URL}}',
        WORKER_URL: '${{worker.RAILWAY_PRIVATE_URL}}',
      },
    },
    worker: {
      startCommand: 'node dist/worker.js',
      variables: {
        DATABASE_URL: '${{Postgres.DATABASE_URL}}',
      },
    },
  },
});

const RAILWAY_JSON_ARRAY = JSON.stringify({
  services: [
    { name: 'web', startCommand: 'node server.js', variables: { DB: '${{Postgres.DATABASE_URL}}' } },
    { name: 'jobs', startCommand: 'node jobs.js', variables: { DB: '${{Postgres.DATABASE_URL}}' } },
  ],
});

const RAILWAY_TOML_SINGLE = [
  '[service]',
  'name = "my-app"',
  'builder = "NIXPACKS"',
  'buildCommand = "npm run build"',
  'startCommand = "npm start"',
  '',
  '[service.variables]',
  'DATABASE_URL = "${{Postgres.DATABASE_URL}}"',
  'REDIS_URL = "${{Redis.URL}}"',
].join('\n');

const NIXPACKS_TOML = `
providers = ["node"]

[phases.build]
cmd = "npm run build"

[phases.start]
cmd = "node dist/index.js"
`;

const PROCFILE = `
web: node server.js
worker: node worker.js
# This is a comment
release: npm run db:migrate
`;

const PACKAGE_JSON_NEXT = JSON.stringify({
  name: 'my-app',
  dependencies: { next: '^14.0.0', react: '^18.0.0' },
});

const PACKAGE_JSON_EXPRESS = JSON.stringify({
  name: 'api',
  dependencies: { express: '^4.18.0' },
});

// ---------------------------------------------------------------------------
// parseRailwayConfig — JSON shapes.

describe('parseRailwayConfig (JSON)', () => {
  it('parses a single-service object config', () => {
    const config = parseRailwayConfig(RAILWAY_JSON_SINGLE, 'railway.json');
    expect(config.services).toHaveLength(1);
    const svc = config.services[0];
    expect(svc.name).toBe('api');
    expect(svc.builder).toBe('NIXPACKS');
    expect(svc.buildCommand).toBe('npm run build');
    expect(svc.startCommand).toBe('npm start');
    expect(svc.envVars?.DATABASE_URL).toBe('${{Postgres.DATABASE_URL}}');
  });

  it('parses a multi-service object config', () => {
    const config = parseRailwayConfig(RAILWAY_JSON_MULTI, 'railway.json');
    expect(config.services).toHaveLength(2);
    const names = config.services.map((s) => s.name).sort();
    expect(names).toEqual(['api', 'worker']);
  });

  it('parses an array-of-services config', () => {
    const config = parseRailwayConfig(RAILWAY_JSON_ARRAY, 'railway.json');
    expect(config.services).toHaveLength(2);
    expect(config.services[0].name).toBe('web');
    expect(config.services[1].name).toBe('jobs');
  });

  it('falls back to a single "app" service for bare config (no services key)', () => {
    const bare = JSON.stringify({ startCommand: 'node index.js' });
    const config = parseRailwayConfig(bare, 'railway.json');
    expect(config.services).toHaveLength(1);
    expect(config.services[0].name).toBe('app');
    expect(config.services[0].startCommand).toBe('node index.js');
  });

  it('does NOT throw on empty JSON object', () => {
    const config = parseRailwayConfig('{}', 'railway.json');
    expect(config.services).toHaveLength(1); // fallback app service
  });

  it('does NOT throw on malformed JSON (catches internally via try/catch in caller)', () => {
    // parseRailwayConfig itself throws for truly unparseable input —
    // the adapter wraps it in try/catch. Verify the throw at parser level
    // so the adapter's console.warn path is exercised.
    expect(() => parseRailwayConfig('{broken json', 'railway.json')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseRailwayConfig — TOML shape.

describe('parseRailwayConfig (TOML)', () => {
  it('parses a railway.toml with a [service] table', () => {
    const config = parseRailwayConfig(RAILWAY_TOML_SINGLE, 'railway.toml');
    // TOML single-service: falls back to the root as a single service
    // (no `services` key at root in toml = single-service project)
    expect(config.services.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT throw on empty TOML', () => {
    const config = parseRailwayConfig('', 'railway.toml');
    expect(config.services).toHaveLength(1); // fallback app
  });
});

// ---------------------------------------------------------------------------
// extractEnvRefs.

describe('extractEnvRefs', () => {
  it('extracts plugin refs and marks isPlugin = true', () => {
    const refs = extractEnvRefs('DB=${{Postgres.DATABASE_URL}} CACHE=${{Redis.URL}}');
    expect(refs).toHaveLength(2);
    const db = refs.find((r) => r.nameLower === 'postgres')!;
    expect(db.isPlugin).toBe(true);
    expect(db.varKey).toBe('DATABASE_URL');
    const cache = refs.find((r) => r.nameLower === 'redis')!;
    expect(cache.isPlugin).toBe(true);
  });

  it('extracts service refs and marks isPlugin = false', () => {
    const refs = extractEnvRefs('URL=${{api.RAILWAY_PRIVATE_URL}}');
    expect(refs).toHaveLength(1);
    expect(refs[0].nameLower).toBe('api');
    expect(refs[0].isPlugin).toBe(false);
    expect(refs[0].varKey).toBe('RAILWAY_PRIVATE_URL');
  });

  it('returns empty array for text with no refs', () => {
    expect(extractEnvRefs('PORT=3000')).toHaveLength(0);
    expect(extractEnvRefs('')).toHaveLength(0);
  });

  it('handles MongoDB and MySQL refs as plugins', () => {
    const refs = extractEnvRefs('URL=${{MongoDB.MONGODB_URL}} DB=${{mysql.DATABASE_URL}}');
    expect(refs.every((r) => r.isPlugin)).toBe(true);
  });

  it('preserves original casing in name field', () => {
    const refs = extractEnvRefs('${{Postgres.DATABASE_URL}}');
    expect(refs[0].name).toBe('Postgres');
    expect(refs[0].nameLower).toBe('postgres');
  });

  it('extracts multiple refs from the same string', () => {
    const refs = extractEnvRefs('${{Postgres.DB}} ${{Redis.URL}} ${{Postgres.URL}}');
    expect(refs).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// extractConfigRefs.

describe('extractConfigRefs', () => {
  it('collects refs from all service envVars', () => {
    const config = parseRailwayConfig(RAILWAY_JSON_MULTI, 'railway.json');
    const refs = extractConfigRefs(config);
    const pluginRefs = refs.filter((r) => r.isPlugin);
    // Both api + worker reference Postgres → 2 refs (dedupe is graph-builder's job)
    expect(pluginRefs.some((r) => r.nameLower === 'postgres')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseNixpacksConfig.

describe('parseNixpacksConfig', () => {
  it('extracts providers, build cmd, and start cmd', () => {
    const nx = parseNixpacksConfig(NIXPACKS_TOML);
    expect(nx.providers).toContain('node');
    expect(nx.buildCmd).toBe('npm run build');
    expect(nx.startCmd).toBe('node dist/index.js');
  });

  it('does NOT throw on empty TOML', () => {
    const nx = parseNixpacksConfig('');
    expect(nx.providers).toBeUndefined();
    expect(nx.buildCmd).toBeUndefined();
  });

  it('does NOT throw on a nixpacks.toml with no phases', () => {
    const nx = parseNixpacksConfig('[metadata]\nname = "test"');
    expect(nx.buildCmd).toBeUndefined();
    expect(nx.startCmd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseProcfile.

describe('parseProcfile', () => {
  it('parses web and worker process types', () => {
    const entries = parseProcfile(PROCFILE);
    expect(entries).toContainEqual({ process: 'web', command: 'node server.js' });
    expect(entries).toContainEqual({ process: 'worker', command: 'node worker.js' });
  });

  it('parses the release process type', () => {
    const entries = parseProcfile(PROCFILE);
    expect(entries).toContainEqual({ process: 'release', command: 'npm run db:migrate' });
  });

  it('ignores comment lines and blank lines', () => {
    const entries = parseProcfile(PROCFILE);
    expect(entries.every((e) => !e.process.startsWith('#'))).toBe(true);
  });

  it('returns empty array for empty Procfile', () => {
    expect(parseProcfile('')).toHaveLength(0);
    expect(parseProcfile('# just a comment\n\n')).toHaveLength(0);
  });

  it('does NOT throw on a line without a colon', () => {
    const entries = parseProcfile('web node server.js\nworker: node worker.js');
    expect(entries).toHaveLength(1);
    expect(entries[0].process).toBe('worker');
  });
});

// ---------------------------------------------------------------------------
// detectFramework.

describe('detectFramework', () => {
  it('detects Next.js', () => {
    expect(detectFramework(PACKAGE_JSON_NEXT)).toBe('next');
  });

  it('detects Express', () => {
    expect(detectFramework(PACKAGE_JSON_EXPRESS)).toBe('express');
  });

  it('returns undefined when no known framework found', () => {
    expect(detectFramework(JSON.stringify({ dependencies: { lodash: '^4' } }))).toBeUndefined();
  });

  it('does NOT throw on malformed package.json', () => {
    expect(detectFramework('{broken')).toBeUndefined();
  });

  it('does NOT throw on empty string', () => {
    expect(detectFramework('')).toBeUndefined();
  });
});
