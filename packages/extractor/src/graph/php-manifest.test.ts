// Composer dependency-manifest reading.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readComposerDeps, readComposerJson } from './php-manifest.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-php-manifest-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content);
  return dir;
}

describe('readComposerDeps', () => {
  it('reads require + require-dev keys, dropping platform packages', async () => {
    const dir = await repo({
      'composer.json': JSON.stringify({
        require: { php: '^8.2', 'ext-json': '*', 'laravel/framework': '^11.0' },
        'require-dev': { 'phpunit/phpunit': '^11.0' },
      }),
    });
    const deps = readComposerDeps(dir);
    expect(deps.has('laravel/framework')).toBe(true);
    expect(deps.has('phpunit/phpunit')).toBe(true);
    expect(deps.has('php')).toBe(false); // platform — dropped
    expect(deps.has('ext-json')).toBe(false); // platform — dropped
  });

  it('unions composer.lock package names', async () => {
    const dir = await repo({
      'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
      'composer.lock': JSON.stringify({
        packages: [{ name: 'symfony/console' }, { name: 'doctrine/orm' }],
        'packages-dev': [{ name: 'mockery/mockery' }],
      }),
    });
    const deps = readComposerDeps(dir);
    expect(deps.has('laravel/framework')).toBe(true);
    expect(deps.has('symfony/console')).toBe(true);
    expect(deps.has('doctrine/orm')).toBe(true);
    expect(deps.has('mockery/mockery')).toBe(true);
  });

  it('lowercases + never throws on a malformed manifest', async () => {
    const dir = await repo({ 'composer.json': '{ this is not json' });
    expect(readComposerDeps(dir).size).toBe(0);
    const dir2 = await repo({ 'composer.json': JSON.stringify({ require: { 'Foo/Bar': '*' } }) });
    expect(readComposerDeps(dir2).has('foo/bar')).toBe(true);
  });
});

describe('readComposerJson', () => {
  it('returns the parsed object, or {} when absent/malformed', async () => {
    const dir = await repo({
      'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }),
    });
    const c = readComposerJson(dir) as { autoload: { 'psr-4': Record<string, string> } };
    expect(c.autoload['psr-4']['App\\']).toBe('app/');
    const empty = await repo({});
    expect(readComposerJson(empty)).toEqual({});
  });
});
