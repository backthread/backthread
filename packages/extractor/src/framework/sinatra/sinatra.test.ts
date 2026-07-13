// The Sinatra adapter — app files (classic + modular) → gateway.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sinatraAdapter, scoreSinatra } from './sinatra.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-sinatra-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return {
    repoDir: dir,
    rootPath: '',
    graph: {
      root: dir,
      files: Object.keys(files).filter((f) => f.endsWith('.rb')).map((id) => ({ id, loc: 1, language: 'rb' })),
      edges: [],
      externals: [],
    } as NormalizedGraph,
    match: { adapter: 'sinatra', confidence: 0.85, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

describe('sinatra', () => {
  it('scores on the sinatra dep', () => {
    expect(scoreSinatra({ hasSinatra: true })?.adapter).toBe('sinatra');
    expect(scoreSinatra({ hasSinatra: false })).toBeNull();
  });

  it('tags classic + modular Sinatra app files as gateway, leaving non-routes alone', async () => {
    const roles = await sinatraAdapter.roleTags!(
      await repo({
        Gemfile: "gem 'sinatra'\n",
        'app.rb': "require 'sinatra'\nget '/' do\n  'hi'\nend\npost '/users' do\nend\n", // classic
        'lib/api.rb': "class Api < Sinatra::Base\n  get '/health' do\n  end\nend\n", // modular
        'lib/util.rb': 'class Util\n  def get(x); x; end\nend\n', // a get METHOD, not a route
      }),
    );
    expect(roles.get('app.rb')).toMatchObject({ role: 'sinatra-app', kind: 'gateway' });
    expect(roles.get('lib/api.rb')).toMatchObject({ role: 'sinatra-app', kind: 'gateway' });
    expect(roles.has('lib/util.rb')).toBe(false);
  });
});
