// gRPC adapter tests.
//
// scoreGrpc is pure; detect() runs against real tmp dirs (pyproject +
// requirements grpcio, a secondary proto+generated-stub match with no dep, a
// non-gRPC Python no-match + a TS no-match, and a nested backend). The analysis
// hooks run over a real PythonExtractor graph of a small gRPC fixture (servicer
// impls + a server bootstrap + a client stub + a generated stub + .proto files)
// and assert the file-id-space contributions (the contribute-step resolves those
// to modules downstream; that resolution is covered by contribute-step.test.ts).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  grpcAdapter,
  scoreGrpc,
  gatherGrpcSignals,
  parseProtoServices,
  type GrpcSignals,
} from './grpc.js';
import { PythonExtractor } from '../../graph/python-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: GrpcSignals = {
  hasGrpcio: false,
  hasGrpcioTools: false,
  hasProtoFiles: false,
  hasGeneratedGrpc: false,
};

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// scoreGrpc (pure)

describe('scoreGrpc (pure)', () => {
  it('returns null with no gRPC signal (generic-Python fallthrough)', () => {
    expect(scoreGrpc(NO_SIGNALS)).toBeNull();
    // A lone .proto (no generated stubs, no dep) is NOT enough — could be a
    // schema-only repo.
    expect(scoreGrpc({ ...NO_SIGNALS, hasProtoFiles: true })).toBeNull();
    // Generated stubs alone (no proto, no dep) also not enough.
    expect(scoreGrpc({ ...NO_SIGNALS, hasGeneratedGrpc: true })).toBeNull();
  });

  it('detects gRPC on the grpcio dep', () => {
    const m = scoreGrpc({ ...NO_SIGNALS, hasGrpcio: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('grpc');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('raises confidence with grpcio-tools + proto files', () => {
    const m = scoreGrpc({ hasGrpcio: true, hasGrpcioTools: true, hasProtoFiles: true, hasGeneratedGrpc: false });
    expect(m!.confidence).toBeGreaterThan(0.8);
    expect((m!.metadata?.signals as Record<string, boolean>).grpcioTools).toBe(true);
  });

  it('detects gRPC on the SECONDARY signal (proto + generated stubs, no dep)', () => {
    const m = scoreGrpc({ ...NO_SIGNALS, hasProtoFiles: true, hasGeneratedGrpc: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('grpc');
    // Weaker than a declared dep.
    expect(m!.confidence).toBeLessThan(0.8);
  });

  it('passes rootPath through', () => {
    const m = scoreGrpc({ ...NO_SIGNALS, hasGrpcio: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// parseProtoServices (pure)

describe('parseProtoServices (pure)', () => {
  it('parses service + rpc blocks into service → sorted methods', () => {
    const proto = [
      'syntax = "proto3";',
      'package helloworld;',
      'service Greeter {',
      '  rpc SayHello (HelloRequest) returns (HelloReply) {}',
      '  rpc SayHelloAgain (HelloRequest) returns (HelloReply);',
      '}',
      'message HelloRequest { string name = 1; }',
    ].join('\n');
    const services = parseProtoServices(proto);
    expect([...services.keys()]).toEqual(['Greeter']);
    expect(services.get('Greeter')).toEqual(['SayHello', 'SayHelloAgain']);
  });

  it('handles multiple services in one file', () => {
    const proto = 'service A { rpc M1(X) returns (Y); }\nservice B { rpc M2(X) returns (Y); }';
    const services = parseProtoServices(proto);
    expect(services.get('A')).toEqual(['M1']);
    expect(services.get('B')).toEqual(['M2']);
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests / artifacts

describe('grpcAdapter.detect (fs fixtures)', () => {
  let pyproject: string;
  let requirements: string;
  let secondary: string;
  let plainPy: string;
  let tsRepo: string;

  beforeAll(() => {
    pyproject = mkdtempSync(join(tmpdir(), 'bt-grpc-toml-'));
    writeFileSync(
      join(pyproject, 'pyproject.toml'),
      ['[project]', 'name = "svc"', 'dependencies = [', '  "grpcio>=1.60",', '  "grpcio-tools>=1.60",', ']'].join('\n'),
    );

    requirements = mkdtempSync(join(tmpdir(), 'bt-grpc-req-'));
    writeFileSync(join(requirements, 'requirements.txt'), ['# app deps', 'grpcio==1.60.0', 'protobuf'].join('\n'));

    // SECONDARY: no declared dep, but a .proto + a generated *_pb2_grpc.py.
    secondary = mkdtempSync(join(tmpdir(), 'bt-grpc-secondary-'));
    write(secondary, 'protos/thing.proto', 'service Thing { rpc Do(X) returns (Y); }\n');
    write(secondary, 'gen/thing_pb2_grpc.py', 'class ThingStub(object):\n    pass\n');

    plainPy = mkdtempSync(join(tmpdir(), 'bt-grpc-plain-'));
    writeFileSync(join(plainPy, 'pyproject.toml'), '[project]\nname = "x"\ndependencies = ["requests>=2"]\n');

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-grpc-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [pyproject, requirements, secondary, plainPy, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects gRPC from pyproject PEP 621 dependencies (tools bumps confidence)', async () => {
    const m = await grpcAdapter.detect({ repoDir: pyproject });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('grpc');
    expect(m!.confidence).toBeGreaterThan(0.8);
  });

  it('detects gRPC from requirements.txt', async () => {
    const m = await grpcAdapter.detect({ repoDir: requirements });
    expect(m).not.toBeNull();
    expect((m!.metadata?.signals as Record<string, boolean>).grpcio).toBe(true);
  });

  it('detects gRPC on the secondary proto+generated-stub signal (no declared dep)', async () => {
    const m = await grpcAdapter.detect({ repoDir: secondary });
    expect(m).not.toBeNull();
    const signals = m!.metadata?.signals as Record<string, boolean>;
    expect(signals.protoFiles).toBe(true);
    expect(signals.generatedGrpc).toBe(true);
    expect(signals.grpcio).toBe(false);
  });

  it('does NOT detect a non-gRPC Python repo', async () => {
    expect(await grpcAdapter.detect({ repoDir: plainPy })).toBeNull();
  });

  it('does NOT detect a TS repo (no Python/gRPC signal)', async () => {
    expect(await grpcAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED gRPC backend and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-grpc-nested-'));
    // A frontend+backend monorepo: no root Python manifest; grpcio under backend/.
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'requirements.txt'), 'grpcio>=1.60\n');
    try {
      const m = await grpcAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherGrpcSignals reads deps from disk', () => {
    const s = gatherGrpcSignals(requirements);
    expect(s.hasGrpcio).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real gRPC fixture

describe('grpcAdapter analysis (groupingPrior / syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let groups: Awaited<ReturnType<NonNullable<typeof grpcAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-grpc-app-'));

    // Service 1 (Greeter): impl in one module, server bootstrap in ANOTHER,
    // client in a third — the cross-module wiring + stub-call layout.
    write(dir, 'greeter/servicer.py', [
      'import helloworld_pb2_grpc',
      'class Greeter(helloworld_pb2_grpc.GreeterServicer):',
      '    def SayHello(self, request, context):',
      '        return None',
    ].join('\n'));
    write(dir, 'server.py', [
      'import grpc',
      'import helloworld_pb2_grpc',
      'from greeter.servicer import Greeter',
      'def serve():',
      '    server = grpc.server(None)',
      '    helloworld_pb2_grpc.add_GreeterServicer_to_server(Greeter(), server)',
      '    server.start()',
    ].join('\n'));
    write(dir, 'client.py', [
      'import grpc',
      'import helloworld_pb2',
      'import helloworld_pb2_grpc',
      'def run():',
      "    channel = grpc.insecure_channel('localhost:50051')",
      '    stub = helloworld_pb2_grpc.GreeterStub(channel)',
      "    response = stub.SayHello(helloworld_pb2.HelloRequest(name='you'))",
      '    return response',
    ].join('\n'));
    // A second client using only the async/future form `stub.SayHello.future(...)`.
    write(dir, 'future_client.py', [
      'import helloworld_pb2',
      'import helloworld_pb2_grpc',
      'def run(channel):',
      '    stub = helloworld_pb2_grpc.GreeterStub(channel)',
      '    future = stub.SayHello.future(helloworld_pb2.HelloRequest())',
      '    return future.result()',
    ].join('\n'));
    // The GENERATED stub — must be recognized + NOT tagged a servicer role.
    write(dir, 'helloworld_pb2_grpc.py', [
      'class GreeterServicer(object):',
      '    def SayHello(self, request, context):',
      '        raise NotImplementedError()',
      'class GreeterStub(object):',
      '    def __init__(self, channel):',
      "        self.SayHello = channel.unary_unary('/helloworld.Greeter/SayHello')",
      'def add_GreeterServicer_to_server(servicer, server):',
      '    pass',
    ].join('\n'));
    write(dir, 'helloworld.proto', [
      'syntax = "proto3";',
      'service Greeter {',
      '  rpc SayHello (HelloRequest) returns (HelloReply);',
      '}',
    ].join('\n'));

    // Service 2 (RouteGuide): impl + server bootstrap in the SAME file → the
    // wiring edge is a self-edge (dropped). Proves the collapse + a 2nd group.
    write(dir, 'route_guide.py', [
      'import grpc',
      'import route_guide_pb2_grpc',
      'class RouteGuideServicer(route_guide_pb2_grpc.RouteGuideServicer):',
      '    def GetFeature(self, request, context):',
      '        return None',
      'def serve():',
      '    server = grpc.server(None)',
      '    route_guide_pb2_grpc.add_RouteGuideServicer_to_server(RouteGuideServicer(), server)',
    ].join('\n'));
    write(dir, 'route_guide.proto', [
      'service RouteGuide {',
      '  rpc GetFeature (Point) returns (Feature);',
      '  rpc ListFeatures (Rectangle) returns (stream Feature);',
      '}',
    ].join('\n'));

    graph = await new PythonExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'grpc', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    ({ groups } = await grpcAdapter.groupingPrior!(ctx));
    edges = await grpcAdapter.syntheticEdges!(ctx);
    roles = await grpcAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags an XServicer subclass as gateway; skips the generated stub', () => {
    expect(roles.get('greeter/servicer.py')).toMatchObject({ role: 'servicer', kind: 'gateway' });
    expect(roles.get('route_guide.py')).toMatchObject({ role: 'servicer', kind: 'gateway' });
    // The generated *_pb2_grpc.py is recognized as codegen → NO role.
    expect(roles.get('helloworld_pb2_grpc.py')).toBeUndefined();
    // The server bootstrap + client are wiring/consumers, not servicer roles.
    expect(roles.get('server.py')).toBeUndefined();
    expect(roles.get('client.py')).toBeUndefined();
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('enriches the servicer role with the .proto RPC method inventory', () => {
    expect((roles.get('greeter/servicer.py')!.metadata as { services: string[] }).services).toEqual(['Greeter']);
    expect((roles.get('greeter/servicer.py')!.metadata as { rpcMethods: string[] }).rpcMethods).toEqual(['SayHello']);
    expect((roles.get('route_guide.py')!.metadata as { rpcMethods: string[] }).rpcMethods).toEqual([
      'GetFeature',
      'ListFeatures',
    ]);
  });

  it('groups each gRPC service into its own named subsystem', () => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get('greeter')?.label).toBe('Greeter');
    expect(byId.get('greeter')?.fileIds).toEqual(['greeter/servicer.py']);
    expect(byId.get('route-guide')?.label).toBe('Route Guide');
    expect(byId.get('route-guide')?.fileIds).toEqual(['route_guide.py']);
  });

  it('emits a cross-module add_XServicer_to_server wiring edge (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    // server bootstrap → the servicer impl it wires in (a different module).
    expect(keys).toContain('server.py→greeter/servicer.py:calls');
  });

  it('emits a client stub.Method() cross-module call edge to the in-repo servicer', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('client.py→greeter/servicer.py:calls');
  });

  it('emits a stub edge for the async/future form stub.Method.future(...)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('future_client.py→greeter/servicer.py:calls');
  });

  it('drops the SAME-FILE wiring self-edge (impl + bootstrap in one module)', () => {
    // route_guide.py wires its own RouteGuideServicer → a self-edge, never emitted.
    expect(edges.some((e) => e.source === 'route_guide.py')).toBe(false);
  });

  it('is deterministic across two runs (stable ids + ordering)', async () => {
    const g2 = (await grpcAdapter.groupingPrior!(ctx)).groups;
    const e2 = await grpcAdapter.syntheticEdges!(ctx);
    const r2 = await grpcAdapter.roleTags!(ctx);
    expect(g2).toEqual(groups);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
    expect([...r2.keys()].sort()).toEqual([...roles.keys()].sort());
  });
});
