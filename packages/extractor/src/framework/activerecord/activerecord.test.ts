// The ActiveRecord adapter — model roles, association edges, data-model grouping.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { activeRecordAdapter, scoreActiveRecord } from './activerecord.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-ar-'));
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
    match: { adapter: 'activerecord', confidence: 0.85, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

const MODELS = {
  Gemfile: "gem 'rails'\n",
  'app/models/application_record.rb': 'class ApplicationRecord < ActiveRecord::Base\nend\n',
  'app/models/author.rb': 'class Author < ApplicationRecord\n  has_many :posts\nend\n',
  'app/models/post.rb': 'class Post < ApplicationRecord\n  belongs_to :author\n  has_many :comments\nend\n',
  'app/models/comment.rb':
    'class Comment < ApplicationRecord\n  belongs_to :post\n  belongs_to :writer, class_name: "Author"\nend\n',
  'app/models/poro.rb': 'class Poro\n  def call; end\nend\n', // not an AR model
};

describe('activerecord detect', () => {
  it('scores on a rails/activerecord dep', () => {
    expect(scoreActiveRecord({ hasActiveRecord: true })?.adapter).toBe('activerecord');
    expect(scoreActiveRecord({ hasActiveRecord: false })).toBeNull();
  });
});

describe('activerecord roleTags', () => {
  it('tags AR models as service/model and leaves POROs alone', async () => {
    const roles = await activeRecordAdapter.roleTags!(await repo(MODELS));
    expect(roles.get('app/models/author.rb')).toMatchObject({ role: 'model', kind: 'service' });
    expect(roles.get('app/models/post.rb')).toMatchObject({ role: 'model', kind: 'service' });
    expect(roles.get('app/models/comment.rb')).toMatchObject({ role: 'model', kind: 'service' });
    expect(roles.has('app/models/poro.rb')).toBe(false);
  });
});

describe('activerecord syntheticEdges (associations)', () => {
  it('draws association edges between model modules, honoring singularize + class_name', async () => {
    const edges = await activeRecordAdapter.syntheticEdges!(await repo(MODELS));
    const pairs = edges.map((e) => `${e.source}->${e.target}`);
    expect(pairs).toContain('app/models/author.rb->app/models/post.rb'); // has_many :posts -> Post
    expect(pairs).toContain('app/models/post.rb->app/models/author.rb'); // belongs_to :author
    expect(pairs).toContain('app/models/post.rb->app/models/comment.rb'); // has_many :comments -> Comment
    expect(pairs).toContain('app/models/comment.rb->app/models/author.rb'); // belongs_to :writer, class_name: "Author"
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
  });
});

describe('activerecord groupingPrior', () => {
  it('groups the models dir into a Data Model subsystem', async () => {
    const prior = await activeRecordAdapter.groupingPrior!(await repo(MODELS));
    const dataModel = prior.groups.find((g) => g.label === 'Data Model');
    expect(dataModel).toBeTruthy();
    expect(dataModel!.fileIds).toContain('app/models/post.rb');
  });
});
