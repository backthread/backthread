// Ruby dependency-manifest reading.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRubyDeps, parseLockDependencies } from './ruby-manifest.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-rbman-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content);
  return dir;
}

describe('parseLockDependencies', () => {
  it('reads the DEPENDENCIES section, stripping constraints and ! suffixes', () => {
    const lock =
      'GEM\n  specs:\n    rails (7.0.0)\n    pg (1.5.0)\n\nDEPENDENCIES\n  pg\n  rails (~> 7.0)\n  sidekiq!\n\nBUNDLED WITH\n   2.4.0\n';
    expect(parseLockDependencies(lock).sort()).toEqual(['pg', 'rails', 'sidekiq']);
  });
});

describe('readRubyDeps', () => {
  it('reads gem lines from a Gemfile, including group blocks', async () => {
    const dir = await repo({
      Gemfile:
        "source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\ngem \"sidekiq\"\n\ngroup :test do\n  gem 'rspec-rails'\nend\n",
    });
    const deps = readRubyDeps(dir);
    expect(deps.has('rails')).toBe(true);
    expect(deps.has('sidekiq')).toBe(true);
    expect(deps.has('rspec-rails')).toBe(true);
  });

  it('reads add_dependency variants from a gemspec', async () => {
    const dir = await repo({
      'my_gem.gemspec':
        "Gem::Specification.new do |spec|\n  spec.add_dependency 'activesupport'\n  spec.add_development_dependency \"rspec\"\nend\n",
    });
    const deps = readRubyDeps(dir);
    expect(deps.has('activesupport')).toBe(true);
    expect(deps.has('rspec')).toBe(true);
  });

  it('unions Gemfile + Gemfile.lock, lowercases, and is empty for a non-Ruby dir', async () => {
    const dir = await repo({
      Gemfile: "gem 'Rails'\n",
      'Gemfile.lock': 'DEPENDENCIES\n  graphql\n  pg\n',
    });
    const deps = readRubyDeps(dir);
    expect(deps.has('rails')).toBe(true); // lowercased
    expect(deps.has('graphql')).toBe(true); // from the lockfile
    expect(deps.has('pg')).toBe(true);
    expect(readRubyDeps(await repo({ 'README.md': '# hi' })).size).toBe(0);
  });
});
