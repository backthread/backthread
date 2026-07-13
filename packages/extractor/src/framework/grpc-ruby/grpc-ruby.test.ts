// The gRPC-Ruby adapter — servicers → gateway (and NOT plain service objects).

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { grpcRubyAdapter, scoreGrpcRuby } from './grpc-ruby.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-grpc-'));
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
    match: { adapter: 'grpc-ruby', confidence: 0.85, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

describe('grpc-ruby', () => {
  it('scores on the grpc dep', () => {
    expect(scoreGrpcRuby({ hasGrpc: true })?.adapter).toBe('grpc-ruby');
    expect(scoreGrpcRuby({ hasGrpc: false })).toBeNull();
  });

  it('tags servicers (generated base + GenericService include) but NOT plain service objects', async () => {
    const roles = await grpcRubyAdapter.roleTags!(
      await repo({
        Gemfile: "gem 'grpc'\n",
        'lib/greeter_server.rb': 'class GreeterServer < Helloworld::Greeter::Service\n  def say_hello(req, _call); end\nend\n',
        'lib/health_check.rb': 'class HealthCheck\n  include GRPC::GenericService\nend\n',
        'app/services/payment_service.rb': 'class PaymentService < ApplicationService\nend\n', // a plain service object
      }),
    );
    expect(roles.get('lib/greeter_server.rb')).toMatchObject({ role: 'servicer', kind: 'gateway' });
    expect(roles.get('lib/health_check.rb')).toMatchObject({ role: 'servicer', kind: 'gateway' });
    expect(roles.has('app/services/payment_service.rb')).toBe(false); // ApplicationService is not a servicer
  });
});
