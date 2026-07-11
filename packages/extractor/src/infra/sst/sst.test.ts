// SST adapter tests.
//
// sstKind / sstSourceRoots / buildSstGraph are pure; the adapter's detect/extract
// run against a real tmp dir. Mirrors pulumi.test.ts / netlify.test.ts.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSstGraph, sstAdapter, sstKind, sstSourceRoots } from './sst.js';
import { extractSstConstructs } from './sst-parse.js';
import type { DockerfileIndex } from '../image-resolve.js';

describe('sstKind', () => {
  it('maps each construct family to its InfraModuleKind', () => {
    expect(sstKind('Function')).toBe('worker');
    expect(sstKind('Cron')).toBe('worker');
    expect(sstKind('Nextjs')).toBe('static-site');
    expect(sstKind('StaticSite')).toBe('static-site');
    expect(sstKind('Service')).toBe('container');
    expect(sstKind('Bucket')).toBe('datastore');
    expect(sstKind('Postgres')).toBe('datastore');
    expect(sstKind('Queue')).toBe('queue');
    expect(sstKind('Secret')).toBe('secret-store');
    expect(sstKind('Cdn')).toBe('cdn');
  });

  it('returns null for an unrecognized construct (→ skipped, no guess)', () => {
    expect(sstKind('Vpc')).toBeNull();
    expect(sstKind('SomethingNew')).toBeNull();
  });
});

describe('sstSourceRoots', () => {
  it('worker: a handler path → its dir', () => {
    expect(sstSourceRoots('worker', '{ handler: "packages/functions/src/api.handler" }')).toEqual([
      'packages/functions/src',
    ]);
  });

  it('static-site: a path → that dir', () => {
    expect(sstSourceRoots('static-site', '{ path: "packages/web" }')).toEqual(['packages/web']);
  });

  it('container: an image build context → that dir', () => {
    expect(sstSourceRoots('container', '{ image: { context: "packages/api" } }')).toEqual(['packages/api']);
  });

  it('container: a bare image ref → the  resolver (name-convention match)', () => {
    const index: DockerfileIndex = { dockerfiles: [{ dockerfile: 'api/Dockerfile', context: 'api' }], pairings: [] };
    expect(sstSourceRoots('container', '{ image: "myorg/api:1.2" }', index)).toEqual(['api']);
  });

  it('honest "Other": an interpolated / unresolvable signal yields no source root', () => {
    // a `${…}` template handler — the [^"\'`$] class refuses to match across it.
    expect(sstSourceRoots('worker', '{ handler: `src/${name}.handler` }')).toEqual([]);
    // an image with no matching in-repo Dockerfile → resolver returns []
    const index: DockerfileIndex = { dockerfiles: [{ dockerfile: 'web/Dockerfile', context: 'web' }], pairings: [] };
    expect(sstSourceRoots('container', '{ image: "postgres:16" }', index)).toEqual([]);
  });

  it('a worker handler at the repo root drops to no source root (never a catch-all)', () => {
    expect(sstSourceRoots('worker', '{ handler: "index.handler" }')).toEqual([]);
  });
});

describe('buildSstGraph', () => {
  const CONFIG = `
    export default $config({
      async run() {
        const uploads = new sst.aws.Bucket("Uploads");
        const queue = new sst.aws.Queue("Jobs");
        const api = new sst.aws.Function("Api", { handler: "packages/functions/src/api.handler", link: [uploads, queue] });
        new sst.aws.Nextjs("Web", { path: "packages/web" });
        new sst.aws.Vpc("Network");
      },
    });
  `;
  const graph = buildSstGraph({ constructs: extractSstConstructs(CONFIG, 'sst.config.ts'), root: '/repo' });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits the Function worker with its handler dir as source root', () => {
    const fn = byId.get('resource:sst.aws.Function.Api');
    expect(fn?.kind).toBe('worker');
    expect(fn?.provenance).toBe('declared');
    expect(fn?.sourceRoots).toEqual(['packages/functions/src']);
  });

  it('emits the static site with its path as source root + the datastore/queue (no source roots)', () => {
    expect(byId.get('resource:sst.aws.Nextjs.Web')?.sourceRoots).toEqual(['packages/web']);
    expect(byId.get('resource:sst.aws.Bucket.Uploads')?.kind).toBe('datastore');
    expect(byId.get('resource:sst.aws.Bucket.Uploads')?.sourceRoots).toBeUndefined();
    expect(byId.get('resource:sst.aws.Queue.Jobs')?.kind).toBe('queue');
  });

  it('skips an unrecognized construct (Vpc) — no node, no guessed kind', () => {
    expect([...byId.keys()].some((id) => id.includes('Vpc'))).toBe(false);
  });

  it('emits link edges with the verb keyed by target kind', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'resource:sst.aws.Function.Api', target: 'resource:sst.aws.Bucket.Uploads', kind: 'stores-in' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'resource:sst.aws.Function.Api', target: 'resource:sst.aws.Queue.Jobs', kind: 'publishes' }),
    );
  });

  it('no classifications needed (no LLM)', () => {
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

describe('sstAdapter detect + extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-sst-'));
    mkdirSync(join(dir, 'api'), { recursive: true });
    // an in-repo Dockerfile so the Service's image ref resolves by name-convention
    writeFileSync(join(dir, 'api', 'Dockerfile'), 'FROM node:20\n');
    writeFileSync(
      join(dir, 'sst.config.ts'),
      `export default $config({
        async run() {
          const bucket = new sst.aws.Bucket("Uploads");
          new sst.aws.Function("Api", { handler: "src/api.handler", link: [bucket] });
          new sst.aws.Service("Svc", { image: "myorg/api:1" });
          new sst.aws.Function("Dynamic", { handler: dynamicHandler });
        },
      });`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects sst.config.ts', async () => {
    expect(await sstAdapter.detect(dir)).toBe(true);
  });

  it('extracts constructs with handler/image source roots + honest Other for the interpolated handler', async () => {
    const graph = await sstAdapter.extract(dir);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('resource:sst.aws.Function.Api')?.sourceRoots).toEqual(['src']);
    // image "myorg/api:1" resolves to the in-repo api/ Dockerfile context
    expect(byId.get('resource:sst.aws.Service.Svc')?.sourceRoots).toEqual(['api']);
    // a non-literal (variable-reference) handler is unresolvable → the node is still
    // emitted, but with NO source root (honest "Other") — assert presence so this
    // can't pass vacuously if extraction ever stops emitting the construct.
    expect(byId.has('resource:sst.aws.Function.Dynamic')).toBe(true);
    expect(byId.get('resource:sst.aws.Function.Dynamic')?.sourceRoots).toBeUndefined();
  });

  it('does not detect a repo with no sst.config', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-sst-empty-'));
    try {
      writeFileSync(join(empty, 'package.json'), '{}');
      expect(await sstAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('does not declare scansSourcePath (config-only adapter)', () => {
    expect(sstAdapter.scansSourcePath).toBeUndefined();
  });
});
