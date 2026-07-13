// The Rails adapter — detection, role tags, and the route spine.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { railsAdapter, gatherRailsSignals, scoreRails } from './rails.js';
import type { FrameworkContext, FrameworkDetectContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function railsRepo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-rails-'));
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
    match: { adapter: 'rails', confidence: 0.9, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

describe('rails detect', () => {
  it('scores rails on a rails/railties dep, null otherwise', () => {
    expect(scoreRails({ hasRails: true })?.adapter).toBe('rails');
    expect(scoreRails({ hasRails: false })).toBeNull();
  });
  it('detects via the Gemfile', async () => {
    const ctx = await railsRepo({ Gemfile: "gem 'rails', '~> 7.1'\n", 'app/models/user.rb': 'class User; end\n' });
    const m = await railsAdapter.detect({ repoDir: ctx.repoDir } as FrameworkDetectContext);
    expect(m?.adapter).toBe('rails');
  });
  it('does not detect sinatra-only repos', async () => {
    expect(gatherRailsSignals(await mkdtemp(join(tmpdir(), 'x-'))).hasRails).toBe(false);
  });
});

describe('rails roleTags', () => {
  it('maps Rails class conventions onto the locked module kinds', async () => {
    const ctx = await railsRepo({
      Gemfile: "gem 'rails'\n",
      'app/controllers/application_controller.rb': 'class ApplicationController < ActionController::Base\nend\n',
      'app/controllers/posts_controller.rb': 'class PostsController < ApplicationController\nend\n',
      'app/mailers/user_mailer.rb': 'class UserMailer < ApplicationMailer\nend\n',
      'app/channels/chat_channel.rb': 'class ChatChannel < ApplicationCable::Channel\nend\n',
      'app/channels/application_cable/connection.rb':
        'module ApplicationCable\n  class Connection < ActionCable::Connection::Base\n  end\nend\n',
      'app/components/button_component.rb': 'class ButtonComponent < ViewComponent::Base\nend\n',
      'app/helpers/posts_helper.rb': 'module PostsHelper\nend\n',
    });
    const roles = await railsAdapter.roleTags!(ctx);
    const roleOf = (f: string) => roles.get(f);
    expect(roleOf('app/controllers/posts_controller.rb')).toMatchObject({ role: 'controller', kind: 'gateway' });
    expect(roleOf('app/mailers/user_mailer.rb')).toMatchObject({ role: 'mailer', kind: 'job' });
    expect(roleOf('app/channels/chat_channel.rb')).toMatchObject({ role: 'channel', kind: 'gateway' });
    expect(roleOf('app/channels/application_cable/connection.rb')).toMatchObject({
      role: 'cable-connection',
      kind: 'gateway',
    });
    expect(roleOf('app/components/button_component.rb')).toMatchObject({ role: 'view-component', kind: 'frontend' });
    expect(roleOf('app/helpers/posts_helper.rb')).toMatchObject({ role: 'helper', kind: 'frontend' });
  });
});

describe('rails syntheticEdges (route spine)', () => {
  it('draws config/routes.rb -> controller edges, namespace-aware', async () => {
    const ctx = await railsRepo({
      Gemfile: "gem 'rails'\n",
      'app/controllers/application_controller.rb': 'class ApplicationController\nend\n',
      'app/controllers/posts_controller.rb': 'class PostsController < ApplicationController\nend\n',
      'app/controllers/admin/users_controller.rb':
        'module Admin\n  class UsersController < ApplicationController\n  end\nend\n',
      'config/routes.rb':
        "Rails.application.routes.draw do\n  resources :posts\n  namespace :admin do\n    resources :users\n  end\n  root 'posts#index'\n  get '/health', to: 'posts#health'\nend\n",
    });
    const edges = await railsAdapter.syntheticEdges!(ctx);
    const pairs = edges.map((e) => `${e.source}->${e.target}`);
    expect(pairs).toContain('config/routes.rb->app/controllers/posts_controller.rb');
    expect(pairs).toContain('config/routes.rb->app/controllers/admin/users_controller.rb');
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
  });
});
