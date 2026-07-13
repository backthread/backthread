// The Sidekiq + ActiveJob adapter — job roles + enqueue edges.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sidekiqAdapter, scoreSidekiq } from './sidekiq.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-sk-'));
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
    match: { adapter: 'sidekiq', confidence: 0.85, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

const JOBS = {
  Gemfile: "gem 'rails'\ngem 'sidekiq'\n",
  'app/jobs/application_job.rb': 'class ApplicationJob < ActiveJob::Base\nend\n',
  'app/jobs/email_job.rb': 'class EmailJob < ApplicationJob\n  def perform(id); end\nend\n',
  'app/workers/hard_worker.rb': 'class HardWorker\n  include Sidekiq::Job\n  def perform; end\nend\n',
  'app/controllers/posts_controller.rb':
    'class PostsController\n  def create\n    EmailJob.perform_later(1)\n    HardWorker.perform_async(2)\n  end\nend\n',
  'app/models/user.rb': 'class User\n  def notify\n    EmailJob.set(wait: 5).perform_later(id)\n  end\nend\n',
};

describe('sidekiq detect', () => {
  it('scores sidekiq high, activejob (rails-only) lower, else null', () => {
    expect(scoreSidekiq({ hasSidekiq: true, hasActiveJob: true })?.metadata?.variant).toBe('sidekiq');
    expect(scoreSidekiq({ hasSidekiq: false, hasActiveJob: true })?.metadata?.variant).toBe('activejob');
    expect(scoreSidekiq({ hasSidekiq: false, hasActiveJob: false })).toBeNull();
  });
});

describe('sidekiq roleTags', () => {
  it('tags ActiveJob + Sidekiq job classes as job/job', async () => {
    const roles = await sidekiqAdapter.roleTags!(await repo(JOBS));
    expect(roles.get('app/jobs/email_job.rb')).toMatchObject({ role: 'job', kind: 'job' });
    expect(roles.get('app/workers/hard_worker.rb')).toMatchObject({ role: 'job', kind: 'job' });
    expect(roles.has('app/controllers/posts_controller.rb')).toBe(false);
  });
});

describe('sidekiq syntheticEdges (enqueue)', () => {
  it('draws enqueue edges from the caller to the job, incl. the set(...) chain', async () => {
    const edges = await sidekiqAdapter.syntheticEdges!(await repo(JOBS));
    const pairs = edges.map((e) => `${e.source}->${e.target}`);
    expect(pairs).toContain('app/controllers/posts_controller.rb->app/jobs/email_job.rb'); // perform_later
    expect(pairs).toContain('app/controllers/posts_controller.rb->app/workers/hard_worker.rb'); // perform_async
    expect(pairs).toContain('app/models/user.rb->app/jobs/email_job.rb'); // set(...).perform_later chain
    expect(edges.every((e) => e.kind === 'calls' && e.metadata?.relation === 'enqueue')).toBe(true);
  });
});
