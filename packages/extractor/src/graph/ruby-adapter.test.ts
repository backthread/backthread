// Ruby structural extractor — the node backbone (import edges land next).

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

describe('RubyExtractor', () => {
  it('emits one node per first-party Ruby file, real loc, no edges yet (backbone TBD)', async () => {
    const dir = await repo({
      'app/models/user.rb': 'class User\n  def name\n  end\nend\n',
      'app/controllers/users_controller.rb': 'class UsersController\nend\n',
      'lib/tasks/db.rake': 'task :migrate do\nend\n',
      Rakefile: "require 'rake'\n",
      Gemfile: "gem 'rails'\n", // manifest — not a node
      'vendor/bundle/gems/x/lib/x.rb': 'module X; end\n', // vendored — excluded
    });
    const graph = await new RubyExtractor().extract(dir);

    // sorted, deterministic; manifests + vendored deps excluded
    expect(graph.files.map((f) => f.id)).toEqual([
      'Rakefile',
      'app/controllers/users_controller.rb',
      'app/models/user.rb',
      'lib/tasks/db.rake',
    ]);
    expect(graph.files.every((f) => f.language === 'rb')).toBe(true);
    expect(graph.files.find((f) => f.id === 'app/models/user.rb')?.loc).toBe(5);
    // Seam only — no import/call edges or externals yet.
    expect(graph.edges).toEqual([]);
    expect(graph.externals).toEqual([]);
  });

  it('returns an empty graph for a repo with no Ruby files', async () => {
    const dir = await repo({ 'README.md': '# hi\n' });
    const graph = await new RubyExtractor().extract(dir);
    expect(graph.files).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});
