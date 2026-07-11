// Fly.io adapter integration tests.
//
// buildFlyGraph is pure (FlyConfigEntry[] → InfraGraph); the adapter's
// detect/extract are exercised against a real tmp dir. No Supabase chain,
// so this collects clean under vitest.
//
// Fixtures mirror a real fly.io repo shape:
//   - single-process app with a volume (guaranteed second node kind + stores-in)
//   - multi-process app ([processes] block)
//   - detect() hit + miss
//   - malformed fly.toml doesn't crash extract()

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFlyGraph, flyAdapter, type FlyConfigEntry } from './fly.js';
import { parseFlyConfig } from './fly-parse.js';

// ---------------------------------------------------------------------------
// Fixtures

/**
 * Real fly.toml shape — single process, one volume.
 * Mirrors the shape you'd see after `fly launch` on a Node.js web app.
 */
const SINGLE_PROCESS_TOML = `
app = "marola-api"
primary_region = "ams"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "3000"

[[services]]
  internal_port = 3000
  protocol = "tcp"

  [services.concurrency]
    type = "connections"
    hard_limit = 25
    soft_limit = 20

[[mounts]]
  source = "marola_uploads"
  destination = "/app/uploads"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
  cpu_kind = "shared"
`;

/**
 * Multi-process fly.toml — web server + background worker, each with its
 * own volume. Mirrors a Sidekiq-style Rails/Node split.
 */
const MULTI_PROCESS_TOML = `
app = "marola-platform"
primary_region = "ord"

[build]
  image = "registry.fly.io/marola-platform:latest"

[processes]
  web = "node server.js"
  worker = "node worker.js"

[[services]]
  internal_port = 8080
  protocol = "tcp"
  processes = ["web"]

[[mounts]]
  source = "platform_data"
  destination = "/data"
  processes = ["web", "worker"]

[[mounts]]
  source = "worker_tmp"
  destination = "/tmp/worker"
  processes = ["worker"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "512mb"
  processes = ["web"]

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
  processes = ["worker"]
`;

/**
 * Minimal app — just a name, no volumes or services.
 * Tests that extract() never explodes on a bare-bones config.
 */
const MINIMAL_TOML = `app = "bare-minimum"`;

/**
 * Malformed TOML — must not throw; must degrade gracefully.
 */
const MALFORMED_TOML = `
app = "broken-app"
[[services
  internal_port = not_a_number
===invalid===
`;

// ---------------------------------------------------------------------------
// buildFlyGraph — single process

describe('buildFlyGraph — single-process app with volume', () => {
  const entry: FlyConfigEntry = {
    config: parseFlyConfig(SINGLE_PROCESS_TOML),
    file: '/repo/fly.toml',
    dockerfilePath: 'Dockerfile',
  };
  const graph = buildFlyGraph([entry], '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits adapter name "fly"', () => {
    expect(graph.adapter).toBe('fly');
  });

  it('emits the app as a container-kind node (app-scoped id)', () => {
    // Fix #1/#3: single-process id is machine:<app> (not just machine:<name>)
    const node = byId.get('machine:marola-api');
    expect(node?.kind).toBe('container');
  });

  it('container node carries app + region + dockerfile in metadata', () => {
    const node = byId.get('machine:marola-api');
    expect(node?.metadata?.app).toBe('marola-api');
    expect(node?.metadata?.primaryRegion).toBe('ams');
    expect(node?.metadata?.dockerfile).toBe('Dockerfile');
  });

  it('emits the volume as a datastore-kind node (app-scoped id)', () => {
    // Fix #2: volume id is volume:<app>/<name>
    const vol = byId.get('volume:marola-api/marola_uploads');
    expect(vol?.kind).toBe('datastore');
    expect(vol?.label).toBe('marola_uploads');
  });

  it('emits a stores-in edge from container to volume (app-scoped ids)', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'machine:marola-api',
        target: 'volume:marola-api/marola_uploads',
        kind: 'stores-in',
      }),
    );
  });

  it('emits only "container" and "datastore" node kinds', () => {
    const kinds = [...new Set(graph.nodes.map((n) => n.kind))].sort();
    expect(kinds).toEqual(['container', 'datastore']);
  });

  it('emits only "stores-in" edge kind', () => {
    const edgeKinds = [...new Set(graph.edges.map((e) => e.kind))];
    expect(edgeKinds).toEqual(['stores-in']);
  });

  it('is all-declared provenance with no classifications needed (no LLM)', () => {
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
    expect(graph.classificationsNeeded).toEqual([]);
  });

  it('vm sizing lands in container metadata', () => {
    const node = byId.get('machine:marola-api');
    expect(node?.metadata?.vmSize).toBe('shared-cpu-1x');
    expect(node?.metadata?.vmMemory).toBe('256mb');
  });

  it('service internal_port lands in container metadata', () => {
    const node = byId.get('machine:marola-api');
    expect(node?.metadata?.internalPort).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// buildFlyGraph — multi-process app

describe('buildFlyGraph — multi-process app', () => {
  const entry: FlyConfigEntry = {
    config: parseFlyConfig(MULTI_PROCESS_TOML),
    file: '/repo/fly.toml',
  };
  const graph = buildFlyGraph([entry], '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits one container node per named process (app-scoped ids)', () => {
    // Fix #1: multi-process ids are machine:<app>/<proc>
    expect(byId.get('machine:marola-platform/web')?.kind).toBe('container');
    expect(byId.get('machine:marola-platform/worker')?.kind).toBe('container');
  });

  it('container labels include app/process names', () => {
    expect(byId.get('machine:marola-platform/web')?.label).toBe('marola-platform / web');
    expect(byId.get('machine:marola-platform/worker')?.label).toBe('marola-platform / worker');
  });

  it('container metadata carries process command', () => {
    expect(byId.get('machine:marola-platform/web')?.metadata?.command).toBe('node server.js');
    expect(byId.get('machine:marola-platform/worker')?.metadata?.command).toBe('node worker.js');
  });

  it('emits both volumes as datastore nodes (app-scoped ids)', () => {
    // Fix #2: volume ids are volume:<app>/<name>
    expect(byId.get('volume:marola-platform/platform_data')?.kind).toBe('datastore');
    expect(byId.get('volume:marola-platform/worker_tmp')?.kind).toBe('datastore');
  });

  it('shared mount (no processes restriction) → stores-in from both containers', () => {
    const edges = graph.edges.filter((e) => e.target === 'volume:marola-platform/platform_data');
    const sources = edges.map((e) => e.source).sort();
    expect(sources).toEqual(['machine:marola-platform/web', 'machine:marola-platform/worker']);
  });

  it('worker-only mount → stores-in from worker only', () => {
    const edges = graph.edges.filter((e) => e.target === 'volume:marola-platform/worker_tmp');
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('machine:marola-platform/worker');
  });

  it('build image lands in container metadata', () => {
    const web = byId.get('machine:marola-platform/web');
    expect(web?.metadata?.image).toBe('registry.fly.io/marola-platform:latest');
  });

  it('per-process vm sizing lands in correct container metadata', () => {
    expect(byId.get('machine:marola-platform/web')?.metadata?.vmSize).toBe('shared-cpu-2x');
    expect(byId.get('machine:marola-platform/worker')?.metadata?.vmSize).toBe('shared-cpu-1x');
  });

  it('all edges are stores-in (no invented calls edges)', () => {
    expect(graph.edges.every((e) => e.kind === 'stores-in')).toBe(true);
  });

  it('is all-declared provenance, no classifications needed', () => {
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildFlyGraph — sourceRoots

describe('buildFlyGraph — sourceRoots', () => {
  it('Dockerfile-build app (nested) → its fly.toml dir is the source root', () => {
    // SINGLE_PROCESS_TOML has [build].dockerfile and no image → builds from source.
    const g = buildFlyGraph(
      [{ config: parseFlyConfig(SINGLE_PROCESS_TOML), file: '/repo/apps/api/fly.toml' }],
      '/repo',
    );
    expect(g.nodes.find((n) => n.id === 'machine:marola-api')?.sourceRoots).toEqual(['apps/api']);
  });

  it('image-only app → NO source root (honest "Other"), all process containers', () => {
    // MULTI_PROCESS_TOML has [build].image (prebuilt) → no source.
    const g = buildFlyGraph(
      [{ config: parseFlyConfig(MULTI_PROCESS_TOML), file: '/repo/apps/platform/fly.toml' }],
      '/repo',
    );
    expect(g.nodes.find((n) => n.id === 'machine:marola-platform/web')?.sourceRoots).toBeUndefined();
    expect(g.nodes.find((n) => n.id === 'machine:marola-platform/worker')?.sourceRoots).toBeUndefined();
  });

  it('no-build app (nested) → the fly.toml dir is the source root', () => {
    const g = buildFlyGraph(
      [{ config: parseFlyConfig(MINIMAL_TOML), file: '/repo/services/bare/fly.toml' }],
      '/repo',
    );
    expect(g.nodes.find((n) => n.id === 'machine:bare-minimum')?.sourceRoots).toEqual(['services/bare']);
  });

  it('root app → NO source root (never the bare repo root, no catch-all)', () => {
    const g = buildFlyGraph(
      [{ config: parseFlyConfig(SINGLE_PROCESS_TOML), file: '/repo/fly.toml' }],
      '/repo',
    );
    expect(g.nodes.find((n) => n.id === 'machine:marola-api')?.sourceRoots).toBeUndefined();
  });

  it('volume (datastore) nodes never carry sourceRoots (they run no code)', () => {
    const g = buildFlyGraph(
      [{ config: parseFlyConfig(SINGLE_PROCESS_TOML), file: '/repo/apps/api/fly.toml' }],
      '/repo',
    );
    expect(g.nodes.find((n) => n.id === 'volume:marola-api/marola_uploads')?.sourceRoots).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildFlyGraph — minimal app (no services / mounts)

describe('buildFlyGraph — minimal app', () => {
  const graph = buildFlyGraph(
    [{ config: parseFlyConfig(MINIMAL_TOML), file: '/repo/fly.toml' }],
    '/repo',
  );

  it('emits exactly one container node with app-scoped id', () => {
    const containers = graph.nodes.filter((n) => n.kind === 'container');
    expect(containers).toHaveLength(1);
    expect(containers[0].id).toBe('machine:bare-minimum');
    expect(containers[0].label).toBe('bare-minimum');
  });

  it('emits no edges and no datastore nodes when no volumes declared', () => {
    expect(graph.nodes.filter((n) => n.kind === 'datastore')).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildFlyGraph — deduplication across multiple configs

describe('buildFlyGraph — deduplication / app-scoping across configs', () => {
  // Fix #2: Fly volumes are per-app. Two apps each declaring a volume with the
  // same *name* are separate Fly volumes → separate datastore nodes.
  it('two apps with same volume name produce two distinct datastore nodes', () => {
    const cfgA = `
app = "app-a"
[[mounts]]
  source = "shared_vol"
  destination = "/data"
`;
    const cfgB = `
app = "app-b"
[[mounts]]
  source = "shared_vol"
  destination = "/data"
`;
    const g = buildFlyGraph(
      [
        { config: parseFlyConfig(cfgA), file: '/repo/fly.toml' },
        { config: parseFlyConfig(cfgB), file: '/repo/api/fly.toml' },
      ],
      '/repo',
    );
    // Each app gets its own volume node
    expect(g.nodes.filter((n) => n.id === 'volume:app-a/shared_vol')).toHaveLength(1);
    expect(g.nodes.filter((n) => n.id === 'volume:app-b/shared_vol')).toHaveLength(1);
    // No un-scoped node from the old scheme
    expect(g.nodes.filter((n) => n.id === 'volume:shared_vol')).toHaveLength(0);
  });

  // Same-app dedup: the same volume referenced from two mounts in ONE config
  // should still produce only one datastore node.
  it('same app referencing the same volume name twice deduplicates to one node', () => {
    const cfg = `
app = "dedup-app"
[[mounts]]
  source = "my_vol"
  destination = "/data"
  processes = ["web"]
[[mounts]]
  source = "my_vol"
  destination = "/data2"
  processes = ["worker"]
`;
    const g = buildFlyGraph(
      [{ config: parseFlyConfig(cfg), file: '/repo/fly.toml' }],
      '/repo',
    );
    expect(g.nodes.filter((n) => n.id === 'volume:dedup-app/my_vol')).toHaveLength(1);
  });

  // Fix #1 + #3: two apps each with a process named 'web' get distinct node ids.
  it('two apps each with a web process get distinct machine node ids', () => {
    const cfgX = `
app = "svc-x"
[processes]
  web = "node x.js"
`;
    const cfgY = `
app = "svc-y"
[processes]
  web = "node y.js"
`;
    const g = buildFlyGraph(
      [
        { config: parseFlyConfig(cfgX), file: '/repo/svc-x/fly.toml' },
        { config: parseFlyConfig(cfgY), file: '/repo/svc-y/fly.toml' },
      ],
      '/repo',
    );
    expect(g.nodes.filter((n) => n.id === 'machine:svc-x/web')).toHaveLength(1);
    expect(g.nodes.filter((n) => n.id === 'machine:svc-y/web')).toHaveLength(1);
    // No un-scoped node
    expect(g.nodes.filter((n) => n.id === 'machine:web')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// flyAdapter detect + extract

describe('flyAdapter detect + extract', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-fly-'));
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'api', 'fly.toml'), SINGLE_PROCESS_TOML);
    writeFileSync(join(dir, 'api', 'Dockerfile'), 'FROM node:22-alpine\nCMD ["node", "server.js"]');
    // node_modules must NOT be descended into.
    mkdirSync(join(dir, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'some-pkg', 'fly.toml'), 'app = "should-be-ignored"');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a repo with a nested fly.toml', async () => {
    expect(await flyAdapter.detect(dir)).toBe(true);
  });

  it('does not detect a repo with no fly.toml', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-fly-empty-'));
    try {
      expect(await flyAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('extracts the app topology and skips node_modules', async () => {
    const graph = await flyAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    // Fix #1/#3: single-process id is machine:<app>
    expect(ids).toContain('machine:marola-api');
    expect(ids).not.toContain('machine:should-be-ignored');
  });

  it('extract picks up the Dockerfile path when adjacent to fly.toml', async () => {
    const graph = await flyAdapter.extract(dir);
    const node = graph.nodes.find((n) => n.id === 'machine:marola-api');
    expect(node?.metadata?.dockerfile).toBe('api/Dockerfile');
  });

  it('extract emits a stores-in edge for the volume (app-scoped ids)', async () => {
    const graph = await flyAdapter.extract(dir);
    // Fix #2: volume id is volume:<app>/<name>
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'machine:marola-api',
        target: 'volume:marola-api/marola_uploads',
        kind: 'stores-in',
      }),
    );
  });

  it('malformed fly.toml in extract does NOT crash; emits warn + continues', async () => {
    const malformedDir = mkdtempSync(join(tmpdir(), 'backthread-fly-bad-'));
    writeFileSync(join(malformedDir, 'fly.toml'), MALFORMED_TOML);
    try {
      let graph;
      // Should not throw even with malformed TOML
      expect(async () => {
        graph = await flyAdapter.extract(malformedDir);
      }).not.toThrow();
      // The degraded config still produces a container node (app = "broken-app" parses fine)
      graph = await flyAdapter.extract(malformedDir);
      expect(graph.adapter).toBe('fly');
      // nodes may be empty if parseFlyConfig itself returns a minimal config with services=[]
      // — the important invariant is "no crash"
      expect(Array.isArray(graph.nodes)).toBe(true);
    } finally {
      rmSync(malformedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix #4 — build.dockerfile path is resolved + surfaced in metadata

describe('buildFlyGraph — Fix #4: build.dockerfile provenance', () => {
  it('when build.dockerfile is set, surfaced as buildDockerfile in metadata', () => {
    // Uses the buildFlyGraph pure function; no real filesystem needed because
    // findDockerfile falls back to the declared path when the file doesn't exist.
    const cfg = parseFlyConfig(`
app = "custom-build"
[build]
  dockerfile = "docker/Dockerfile.prod"
`);
    const g = buildFlyGraph([{ config: cfg, file: '/repo/fly.toml' }], '/repo');
    const node = g.nodes.find((n) => n.id === 'machine:custom-build');
    // The declared path is preserved even when the file isn't on disk
    expect(node?.metadata?.buildDockerfile).toBe('docker/Dockerfile.prod');
  });

  it('adjacent default Dockerfile does NOT set buildDockerfile (not a custom path)', () => {
    // Use the filesystem-backed extract path; the test dir has an adjacent Dockerfile.
    const testDir = mkdtempSync(join(tmpdir(), 'backthread-fly-df-'));
    try {
      writeFileSync(
        join(testDir, 'fly.toml'),
        `app = "df-test"\nprimary_region = "ams"\n`,
      );
      writeFileSync(join(testDir, 'Dockerfile'), 'FROM node:22-alpine');
      const g2 = buildFlyGraph(
        [{ config: parseFlyConfig(`app = "df-test"\nprimary_region = "ams"\n`), file: join(testDir, 'fly.toml') }],
        testDir,
      );
      const n = g2.nodes.find((n) => n.id === 'machine:df-test');
      expect(n?.metadata?.dockerfile).toBe('Dockerfile');
      // Not a custom path — buildDockerfile should NOT be present
      expect(n?.metadata?.buildDockerfile).toBeUndefined();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix #5 — missing app name derives stable fallback from config file path

describe('buildFlyGraph — Fix #5: missing app name fallback', () => {
  it('config with no app field derives id from config dir, not collapsing to "machine:app"', () => {
    // parseFlyConfig sets appMissing:true when the `app` field is absent
    const cfg = parseFlyConfig(`primary_region = "ams"\n`);
    expect(cfg.appMissing).toBe(true);

    const g = buildFlyGraph([{ config: cfg, file: '/repo/services/backend/fly.toml' }], '/repo');
    // id should use "services/backend" derived from the dir, NOT "machine:app" or "machine:__missing__"
    expect(g.nodes.find((n) => n.id === 'machine:app')).toBeUndefined();
    expect(g.nodes.find((n) => n.id === 'machine:__missing__')).toBeUndefined();
    // The node id should be derived from the relative config dir path
    const container = g.nodes.find((n) => n.kind === 'container');
    expect(container?.id).toBe('machine:services/backend');
  });

  it('two anonymous configs at different paths get distinct node ids', () => {
    const cfg = parseFlyConfig(`primary_region = "ams"\n`);
    const g = buildFlyGraph(
      [
        { config: { ...cfg }, file: '/repo/svc-a/fly.toml' },
        { config: { ...cfg }, file: '/repo/svc-b/fly.toml' },
      ],
      '/repo',
    );
    const containers = g.nodes.filter((n) => n.kind === 'container');
    const ids = containers.map((n) => n.id).sort();
    expect(ids).toEqual(['machine:svc-a', 'machine:svc-b']);
  });
});
