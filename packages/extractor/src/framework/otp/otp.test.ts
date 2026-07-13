// OTP adapter tests (runtime / supervision) — mirroring ecto.test.ts's three tiers:
//   (1) detect() gates on the mix.exs `application/0` `mod:` callback (a manifest
//       signal), not a dep — so a pure library (no `mod:`) is NOT matched.
//   (2) detect() runs against real tmp mix.exs dirs (root + nested + a no-match lib +
//       a TS no-match).
//   (3) the analysis hooks run over a REAL ElixirExtractor graph of a small on-disk
//       app + supervisor fixture and assert the supervision spine (application → its
//       children incl. a nested supervisor; the supervisor → its own workers), the
//       application/supervisor roles, and the external/DynamicSupervisor drops.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { otpAdapter } from './otp.js';
import { ElixirExtractor } from '../../graph/elixir-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// A mix.exs with (optionally) an `application/0` `mod:` callback + some deps.
function mixExs(opts: { mod?: string; deps?: string[] } = {}): string {
  const deps = (opts.deps ?? []).map((d) => `      {:${d}, "~> 1.0"},`).join('\n');
  const app = opts.mod
    ? `  def application do\n    [\n      mod: {${opts.mod}, []},\n      extra_applications: [:logger]\n    ]\n  end\n`
    : '';
  return `defmodule App.MixProject do\n  use Mix.Project\n${app}  defp deps do\n    [\n${deps}\n    ]\n  end\nend\n`;
}

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('otpAdapter.detect (fs fixtures)', () => {
  let appRepo: string;
  let libRepo: string;
  let tsRepo: string;

  beforeAll(() => {
    appRepo = mkdtempSync(join(tmpdir(), 'bt-otp-app-'));
    writeFileSync(join(appRepo, 'mix.exs'), mixExs({ mod: 'MyApp.Application', deps: ['ecto', 'phoenix'] }));

    // A pure library: deps but NO application callback → not an OTP app.
    libRepo = mkdtempSync(join(tmpdir(), 'bt-otp-lib-'));
    writeFileSync(join(libRepo, 'mix.exs'), mixExs({ deps: ['jason', 'nimble_parsec'] }));

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-otp-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [appRepo, libRepo, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects an OTP app from the mix.exs mod: callback', async () => {
    const m = await otpAdapter.detect({ repoDir: appRepo });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('otp');
    expect(m!.confidence).toBeGreaterThan(0.5);
  });

  it('does NOT detect a pure library (no application callback)', async () => {
    expect(await otpAdapter.detect({ repoDir: libRepo })).toBeNull();
  });

  it('does NOT detect a TS repo (no mix manifest)', async () => {
    expect(await otpAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED OTP app and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-otp-nested-'));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'mix.exs'), mixExs({ mod: 'Backend.Application' }));
    try {
      const m = await otpAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real app + supervisor fixture

describe('otpAdapter analysis (syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-otp-fix-'));

    // The application module (supervision-tree root).
    write(
      dir,
      'lib/my_app/application.ex',
      [
        'defmodule MyApp.Application do',
        '  use Application',
        '  @impl true',
        '  def start(_type, _args) do',
        '    children = [',
        '      MyApp.Repo,',
        '      MyAppWeb.Endpoint,',
        '      {Phoenix.PubSub, name: MyApp.PubSub},',
        '      MyApp.Cache.Supervisor,',
        '      {MyApp.Worker, []}',
        '    ]',
        '    opts = [strategy: :one_for_one, name: MyApp.Supervisor]',
        '    Supervisor.start_link(children, opts)',
        '  end',
        'end',
        '',
      ].join('\n'),
    );

    // A nested supervisor with its OWN children (one bare, one via child_spec).
    write(
      dir,
      'lib/my_app/cache/supervisor.ex',
      [
        'defmodule MyApp.Cache.Supervisor do',
        '  use Supervisor',
        '  def start_link(arg), do: Supervisor.start_link(__MODULE__, arg, name: __MODULE__)',
        '  @impl true',
        '  def init(_arg) do',
        '    children = [',
        '      MyApp.Cache.Store,',
        '      Supervisor.child_spec({MyApp.Cache.Warmer, []}, id: :warmer)',
        '    ]',
        '    Supervisor.init(children, strategy: :one_for_one)',
        '  end',
        'end',
        '',
      ].join('\n'),
    );

    // A DynamicSupervisor — role only, no static children.
    write(
      dir,
      'lib/my_app/dyn_sup.ex',
      [
        'defmodule MyApp.DynSup do',
        '  use DynamicSupervisor',
        '  @impl true',
        '  def init(_arg), do: DynamicSupervisor.init(strategy: :one_for_one)',
        'end',
        '',
      ].join('\n'),
    );

    // The supervised children (workers / a repo / an endpoint) — none is an OTP role.
    write(dir, 'lib/my_app/repo.ex', 'defmodule MyApp.Repo do\n  use Ecto.Repo, otp_app: :my_app\nend\n');
    write(dir, 'lib/my_app_web/endpoint.ex', 'defmodule MyAppWeb.Endpoint do\n  use Phoenix.Endpoint, otp_app: :my_app\nend\n');
    write(dir, 'lib/my_app/worker.ex', 'defmodule MyApp.Worker do\n  use GenServer\nend\n');
    write(dir, 'lib/my_app/cache/store.ex', 'defmodule MyApp.Cache.Store do\n  use GenServer\nend\n');
    write(dir, 'lib/my_app/cache/warmer.ex', 'defmodule MyApp.Cache.Warmer do\n  use GenServer\nend\n');

    graph = await new ElixirExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'otp', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    edges = await otpAdapter.syntheticEdges!(ctx);
    roles = await otpAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags the application + supervisors as service (roles application / supervisor)', () => {
    expect(roles.get('lib/my_app/application.ex')).toMatchObject({ role: 'application', kind: 'service' });
    expect(roles.get('lib/my_app/cache/supervisor.ex')).toMatchObject({ role: 'supervisor', kind: 'service' });
    expect(roles.get('lib/my_app/dyn_sup.ex')).toMatchObject({ role: 'supervisor', kind: 'service' });
    // Workers / repo / endpoint are NOT OTP roles (other adapters own those).
    expect(roles.get('lib/my_app/worker.ex')).toBeUndefined();
    expect(roles.get('lib/my_app/repo.ex')).toBeUndefined();
    // Every OTP role kind is the locked `service` value.
    for (const tag of roles.values()) expect(tag.kind).toBe('service');
  });

  it('emits the application → children supervision spine (kind calls, relation supervises)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('lib/my_app/application.ex→lib/my_app/repo.ex:calls');
    expect(keys).toContain('lib/my_app/application.ex→lib/my_app_web/endpoint.ex:calls');
    expect(keys).toContain('lib/my_app/application.ex→lib/my_app/cache/supervisor.ex:calls');
    expect(keys).toContain('lib/my_app/application.ex→lib/my_app/worker.ex:calls'); // {MyApp.Worker, []}
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
    expect(edges.every((e) => e.metadata?.relation === 'supervises')).toBe(true);
  });

  it('emits the nested supervisor → its workers (bare + child_spec forms)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('lib/my_app/cache/supervisor.ex→lib/my_app/cache/store.ex:calls');
    // Supervisor.child_spec({MyApp.Cache.Warmer, []}, id: :warmer) → the inner module.
    expect(keys).toContain('lib/my_app/cache/supervisor.ex→lib/my_app/cache/warmer.ex:calls');
  });

  it('drops external children and DynamicSupervisor (no static list)', () => {
    const keys = new Set(edges.map(edgeKey));
    // {Phoenix.PubSub, name: MyApp.PubSub} — external child, no internal edge (and the
    // MyApp.PubSub NAME atom is not mistaken for the child).
    expect([...keys].some((k) => k.includes('PubSub'))).toBe(false);
    // The DynamicSupervisor contributes no edges.
    expect([...keys].some((k) => k.startsWith('lib/my_app/dyn_sup.ex'))).toBe(false);
    // No edge leaves the first-party file set.
    const fileIds = new Set(graph.files.map((f) => f.id));
    for (const e of edges) {
      expect(fileIds.has(e.source)).toBe(true);
      expect(fileIds.has(e.target)).toBe(true);
    }
  });

  it('parses a COMPOSED child list (if/else ++ [...]) without picking option values as children', async () => {
    // The idiomatic Livebook/Plausible shape: `children = if ... do [] else [...] end
    // ++ [...]`, plus a `{var, name: SomeModule}` element whose child is a runtime var.
    const cdir = mkdtempSync(join(tmpdir(), 'bt-otp-comp-'));
    try {
      write(
        cdir,
        'lib/app/application.ex',
        [
          'defmodule App.Application do',
          '  use Application',
          '  def start(_t, _a) do',
          '    children =',
          '      if serverless?() do',
          '        []',
          '      else',
          '        [{Phoenix.PubSub, name: App.PubSub}]',
          '      end ++',
          '        [',
          '          App.Telemetry,',
          '          {App.Worker, []},',
          '          warmed_cache(App.SiteCache, ttl: 5),',
          '          {zta_module, name: App.ZTA, key: k}',
          '        ]',
          '    opts = [strategy: :one_for_one]',
          '    Supervisor.start_link(children, opts)',
          '  end',
          'end',
          '',
        ].join('\n'),
      );
      write(cdir, 'lib/app/telemetry.ex', 'defmodule App.Telemetry do\n  use Supervisor\nend\n');
      write(cdir, 'lib/app/worker.ex', 'defmodule App.Worker do\n  use GenServer\nend\n');
      // A cache module wrapped in a spec-builder helper — the FIRST positional module.
      write(cdir, 'lib/app/site_cache.ex', 'defmodule App.SiteCache do\n  use GenServer\nend\n');
      // A real module named App.ZTA exists — but it's only a `name:` option value, so it
      // must NOT become a supervision edge (the child there is the `zta_module` var).
      write(cdir, 'lib/app/zta.ex', 'defmodule App.ZTA do\nend\n');

      const g = await new ElixirExtractor().extract(cdir);
      const c: FrameworkContext = {
        repoDir: cdir,
        rootPath: '',
        match: { adapter: 'otp', confidence: 1, rootPath: '' },
        graph: g,
        cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
      };
      const es = await otpAdapter.syntheticEdges!(c);
      const keys = new Set(es.map(edgeKey));
      // The literal internal children from the composed tail list.
      expect(keys).toContain('lib/app/application.ex→lib/app/telemetry.ex:calls');
      expect(keys).toContain('lib/app/application.ex→lib/app/worker.ex:calls');
      // warmed_cache(App.SiteCache, ...) → the first positional module is the child.
      expect(keys).toContain('lib/app/application.ex→lib/app/site_cache.ex:calls');
      // App.ZTA is only a `name:` option VALUE → NO false edge.
      expect([...keys].some((k) => k.includes('zta.ex'))).toBe(false);
    } finally {
      rmSync(cdir, { recursive: true, force: true });
    }
  });

  it('is deterministic across a genuinely fresh re-parse (new ctx → cache miss)', async () => {
    const ctx2: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'otp', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const e2 = await otpAdapter.syntheticEdges!(ctx2);
    const r2 = await otpAdapter.roleTags!(ctx2);
    expect(e2).toEqual(edges);
    const entries = (m: Map<string, RoleTag>) =>
      [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(r2)).toEqual(entries(roles));
  });
});
