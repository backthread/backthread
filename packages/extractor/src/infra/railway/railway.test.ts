// Railway adapter integration tests.
//
// Drives buildRailwayGraph over inline fixtures that mirror a real Railway
// project shape (the "marola-platform" fictional Baltic retail app used
// throughout the Backthread dogfood corpus — adapted to Railway deployment).
//
// Dogfood note: fixtures mirror a canonical Railway multi-service shape:
//   - api service (Next.js + Nixpacks)
//   - worker service (background jobs)
//   - Railway Postgres plugin (${{Postgres.DATABASE_URL}})
//   - Railway Redis plugin (${{Redis.REDIS_URL}})
//   - Inter-service ref: api → worker (${{worker.RAILWAY_PRIVATE_URL}})
//
// Covers: detect() hit + miss, every node kind emitted (worker/datastore),
// every edge kind emitted (stores-in/calls), malformed-doesn't-crash.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRailwayGraph, railwayAdapter } from './railway.js';
import type { RailwayInputs } from './railway.js';
import { parseRailwayConfig, parseNixpacksConfig } from './railway-parse.js';

// ---------------------------------------------------------------------------
// Fixtures.

const RAILWAY_JSON_MULTI = JSON.stringify({
  services: {
    api: {
      builder: 'NIXPACKS',
      startCommand: 'npm start',
      variables: {
        DATABASE_URL: '${{Postgres.DATABASE_URL}}',
        REDIS_URL: '${{Redis.REDIS_URL}}',
        WORKER_URL: '${{worker.RAILWAY_PRIVATE_URL}}',
        NODE_ENV: 'production',
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

const NIXPACKS_TOML = `
providers = ["node"]

[phases.build]
cmd = "npm run build"

[phases.start]
cmd = "npm start"
`;

const PACKAGE_JSON = JSON.stringify({
  name: 'marola-platform',
  dependencies: { next: '^14.0.0', react: '^18.0.0' },
});

const NIXPACKS_ONLY_TOML = `
providers = ["python"]

[phases.start]
cmd = "gunicorn app:app"
`;

const PROCFILE = `web: node server.js\nworker: node worker.js`;

// ---------------------------------------------------------------------------
// buildRailwayGraph — pure builder tests.

describe('buildRailwayGraph — multi-service Railway project', () => {
  const inputs: RailwayInputs = {
    railwayConfig: parseRailwayConfig(RAILWAY_JSON_MULTI, 'railway.json'),
    nixpacks: parseNixpacksConfig(NIXPACKS_TOML),
    procfile: [],
    framework: 'next',
    railwayConfigFile: 'railway.json',
  };
  const graph = buildRailwayGraph(inputs, '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits both service nodes as worker kind', () => {
    expect(byId.get('service:api')?.kind).toBe('worker');
    expect(byId.get('service:worker')?.kind).toBe('worker');
  });

  it('emits Railway Postgres plugin as a datastore', () => {
    const pg = byId.get('plugin:postgres');
    expect(pg?.kind).toBe('datastore');
    expect(pg?.label).toBe('Railway Postgres');
  });

  it('emits Railway Redis plugin as a datastore', () => {
    const redis = byId.get('plugin:redis');
    expect(redis?.kind).toBe('datastore');
    expect(redis?.label).toBe('Railway Redis');
  });

  it('does NOT emit a "platform" node kind (locked enum enforcement)', () => {
    const kinds = graph.nodes.map((n) => n.kind);
    expect(kinds).not.toContain('platform' as never);
  });

  it('emits stores-in edge from api service to Postgres', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'service:api', target: 'plugin:postgres', kind: 'stores-in' }),
    );
  });

  it('emits stores-in edge from api service to Redis', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'service:api', target: 'plugin:redis', kind: 'stores-in' }),
    );
  });

  it('emits stores-in edge from worker service to Postgres', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'service:worker', target: 'plugin:postgres', kind: 'stores-in' }),
    );
  });

  it('emits calls edge from api to worker (inter-service ref)', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'service:api', target: 'service:worker', kind: 'calls' }),
    );
  });

  it('deduplicates edges (Postgres referenced by both api + worker = 2 stores-in, not duplicated)', () => {
    const pgEdges = graph.edges.filter((e) => e.target === 'plugin:postgres' && e.kind === 'stores-in');
    // api → postgres AND worker → postgres = 2 edges (different sources, both expected)
    expect(pgEdges).toHaveLength(2);
    const sources = pgEdges.map((e) => e.source).sort();
    expect(sources).toEqual(['service:api', 'service:worker']);
  });

  it('deduplicates plugin nodes (Postgres referenced twice = 1 node)', () => {
    expect(graph.nodes.filter((n) => n.id === 'plugin:postgres')).toHaveLength(1);
  });

  it('is all-declared provenance', () => {
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
  });

  it('emits empty classificationsNeeded (PaaS static model — no LLM)', () => {
    expect(graph.classificationsNeeded).toEqual([]);
  });

  it('sets the adapter field to "railway"', () => {
    expect(graph.adapter).toBe('railway');
  });

  it('carries framework in service metadata', () => {
    expect(byId.get('service:api')?.metadata?.framework).toBe('next');
  });
});

// ---------------------------------------------------------------------------
// buildRailwayGraph — Procfile fallback (nixpacks-only project).

describe('buildRailwayGraph — Procfile + nixpacks fallback', () => {
  const inputs: RailwayInputs = {
    railwayConfig: null,
    nixpacks: parseNixpacksConfig(NIXPACKS_ONLY_TOML),
    procfile: [
      { process: 'web', command: 'node server.js' },
      { process: 'worker', command: 'node worker.js' },
    ],
    framework: undefined,
    railwayConfigFile: undefined,
  };
  const graph = buildRailwayGraph(inputs, '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits web and worker service nodes from Procfile', () => {
    expect(byId.get('service:web')?.kind).toBe('worker');
    expect(byId.get('service:worker')?.kind).toBe('worker');
  });

  it('carries start command from Procfile in metadata', () => {
    expect(byId.get('service:web')?.metadata?.startCommand).toBe('node server.js');
  });

  it('carries nixpacks providers in metadata', () => {
    expect(byId.get('service:web')?.metadata?.nixpacksProviders).toContain('python');
  });
});

// ---------------------------------------------------------------------------
// buildRailwayGraph — single bare nixpacks project (no Procfile, no railway.json).

describe('buildRailwayGraph — nixpacks-only, no Procfile', () => {
  const inputs: RailwayInputs = {
    railwayConfig: null,
    nixpacks: parseNixpacksConfig(NIXPACKS_TOML),
    procfile: [],
    framework: 'express',
    railwayConfigFile: undefined,
  };
  const graph = buildRailwayGraph(inputs, '/repo');

  it('emits a single "app" service node', () => {
    expect(graph.nodes.filter((n) => n.kind === 'worker')).toHaveLength(1);
    expect(graph.nodes[0].id).toBe('service:app');
  });

  it('carries framework + nixpacks startCmd in metadata', () => {
    const app = graph.nodes.find((n) => n.id === 'service:app');
    expect(app?.metadata?.framework).toBe('express');
    expect(app?.metadata?.startCommand).toBe('npm start');
  });
});

// ---------------------------------------------------------------------------
// buildRailwayGraph — malformed inputs do NOT crash.

describe('buildRailwayGraph — malformed inputs', () => {
  it('does NOT crash when railwayConfig is null', () => {
    const graph = buildRailwayGraph(
      { railwayConfig: null, nixpacks: null, procfile: [], framework: undefined, railwayConfigFile: undefined },
      '/repo',
    );
    expect(graph.nodes).toHaveLength(1); // fallback app
    expect(graph.edges).toHaveLength(0);
  });

  it('does NOT crash when services have no envVars', () => {
    const config = parseRailwayConfig(JSON.stringify({ services: { api: { startCommand: 'node index.js' } } }), 'railway.json');
    const graph = buildRailwayGraph(
      { railwayConfig: config, nixpacks: null, procfile: [], framework: undefined, railwayConfigFile: undefined },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:api')).toBeTruthy();
    expect(graph.edges).toHaveLength(0);
  });

  it('does NOT crash with completely empty railway config', () => {
    const config = parseRailwayConfig('{}', 'railway.json');
    expect(() =>
      buildRailwayGraph(
        { railwayConfig: config, nixpacks: null, procfile: [], framework: undefined, railwayConfigFile: undefined },
        '/repo',
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// railwayAdapter.detect — filesystem tests.

describe('railwayAdapter.detect', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-railway-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a repo with railway.json at root', async () => {
    writeFileSync(join(dir, 'railway.json'), RAILWAY_JSON_MULTI);
    expect(await railwayAdapter.detect(dir)).toBe(true);
  });

  it('detects a repo with only nixpacks.toml (no railway.json)', async () => {
    const nixDir = mkdtempSync(join(tmpdir(), 'backthread-nix-'));
    try {
      writeFileSync(join(nixDir, 'nixpacks.toml'), NIXPACKS_TOML);
      expect(await railwayAdapter.detect(nixDir)).toBe(true);
    } finally {
      rmSync(nixDir, { recursive: true, force: true });
    }
  });

  it('does NOT detect a repo with only a Procfile (Heroku-ambiguous)', async () => {
    const herokuDir = mkdtempSync(join(tmpdir(), 'backthread-heroku-'));
    try {
      writeFileSync(join(herokuDir, 'Procfile'), PROCFILE);
      expect(await railwayAdapter.detect(herokuDir)).toBe(false);
    } finally {
      rmSync(herokuDir, { recursive: true, force: true });
    }
  });

  it('does NOT detect an empty repo', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'backthread-empty-'));
    try {
      expect(await railwayAdapter.detect(emptyDir)).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// railwayAdapter.extract — filesystem tests.

describe('railwayAdapter.extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-railway-extract-'));
    writeFileSync(join(dir, 'railway.json'), RAILWAY_JSON_MULTI);
    writeFileSync(join(dir, 'nixpacks.toml'), NIXPACKS_TOML);
    writeFileSync(join(dir, 'package.json'), PACKAGE_JSON);
    // Verify node_modules is NOT descended into.
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'railway.json'), JSON.stringify({ services: { fake: {} } }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('extracts the full topology from real files', async () => {
    const graph = await railwayAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('service:api');
    expect(ids).toContain('service:worker');
    expect(ids).toContain('plugin:postgres');
    expect(ids).toContain('plugin:redis');
  });

  it('skips node_modules (fake service not included)', async () => {
    const graph = await railwayAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).not.toContain('service:fake');
  });

  it('detects Next.js framework from package.json', async () => {
    const graph = await railwayAdapter.extract(dir);
    const api = graph.nodes.find((n) => n.id === 'service:api');
    expect(api?.metadata?.framework).toBe('next');
  });

  it('produces a valid graph (adapter = railway, all nodes declared)', async () => {
    const graph = await railwayAdapter.extract(dir);
    expect(graph.adapter).toBe('railway');
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
    expect(graph.classificationsNeeded).toHaveLength(0);
  });

  it('handles a malformed railway.json gracefully (warn + partial graph)', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'backthread-bad-'));
    try {
      writeFileSync(join(badDir, 'railway.json'), '{broken json');
      writeFileSync(join(badDir, 'nixpacks.toml'), NIXPACKS_TOML);
      // Should NOT throw — adapter wraps in try/catch.
      const graph = await railwayAdapter.extract(badDir);
      // nixpacks present → adapter detects; bad railway.json → fallback app node
      expect(graph.nodes.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Edge kind taxonomy guard — ensure no forbidden verbs are emitted.

describe('Edge kind taxonomy', () => {
  const FORBIDDEN = new Set(['imports', 'depends-on', 'uses']);

  it('never emits forbidden edge kinds', () => {
    const inputs: RailwayInputs = {
      railwayConfig: parseRailwayConfig(RAILWAY_JSON_MULTI, 'railway.json'),
      nixpacks: null,
      procfile: [],
      framework: undefined,
      railwayConfigFile: 'railway.json',
    };
    const graph = buildRailwayGraph(inputs, '/repo');
    for (const e of graph.edges) {
      expect(FORBIDDEN.has(e.kind as string)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix #2 — one-shot Procfile process types are filtered from the graph.

describe('buildRailwayGraph — Procfile one-shot process type filtering', () => {
  it('does NOT emit a node for the "release" process type', () => {
    const inputs: RailwayInputs = {
      railwayConfig: null,
      nixpacks: parseNixpacksConfig(NIXPACKS_TOML),
      procfile: [
        { process: 'web', command: 'node server.js' },
        { process: 'worker', command: 'node worker.js' },
        { process: 'release', command: 'npm run db:migrate' },
        { process: 'postdeploy', command: 'node scripts/seed.js' },
      ],
      framework: undefined,
      railwayConfigFile: undefined,
    };
    const graph = buildRailwayGraph(inputs, '/repo');
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('service:web');
    expect(ids).toContain('service:worker');
    expect(ids).not.toContain('service:release');
    expect(ids).not.toContain('service:postdeploy');
  });

  it('emits only long-running process types (web + worker)', () => {
    const inputs: RailwayInputs = {
      railwayConfig: null,
      nixpacks: parseNixpacksConfig(NIXPACKS_TOML),
      procfile: [
        { process: 'release', command: 'npm run migrate' },
        { process: 'web', command: 'node server.js' },
      ],
      framework: undefined,
      railwayConfigFile: undefined,
    };
    const graph = buildRailwayGraph(inputs, '/repo');
    expect(graph.nodes.filter((n) => n.kind === 'worker')).toHaveLength(1);
    expect(graph.nodes[0].id).toBe('service:web');
  });
});

// ---------------------------------------------------------------------------
// Fix #3 — detect() is a cheap root-only check (no deep walk).

describe('railwayAdapter.detect — root-only cheapness', () => {
  it('does NOT detect a railway.json buried in a sub-directory (root-only contract)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'backthread-deep-'));
    try {
      // Put railway.json in a sub-directory only — root has nothing.
      mkdirSync(join(d, 'services', 'api'), { recursive: true });
      writeFileSync(join(d, 'services', 'api', 'railway.json'), '{}');
      expect(await railwayAdapter.detect(d)).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('detects nixpacks.toml at root immediately (no walk needed)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'backthread-nix-root-'));
    try {
      writeFileSync(join(d, 'nixpacks.toml'), NIXPACKS_TOML);
      expect(await railwayAdapter.detect(d)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix #4 — extract() deep walk picks up nested nixpacks.toml.

describe('railwayAdapter.extract — nested nixpacks.toml discovered by deep walk', () => {
  it('finds nixpacks.toml in a sub-directory and produces a valid graph', async () => {
    const d = mkdtempSync(join(tmpdir(), 'backthread-nested-nix-'));
    try {
      // Only a nested nixpacks.toml — no root-level config.
      mkdirSync(join(d, 'api'), { recursive: true });
      writeFileSync(join(d, 'api', 'nixpacks.toml'), NIXPACKS_TOML);
      // detect() will be false (root-only), but extract() should still find it.
      const graph = await railwayAdapter.extract(d);
      expect(graph.adapter).toBe('railway');
      expect(graph.nodes.length).toBeGreaterThanOrEqual(1);
      // buildContextDir is derived from the nested config's dir, so
      // the app service's source root is `api`, not the bare repo root.
      expect(graph.nodes.find((n) => n.id === 'service:app')?.sourceRoots).toEqual(['api']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// buildRailwayGraph — sourceRoots

describe('buildRailwayGraph — sourceRoots', () => {
  const MULTI_WITH_SOURCE = JSON.stringify({
    services: {
      api: { builder: 'NIXPACKS', rootDirectory: 'apps/api', startCommand: 'npm start' },
      web: { builder: 'NIXPACKS', startCommand: 'npm run web' },
    },
  });

  it('uses a service rootDirectory/source as the source root', () => {
    const graph = buildRailwayGraph(
      {
        railwayConfig: parseRailwayConfig(MULTI_WITH_SOURCE, 'railway.json'),
        nixpacks: null,
        procfile: [],
        framework: undefined,
        railwayConfigFile: 'railway.json',
        buildContextDir: '',
      },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:api')?.sourceRoots).toEqual(['apps/api']);
  });

  it('a sourceless service under a ROOT railway.json gets NO source root (no catch-all)', () => {
    const graph = buildRailwayGraph(
      {
        railwayConfig: parseRailwayConfig(MULTI_WITH_SOURCE, 'railway.json'),
        nixpacks: null,
        procfile: [],
        framework: undefined,
        railwayConfigFile: 'railway.json',
        buildContextDir: '',
      },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:web')?.sourceRoots).toBeUndefined();
  });

  it('a sourceless service under a NESTED config uses the build-context dir', () => {
    const graph = buildRailwayGraph(
      {
        railwayConfig: parseRailwayConfig(JSON.stringify({ services: { web: { startCommand: 'npm run web' } } }), 'railway.json'),
        nixpacks: null,
        procfile: [],
        framework: undefined,
        railwayConfigFile: 'services/web/railway.json',
        buildContextDir: 'services/web',
      },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:web')?.sourceRoots).toEqual(['services/web']);
  });

  it('nixpacks-only app at repo root → NO source root (honest "Other")', () => {
    const graph = buildRailwayGraph(
      {
        railwayConfig: null,
        nixpacks: parseNixpacksConfig(NIXPACKS_ONLY_TOML),
        procfile: [],
        framework: undefined,
        railwayConfigFile: undefined,
        buildContextDir: '',
      },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:app')?.sourceRoots).toBeUndefined();
  });

  it('Procfile processes (nested build context) get the build-context dir', () => {
    const graph = buildRailwayGraph(
      {
        railwayConfig: null,
        nixpacks: parseNixpacksConfig(NIXPACKS_ONLY_TOML),
        procfile: [
          { process: 'web', command: 'node server.js' },
          { process: 'worker', command: 'node worker.js' },
        ],
        framework: undefined,
        railwayConfigFile: undefined,
        buildContextDir: 'apps/svc',
      },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'service:web')?.sourceRoots).toEqual(['apps/svc']);
    expect(graph.nodes.find((n) => n.id === 'service:worker')?.sourceRoots).toEqual(['apps/svc']);
  });

  it('plugin (datastore) nodes never carry sourceRoots', () => {
    const graph = buildRailwayGraph(
      {
        railwayConfig: parseRailwayConfig(RAILWAY_JSON_MULTI, 'railway.json'),
        nixpacks: null,
        procfile: [],
        framework: undefined,
        railwayConfigFile: 'railway.json',
        buildContextDir: '',
      },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'plugin:postgres')?.sourceRoots).toBeUndefined();
  });
});
