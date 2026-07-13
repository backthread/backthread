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

describe('activerecord syntheticEdges (real inflections)', () => {
  it('singularizes irregular association names to the right model (people → Person)', async () => {
    const edges = await activeRecordAdapter.syntheticEdges!(
      await repo({
        Gemfile: "gem 'rails'\n",
        'app/models/application_record.rb': 'class ApplicationRecord < ActiveRecord::Base\nend\n',
        'app/models/group.rb': 'class Group < ApplicationRecord\n  has_many :people\nend\n',
        'app/models/person.rb': 'class Person < ApplicationRecord\n  belongs_to :group\nend\n',
      }),
    );
    const pairs = edges.map((e) => `${e.source}->${e.target}`);
    // `has_many :people` → Person (irregular), not the naive `People`
    expect(pairs).toContain('app/models/group.rb->app/models/person.rb');
    expect(pairs).toContain('app/models/person.rb->app/models/group.rb');
  });
});

describe('activerecord model-detection tightening', () => {
  // A real AR model + a serializer + a form object that all reuse the association /
  // attribute DSL. Only the AR model should be detected.
  const MIXED = {
    Gemfile: "gem 'rails'\n",
    'app/models/application_record.rb': 'class ApplicationRecord < ActiveRecord::Base\nend\n',
    'app/models/account.rb': 'class Account < ApplicationRecord\n  has_many :statuses\nend\n',
    'app/models/status.rb': 'class Status < ApplicationRecord\n  belongs_to :account\nend\n',
    // AMS serializer with associations — NOT a model (name + base both say Serializer)
    'app/serializers/account_serializer.rb':
      'class AccountSerializer < ActiveModel::Serializer\n  has_many :statuses\n  has_one :account\nend\n',
    // nested serializer base whose superclass is NOT ActiveModel::Serializer
    'app/serializers/activitypub/note_serializer.rb':
      'module ActivityPub\n  class NoteSerializer < ActivityPub::Serializer\n    has_many :tags\n  end\nend\n',
    // form object (include ActiveModel::Model + a persistence-looking marker)
    'app/models/form/admin_settings.rb':
      'class Form::AdminSettings\n  include ActiveModel::Model\n  attribute :site_title\n  validates :site_title, presence: true\n  has_many :statuses\nend\n',
  };

  it('excludes serializers + form objects, keeps real AR models', async () => {
    const roles = await activeRecordAdapter.roleTags!(await repo(MIXED));
    expect(roles.get('app/models/account.rb')).toMatchObject({ role: 'model', kind: 'service' });
    expect(roles.get('app/models/status.rb')).toMatchObject({ role: 'model', kind: 'service' });
    // serializers + form object are NOT models
    expect(roles.has('app/serializers/account_serializer.rb')).toBe(false);
    expect(roles.has('app/serializers/activitypub/note_serializer.rb')).toBe(false);
    expect(roles.has('app/models/form/admin_settings.rb')).toBe(false);
  });

  it('draws no association edge FROM an excluded serializer/form', async () => {
    const edges = await activeRecordAdapter.syntheticEdges!(await repo(MIXED));
    const sources = new Set(edges.map((e) => e.source));
    expect(sources.has('app/serializers/account_serializer.rb')).toBe(false);
    expect(sources.has('app/models/form/admin_settings.rb')).toBe(false);
    // the real Account<->Status association still resolves
    const pairs = edges.map((e) => `${e.source}->${e.target}`);
    expect(pairs).toContain('app/models/account.rb->app/models/status.rb');
    expect(pairs).toContain('app/models/status.rb->app/models/account.rb');
  });

  it('skips polymorphic associations (no edge) but honors :through, HABTM, class_name', async () => {
    const edges = await activeRecordAdapter.syntheticEdges!(
      await repo({
        Gemfile: "gem 'rails'\n",
        'app/models/application_record.rb': 'class ApplicationRecord < ActiveRecord::Base\nend\n',
        'app/models/comment.rb':
          'class Comment < ApplicationRecord\n  belongs_to :commentable, polymorphic: true\n  belongs_to :author, class_name: "Account"\nend\n',
        'app/models/account.rb':
          'class Account < ApplicationRecord\n  has_many :roles, through: :account_roles\n  has_and_belongs_to_many :groups\nend\n',
        'app/models/role.rb': 'class Role < ApplicationRecord\nend\n',
        'app/models/group.rb': 'class Group < ApplicationRecord\nend\n',
      }),
    );
    const pairs = edges.map((e) => `${e.source}->${e.target}`);
    // polymorphic belongs_to :commentable → NO edge (and no `Commentable` target)
    expect(pairs.some((p) => p.includes('commentable') || p.endsWith('->Commentable'))).toBe(false);
    expect(edges.some((e) => e.metadata?.relation === 'belongs_to' && e.source === 'app/models/comment.rb'
      && e.target === 'app/models/account.rb')).toBe(true); // class_name: "Account"
    expect(pairs).toContain('app/models/account.rb->app/models/role.rb'); // :through → final model Role
    expect(pairs).toContain('app/models/account.rb->app/models/group.rb'); // HABTM
  });

  it('a bare has_many is no longer a sufficient model signal (needs a real AR signal)', async () => {
    const roles = await activeRecordAdapter.roleTags!(
      await repo({
        Gemfile: "gem 'rails'\n",
        // a PORO with only has_many + no AR base/marker is NOT a model anymore
        'app/services/aggregator.rb': 'class Aggregator\n  has_many :things\nend\n',
        // belongs_to (a persistence marker) still qualifies a based-less STI-style class
        'app/models/special.rb': 'class Special < SomethingCustom\n  belongs_to :owner\nend\n',
      }),
    );
    expect(roles.has('app/services/aggregator.rb')).toBe(false);
    expect(roles.get('app/models/special.rb')).toMatchObject({ role: 'model' });
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
