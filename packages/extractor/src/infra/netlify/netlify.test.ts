// Netlify adapter tests.
//
// parseNetlifyConfig + buildNetlifyGraph are pure; the adapter's detect/extract
// run against a real tmp dir. Mirrors cloudflare.test.ts.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildNetlifyGraph,
  netlifyAdapter,
  parseNetlifyConfig,
  type BuildNetlifyOpts,
} from './netlify.js';
import { parseTomlSubset } from '../cloudflare/wrangler-parse.js';

const TOML = `
[build]
  base = "frontend"
  publish = "frontend/dist"
  command = "npm run build"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

[[edge_functions]]
  function = "geolocation"
  path = "/api/geo"
`;

const baseOpts = (over: Partial<BuildNetlifyOpts> = {}): BuildNetlifyOpts => ({
  configDir: '',
  siteName: 'storefront',
  srcExists: false,
  defaultFunctionsDirExists: false,
  edgeDirExists: false,
  ...over,
});

describe('parseNetlifyConfig', () => {
  it('reads base, publish, functions dir, and edge-functions presence', () => {
    const cfg = parseNetlifyConfig(parseTomlSubset(TOML));
    expect(cfg.baseDir).toBe('frontend');
    expect(cfg.publishDir).toBe('frontend/dist');
    expect(cfg.functionsDir).toBe('netlify/functions');
    expect(cfg.hasEdgeFunctionsDeclared).toBe(true);
  });

  it('falls back to [build].functions when [functions].directory is absent', () => {
    const cfg = parseNetlifyConfig(parseTomlSubset(`[build]\n  functions = "lambda"\n`));
    expect(cfg.functionsDir).toBe('lambda');
  });

  it('an empty config has no dirs and no edge functions', () => {
    const cfg = parseNetlifyConfig({});
    expect(cfg.baseDir).toBeUndefined();
    expect(cfg.functionsDir).toBeUndefined();
    expect(cfg.hasEdgeFunctionsDeclared).toBe(false);
  });
});

describe('buildNetlifyGraph', () => {
  const graph = buildNetlifyGraph(
    [{ config: parseNetlifyConfig(parseTomlSubset(TOML)), opts: baseOpts(), configFile: 'netlify.toml' }],
    '/repo',
  );
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits a static-site node with base as its source root', () => {
    expect(byId.get('site:storefront')?.kind).toBe('static-site');
    expect(byId.get('site:storefront')?.sourceRoots).toEqual(['frontend']);
  });

  it('emits the Functions worker (declared) with the directory as source root', () => {
    const fn = byId.get('function:storefront:functions');
    expect(fn?.kind).toBe('worker');
    expect(fn?.provenance).toBe('declared');
    expect(fn?.sourceRoots).toEqual(['netlify/functions']);
  });

  it('emits the Edge Functions worker with its dir as source root', () => {
    const edge = byId.get('function:storefront:edge');
    expect(edge?.kind).toBe('worker');
    expect(edge?.sourceRoots).toEqual(['netlify/edge-functions']);
  });

  it('site calls both function units', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'site:storefront', target: 'function:storefront:functions', kind: 'calls' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'site:storefront', target: 'function:storefront:edge', kind: 'calls' }),
    );
  });

  it('no classifications needed (no LLM)', () => {
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

describe('buildNetlifyGraph — site source-root fallback', () => {
  it('falls back to src/ when no base and src exists', () => {
    const graph = buildNetlifyGraph(
      [{ config: { hasEdgeFunctionsDeclared: false }, opts: baseOpts({ srcExists: true }), configFile: 'netlify.toml' }],
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'site:storefront')?.sourceRoots).toEqual(['src']);
  });

  it('no base and no src → site has NO source root (never the repo root)', () => {
    const graph = buildNetlifyGraph(
      [{ config: { hasEdgeFunctionsDeclared: false }, opts: baseOpts({ srcExists: false }), configFile: 'netlify.toml' }],
      '/repo',
    );
    expect(graph.nodes.find((n) => n.id === 'site:storefront')?.sourceRoots).toBeUndefined();
  });

  it('the default Functions dir is INFERRED (not declared) when only the dir exists', () => {
    const graph = buildNetlifyGraph(
      [
        {
          config: { hasEdgeFunctionsDeclared: false },
          opts: baseOpts({ defaultFunctionsDirExists: true }),
          configFile: 'netlify.toml',
        },
      ],
      '/repo',
    );
    const fn = graph.nodes.find((n) => n.id === 'function:storefront:functions');
    expect(fn?.provenance).toBe('inferred');
    expect(fn?.sourceRoots).toEqual(['netlify/functions']);
  });

  it('resolves dirs against a nested configDir (monorepo app)', () => {
    const graph = buildNetlifyGraph(
      [
        {
          config: parseNetlifyConfig(parseTomlSubset(`[build]\n  base = "."\n[functions]\n  directory = "netlify/functions"\n`)),
          opts: baseOpts({ configDir: 'apps/web', siteName: 'web' }),
          configFile: 'apps/web/netlify.toml',
        },
      ],
      '/repo',
    );
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // base "." under apps/web → apps/web; a "." base is the app dir, not repo root.
    expect(byId.get('site:web')?.sourceRoots).toEqual(['apps/web']);
    expect(byId.get('function:web:functions')?.sourceRoots).toEqual(['apps/web/netlify/functions']);
  });

  it('scopes function ids per site so multiple netlify.toml files do not collide', () => {
    const cfg = parseNetlifyConfig(parseTomlSubset(`[functions]\n  directory = "netlify/functions"\n`));
    const graph = buildNetlifyGraph(
      [
        { config: cfg, opts: baseOpts({ configDir: 'apps/web', siteName: 'web' }), configFile: 'apps/web/netlify.toml' },
        { config: cfg, opts: baseOpts({ configDir: 'apps/admin', siteName: 'admin' }), configFile: 'apps/admin/netlify.toml' },
      ],
      '/repo',
    );
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // Both sites' functions survive (no first-wins drop), each with its own root.
    expect(byId.get('function:web:functions')?.sourceRoots).toEqual(['apps/web/netlify/functions']);
    expect(byId.get('function:admin:functions')?.sourceRoots).toEqual(['apps/admin/netlify/functions']);
  });
});

describe('netlifyAdapter detect + extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-netlify-'));
    mkdirSync(join(dir, 'frontend'), { recursive: true });
    mkdirSync(join(dir, 'netlify', 'functions'), { recursive: true });
    mkdirSync(join(dir, 'netlify', 'edge-functions'), { recursive: true });
    writeFileSync(join(dir, 'netlify.toml'), TOML);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/storefront' }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects netlify.toml', async () => {
    expect(await netlifyAdapter.detect(dir)).toBe(true);
  });

  it('extracts site + functions + edge functions, naming the site from package.json', async () => {
    const graph = await netlifyAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('site:storefront'); // scope-stripped pkg name
    expect(ids).toContain('function:storefront:functions');
    expect(ids).toContain('function:storefront:edge');
  });

  it('detects a repo with only a netlify/functions dir (no netlify.toml)', async () => {
    const conv = mkdtempSync(join(tmpdir(), 'backthread-netlify-conv-'));
    try {
      mkdirSync(join(conv, 'netlify', 'functions'), { recursive: true });
      expect(await netlifyAdapter.detect(conv)).toBe(true);
      const graph = await netlifyAdapter.extract(conv);
      // site name derives from the temp dir, so match the function unit by suffix.
      expect(graph.nodes.find((n) => n.id.endsWith(':functions'))?.provenance).toBe('inferred');
    } finally {
      rmSync(conv, { recursive: true, force: true });
    }
  });

  it('does not detect a repo with no Netlify signal', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-netlify-empty-'));
    try {
      writeFileSync(join(empty, '_redirects'), '/* /index.html 200'); // shared w/ CF Pages → not a signal
      expect(await netlifyAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
