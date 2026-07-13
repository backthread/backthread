// The GraphQL-Ruby adapter — schema/types/resolvers → gateway.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { graphqlRubyAdapter, scoreGraphqlRuby } from './graphql-ruby.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-gql-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return {
    repoDir: dir,
    rootPath: '',
    graph: { root: dir, files: Object.keys(files).filter((f) => f.endsWith('.rb')).map((id) => ({ id, loc: 1, language: 'rb' })), edges: [], externals: [] } as NormalizedGraph,
    match: { adapter: 'graphql-ruby', confidence: 0.85, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

describe('graphql-ruby', () => {
  it('scores on the graphql dep', () => {
    expect(scoreGraphqlRuby({ hasGraphql: true })?.adapter).toBe('graphql-ruby');
    expect(scoreGraphqlRuby({ hasGraphql: false })).toBeNull();
  });

  it('tags the schema, types (by dir), and resolvers as gateway', async () => {
    const roles = await graphqlRubyAdapter.roleTags!(
      await repo({
        Gemfile: "gem 'graphql'\n",
        'app/graphql/my_app_schema.rb': 'class MyAppSchema < GraphQL::Schema\nend\n',
        'app/graphql/types/base_object.rb': 'module Types\n  class BaseObject < GraphQL::Schema::Object\n  end\nend\n',
        'app/graphql/types/user_type.rb': 'module Types\n  class UserType < Types::BaseObject\n  end\nend\n',
        'app/graphql/resolvers/search.rb': 'module Resolvers\n  class Search < GraphQL::Schema::Resolver\n  end\nend\n',
      }),
    );
    expect(roles.get('app/graphql/my_app_schema.rb')).toMatchObject({ role: 'graphql-schema', kind: 'gateway' });
    expect(roles.get('app/graphql/types/user_type.rb')).toMatchObject({ role: 'graphql', kind: 'gateway' });
    expect(roles.get('app/graphql/resolvers/search.rb')).toMatchObject({ role: 'graphql', kind: 'gateway' });
  });
});
