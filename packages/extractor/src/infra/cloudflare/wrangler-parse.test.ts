// wrangler config parser tests.
//
// Pure parser → no Supabase/Anthropic import chain, collects clean under
// vitest. Covers both the JSONC path (the dogfood worker config) and the TOML
// subset (the historical-but-common format).

import { describe, it, expect } from '../../testkit.js';
import { parseJsonc, parseTomlSubset, parseWranglerConfig } from './wrangler-parse.js';

describe('parseJsonc', () => {
  it('strips line + block comments and trailing commas', () => {
    const tree = parseJsonc(`{
      // the worker
      "name": "example-ingest-worker",
      /* block */ "main": "src/index.ts",
      "vars": { "A": "1", },
    }`);
    expect(tree.name).toBe('example-ingest-worker');
    expect(tree.main).toBe('src/index.ts');
    expect(tree.vars).toEqual({ A: '1' });
  });

  it('does not strip comment-like sequences inside strings', () => {
    const tree = parseJsonc(`{ "url": "https://x.co//path", "note": "a /* b */ c" }`);
    expect(tree.url).toBe('https://x.co//path');
    expect(tree.note).toBe('a /* b */ c');
  });

  it('does not mangle a `,}` / `,]` byte sequence inside a string value', () => {
    // PR #9 review: the old global trailing-comma regex deleted the comma here.
    const tree = parseJsonc(`{ "a": "x,}", "b": "y,]", "c": "ok" }`);
    expect(tree.a).toBe('x,}');
    expect(tree.b).toBe('y,]');
    expect(tree.c).toBe('ok');
  });

  it('still removes genuine trailing commas (object + array)', () => {
    const tree = parseJsonc(`{ "list": [1, 2, 3,], "obj": { "k": 1, }, }`);
    expect(tree.list).toEqual([1, 2, 3]);
    expect(tree.obj).toEqual({ k: 1 });
  });

  it('parses nested arrays-of-objects (queue consumers)', () => {
    const tree = parseJsonc(`{
      "queues": { "consumers": [{ "queue": "example-ingest", "max_retries": 3 }] }
    }`);
    expect((tree.queues as { consumers: Array<Record<string, unknown>> }).consumers[0].queue).toBe('example-ingest');
  });
});

describe('parseTomlSubset', () => {
  it('parses scalars, tables, and nested tables', () => {
    const tree = parseTomlSubset(`
      name = "my-worker"   # trailing comment
      compatibility_date = "2026-05-01"
      [vars]
      GITHUB_APP_ID = "3887595"
      ENABLED = true
      RETRIES = 3
    `);
    expect(tree.name).toBe('my-worker');
    expect((tree.vars as Record<string, unknown>).GITHUB_APP_ID).toBe('3887595');
    expect((tree.vars as Record<string, unknown>).ENABLED).toBe(true);
    expect((tree.vars as Record<string, unknown>).RETRIES).toBe(3);
  });

  it('parses array-of-tables ([[queues.producers]])', () => {
    const tree = parseTomlSubset(`
      name = "w"
      [[queues.producers]]
      binding = "INGEST_QUEUE"
      queue = "example-ingest"
      [[queues.consumers]]
      queue = "example-ingest"
      max_retries = 3
    `);
    const q = tree.queues as { producers: Array<Record<string, unknown>>; consumers: Array<Record<string, unknown>> };
    expect(q.producers[0]).toEqual({ binding: 'INGEST_QUEUE', queue: 'example-ingest' });
    expect(q.consumers[0]).toEqual({ queue: 'example-ingest', max_retries: 3 });
  });

  it('parses inline arrays and inline tables', () => {
    const tree = parseTomlSubset(`
      compatibility_flags = ["nodejs_compat", "x"]
      [[kv_namespaces]]
      binding = "CLEW_KV"
      [[d1_databases]]
      binding = "DB"
      database_name = "prod"
    `);
    expect(tree.compatibility_flags).toEqual(['nodejs_compat', 'x']);
    expect((tree.kv_namespaces as Array<Record<string, unknown>>)[0].binding).toBe('CLEW_KV');
    expect((tree.d1_databases as Array<Record<string, unknown>>)[0].database_name).toBe('prod');
  });

  it('ignores `#` inside quoted strings', () => {
    const tree = parseTomlSubset(`url = "https://x.co/#frag"`);
    expect(tree.url).toBe('https://x.co/#frag');
  });
});

describe('parseWranglerConfig', () => {
  it('dispatches .toml to the TOML parser', () => {
    expect(parseWranglerConfig(`name = "t"`, 'wrangler.toml').name).toBe('t');
  });
  it('dispatches .jsonc to the JSONC parser', () => {
    expect(parseWranglerConfig(`{ "name": "j" }`, 'wrangler.jsonc').name).toBe('j');
  });
});
