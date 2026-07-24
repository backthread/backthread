// Go manifest reading — go.mod module path + require parsing, the module-info finder
// (root + nested), and the repo-wide dependency union.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseGoModModule, parseGoModRequires, readGoModuleInfo, readGoDeps } from './go-manifest.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-go-mf-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

const GO_MOD = [
  'module github.com/acme/app',
  '',
  'go 1.21',
  '',
  'require (',
  '\tgithub.com/gin-gonic/gin v1.9.1',
  '\tgolang.org/x/sync v0.5.0 // indirect',
  ')',
  '',
  'require github.com/spf13/cobra v1.8.0',
  '',
  'replace github.com/old/x => github.com/new/x v1.2.3',
].join('\n');

describe('parseGoModModule', () => {
  it('reads the module path', () => {
    expect(parseGoModModule(GO_MOD)).toBe('github.com/acme/app');
  });
  it('is empty when there is no module directive', () => {
    expect(parseGoModModule('go 1.21\n')).toBe('');
  });
});

describe('parseGoModRequires', () => {
  it('captures block, single, and replace-target module paths (never the module/go lines)', () => {
    const reqs = new Set(parseGoModRequires(GO_MOD));
    expect(reqs.has('github.com/gin-gonic/gin')).toBe(true);
    expect(reqs.has('golang.org/x/sync')).toBe(true);
    expect(reqs.has('github.com/spf13/cobra')).toBe(true);
    expect(reqs.has('github.com/new/x')).toBe(true); // replace target
    expect(reqs.has('github.com/acme/app')).toBe(false); // the module itself is not a require
  });
});

describe('readGoModuleInfo', () => {
  it('reads a root go.mod (moduleDir empty)', async () => {
    const dir = await repo({ 'go.mod': GO_MOD, 'main.go': 'package main\n' });
    expect(readGoModuleInfo(dir)).toEqual({ modulePath: 'github.com/acme/app', moduleDir: '' });
  });
  it('finds a single nested go.mod and reports its dir offset', async () => {
    const dir = await repo({
      'README.md': '# monorepo',
      'backend/go.mod': 'module github.com/acme/backend\n',
      'backend/main.go': 'package main\n',
    });
    expect(readGoModuleInfo(dir)).toEqual({ modulePath: 'github.com/acme/backend', moduleDir: 'backend' });
  });
});

describe('readGoDeps', () => {
  it('unions require module paths across the repo, skipping vendor', async () => {
    const dir = await repo({
      'go.mod': GO_MOD,
      'vendor/github.com/x/y/go.mod': 'module github.com/x/y\n\nrequire should.skip/pkg v1.0.0\n',
    });
    const deps = readGoDeps(dir);
    expect(deps.has('github.com/gin-gonic/gin')).toBe(true);
    expect(deps.has('github.com/spf13/cobra')).toBe(true);
    expect(deps.has('should.skip/pkg')).toBe(false); // vendor/ skipped
  });
});
