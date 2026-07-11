// FastStream (+ Taskiq) adapter tests.
//
// scoreFastStream is pure; detect() runs against real tmp dirs (faststream
// pyproject, taskiq requirements, both, a non-match Python + a TS no-match, and a
// nested backend). The analysis hooks run over a real PythonExtractor graph of a
// small FastStream + Taskiq fixture (broker + app + cross-file subscribers /
// publishers + imperative publish + a router + a Taskiq task + a `.kiq()` enqueue)
// and assert the file-id-space contributions (the contribute-step resolves those
// to modules downstream; that resolution is covered by contribute-step.test.ts).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fastStreamAdapter,
  scoreFastStream,
  gatherFastStreamSignals,
  type FastStreamSignals,
} from './faststream.js';
import { PythonExtractor } from '../../graph/python-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: FastStreamSignals = { hasFastStream: false, hasTaskiq: false };

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// scoreFastStream (pure)

describe('scoreFastStream (pure)', () => {
  it('returns null with neither faststream nor taskiq (generic-Python fallthrough)', () => {
    expect(scoreFastStream(NO_SIGNALS)).toBeNull();
  });

  it('detects on the faststream dep alone', () => {
    const m = scoreFastStream({ hasFastStream: true, hasTaskiq: false });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('faststream');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(m!.metadata?.faststream).toBe(true);
    expect(m!.metadata?.taskiq).toBe(false);
  });

  it('detects on the taskiq dep alone (task-queue-only repo)', () => {
    const m = scoreFastStream({ hasFastStream: false, hasTaskiq: true });
    expect(m).not.toBeNull();
    expect(m!.metadata?.faststream).toBe(false);
    expect(m!.metadata?.taskiq).toBe(true);
  });

  it('raises confidence when both are present', () => {
    const m = scoreFastStream({ hasFastStream: true, hasTaskiq: true });
    expect(m!.confidence).toBeGreaterThan(0.8);
  });

  it('passes rootPath through', () => {
    const m = scoreFastStream({ hasFastStream: true, hasTaskiq: false }, 'worker');
    expect(m!.rootPath).toBe('worker');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('fastStreamAdapter.detect (fs fixtures)', () => {
  let pyproject: string;
  let requirements: string;
  let both: string;
  let plainPy: string;
  let tsRepo: string;

  beforeAll(() => {
    pyproject = mkdtempSync(join(tmpdir(), 'bt-faststream-toml-'));
    writeFileSync(
      join(pyproject, 'pyproject.toml'),
      [
        '[project]',
        'name = "svc"',
        'dependencies = [',
        '  "faststream[kafka]>=0.5",',
        '  "aiokafka",',
        ']',
      ].join('\n'),
    );

    requirements = mkdtempSync(join(tmpdir(), 'bt-faststream-req-'));
    writeFileSync(
      join(requirements, 'requirements.txt'),
      ['# task worker', 'taskiq>=0.11', 'taskiq-redis>=1.0'].join('\n'),
    );

    both = mkdtempSync(join(tmpdir(), 'bt-faststream-both-'));
    writeFileSync(
      join(both, 'pyproject.toml'),
      '[project]\nname="svc"\ndependencies=["faststream>=0.5", "taskiq>=0.11"]\n',
    );

    plainPy = mkdtempSync(join(tmpdir(), 'bt-faststream-plain-'));
    writeFileSync(join(plainPy, 'pyproject.toml'), '[project]\nname = "x"\ndependencies = ["requests>=2", "click"]\n');

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-faststream-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [pyproject, requirements, both, plainPy, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects FastStream from pyproject PEP 621 dependencies', async () => {
    const m = await fastStreamAdapter.detect({ repoDir: pyproject });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('faststream');
    expect(m!.metadata?.faststream).toBe(true);
    expect(m!.metadata?.taskiq).toBe(false);
  });

  it('detects Taskiq from requirements.txt (a taskiq-* broker counts)', async () => {
    const m = await fastStreamAdapter.detect({ repoDir: requirements });
    expect(m).not.toBeNull();
    expect(m!.metadata?.taskiq).toBe(true);
    expect(m!.metadata?.faststream).toBe(false);
  });

  it('detects both and raises confidence', async () => {
    const m = await fastStreamAdapter.detect({ repoDir: both });
    expect(m).not.toBeNull();
    expect(m!.confidence).toBeGreaterThan(0.8);
    expect(m!.metadata?.faststream).toBe(true);
    expect(m!.metadata?.taskiq).toBe(true);
  });

  it('does NOT detect a non-FastStream/Taskiq Python repo', async () => {
    expect(await fastStreamAdapter.detect({ repoDir: plainPy })).toBeNull();
  });

  it('does NOT detect a TS repo (no Python manifest)', async () => {
    expect(await fastStreamAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED worker and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-faststream-nested-'));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'worker'), { recursive: true });
    writeFileSync(join(nested, 'worker', 'requirements.txt'), 'faststream>=0.5\nfaststream[nats]\n');
    try {
      const m = await fastStreamAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('worker');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherFastStreamSignals reads deps from disk', () => {
    const s = gatherFastStreamSignals(requirements);
    expect(s.hasFastStream).toBe(false);
    expect(s.hasTaskiq).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real FastStream + Taskiq fixture

describe('fastStreamAdapter analysis (groupingPrior / syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let groups: Awaited<ReturnType<NonNullable<typeof fastStreamAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-faststream-app-'));
    // The broker (its own module — the common "broker imported everywhere" layout).
    write(dir, 'app/broker.py', [
      'from faststream.kafka import KafkaBroker',
      'broker = KafkaBroker("localhost:9092")',
    ].join('\n'));
    // The app entry: wraps the broker + mounts the billing router.
    write(dir, 'app/main.py', [
      'from faststream import FastStream',
      'from app.broker import broker',
      'from app.routers.billing import router as billing_router',
      'app = FastStream(broker)',
      'broker.include_router(billing_router)',
    ].join('\n'));
    // A pipeline handler: subscribes "orders-in", publishes "orders-out" (stacked).
    write(dir, 'app/handlers/orders.py', [
      'from app.broker import broker',
      '@broker.subscriber("orders-in")',
      '@broker.publisher("orders-out")',
      'async def handle_order(msg):',
      '    return msg',
    ].join('\n'));
    // A downstream consumer of "orders-out" — linked FROM orders.py by topic.
    write(dir, 'app/handlers/shipping.py', [
      'from app.broker import broker',
      '@broker.subscriber("orders-out")',
      'async def ship(msg):',
      '    return None',
    ].join('\n'));
    // An imperative producer into "orders-in" — linked TO orders.py by topic. The
    // trailing positional ("route-key") is NOT the destination and must not be read
    // as a second topic (only index 1 is the dest).
    write(dir, 'app/handlers/ingest.py', [
      'from app.broker import broker',
      'async def ingest(data):',
      '    await broker.publish(data, "orders-in", "route-key")',
    ].join('\n'));
    // A decoy subscriber on the trailing publish positional's string — proves that
    // positional is ignored (no edge should link ingest.py → here).
    write(dir, 'app/handlers/decoy.py', [
      'from app.broker import broker',
      '@broker.subscriber("route-key")',
      'async def decoy(msg):',
      '    return None',
    ].join('\n'));
    // A router as a pure aggregator (definer) + its handler in a sibling module.
    write(dir, 'app/routers/billing/__init__.py', [
      'from faststream.kafka import KafkaRouter',
      'router = KafkaRouter()',
    ].join('\n'));
    write(dir, 'app/routers/billing/handlers.py', [
      'from app.routers.billing import router',
      '@router.subscriber("billing-events")',
      'async def bill(msg):',
      '    return None',
    ].join('\n'));
    // Taskiq: a broker + a task, and a separate module that enqueues it via .kiq().
    write(dir, 'app/tasks.py', [
      'from taskiq_redis import RedisStreamBroker',
      'taskiq_broker = RedisStreamBroker("redis://localhost:6379")',
      '@taskiq_broker.task',
      'async def send_email(uid):',
      '    return uid',
    ].join('\n'));
    write(dir, 'app/services/notify.py', [
      'from app.tasks import send_email',
      'async def notify(uid):',
      '    await send_email.kiq(uid)',
    ].join('\n'));

    graph = await new PythonExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'faststream', confidence: 1, rootPath: '', metadata: { faststream: true, taskiq: true } },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    ({ groups } = await fastStreamAdapter.groupingPrior!(ctx));
    edges = await fastStreamAdapter.syntheticEdges!(ctx);
    roles = await fastStreamAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags roles onto locked MODULE_KINDS (gateway for app/broker/router, service for handlers, job for task)', () => {
    expect(roles.get('app/main.py')).toMatchObject({ role: 'app', kind: 'gateway' });
    expect(roles.get('app/broker.py')).toMatchObject({ role: 'broker', kind: 'gateway' });
    expect(roles.get('app/handlers/orders.py')).toMatchObject({ role: 'subscriber', kind: 'service' });
    expect(roles.get('app/handlers/shipping.py')).toMatchObject({ role: 'subscriber', kind: 'service' });
    expect(roles.get('app/handlers/ingest.py')).toMatchObject({ role: 'publisher', kind: 'service' });
    // A pure aggregator router (handlers elsewhere) reads as `router`; its handler
    // module reads as the informative leaf `subscriber`.
    expect(roles.get('app/routers/billing/__init__.py')).toMatchObject({ role: 'router', kind: 'gateway' });
    expect(roles.get('app/routers/billing/handlers.py')).toMatchObject({ role: 'subscriber', kind: 'service' });
    // Taskiq task → job.
    expect(roles.get('app/tasks.py')).toMatchObject({ role: 'task', kind: 'job' });
    // A bare `.kiq()` caller is not itself a handler — no role.
    expect(roles.get('app/services/notify.py')).toBeUndefined();
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('groups a FastStream router into its own subsystem (definer + handler files)', () => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get('billing')?.label).toBe('Billing');
    expect(byId.get('billing')?.fileIds).toEqual([
      'app/routers/billing/__init__.py',
      'app/routers/billing/handlers.py',
    ]);
  });

  it('links publisher → subscriber modules through the shared topic (kind publishes)', () => {
    const keys = new Set(edges.map(edgeKey));
    // imperative publish("orders-in") → the "orders-in" subscriber.
    expect(keys).toContain('app/handlers/ingest.py→app/handlers/orders.py:publishes');
    // publisher("orders-out") → the "orders-out" subscriber.
    expect(keys).toContain('app/handlers/orders.py→app/handlers/shipping.py:publishes');
    // The shared topic rides in metadata.
    const ordersOut = edges.find(
      (e) => e.source === 'app/handlers/orders.py' && e.target === 'app/handlers/shipping.py',
    );
    expect(ordersOut?.metadata?.topics).toEqual(['orders-out']);
    expect(ordersOut?.metadata?.relation).toBe('pubsub');
  });

  it('does NOT link a topic with no internal publisher', () => {
    // "billing-events" has a subscriber but no internal publisher → no edge.
    expect(edges.some((e) => e.target === 'app/routers/billing/handlers.py')).toBe(false);
  });

  it('does NOT treat a trailing publish positional as a topic', () => {
    // broker.publish(data, "orders-in", "route-key") — "route-key" is index 2, not
    // a destination, so the "route-key" subscriber (decoy.py) gets no edge.
    expect(edges.some((e) => e.source === 'app/handlers/ingest.py' && e.target === 'app/handlers/decoy.py')).toBe(false);
    // The real destination ("orders-in") edge is unaffected.
    expect(edges.some((e) => e.source === 'app/handlers/ingest.py' && e.target === 'app/handlers/orders.py')).toBe(true);
  });

  it('emits a Taskiq .kiq() enqueue edge (kind publishes, not a plain call)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('app/services/notify.py→app/tasks.py:publishes');
    const kiq = edges.find((e) => e.source === 'app/services/notify.py');
    expect(kiq?.metadata?.relation).toBe('taskiq-kiq');
  });

  it('emits a broker.include_router mounting edge (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('app/main.py→app/routers/billing/__init__.py:calls');
  });

  it('is deterministic across two runs (stable ids + ordering)', async () => {
    const g2 = (await fastStreamAdapter.groupingPrior!(ctx)).groups;
    const e2 = await fastStreamAdapter.syntheticEdges!(ctx);
    const r2 = await fastStreamAdapter.roleTags!(ctx);
    expect(g2).toEqual(groups);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
    expect([...r2.keys()].sort()).toEqual([...roles.keys()].sort());
  });

  it('does not run the Taskiq pass when taskiq is absent (no task role, no kiq edge)', async () => {
    const noTaskiq: FrameworkContext = { ...ctx, match: { ...ctx.match, metadata: { faststream: true, taskiq: false } } };
    const e = await fastStreamAdapter.syntheticEdges!(noTaskiq);
    expect(e.some((x) => x.metadata?.relation === 'taskiq-kiq')).toBe(false);
    const r = await fastStreamAdapter.roleTags!(noTaskiq);
    expect(r.get('app/tasks.py')).toBeUndefined(); // a Taskiq broker is NOT a FastStream gateway
  });

  it('does not run the FastStream pass when faststream is absent (task-only repo)', async () => {
    const noFastStream: FrameworkContext = { ...ctx, match: { ...ctx.match, metadata: { faststream: false, taskiq: true } } };
    const e = await fastStreamAdapter.syntheticEdges!(noFastStream);
    // Only the Taskiq enqueue survives; no pub/sub or include_router edges.
    expect(e.every((x) => x.metadata?.relation === 'taskiq-kiq')).toBe(true);
    const r = await fastStreamAdapter.roleTags!(noFastStream);
    expect(r.get('app/handlers/orders.py')).toBeUndefined();
    expect(r.get('app/tasks.py')).toMatchObject({ role: 'task', kind: 'job' });
  });
});
