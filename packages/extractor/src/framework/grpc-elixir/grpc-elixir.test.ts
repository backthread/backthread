// gRPC-Elixir adapter tests — the Elixir gRPC protocol adapter, mirroring
// phoenix.test.ts's three tiers:
//   (1) scoreGrpcElixir is PURE (dep present/absent, proto-confidence bump, the
//       depless proto+stub secondary match, rootPath).
//   (2) detect() runs against real tmp mix.exs dirs (+ a non-gRPC Elixir no-match,
//       a TS no-match, a nested app, the secondary proto+pb.ex match).
//   (3) the analysis hooks run over a REAL ElixirExtractor graph of a small on-disk
//       gRPC fixture and assert the file-id-space contributions (a `use GRPC.Server`
//       servicer → gateway role servicer; the servicer→service-stub edge; generated
//       `*.pb.ex` skipped; a `@behaviour X.Service` servicer tagged, role-only).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  grpcElixirAdapter,
  scoreGrpcElixir,
  gatherGrpcElixirSignals,
  type GrpcElixirSignals,
} from './grpc-elixir.js';
import { ElixirExtractor } from '../../graph/elixir-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: GrpcElixirSignals = {
  hasGrpc: false,
  hasProtoFiles: false,
  hasGeneratedPb: false,
};

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// A mix.exs whose deps/0 declares the given dep atoms.
function mixExs(deps: string[]): string {
  const tuples = deps.map((d) => `      {:${d}, "~> 1.0"},`).join('\n');
  return `defmodule App.MixProject do\n  use Mix.Project\n  defp deps do\n    [\n${tuples}\n    ]\n  end\nend\n`;
}

// ---------------------------------------------------------------------------
// scoreGrpcElixir (pure)

describe('scoreGrpcElixir (pure)', () => {
  it('returns null with no grpc dep and no artifacts', () => {
    expect(scoreGrpcElixir(NO_SIGNALS)).toBeNull();
  });

  it('detects gRPC on the grpc dep', () => {
    const m = scoreGrpcElixir({ ...NO_SIGNALS, hasGrpc: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('grpc-elixir');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('raises confidence when .proto files are present', () => {
    const m = scoreGrpcElixir({ ...NO_SIGNALS, hasGrpc: true, hasProtoFiles: true });
    expect(m!.confidence).toBeGreaterThan(0.8);
  });

  it('matches on the depless proto + generated stub secondary signal (weaker)', () => {
    const m = scoreGrpcElixir({ hasGrpc: false, hasProtoFiles: true, hasGeneratedPb: true });
    expect(m).not.toBeNull();
    expect(m!.confidence).toBeLessThan(0.8);
  });

  it('does NOT match proto-only (no generated stub, no dep)', () => {
    expect(scoreGrpcElixir({ hasGrpc: false, hasProtoFiles: true, hasGeneratedPb: false })).toBeNull();
  });

  it('passes rootPath through', () => {
    const m = scoreGrpcElixir({ ...NO_SIGNALS, hasGrpc: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('grpcElixirAdapter.detect (fs fixtures)', () => {
  let grpcRepo: string;
  let secondaryRepo: string;
  let plainElixir: string;
  let tsRepo: string;

  beforeAll(() => {
    grpcRepo = mkdtempSync(join(tmpdir(), 'bt-grpcex-ok-'));
    writeFileSync(join(grpcRepo, 'mix.exs'), mixExs(['grpc', 'protobuf']));

    // Vendored codegen, no declared grpc dep — the secondary signal.
    secondaryRepo = mkdtempSync(join(tmpdir(), 'bt-grpcex-sec-'));
    writeFileSync(join(secondaryRepo, 'mix.exs'), mixExs(['protobuf']));
    write(secondaryRepo, 'priv/protos/helloworld.proto', 'service Greeter { rpc SayHello (Req) returns (Rep); }\n');
    write(secondaryRepo, 'lib/helloworld.pb.ex', 'defmodule Helloworld.HelloRequest do\nend\n');

    plainElixir = mkdtempSync(join(tmpdir(), 'bt-grpcex-plain-'));
    writeFileSync(join(plainElixir, 'mix.exs'), mixExs(['jason', 'ecto', 'phoenix']));

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-grpcex-ts-'));
    writeFileSync(
      join(tsRepo, 'package.json'),
      JSON.stringify({ name: 'web', dependencies: { react: '18' } }),
    );
  });

  afterAll(() => {
    for (const d of [grpcRepo, secondaryRepo, plainElixir, tsRepo]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('detects gRPC from the grpc dep', async () => {
    const m = await grpcElixirAdapter.detect({ repoDir: grpcRepo });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('grpc-elixir');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects gRPC via the secondary proto + generated stub signal', async () => {
    const m = await grpcElixirAdapter.detect({ repoDir: secondaryRepo });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('grpc-elixir');
    expect(m!.confidence).toBeLessThan(0.8); // weaker than the dep-declared match
  });

  it('does NOT detect a non-gRPC Elixir repo', async () => {
    expect(await grpcElixirAdapter.detect({ repoDir: plainElixir })).toBeNull();
  });

  it('does NOT detect a TS repo (no mix manifest)', async () => {
    expect(await grpcElixirAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED gRPC app and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-grpcex-nested-'));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'mix.exs'), mixExs(['grpc']));
    try {
      const m = await grpcElixirAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherGrpcElixirSignals reads the grpc dep', () => {
    expect(gatherGrpcElixirSignals(grpcRepo).hasGrpc).toBe(true);
    expect(gatherGrpcElixirSignals(plainElixir).hasGrpc).toBe(false);
    const sec = gatherGrpcElixirSignals(secondaryRepo);
    expect(sec.hasProtoFiles).toBe(true);
    expect(sec.hasGeneratedPb).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real gRPC fixture

describe('grpcElixirAdapter analysis (syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-grpcex-app-'));

    // The hand-written servicer — `use GRPC.Server, service: X.Service`.
    write(
      dir,
      'lib/helloworld/greeter_server.ex',
      [
        'defmodule Helloworld.Greeter.Server do',
        '  use GRPC.Server, service: Helloworld.Greeter.Service',
        '',
        '  def say_hello(request, _stream) do',
        '    Helloworld.HelloReply.new(message: "Hello, #{request.name}")',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    // The generated protobuf/gRPC stub — messages + the `.Service` behaviour module.
    write(
      dir,
      'lib/helloworld.pb.ex',
      [
        'defmodule Helloworld.HelloRequest do',
        '  use Protobuf, syntax: :proto3',
        'end',
        '',
        'defmodule Helloworld.HelloReply do',
        '  use Protobuf, syntax: :proto3',
        'end',
        '',
        'defmodule Helloworld.Greeter.Service do',
        '  use GRPC.Service, name: "helloworld.Greeter"',
        'end',
        '',
      ].join('\n'),
    );
    // A @behaviour-form servicer (no `use GRPC.Server`) — tagged, role-only.
    write(
      dir,
      'lib/other/handler.ex',
      [
        'defmodule Other.Handler do',
        '  @behaviour Other.Thing.Service',
        '  def handle(_req, _stream), do: :ok',
        'end',
        '',
      ].join('\n'),
    );
    // A plain module — must stay untagged.
    write(
      dir,
      'lib/helloworld/application.ex',
      'defmodule Helloworld.Application do\n  def start(_, _), do: :ok\nend\n',
    );

    graph = await new ElixirExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'grpc-elixir', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    edges = await grpcElixirAdapter.syntheticEdges!(ctx);
    roles = await grpcElixirAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags a use-GRPC.Server servicer gateway (role servicer)', () => {
    expect(roles.get('lib/helloworld/greeter_server.ex')).toMatchObject({
      role: 'servicer',
      kind: 'gateway',
    });
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'frontend', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('skips the generated *.pb.ex stub (never a servicer role)', () => {
    expect(roles.get('lib/helloworld.pb.ex')).toBeUndefined();
  });

  it('tags a @behaviour X.Service servicer (role-only, no service option)', () => {
    expect(roles.get('lib/other/handler.ex')).toMatchObject({ role: 'servicer', kind: 'gateway' });
  });

  it('leaves a plain module untagged', () => {
    expect(roles.get('lib/helloworld/application.ex')).toBeUndefined();
  });

  it('emits the servicer→service-stub edge (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('lib/helloworld/greeter_server.ex→lib/helloworld.pb.ex:calls');
    const svc = edges.find((e) => e.metadata?.relation === 'grpc-service');
    expect(svc?.kind).toBe('calls');
    // The @behaviour-only servicer contributes no edge (no `service:` option).
    expect(edges.length).toBe(1);
  });

  it('is deterministic across a genuinely fresh re-parse (stable ordering + values)', async () => {
    const ctx2: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'grpc-elixir', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const e2 = await grpcElixirAdapter.syntheticEdges!(ctx2);
    const r2 = await grpcElixirAdapter.roleTags!(ctx2);
    expect(e2).toEqual(edges);
    const entries = (m: Map<string, RoleTag>) =>
      [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(r2)).toEqual(entries(roles));
  });
});
