// Shared Ruby framework-analysis layer — const resolution + no-re-parse scope.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseRubyScope, buildConstantBindings } from './analyze.js';
import { callName, positionalArgs, symbolValue, keywordArg, stringValue } from './ruby-ast.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function rubyRepo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-rbscope-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const graph: NormalizedGraph = {
    root: dir,
    files: Object.keys(files)
      .filter((f) => f.endsWith('.rb'))
      .map((id) => ({ id, loc: 1, language: 'rb' })),
    edges: [],
    externals: [],
  };
  return {
    repoDir: dir,
    rootPath: '',
    graph,
    match: { adapter: 'test', confidence: 1, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

describe('buildConstantBindings', () => {
  it('indexes files by their Zeitwerk constant', () => {
    const { index } = buildConstantBindings([
      'app/models/user.rb',
      'app/models/account.rb',
      'app/controllers/admin/users_controller.rb',
    ]);
    expect(index.get('User')).toBe('app/models/user.rb');
    expect(index.get('Account')).toBe('app/models/account.rb');
    expect(index.get('Admin::UsersController')).toBe('app/controllers/admin/users_controller.rb');
  });
});

describe('parseRubyScope', () => {
  it('parses in-scope files once, exposing classes/calls + a nesting-aware resolver', async () => {
    const ctx = await rubyRepo({
      'app/models/account.rb': 'class Account < ApplicationRecord\nend\n',
      'app/models/user.rb':
        'class User < ApplicationRecord\n  belongs_to :account, class_name: "Account"\n  has_many :posts\nend\n',
      'app/controllers/users_controller.rb': 'class UsersController < ApplicationController\nend\n',
    });
    const scope = await parseRubyScope(ctx);

    // every rb file parsed exactly once (adapters consume this without re-parsing)
    expect(scope.parsed.size).toBe(3);

    // classes collected with superclass + top-level DSL calls
    const user = scope.parsed.get('app/models/user.rb')!.classes.find((c) => c.name === 'User')!;
    expect(user.superclass).toBe('ApplicationRecord');
    const dsl = user.bodyCalls.map((c) => callName(c));
    expect(dsl).toContain('belongs_to');
    expect(dsl).toContain('has_many');

    // ruby-ast accessors on a DSL call
    const belongsTo = user.bodyCalls.find((c) => callName(c) === 'belongs_to')!;
    expect(symbolValue(positionalArgs(belongsTo)[0])).toBe('account');
    expect(stringValue(keywordArg(belongsTo, 'class_name'))).toBe('Account');

    // the shared Zeitwerk resolver
    expect(scope.resolve('Account')).toBe('app/models/account.rb');
    expect(scope.resolve('UsersController')).toBe('app/controllers/users_controller.rb');
    expect(scope.resolve('Nope')).toBeUndefined();
  });

  it('scopes parsing to rootPath (engine partition)', async () => {
    const ctx = await rubyRepo({
      'engine/app/models/thing.rb': 'class Thing\nend\n',
      'app/models/user.rb': 'class User\nend\n',
    });
    const scoped = await parseRubyScope({ ...ctx, rootPath: 'engine' });
    expect([...scoped.parsed.keys()]).toEqual(['engine/app/models/thing.rb']);
  });
});
