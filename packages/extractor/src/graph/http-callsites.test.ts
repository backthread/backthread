// frontend HTTP call-site extraction tests.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { collectFrontendApiCalls } from './http-callsites.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-http-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

describe('collectFrontendApiCalls', () => {
  it('finds /api URL literals (fetch, axios, and the generated-SDK __request shape)', async () => {
    const dir = await repo({
      'package.json': '{"name":"web"}',
      'src/api.ts': [
        "export const users = () => fetch('/api/users');",
        "export const items = () => axios.post('/api/items', {});",
      ].join('\n'),
      // Generated OpenAPI SDK (hey-api): the dominant real-world shape.
      'src/client/sdk.gen.ts': [
        'export function readThings() {',
        "  return __request(OpenAPI, { method: 'GET', url: '/api/v1/things/' });",
        '}',
      ].join('\n'),
    });
    const calls = collectFrontendApiCalls(dir);
    const byFile = new Map<string, string[]>();
    for (const c of calls) byFile.set(c.fileId, [...(byFile.get(c.fileId) ?? []), c.url]);
    expect(byFile.get('src/api.ts')).toEqual(expect.arrayContaining(['/api/users', '/api/items']));
    expect(byFile.get('src/client/sdk.gen.ts')).toEqual(['/api/v1/things/']);
  });

  it('captures a non-/api path only when it is an HTTP-call argument', async () => {
    const dir = await repo({
      'package.json': '{"name":"web"}',
      'src/health.ts': "export const ping = () => fetch('/health');",
    });
    const calls = collectFrontendApiCalls(dir);
    expect(calls.map((c) => c.url)).toContain('/health');
  });

  it('does NOT match client-side router paths (no HTTP-call context, not /api)', async () => {
    const dir = await repo({
      'package.json': '{"name":"web"}',
      'src/router.tsx': [
        "import { createFileRoute } from '@tanstack/react-router';",
        "export const Route = createFileRoute('/login')({});",
        "const to = '/settings';",
      ].join('\n'),
    });
    const calls = collectFrontendApiCalls(dir);
    expect(calls).toEqual([]);
  });

  it('is deterministic (sorted, stable across runs)', async () => {
    const dir = await repo({
      'package.json': '{"name":"web"}',
      'src/b.ts': "fetch('/api/b');",
      'src/a.ts': "fetch('/api/a');",
    });
    const a = collectFrontendApiCalls(dir).map((c) => `${c.fileId}:${c.url}`);
    const b = collectFrontendApiCalls(dir).map((c) => `${c.fileId}:${c.url}`);
    expect(a).toEqual(b);
    expect(a).toEqual(['src/a.ts:/api/a', 'src/b.ts:/api/b']);
  });
});
