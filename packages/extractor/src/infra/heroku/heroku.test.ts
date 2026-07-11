// Heroku adapter tests.
//
// buildHerokuGraph is pure (parsed config → InfraGraph); the adapter's
// detect/extract are exercised against a real tmp dir.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHerokuGraph, herokuAdapter, type HerokuInputs } from './heroku.js';

// ---------------------------------------------------------------------------
// Fixtures mirroring a real Heroku app:
//   - web dyno (Node.js server)
//   - worker dyno (background job processor)
//   - release dyno (DB migration)
//   - Postgres addon (customer-data datastore)
//   - Redis addon (datastore)
//   - SendGrid addon (paid external-api)

const PROCFILE = `web: node server.js\nworker: node jobs.js\nrelease: node migrate.js\n`;

const APP_JSON = JSON.stringify({
  name: 'my-heroku-app',
  addons: [
    { id: 'heroku-postgresql', plan: 'mini' },
    'heroku-redis',
    'sendgrid',
  ],
  env: {
    NODE_ENV: { value: 'production' },
    SECRET_KEY: { generator: 'secret' },
  },
  formation: {
    web: { quantity: 1, size: 'basic' },
    worker: { quantity: 1, size: 'basic' },
  },
});

// Full inputs for the pure builder
const FULL_INPUTS: HerokuInputs = {
  procfileEntries: [
    { processType: 'web', command: 'node server.js' },
    { processType: 'worker', command: 'node jobs.js' },
    { processType: 'release', command: 'node migrate.js' },
  ],
  appJson: {
    name: 'my-heroku-app',
    addons: [
      { slug: 'heroku-postgresql', plan: 'mini' },
      { slug: 'heroku-redis' },
      { slug: 'sendgrid' },
    ],
    env: {},
    formation: {},
  },
  hasHerokuYml: false,
};

// ---------------------------------------------------------------------------
// buildHerokuGraph — pure builder tests

describe('buildHerokuGraph — node kinds', () => {
  const graph = buildHerokuGraph(FULL_INPUTS, '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits all three dynos as worker-kind nodes', () => {
    expect(byId.get('dyno:web')?.kind).toBe('worker');
    expect(byId.get('dyno:worker')?.kind).toBe('worker');
    expect(byId.get('dyno:release')?.kind).toBe('worker');
  });

  it('emits Postgres addon as datastore', () => {
    const pg = byId.get('addon:heroku-postgresql');
    expect(pg?.kind).toBe('datastore');
  });

  it('emits Redis addon as datastore', () => {
    const redis = byId.get('addon:heroku-redis');
    expect(redis?.kind).toBe('datastore');
  });

  it('emits SendGrid addon as external-api', () => {
    const sg = byId.get('addon:sendgrid');
    expect(sg?.kind).toBe('external-api');
  });

  it('all nodes have declared provenance', () => {
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
  });

  it('emits no classificationsNeeded (static slug map covers all)', () => {
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

describe('buildHerokuGraph — edge kinds', () => {
  const graph = buildHerokuGraph(FULL_INPUTS, '/repo');

  it('emits stores-in edges from web dyno to datastore addons', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'dyno:web', target: 'addon:heroku-postgresql', kind: 'stores-in' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'dyno:web', target: 'addon:heroku-redis', kind: 'stores-in' }),
    );
  });

  it('emits calls edges from web dyno to external-api addons', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'dyno:web', target: 'addon:sendgrid', kind: 'calls' }),
    );
  });

  it('emits stores-in + calls edges from worker dyno too', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'dyno:worker', target: 'addon:heroku-postgresql', kind: 'stores-in' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'dyno:worker', target: 'addon:sendgrid', kind: 'calls' }),
    );
  });

  it('covers stores-in and calls kinds', () => {
    const kinds = new Set(graph.edges.map((e) => e.kind));
    expect(kinds.has('stores-in')).toBe(true);
    expect(kinds.has('calls')).toBe(true);
  });
});

describe('buildHerokuGraph — edge cases', () => {
  it('returns empty nodes + edges when both inputs are empty', () => {
    const graph = buildHerokuGraph({ procfileEntries: [], appJson: null, hasHerokuYml: false }, '/repo');
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('emits no edges when no Procfile entries (addons only)', () => {
    const graph = buildHerokuGraph({
      procfileEntries: [],
      appJson: { name: 'app', addons: [{ slug: 'heroku-postgresql' }], env: {}, formation: {} },
      hasHerokuYml: false,
    }, '/repo');
    expect(graph.edges).toHaveLength(0);
    // But the addon node should still exist
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].kind).toBe('datastore');
  });

  it('dedupes addon nodes (same slug referenced twice)', () => {
    const graph = buildHerokuGraph({
      procfileEntries: [{ processType: 'web', command: 'node app.js' }],
      appJson: {
        name: 'app',
        addons: [
          { slug: 'heroku-postgresql' },
          { slug: 'heroku-postgresql' }, // duplicate
        ],
        env: {},
        formation: {},
      },
      hasHerokuYml: false,
    }, '/repo');
    expect(graph.nodes.filter((n) => n.id === 'addon:heroku-postgresql')).toHaveLength(1);
  });

  it('handles unknown addon slug as external-api declared', () => {
    const graph = buildHerokuGraph({
      procfileEntries: [{ processType: 'web', command: 'node app.js' }],
      appJson: {
        name: 'app',
        addons: [{ slug: 'some-unknown-service' }],
        env: {},
        formation: {},
      },
      hasHerokuYml: false,
    }, '/repo');
    const unknownNode = graph.nodes.find((n) => n.id === 'addon:some-unknown-service');
    expect(unknownNode?.kind).toBe('external-api');
    expect(unknownNode?.provenance).toBe('declared');
  });

  it('returns correct adapter name and root', () => {
    const graph = buildHerokuGraph(FULL_INPUTS, '/my/repo');
    expect(graph.adapter).toBe('heroku');
    expect(graph.root).toBe('/my/repo');
  });

  it('Procfile-only (no app.json) — emits dynos only, no edges', () => {
    const graph = buildHerokuGraph({
      procfileEntries: [{ processType: 'web', command: 'node app.js' }],
      appJson: null,
      hasHerokuYml: false,
    }, '/repo');
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].kind).toBe('worker');
    expect(graph.edges).toHaveLength(0);
  });

  it('queue-kind addon (CloudAMQP) uses publishes edge', () => {
    const graph = buildHerokuGraph({
      procfileEntries: [{ processType: 'web', command: 'node app.js' }],
      appJson: {
        name: 'app',
        addons: [{ slug: 'cloudamqp' }],
        env: {},
        formation: {},
      },
      hasHerokuYml: false,
    }, '/repo');
    const amqp = graph.nodes.find((n) => n.id === 'addon:cloudamqp');
    expect(amqp?.kind).toBe('queue');
    // queue addons use 'publishes' (not stores-in) per 8-verb taxonomy
    expect(graph.edges[0].kind).toBe('publishes');
  });

  it('addon nodes carry provider:heroku in metadata', () => {
    const graph = buildHerokuGraph({
      procfileEntries: [],
      appJson: {
        name: 'app',
        addons: [{ slug: 'heroku-postgresql', plan: 'mini' }],
        env: {},
        formation: {},
      },
      hasHerokuYml: false,
    }, '/repo');
    const pg = graph.nodes.find((n) => n.id === 'addon:heroku-postgresql');
    expect(pg?.metadata).toMatchObject({ provider: 'heroku', slug: 'heroku-postgresql', plan: 'mini' });
  });
});

// ---------------------------------------------------------------------------
// detect() + extract() — integration via real tmp dir

describe('herokuAdapter detect + extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-heroku-'));
    writeFileSync(join(dir, 'Procfile'), PROCFILE);
    writeFileSync(join(dir, 'app.json'), APP_JSON);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a repo with Procfile + app.json', async () => {
    expect(await herokuAdapter.detect(dir)).toBe(true);
  });

  it('extracts correct topology from real files', async () => {
    const graph = await herokuAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('dyno:web');
    expect(ids).toContain('dyno:worker');
    expect(ids).toContain('dyno:release');
    expect(ids).toContain('addon:heroku-postgresql');
    expect(ids).toContain('addon:heroku-redis');
    expect(ids).toContain('addon:sendgrid');
  });

  it('extract emits stores-in + calls edges', async () => {
    const graph = await herokuAdapter.extract(dir);
    const kinds = new Set(graph.edges.map((e) => e.kind));
    expect(kinds.has('stores-in')).toBe(true);
    expect(kinds.has('calls')).toBe(true);
  });

  it('does not detect a repo with no Heroku files', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-heroku-empty-'));
    try {
      expect(await herokuAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('detects when only heroku.yml is present', async () => {
    const ymlOnly = mkdtempSync(join(tmpdir(), 'backthread-heroku-yml-'));
    try {
      writeFileSync(join(ymlOnly, 'heroku.yml'), 'build:\n  docker:\n    web: Dockerfile\n');
      expect(await herokuAdapter.detect(ymlOnly)).toBe(true);
    } finally {
      rmSync(ymlOnly, { recursive: true, force: true });
    }
  });

  it('extract does not crash on malformed app.json (warns, returns partial graph)', async () => {
    const malformed = mkdtempSync(join(tmpdir(), 'backthread-heroku-bad-'));
    try {
      writeFileSync(join(malformed, 'Procfile'), 'web: node app.js\n');
      writeFileSync(join(malformed, 'app.json'), '{ not valid json at all');
      const graph = await herokuAdapter.extract(malformed);
      // Should still have the web dyno from Procfile
      expect(graph.nodes.some((n) => n.id === 'dyno:web')).toBe(true);
    } finally {
      rmSync(malformed, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Addon slug plan-stripping

describe('buildHerokuGraph — addon plan suffix stripping', () => {
  it('strips :plan suffix from inline slug+plan form passed via addons array', () => {
    // Some app.json files use "heroku-postgresql:mini" as the id string
    const graph = buildHerokuGraph({
      procfileEntries: [],
      appJson: {
        name: 'app',
        addons: [{ slug: 'heroku-postgresql:mini' }],
        env: {},
        formation: {},
      },
      hasHerokuYml: false,
    }, '/repo');
    // Should map to the same id as the plain slug
    expect(graph.nodes.find((n) => n.id === 'addon:heroku-postgresql')).toBeDefined();
    expect(graph.nodes[0].kind).toBe('datastore');
  });
});

// ---------------------------------------------------------------------------
// buildHerokuGraph — sourceRoots

describe('buildHerokuGraph — sourceRoots', () => {
  const procfile = [
    { processType: 'web', command: 'node server.js' },
    { processType: 'worker', command: 'node jobs.js' },
  ];

  it('a root-level app (no monorepo base env) emits NO source root (honest "Other")', () => {
    const graph = buildHerokuGraph(
      { procfileEntries: procfile, appJson: { addons: [], env: {}, formation: {} }, hasHerokuYml: false },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'dyno:web')?.sourceRoots).toBeUndefined();
    expect(graph.nodes.find((n) => n.id === 'dyno:worker')?.sourceRoots).toBeUndefined();
  });

  it('a Procfile with no app.json at all emits NO source root', () => {
    const graph = buildHerokuGraph({ procfileEntries: procfile, appJson: null, hasHerokuYml: false }, '/repo');
    expect(graph.nodes.find((n) => n.id === 'dyno:web')?.sourceRoots).toBeUndefined();
  });

  it('the monorepo APP_BASE env ({ value }) becomes the shared dyno source root', () => {
    const graph = buildHerokuGraph(
      {
        procfileEntries: procfile,
        appJson: { addons: [], env: { APP_BASE: { value: 'apps/api' } }, formation: {} },
        hasHerokuYml: false,
      },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'dyno:web')?.sourceRoots).toEqual(['apps/api']);
    expect(graph.nodes.find((n) => n.id === 'dyno:worker')?.sourceRoots).toEqual(['apps/api']);
  });

  it('a bare-string PROJECT_PATH env is also honored', () => {
    const graph = buildHerokuGraph(
      {
        procfileEntries: procfile,
        appJson: { addons: [], env: { PROJECT_PATH: 'services/web' }, formation: {} },
        hasHerokuYml: false,
      },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'dyno:web')?.sourceRoots).toEqual(['services/web']);
  });

  it('an APP_BASE of "." (repo root) emits NO source root (no catch-all)', () => {
    const graph = buildHerokuGraph(
      {
        procfileEntries: procfile,
        appJson: { addons: [], env: { APP_BASE: { value: '.' } }, formation: {} },
        hasHerokuYml: false,
      },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'dyno:web')?.sourceRoots).toBeUndefined();
  });

  it('addon (datastore/external-api) nodes never carry sourceRoots', () => {
    const graph = buildHerokuGraph(
      {
        procfileEntries: procfile,
        appJson: {
          addons: [{ slug: 'heroku-postgresql', plan: 'mini' }, { slug: 'sendgrid' }],
          env: { APP_BASE: { value: 'apps/api' } },
          formation: {},
        },
        hasHerokuYml: false,
      },
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'addon:heroku-postgresql')?.sourceRoots).toBeUndefined();
    expect(graph.nodes.find((n) => n.id === 'addon:sendgrid')?.sourceRoots).toBeUndefined();
  });
});
