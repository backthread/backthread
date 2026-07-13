// Oban adapter tests — an Elixir async framework adapter, mirroring phoenix.test.ts's
// three tiers:
//   (1) scoreOban is PURE (dep present/absent, oban_* extension confidence, rootPath).
//   (2) detect() runs against real tmp mix.exs dirs (+ a non-Oban Elixir no-match, a
//       TS no-match, a nested app).
//   (3) the analysis hooks run over a REAL ElixirExtractor graph of a small on-disk
//       Oban fixture and assert the file-id-space contributions (workers → job
//       roleTags, `Oban.insert` + `<Worker>.new` → publishes enqueue edges, resolved
//       fully-qualified AND via alias). The contribute-step resolves file ids to
//       modules downstream (covered by contribute-step.test.ts).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { obanAdapter, scoreOban, gatherObanSignals, type ObanSignals } from './oban.js';
import { ElixirExtractor } from '../../graph/elixir-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: ObanSignals = { hasOban: false, hasObanExtension: false };

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
// scoreOban (pure)

describe('scoreOban (pure)', () => {
  it('returns null with no oban dep (generic-Elixir fallthrough)', () => {
    expect(scoreOban(NO_SIGNALS)).toBeNull();
    // an oban_* extension alone is not a claim (guard the invariant).
    expect(scoreOban({ hasOban: false, hasObanExtension: true })).toBeNull();
  });

  it('detects Oban on the oban dep', () => {
    const m = scoreOban({ ...NO_SIGNALS, hasOban: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('oban');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('raises confidence with an oban_* extension', () => {
    const m = scoreOban({ hasOban: true, hasObanExtension: true });
    expect(m!.confidence).toBeGreaterThan(0.8);
    expect((m!.metadata?.signals as Record<string, boolean>).obanExtension).toBe(true);
  });

  it('passes rootPath through', () => {
    const m = scoreOban({ ...NO_SIGNALS, hasOban: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('obanAdapter.detect (fs fixtures)', () => {
  let obanRepo: string;
  let plainElixir: string;
  let tsRepo: string;

  beforeAll(() => {
    obanRepo = mkdtempSync(join(tmpdir(), 'bt-oban-ok-'));
    writeFileSync(join(obanRepo, 'mix.exs'), mixExs(['oban', 'oban_web', 'ecto_sql']));

    plainElixir = mkdtempSync(join(tmpdir(), 'bt-oban-plain-'));
    writeFileSync(join(plainElixir, 'mix.exs'), mixExs(['jason', 'ecto', 'phoenix']));

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-oban-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [obanRepo, plainElixir, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects Oban from mix.exs deps (with oban_web confidence)', async () => {
    const m = await obanAdapter.detect({ repoDir: obanRepo });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('oban');
    expect(m!.confidence).toBeGreaterThan(0.8);
  });

  it('does NOT detect a non-Oban Elixir repo', async () => {
    expect(await obanAdapter.detect({ repoDir: plainElixir })).toBeNull();
  });

  it('does NOT detect a TS repo (no mix manifest)', async () => {
    expect(await obanAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED Oban app and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-oban-nested-'));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'mix.exs'), mixExs(['oban']));
    try {
      const m = await obanAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherObanSignals reads deps from mix.exs', () => {
    const s = gatherObanSignals(obanRepo);
    expect(s.hasOban).toBe(true);
    expect(s.hasObanExtension).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real Oban fixture

describe('obanAdapter analysis (syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-oban-app-'));

    // ── Workers (use Oban.Worker) ──
    write(
      dir,
      'lib/my_app/workers/email_worker.ex',
      [
        'defmodule MyApp.Workers.EmailWorker do',
        '  use Oban.Worker, queue: :mailers, max_attempts: 3',
        '',
        '  @impl Oban.Worker',
        '  def perform(%Oban.Job{args: %{"email" => email}}) do',
        '    MyApp.Mailer.deliver(email)',
        '    :ok',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    // A worker that ALSO enqueues another worker (tests worker→worker + role on the
    // same file).
    write(
      dir,
      'lib/my_app/workers/report_worker.ex',
      [
        'defmodule MyApp.Workers.ReportWorker do',
        '  use Oban.Worker, queue: :reports',
        '',
        '  @impl Oban.Worker',
        '  def perform(_job) do',
        '    %{"email" => "done@example.com"}',
        '    |> MyApp.Workers.EmailWorker.new()',
        '    |> Oban.insert()',
        '    :ok',
        '  end',
        'end',
        '',
      ].join('\n'),
    );

    // ── Enqueuers ──
    // Fully-qualified enqueue (`MyApp.Workers.EmailWorker.new |> Oban.insert`).
    write(
      dir,
      'lib/my_app/accounts.ex',
      [
        'defmodule MyApp.Accounts do',
        '  def welcome(user) do',
        '    %{"email" => user.email}',
        '    |> MyApp.Workers.EmailWorker.new()',
        '    |> Oban.insert()',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    // Aliased enqueue (`alias ...ReportWorker` → `ReportWorker.new`).
    write(
      dir,
      'lib/my_app/reports.ex',
      [
        'defmodule MyApp.Reports do',
        '  alias MyApp.Workers.ReportWorker',
        '',
        '  def schedule(params) do',
        '    changeset = ReportWorker.new(params)',
        '    Oban.insert(changeset)',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    // A NON-enqueuer that builds a `.new` but never inserts — no role, no edge.
    write(
      dir,
      'lib/my_app/plain.ex',
      'defmodule MyApp.Plain do\n  def build, do: SomeStruct.new(%{})\nend\n',
    );

    graph = await new ElixirExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'oban', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    edges = await obanAdapter.syntheticEdges!(ctx);
    roles = await obanAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags each Oban worker as role oban-worker on the locked job kind', () => {
    expect(roles.get('lib/my_app/workers/email_worker.ex')).toMatchObject({
      role: 'oban-worker',
      kind: 'job',
    });
    expect(roles.get('lib/my_app/workers/report_worker.ex')).toMatchObject({
      role: 'oban-worker',
      kind: 'job',
    });
    // Enqueuers + a plain module are NOT workers.
    expect(roles.get('lib/my_app/accounts.ex')).toBeUndefined();
    expect(roles.get('lib/my_app/reports.ex')).toBeUndefined();
    expect(roles.get('lib/my_app/plain.ex')).toBeUndefined();
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'frontend', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('emits enqueue edges (kind publishes) resolving both qualified and aliased workers', () => {
    const keys = new Set(edges.map(edgeKey));
    // Fully-qualified enqueue.
    expect(keys).toContain('lib/my_app/accounts.ex→lib/my_app/workers/email_worker.ex:publishes');
    // Aliased enqueue (`ReportWorker.new` via the worker last-segment index).
    expect(keys).toContain('lib/my_app/reports.ex→lib/my_app/workers/report_worker.ex:publishes');
    // A worker enqueuing ANOTHER worker.
    expect(keys).toContain(
      'lib/my_app/workers/report_worker.ex→lib/my_app/workers/email_worker.ex:publishes',
    );
    // All enqueue edges are the locked `publishes` verb.
    expect(edges.every((e) => e.kind === 'publishes')).toBe(true);
    expect(edges.every((e) => e.metadata?.framework === 'oban')).toBe(true);
  });

  it('does NOT emit an edge from a non-enqueuer (no Oban.insert)', () => {
    expect(edges.some((e) => e.source === 'lib/my_app/plain.ex')).toBe(false);
  });

  it('is deterministic across a genuinely fresh re-parse (stable ordering + values)', async () => {
    // A NEW context object → the WeakMap analysis cache MISSES → analyzeOban re-reads
    // + re-parses the fixture from disk.
    const ctx2: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'oban', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const e2 = await obanAdapter.syntheticEdges!(ctx2);
    const r2 = await obanAdapter.roleTags!(ctx2);
    expect(e2).toEqual(edges);
    const entries = (m: Map<string, RoleTag>) =>
      [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(r2)).toEqual(entries(roles));
  });
});
