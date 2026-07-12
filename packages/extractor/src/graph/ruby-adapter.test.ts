// Ruby structural extractor — the Prism-driven import backbone.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { RubyExtractor } from './ruby-adapter.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-ruby-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

const internalEdges = (g: { edges: Array<{ from: string; to: string; external: boolean }> }): string[] =>
  g.edges.filter((e) => !e.external).map((e) => `${e.from}->${e.to}`);

describe('RubyExtractor', () => {
  it('builds Zeitwerk import edges from constant references (superclass + body refs)', async () => {
    const dir = await repo({
      Gemfile: "gem 'rails'\n",
      'app/models/application_record.rb': 'class ApplicationRecord\nend\n',
      'app/models/user.rb': 'class User < ApplicationRecord\nend\n',
      'app/controllers/application_controller.rb': 'class ApplicationController\nend\n',
      'app/controllers/users_controller.rb':
        'class UsersController < ApplicationController\n  def index\n    @users = User.all\n  end\nend\n',
    });
    const graph = await new RubyExtractor().extract(dir);
    const edges = internalEdges(graph);
    // superclass edge + autoloaded-constant reference edge
    expect(edges).toContain(
      'app/controllers/users_controller.rb->app/controllers/application_controller.rb',
    );
    expect(edges).toContain('app/controllers/users_controller.rb->app/models/user.rb');
    expect(edges).toContain('app/models/user.rb->app/models/application_record.rb');
  });

  it('resolves require_relative to first-party edges and require to gem externals', async () => {
    const dir = await repo({
      'my_gem.gemspec': 'Gem::Specification.new\n',
      'lib/my_gem.rb':
        "require_relative 'my_gem/version'\nrequire 'json'\nrequire 'sidekiq'\nmodule MyGem\nend\n",
      'lib/my_gem/version.rb': "module MyGem\n  VERSION = '1.0'\nend\n",
    });
    const graph = await new RubyExtractor().extract(dir);
    expect(internalEdges(graph)).toContain('lib/my_gem.rb->lib/my_gem/version.rb'); // require_relative
    const exts = graph.externals.map((x) => x.id);
    expect(exts).toContain('ext:sidekiq'); // third-party gem
    expect(exts).not.toContain('ext:json'); // stdlib dropped
    expect(graph.files.map((f) => f.id)).not.toContain('Gemfile'); // manifest, not a node
  });

  it('emits deterministic sorted nodes (rb + real loc); import edges only, no call edges', async () => {
    const dir = await repo({
      'app/models/user.rb': 'class User\n  def name\n  end\nend\n',
      'app/models/post.rb': 'class Post\nend\n',
    });
    const graph = await new RubyExtractor().extract(dir);
    expect(graph.files.map((f) => f.id)).toEqual(['app/models/post.rb', 'app/models/user.rb']);
    expect(graph.files.every((f) => f.language === 'rb')).toBe(true);
    expect(graph.files.find((f) => f.id === 'app/models/user.rb')?.loc).toBe(5);
    expect(graph.edges.every((e) => e.kind === 'import')).toBe(true); // v1: no call edges
  });

  it('returns an empty graph for a repo with no Ruby files', async () => {
    const dir = await repo({ 'README.md': '# hi\n' });
    const graph = await new RubyExtractor().extract(dir);
    expect(graph.files).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});
