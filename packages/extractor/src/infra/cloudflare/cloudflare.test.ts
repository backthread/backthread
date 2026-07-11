// Cloudflare adapter tests.
//
// buildCloudflareGraph is pure (parsed config → InfraGraph); the adapter's
// detect/extract are exercised against a real tmp dir. No Supabase chain, so
// this collects clean under vitest.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCloudflareGraph,
  cloudflareAdapter,
  copySourceToRoots,
  detectViteSpa,
  dockerfilePathFor,
  dockerfileCopySources,
} from './cloudflare.js';
import { parseJsonc } from './wrangler-parse.js';

// The actual dogfood config (example-ingest-worker), trimmed to the binding model.
const WORKER_JSONC = `{
  "name": "example-ingest-worker",
  "main": "src/index.ts",
  "kv_namespaces": [{ "binding": "CLEW_KV", "id": "abc" }],
  "queues": {
    "producers": [{ "binding": "INGEST_QUEUE", "queue": "example-ingest" }],
    "consumers": [{ "queue": "example-ingest", "max_retries": 3 }]
  },
  "containers": [{ "class_name": "Sandbox", "image": "../Dockerfile" }],
  "durable_objects": { "bindings": [{ "name": "SANDBOX", "class_name": "Sandbox" }] }
}`;

describe('buildCloudflareGraph', () => {
  const graph = buildCloudflareGraph(
    [{ tree: parseJsonc(WORKER_JSONC), file: '/repo/worker/wrangler.jsonc' }],
    '/repo',
  );
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits the worker as a worker-kind node', () => {
    expect(byId.get('worker:example-ingest-worker')?.kind).toBe('worker');
  });

  it('emits queue / datastore / container nodes', () => {
    expect(byId.get('queue:example-ingest')?.kind).toBe('queue');
    expect(byId.get('kv:CLEW_KV')?.kind).toBe('datastore');
    expect(byId.get('container:Sandbox')?.kind).toBe('container');
  });

  it('emits publishes + subscribes edges to the same queue (producer & consumer)', () => {
    const qEdges = graph.edges.filter((e) => e.target === 'queue:example-ingest');
    expect(qEdges.map((e) => e.kind).sort()).toEqual(['publishes', 'subscribes']);
  });

  it('worker stores-in the KV datastore and calls the container', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'worker:example-ingest-worker', target: 'kv:CLEW_KV', kind: 'stores-in' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'worker:example-ingest-worker', target: 'container:Sandbox', kind: 'calls' }),
    );
  });

  it('is all-declared provenance with no classifications needed (no LLM)', () => {
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
    expect(graph.classificationsNeeded).toEqual([]);
  });

  it('classifies Workers AI as an external-api', () => {
    const g = buildCloudflareGraph(
      [{ tree: parseJsonc(`{ "name": "w", "ai": { "binding": "AI" } }`), file: '/repo/wrangler.jsonc' }],
      '/repo',
    );
    const ai = g.nodes.find((n) => n.id === 'ai:workers-ai');
    expect(ai?.kind).toBe('external-api');
  });

  it('detects Pages (pages_build_output_dir) as a static-site', () => {
    const g = buildCloudflareGraph(
      [{ tree: parseJsonc(`{ "name": "site", "pages_build_output_dir": "dist" }`), file: '/repo/wrangler.jsonc' }],
      '/repo',
    );
    expect(g.nodes.find((n) => n.id === 'pages:site')?.kind).toBe('static-site');
  });

  it('dedupes a resource bound by two configs', () => {
    const g = buildCloudflareGraph(
      [
        { tree: parseJsonc(`{ "name": "a", "queues": { "producers": [{ "queue": "shared" }] } }`), file: 'a' },
        { tree: parseJsonc(`{ "name": "b", "queues": { "consumers": [{ "queue": "shared" }] } }`), file: 'b' },
      ],
      '/repo',
    );
    expect(g.nodes.filter((n) => n.id === 'queue:shared')).toHaveLength(1);
  });
});

describe('cloudflareAdapter detect + extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-cf-'));
    mkdirSync(join(dir, 'worker'), { recursive: true });
    writeFileSync(join(dir, 'worker', 'wrangler.jsonc'), WORKER_JSONC);
    // node_modules must NOT be descended into.
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'wrangler.toml'), 'name = "should-be-ignored"');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a nested wrangler config', async () => {
    expect(await cloudflareAdapter.detect(dir)).toBe(true);
  });

  it('extracts the worker topology and skips node_modules', async () => {
    const graph = await cloudflareAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('worker:example-ingest-worker');
    expect(ids).not.toContain('worker:should-be-ignored');
  });

  it('does not detect a repo with no wrangler config', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-empty-'));
    try {
      expect(await cloudflareAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// --: deployment-target source roots --------------------------------

describe('dockerfileCopySources (pure token parse)', () => {
  it('extracts COPY source tokens (shell form), skipping flags/URLs/absolute', () => {
    const df = [
      'FROM base',
      'WORKDIR /app',
      'COPY worker/container/package.json /app/package.json',
      'COPY scripts/ingest /app/scripts/ingest',
      'COPY src/types /app/src/types',
      'COPY --from=builder /out /app/out', // build-stage, absolute → skipped
      'COPY https://example.com/x /app/x', // remote → skipped
      'RUN npm ci',
    ].join('\n');
    expect(dockerfileCopySources(df)).toEqual([
      'worker/container/package.json',
      'scripts/ingest',
      'src/types',
    ]);
  });

  it('parses the JSON exec form and skips heredocs (no garbage tokens)', () => {
    expect(dockerfileCopySources('COPY ["src/app", "pkg.json", "dest/"]')).toEqual(['src/app', 'pkg.json']);
    expect(dockerfileCopySources('COPY <<EOF /app/x\nhello\nEOF')).toEqual([]);
    expect(dockerfileCopySources('COPY [malformed')).toEqual([]);
  });
});

describe('copySourceToRoots (fs-resolved dir vs file)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-copy-'));
    mkdirSync(join(dir, 'scripts', 'ingest'), { recursive: true });
    mkdirSync(join(dir, 'src', 'types'), { recursive: true });
    mkdirSync(join(dir, 'my.config'), { recursive: true }); // a DIR with a dot
    writeFileSync(join(dir, 'Makefile'), 'all:'); // an extensionless FILE
    writeFileSync(join(dir, 'src', 'app.ts'), '');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a directory contributes itself; a file contributes its dir', () => {
    expect(copySourceToRoots(dir, '', ['scripts/ingest', 'src/app.ts'])).toEqual(['scripts/ingest', 'src']);
  });
  it('a dotted DIRECTORY (my.config) is kept, not dropped as a file', () => {
    expect(copySourceToRoots(dir, '', ['my.config'])).toEqual(['my.config']);
  });
  it('an extensionless root FILE (Makefile) is dropped, not claimed as a root', () => {
    expect(copySourceToRoots(dir, '', ['Makefile'])).toEqual([]);
  });
  it('resolves a glob to its literal dir prefix', () => {
    expect(copySourceToRoots(dir, '', ['src/*.ts'])).toEqual(['src']);
  });
  it('resolves COPY sources against the Dockerfile build context (contextDir)', () => {
    // A Dockerfile in `build/` COPYing `../scripts/ingest` → repo-relative scripts/ingest.
    expect(copySourceToRoots(dir, 'build', ['../scripts/ingest'])).toEqual(['scripts/ingest']);
  });
});

describe('dockerfilePathFor', () => {
  it('resolves the image path relative to the config dir', () => {
    expect(dockerfilePathFor('worker', '../Dockerfile')).toBe('Dockerfile');
    expect(dockerfilePathFor('', './Dockerfile')).toBe('Dockerfile');
    expect(dockerfilePathFor('svc', 'Dockerfile')).toBe('svc/Dockerfile');
  });
});

describe('buildCloudflareGraph — source roots', () => {
  const graph = buildCloudflareGraph(
    [{ tree: parseJsonc(WORKER_JSONC), file: '/repo/worker/wrangler.jsonc' }],
    '/repo',
    {
      // extract() pre-resolves the Dockerfile (at repo-relative `Dockerfile`) to roots.
      containerRoots: new Map([['Dockerfile', ['scripts/ingest', 'src/types']]]),
      viteSpa: { name: 'backthread' },
    },
  );
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('worker source root = its config dir', () => {
    expect(byId.get('worker:example-ingest-worker')?.sourceRoots).toEqual(['worker']);
  });
  it('container source roots = the pre-resolved Dockerfile build context', () => {
    expect(byId.get('container:Sandbox')?.sourceRoots).toEqual(['scripts/ingest', 'src/types']);
  });
  it('skips the inferred Vite-SPA Pages node when a Pages site is already declared', () => {
    const g = buildCloudflareGraph(
      [{ tree: parseJsonc(`{ "name": "site", "pages_build_output_dir": "dist" }`), file: '/repo/wrangler.jsonc' }],
      '/repo',
      { viteSpa: { name: 'other' } },
    );
    expect(g.nodes.filter((n) => n.kind === 'static-site').map((n) => n.id)).toEqual(['pages:site']);
  });
  it('emits an inferred Pages unit for the root Vite SPA (src/**)', () => {
    const pages = byId.get('pages:backthread');
    expect(pages?.kind).toBe('static-site');
    expect(pages?.provenance).toBe('inferred');
    expect(pages?.sourceRoots).toEqual(['src']);
  });
  it('a repo-root config yields no worker source root (not a catch-all)', () => {
    const g = buildCloudflareGraph(
      [{ tree: parseJsonc(`{ "name": "root", "main": "index.ts" }`), file: '/repo/wrangler.jsonc' }],
      '/repo',
    );
    expect(g.nodes.find((n) => n.id === 'worker:root')?.sourceRoots).toBeUndefined();
  });
});

describe('detectViteSpa', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-spa-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    writeFileSync(join(dir, 'vite.config.ts'), 'export default {}');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/backthread' }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects index.html + vite.config and uses the scope-stripped package name', () => {
    expect(detectViteSpa(dir)).toEqual({ name: 'backthread' });
  });
  it('returns null without an index.html', () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-novite-'));
    try {
      writeFileSync(join(empty, 'vite.config.ts'), '');
      expect(detectViteSpa(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
