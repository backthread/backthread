// Broadway adapter tests — an Elixir async framework adapter, mirroring
// phoenix.test.ts's three tiers:
//   (1) scoreBroadway is PURE (dep present/absent, broadway_* transport confidence,
//       rootPath).
//   (2) detect() runs against real tmp mix.exs dirs (+ a non-Broadway Elixir no-match,
//       a TS no-match, a nested app).
//   (3) the analysis hooks run over a REAL ElixirExtractor graph of a small on-disk
//       Broadway fixture and assert the file-id-space contributions (pipelines → job
//       roleTags, an in-repo `producer: [module: {P, _}]` → subscribes edge, an
//       external transport producer skipped, an unresolvable producer dropped).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  broadwayAdapter,
  scoreBroadway,
  gatherBroadwaySignals,
  type BroadwaySignals,
} from './broadway.js';
import { ElixirExtractor } from '../../graph/elixir-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: BroadwaySignals = { hasBroadway: false, hasBroadwayTransport: false };

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
// scoreBroadway (pure)

describe('scoreBroadway (pure)', () => {
  it('returns null with no broadway dep (generic-Elixir fallthrough)', () => {
    expect(scoreBroadway(NO_SIGNALS)).toBeNull();
    // a broadway_* transport alone is not a claim (guard the invariant).
    expect(scoreBroadway({ hasBroadway: false, hasBroadwayTransport: true })).toBeNull();
  });

  it('detects Broadway on the broadway dep', () => {
    const m = scoreBroadway({ ...NO_SIGNALS, hasBroadway: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('broadway');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('raises confidence with a broadway_* transport', () => {
    const m = scoreBroadway({ hasBroadway: true, hasBroadwayTransport: true });
    expect(m!.confidence).toBeGreaterThan(0.8);
    expect((m!.metadata?.signals as Record<string, boolean>).broadwayTransport).toBe(true);
  });

  it('passes rootPath through', () => {
    const m = scoreBroadway({ ...NO_SIGNALS, hasBroadway: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('broadwayAdapter.detect (fs fixtures)', () => {
  let broadwayRepo: string;
  let plainElixir: string;
  let tsRepo: string;

  beforeAll(() => {
    broadwayRepo = mkdtempSync(join(tmpdir(), 'bt-bw-ok-'));
    writeFileSync(join(broadwayRepo, 'mix.exs'), mixExs(['broadway', 'broadway_kafka', 'ecto_sql']));

    plainElixir = mkdtempSync(join(tmpdir(), 'bt-bw-plain-'));
    writeFileSync(join(plainElixir, 'mix.exs'), mixExs(['jason', 'ecto', 'oban']));

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-bw-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [broadwayRepo, plainElixir, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects Broadway from mix.exs deps (with broadway_kafka confidence)', async () => {
    const m = await broadwayAdapter.detect({ repoDir: broadwayRepo });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('broadway');
    expect(m!.confidence).toBeGreaterThan(0.8);
  });

  it('does NOT detect a non-Broadway Elixir repo', async () => {
    expect(await broadwayAdapter.detect({ repoDir: plainElixir })).toBeNull();
  });

  it('does NOT detect a TS repo (no mix manifest)', async () => {
    expect(await broadwayAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED Broadway app and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-bw-nested-'));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'mix.exs'), mixExs(['broadway']));
    try {
      const m = await broadwayAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherBroadwaySignals reads deps from mix.exs', () => {
    const s = gatherBroadwaySignals(broadwayRepo);
    expect(s.hasBroadway).toBe(true);
    expect(s.hasBroadwayTransport).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real Broadway fixture

describe('broadwayAdapter analysis (syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-bw-app-'));

    // ── An in-repo GenStage producer ──
    write(
      dir,
      'lib/my_app/producers/counter_producer.ex',
      [
        'defmodule MyApp.Producers.CounterProducer do',
        '  use GenStage',
        '  def init(_), do: {:producer, 0}',
        'end',
        '',
      ].join('\n'),
    );

    // ── A pipeline wired to the IN-REPO producer ──
    write(
      dir,
      'lib/my_app/pipelines/local_pipeline.ex',
      [
        'defmodule MyApp.Pipelines.LocalPipeline do',
        '  use Broadway',
        '',
        '  def start_link(_opts) do',
        '    Broadway.start_link(__MODULE__,',
        '      name: __MODULE__,',
        '      producer: [',
        '        module: {MyApp.Producers.CounterProducer, []},',
        '        concurrency: 1',
        '      ],',
        '      processors: [default: [concurrency: 2]]',
        '    )',
        '  end',
        '',
        '  def handle_message(_processor, message, _context), do: message',
        'end',
        '',
      ].join('\n'),
    );

    // ── A pipeline wired to an EXTERNAL transport producer (skipped) ──
    write(
      dir,
      'lib/my_app/pipelines/kafka_pipeline.ex',
      [
        'defmodule MyApp.Pipelines.KafkaPipeline do',
        '  use Broadway',
        '',
        '  def start_link(_opts) do',
        '    Broadway.start_link(__MODULE__,',
        '      name: __MODULE__,',
        '      producer: [',
        '        module: {BroadwayKafka.Producer, [hosts: [], group_id: "g", topics: ["t"]]},',
        '        concurrency: 4',
        '      ]',
        '    )',
        '  end',
        '',
        '  def handle_message(_processor, message, _context), do: message',
        'end',
        '',
      ].join('\n'),
    );

    // ── A pipeline whose producer neither resolves in-repo nor looks external ──
    // (exercises the degrade path — no edge, counted + logged).
    write(
      dir,
      'lib/my_app/pipelines/ghost_pipeline.ex',
      [
        'defmodule MyApp.Pipelines.GhostPipeline do',
        '  use Broadway',
        '',
        '  def start_link(_opts) do',
        '    Broadway.start_link(__MODULE__,',
        '      name: __MODULE__,',
        '      producer: [module: {MyApp.Unknown.Handler, []}]',
        '    )',
        '  end',
        '',
        '  def handle_message(_processor, message, _context), do: message',
        'end',
        '',
      ].join('\n'),
    );

    graph = await new ElixirExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'broadway', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    edges = await broadwayAdapter.syntheticEdges!(ctx);
    roles = await broadwayAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags each Broadway pipeline as role broadway-pipeline on the locked job kind', () => {
    for (const id of [
      'lib/my_app/pipelines/local_pipeline.ex',
      'lib/my_app/pipelines/kafka_pipeline.ex',
      'lib/my_app/pipelines/ghost_pipeline.ex',
    ]) {
      expect(roles.get(id)).toMatchObject({ role: 'broadway-pipeline', kind: 'job' });
    }
    // The producer module itself is NOT a pipeline.
    expect(roles.get('lib/my_app/producers/counter_producer.ex')).toBeUndefined();
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'frontend', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('emits a subscribes edge to an IN-REPO producer only', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain(
      'lib/my_app/pipelines/local_pipeline.ex→lib/my_app/producers/counter_producer.ex:subscribes',
    );
    // The external transport producer is skipped — no edge from the kafka pipeline.
    expect(edges.some((e) => e.source === 'lib/my_app/pipelines/kafka_pipeline.ex')).toBe(false);
    // The unresolvable producer is dropped — no edge from the ghost pipeline.
    expect(edges.some((e) => e.source === 'lib/my_app/pipelines/ghost_pipeline.ex')).toBe(false);
    // All edges are the locked `subscribes` verb.
    expect(edges.every((e) => e.kind === 'subscribes')).toBe(true);
    expect(edges.every((e) => e.metadata?.framework === 'broadway')).toBe(true);
  });

  it('is deterministic across a genuinely fresh re-parse (stable ordering + values)', async () => {
    const ctx2: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'broadway', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const e2 = await broadwayAdapter.syntheticEdges!(ctx2);
    const r2 = await broadwayAdapter.roleTags!(ctx2);
    expect(e2).toEqual(edges);
    const entries = (m: Map<string, RoleTag>) =>
      [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(r2)).toEqual(entries(roles));
  });
});
