// The Hanami adapter — action classes + router → gateway.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { hanamiAdapter, scoreHanami } from './hanami.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-hanami-'));
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
    match: { adapter: 'hanami', confidence: 0.85, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

describe('hanami', () => {
  it('scores on a hanami dep', () => {
    expect(scoreHanami({ hasHanami: true })?.adapter).toBe('hanami');
    expect(scoreHanami({ hasHanami: false })).toBeNull();
  });

  it('tags action classes + the router file as gateway', async () => {
    const roles = await hanamiAdapter.roleTags!(
      await repo({
        Gemfile: "gem 'hanami'\n",
        'config/routes.rb': 'module MyApp\n  class Routes < Hanami::Routes\n  end\nend\n',
        'app/actions/base.rb': 'module MyApp\n  class Action < Hanami::Action\n  end\nend\n',
        'app/actions/users/show.rb':
          'module MyApp\n  module Actions\n    module Users\n      class Show < MyApp::Action\n      end\n    end\n  end\nend\n',
      }),
    );
    expect(roles.get('config/routes.rb')).toMatchObject({ role: 'router', kind: 'gateway' });
    expect(roles.get('app/actions/users/show.rb')).toMatchObject({ role: 'action', kind: 'gateway' });
  });
});
