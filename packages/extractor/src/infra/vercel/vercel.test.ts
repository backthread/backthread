// Vercel adapter tests.
//
// Drives `buildVercelGraph` over inline fixtures mirroring a realistic
// Next.js-on-Vercel app (App Router + Pages Router API routes, middleware,
// vercel.json with crons + functions + regions, package.json with `next`).
//
// The detect/extract path is exercised against a real tmp dir to verify the
// fs-walk + detect() hit/miss logic.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVercelGraph, vercelAdapter, type VercelProjectInputs } from './vercel.js';

// ---------------------------------------------------------------------------
// Realistic fixture data — mirrors a Next.js 14 App Router project deployed
// on Vercel with crons, function overrides, and both App + Pages API routes.

const VERCEL_JSON = JSON.stringify({
  framework: 'nextjs',
  regions: ['iad1'],
  functions: {
    'app/api/heavy/route.ts': { memory: 1024, maxDuration: 60 },
    'pages/api/webhook.ts': { runtime: 'nodejs20.x', maxDuration: 30 },
  },
  crons: [
    { path: '/api/cron/daily', schedule: '0 0 * * *' },
    { path: '/api/cron/hourly', schedule: '0 * * * *' },
  ],
  rewrites: [{ source: '/old/:path*', destination: '/new/:path*' }],
});

const PACKAGE_JSON = JSON.stringify({
  name: 'marola-platform',
  dependencies: {
    next: '^14.2.0',
    react: '^18.3.0',
    'react-dom': '^18.3.0',
  },
  devDependencies: {
    typescript: '^5.4.0',
    vercel: '^35.0.0',
  },
});

const NEXT_CONFIG = `
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
};
module.exports = nextConfig;
`;

// Fixtures for the pure builder — inline VercelProjectInputs
function makeFixtureInputs(root = '/repo'): VercelProjectInputs[] {
  return [
    {
      projectDir: root,
      vercelJsonPath: 'vercel.json',
      vercelConfig: JSON.parse(VERCEL_JSON),
      packageInfo: {
        name: 'marola-platform',
        detectedFramework: 'next',
        hasVercelDep: true,
      },
      nextOutputMode: 'standalone',
      routeFiles: [
        'app/api/heavy/route.ts',
        'app/api/products/route.ts',
        'pages/api/webhook.ts',
        'pages/api/users/[id].ts',
        'middleware.ts',
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// buildVercelGraph — pure unit tests

describe('buildVercelGraph — node kinds', () => {
  const graph = buildVercelGraph(makeFixtureInputs(), '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits the app as a static-site node', () => {
    const app = byId.get('app:.');
    expect(app?.kind).toBe('static-site');
    expect(app?.label).toBe('marola-platform');
    expect(app?.provenance).toBe('declared');
  });

  it('captures framework + outputMode in app metadata', () => {
    const app = byId.get('app:.');
    expect(app?.metadata?.framework).toBe('nextjs');
    expect(app?.metadata?.outputMode).toBe('standalone');
    expect(app?.metadata?.regions).toEqual(['iad1']);
  });

  it('emits a cdn node for the Vercel Edge Network', () => {
    const cdn = byId.get('edge-network');
    expect(cdn?.kind).toBe('cdn');
    expect(cdn?.label).toBe('Vercel Edge Network');
  });

  it('emits worker nodes for every API route file', () => {
    // App Router routes — namespaced by project dir (. for repo root)
    expect(byId.get('fn:.:/api/heavy')?.kind).toBe('worker');
    expect(byId.get('fn:.:/api/products')?.kind).toBe('worker');
    // Pages Router routes
    expect(byId.get('fn:.:/api/webhook')?.kind).toBe('worker');
    expect(byId.get('fn:.:/api/users/[id]')?.kind).toBe('worker');
  });

  it('emits worker node for middleware.ts', () => {
    const mw = byId.get('fn:.:middleware');
    expect(mw?.kind).toBe('worker');
    expect(mw?.label).toBe('middleware');
    expect(mw?.metadata?.isMiddleware).toBe(true);
  });

  it('applies vercel.json function overrides to node metadata', () => {
    const heavy = byId.get('fn:.:/api/heavy');
    expect(heavy?.metadata?.memory).toBe(1024);
    expect(heavy?.metadata?.maxDuration).toBe(60);
    const webhook = byId.get('fn:.:/api/webhook');
    expect(webhook?.metadata?.runtime).toBe('nodejs20.x');
    expect(webhook?.metadata?.maxDuration).toBe(30);
  });

  it('emits all-declared provenance with no classifications needed', () => {
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

describe('buildVercelGraph — sourceRoots', () => {
  it('a ROOT app gets no app source root from the project dir (no catch-all), but functions get their route dirs', () => {
    const graph = buildVercelGraph(makeFixtureInputs(), '/repo');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // project dir IS the repo root → '' would be a catch-all → dropped (no src/ in fixture)
    expect(byId.get('app:.')?.sourceRoots).toBeUndefined();
    // each function gets its route file's dir
    expect(byId.get('fn:.:/api/heavy')?.sourceRoots).toEqual(['app/api/heavy']);
    expect(byId.get('fn:.:/api/products')?.sourceRoots).toEqual(['app/api/products']);
    expect(byId.get('fn:.:/api/webhook')?.sourceRoots).toEqual(['pages/api']);
    expect(byId.get('fn:.:/api/users/[id]')?.sourceRoots).toEqual(['pages/api/users']);
  });

  it('a root middleware.ts gets NO source root (must not claim the whole repo)', () => {
    const graph = buildVercelGraph(makeFixtureInputs(), '/repo');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('fn:.:middleware')?.sourceRoots).toBeUndefined();
  });

  it('a root app falls back to src/ when it exists', () => {
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo',
        packageInfo: { name: 'root-app', detectedFramework: 'next', hasVercelDep: false },
        srcExists: true,
        routeFiles: [],
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    expect(graph.nodes.find((n) => n.id === 'app:.')?.sourceRoots).toEqual(['src']);
  });

  it('a MONOREPO app gets its project dir as the source root; functions nest under it', () => {
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo/apps/web',
        packageInfo: { name: 'web', hasVercelDep: false },
        routeFiles: ['apps/web/app/api/users/route.ts', 'apps/web/pages/api/ping.ts'],
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    const appNode = graph.nodes.find((n) => n.kind === 'static-site');
    expect(appNode?.sourceRoots).toEqual(['apps/web']);
    // functions live deeper → out-rank the app by longest prefix
    const fnByFile = (file: string) => graph.nodes.find((n) => n.metadata?.file === file);
    expect(fnByFile('apps/web/app/api/users/route.ts')?.sourceRoots).toEqual(['apps/web/app/api/users']);
    expect(fnByFile('apps/web/pages/api/ping.ts')?.sourceRoots).toEqual(['apps/web/pages/api']);
  });

  it('a root app with no src/ and a cron-only synthetic function emits no source roots (graceful)', () => {
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo',
        vercelConfig: { crons: [{ path: '/api/cron/ghost', schedule: '*/5 * * * *' }] },
        packageInfo: { name: 'ghost-app', hasVercelDep: false },
        routeFiles: [],
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    expect(graph.nodes.find((n) => n.id === 'app:.')?.sourceRoots).toBeUndefined();
    // a cron target not present in the file-walk has no known source file → no root
    expect(graph.nodes.find((n) => n.id === 'fn:.:/api/cron/ghost')?.sourceRoots).toBeUndefined();
  });
});

describe('buildVercelGraph — edge kinds', () => {
  const graph = buildVercelGraph(makeFixtureInputs(), '/repo');

  it('emits deploys-to edge from app to cdn', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'app:.', target: 'edge-network', kind: 'deploys-to' }),
    );
  });

  it('emits calls edges from cdn to function nodes', () => {
    // CDN calls API route functions (not middleware)
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'edge-network', target: 'fn:.:/api/heavy', kind: 'calls' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'edge-network', target: 'fn:.:/api/webhook', kind: 'calls' }),
    );
  });

  it('emits calls edges from app to cron-target functions', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'app:.', target: 'fn:.:/api/cron/daily', kind: 'calls' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'app:.', target: 'fn:.:/api/cron/hourly', kind: 'calls' }),
    );
  });

  it('cron edge carries schedule in metadata', () => {
    const cronEdge = graph.edges.find(
      (e) => e.source === 'app:.' && e.target === 'fn:.:/api/cron/daily',
    );
    expect(cronEdge?.metadata?.schedule).toBe('0 0 * * *');
    expect(cronEdge?.metadata?.via).toBe('vercel-cron');
  });

  it('does NOT emit a cdn→middleware calls edge (middleware is interceptor, not routed function)', () => {
    const mwEdge = graph.edges.find(
      (e) => e.source === 'edge-network' && e.target === 'fn:.:middleware',
    );
    expect(mwEdge).toBeUndefined();
  });
});

describe('buildVercelGraph — cron creates function node when not in routeFiles', () => {
  it('synthesises a worker node for a cron path missing from the file-walk', () => {
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo',
        vercelConfig: {
          crons: [{ path: '/api/cron/ghost', schedule: '*/5 * * * *' }],
        },
        packageInfo: { name: 'ghost-app', hasVercelDep: false },
        routeFiles: [],
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    const ghost = graph.nodes.find((n) => n.id === 'fn:.:/api/cron/ghost');
    expect(ghost?.kind).toBe('worker');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'app:.', target: 'fn:.:/api/cron/ghost', kind: 'calls' }),
    );
  });
});

describe('buildVercelGraph — static export skips CDN node', () => {
  it('does not emit a cdn node when output mode is export', () => {
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo',
        packageInfo: { name: 'static-app', detectedFramework: 'next', hasVercelDep: false },
        nextOutputMode: 'export',
        routeFiles: [],
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    expect(graph.nodes.find((n) => n.kind === 'cdn')).toBeUndefined();
    // No deploys-to edge either
    expect(graph.edges.find((e) => e.kind === 'deploys-to')).toBeUndefined();
  });
});

describe('buildVercelGraph — deduplication', () => {
  it('dedupes identical function nodes when the same project dir + route appear twice', () => {
    // Two input entries with the same projectDir and route → same namespaced id
    // → deduped to one node.
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo',
        packageInfo: { name: 'app-a', hasVercelDep: false },
        routeFiles: ['pages/api/shared.ts'],
      },
      {
        projectDir: '/repo',
        packageInfo: { name: 'app-b', hasVercelDep: false },
        routeFiles: ['pages/api/shared.ts'],
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    // Both entries produce fn:.:/api/shared (same namespace) → deduped.
    const sharedNodes = graph.nodes.filter((n) => n.id === 'fn:.:/api/shared');
    expect(sharedNodes).toHaveLength(1);
  });

  it('does NOT dedup function nodes from different monorepo project dirs with the same route path', () => {
    // Two distinct project dirs each exposing /api/shared → different fn ids
    // → two distinct nodes (no misattribution). Route file paths are relative
    // to repoDir (as collectRouteFiles would produce them).
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo/apps/alpha',
        packageInfo: { name: 'alpha', hasVercelDep: false },
        // relative to repoDir '/repo' — pages/api path within the alpha project
        routeFiles: ['apps/alpha/pages/api/shared.ts'],
      },
      {
        projectDir: '/repo/apps/beta',
        packageInfo: { name: 'beta', hasVercelDep: false },
        routeFiles: ['apps/beta/pages/api/shared.ts'],
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    // routeFileToPath('apps/alpha/pages/api/shared.ts') doesn't match the
    // pages/api convention (no leading pages/api/ match) so falls back to
    // the full path. The key invariant is that the two projects produce
    // DIFFERENT fn ids (different namespace prefix).
    const alphaFnNodes = graph.nodes.filter((n) => n.id.startsWith('fn:apps/alpha:'));
    const betaFnNodes = graph.nodes.filter((n) => n.id.startsWith('fn:apps/beta:'));
    expect(alphaFnNodes.length).toBeGreaterThan(0);
    expect(betaFnNodes.length).toBeGreaterThan(0);
    // The two sets of nodes must be disjoint (no id appears in both).
    const alphaIds = new Set(alphaFnNodes.map((n) => n.id));
    const betaIds = new Set(betaFnNodes.map((n) => n.id));
    const intersection = [...alphaIds].filter((id) => betaIds.has(id));
    expect(intersection).toHaveLength(0);
  });
});

describe('buildVercelGraph — malformed config does not crash', () => {
  it('handles inputs with no vercelConfig or packageInfo gracefully', () => {
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo',
        routeFiles: ['pages/api/hello.ts'],
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    expect(graph.nodes.find((n) => n.kind === 'worker')?.id).toBe('fn:.:/api/hello');
  });
});

// ---------------------------------------------------------------------------
// buildVercelGraph — glob matching for vercel.json functions keys (Finding 2)

describe('buildVercelGraph — glob matching for functions keys', () => {
  it('applies config from a ** glob pattern to all matching routes', () => {
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo',
        vercelConfig: {
          functions: {
            'app/api/**': { maxDuration: 45, memory: 512 },
          },
        },
        routeFiles: [
          'app/api/foo/route.ts',
          'app/api/bar/route.ts',
        ],
        packageInfo: { hasVercelDep: false },
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('fn:.:/api/foo')?.metadata?.maxDuration).toBe(45);
    expect(byId.get('fn:.:/api/foo')?.metadata?.memory).toBe(512);
    expect(byId.get('fn:.:/api/bar')?.metadata?.maxDuration).toBe(45);
  });

  it('applies config from a * glob pattern to single-segment matches', () => {
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo',
        vercelConfig: {
          functions: {
            'pages/api/*.ts': { runtime: 'nodejs20.x' },
          },
        },
        routeFiles: ['pages/api/users.ts', 'pages/api/orders.ts'],
        packageInfo: { hasVercelDep: false },
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('fn:.:/api/users')?.metadata?.runtime).toBe('nodejs20.x');
    expect(byId.get('fn:.:/api/orders')?.metadata?.runtime).toBe('nodejs20.x');
  });

  it('does NOT apply a * glob to paths with a slash (subdirectory routes)', () => {
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo',
        vercelConfig: {
          functions: {
            'pages/api/*.ts': { runtime: 'nodejs20.x' },
          },
        },
        routeFiles: ['pages/api/deep/nested.ts'],
        packageInfo: { hasVercelDep: false },
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // Single * should not cross a directory separator.
    expect(byId.get('fn:.:/api/deep/nested')?.metadata?.runtime).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildVercelGraph — truthiness guard for 0 values (Finding 3)

describe('buildVercelGraph — zero values in function config are preserved', () => {
  it('includes memory: 0 in node metadata (not silently dropped)', () => {
    const inputs: VercelProjectInputs[] = [
      {
        projectDir: '/repo',
        vercelConfig: {
          functions: {
            'pages/api/lean.ts': { memory: 0, maxDuration: 0, runtime: '' },
          },
        },
        routeFiles: ['pages/api/lean.ts'],
        packageInfo: { hasVercelDep: false },
      },
    ];
    const graph = buildVercelGraph(inputs, '/repo');
    const node = graph.nodes.find((n) => n.id === 'fn:.:/api/lean');
    expect(node?.metadata?.memory).toBe(0);
    expect(node?.metadata?.maxDuration).toBe(0);
    // runtime: '' is a non-undefined string — must appear.
    expect(node?.metadata?.runtime).toBe('');
  });
});

// ---------------------------------------------------------------------------
// detect + extract — real fs

describe('vercelAdapter detect + extract', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-vercel-'));

    // Write project files
    writeFileSync(join(dir, 'vercel.json'), VERCEL_JSON);
    writeFileSync(join(dir, 'package.json'), PACKAGE_JSON);
    writeFileSync(join(dir, 'next.config.js'), NEXT_CONFIG);

    // App Router routes
    mkdirSync(join(dir, 'app', 'api', 'heavy'), { recursive: true });
    writeFileSync(join(dir, 'app', 'api', 'heavy', 'route.ts'), 'export async function GET() {}');
    mkdirSync(join(dir, 'app', 'api', 'products'), { recursive: true });
    writeFileSync(join(dir, 'app', 'api', 'products', 'route.ts'), 'export async function GET() {}');

    // Pages Router API routes
    mkdirSync(join(dir, 'pages', 'api', 'users'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'api', 'webhook.ts'), 'export default function handler() {}');
    writeFileSync(join(dir, 'pages', 'api', 'users', '[id].ts'), 'export default function handler() {}');

    // Middleware
    writeFileSync(join(dir, 'middleware.ts'), 'export function middleware() {}');

    // node_modules must NOT be descended into
    mkdirSync(join(dir, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', 'some-pkg', 'vercel.json'),
      JSON.stringify({ framework: 'should-be-ignored' }),
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a project with vercel.json', async () => {
    expect(await vercelAdapter.detect(dir)).toBe(true);
  });

  it('does not detect a repo with no vercel.json / next.config / framework dep', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-vercel-empty-'));
    try {
      // Write a generic package.json with no known framework
      writeFileSync(join(empty, 'package.json'), JSON.stringify({ name: 'express-app', dependencies: { express: '^4.0.0' } }));
      expect(await vercelAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('does NOT detect a repo with only a bare package.json (no framework/vercel dep)', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'backthread-vercel-bare-'));
    try {
      writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'just-a-lib', dependencies: { lodash: '^4.0.0' } }));
      expect(await vercelAdapter.detect(bare)).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('detects a repo with package.json that has a vercel dep (no vercel.json)', async () => {
    const vercelDepOnly = mkdtempSync(join(tmpdir(), 'backthread-vercel-dep-'));
    try {
      writeFileSync(join(vercelDepOnly, 'package.json'), JSON.stringify({
        name: 'vercel-cli-user',
        devDependencies: { vercel: '^35.0.0' },
      }));
      expect(await vercelAdapter.detect(vercelDepOnly)).toBe(true);
    } finally {
      rmSync(vercelDepOnly, { recursive: true, force: true });
    }
  });

  it('detects a project by next.config.js alone (no vercel.json)', async () => {
    const nextOnly = mkdtempSync(join(tmpdir(), 'backthread-vercel-next-'));
    try {
      writeFileSync(join(nextOnly, 'next.config.js'), NEXT_CONFIG);
      writeFileSync(join(nextOnly, 'package.json'), PACKAGE_JSON);
      expect(await vercelAdapter.detect(nextOnly)).toBe(true);
    } finally {
      rmSync(nextOnly, { recursive: true, force: true });
    }
  });

  it('extracts the full topology and skips node_modules', async () => {
    const graph = await vercelAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);

    // App node
    expect(ids).toContain('app:.');

    // CDN node
    expect(ids).toContain('edge-network');

    // Function nodes from the file walk — namespaced by project dir (. for root)
    expect(ids).toContain('fn:.:/api/heavy');
    expect(ids).toContain('fn:.:/api/products');
    expect(ids).toContain('fn:.:/api/webhook');
    expect(ids).toContain('fn:.:/api/users/[id]');
    expect(ids).toContain('fn:.:middleware');

    // Should NOT have picked up node_modules
    expect(graph.nodes.find((n) => (n.metadata?.framework as string) === 'should-be-ignored')).toBeUndefined();
  });

  it('emits cron function nodes even if missing from file-walk (from vercel.json crons)', async () => {
    const graph = await vercelAdapter.extract(dir);
    // vercel.json declares crons for /api/cron/daily + /api/cron/hourly
    // which are NOT in the actual file tree — adapter synthesises them
    const cronIds = graph.nodes.filter((n) => n.id.includes('cron')).map((n) => n.id);
    expect(cronIds).toContain('fn:.:/api/cron/daily');
    expect(cronIds).toContain('fn:.:/api/cron/hourly');
  });

  it('extracts cron edges with schedule metadata', async () => {
    const graph = await vercelAdapter.extract(dir);
    const cronEdge = graph.edges.find((e) => e.target === 'fn:.:/api/cron/daily');
    expect(cronEdge?.kind).toBe('calls');
    expect(cronEdge?.metadata?.schedule).toBe('0 0 * * *');
  });

  it('graph adapter field is "vercel"', async () => {
    const graph = await vercelAdapter.extract(dir);
    expect(graph.adapter).toBe('vercel');
  });

  it('emits sourceRoots from the real fs walk', async () => {
    const graph = await vercelAdapter.extract(dir);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // root project, no src/ in the fixture → app has no catch-all root
    expect(byId.get('app:.')?.sourceRoots).toBeUndefined();
    // functions carry their route dirs
    expect(byId.get('fn:.:/api/heavy')?.sourceRoots).toEqual(['app/api/heavy']);
    expect(byId.get('fn:.:/api/users/[id]')?.sourceRoots).toEqual(['pages/api/users']);
  });

  it('all nodes have declared provenance and no classifications needed', async () => {
    const graph = await vercelAdapter.extract(dir);
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

describe('vercelAdapter extract — malformed vercel.json does not crash', () => {
  it('warns and continues when vercel.json is invalid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backthread-vercel-bad-'));
    try {
      writeFileSync(join(dir, 'vercel.json'), '{ this is not valid json }');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bad-app', dependencies: { next: '^14.0.0' } }));
      mkdirSync(join(dir, 'pages', 'api'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'api', 'hello.ts'), 'export default function() {}');

      // Should not throw — should degrade gracefully
      let graph;
      expect(async () => {
        graph = await vercelAdapter.extract(dir);
      }).not.toThrow();

      // Re-run for assertions (the above doesn't await properly inside expect)
      graph = await vercelAdapter.extract(dir);
      // App node should still exist from package.json
      expect(graph.nodes.find((n) => n.kind === 'static-site')).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
