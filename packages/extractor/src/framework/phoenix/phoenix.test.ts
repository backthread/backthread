// Phoenix adapter tests — the first Elixir framework adapter, mirroring
// fastapi.test.ts's three tiers:
//   (1) scorePhoenix is PURE (dep present/absent, live_view confidence, rootPath).
//   (2) detect() runs against real tmp mix.exs dirs (+ a non-Phoenix Elixir no-match,
//       a TS no-match, a nested app).
//   (3) the analysis hooks run over a REAL ElixirExtractor graph of a small on-disk
//       Phoenix fixture and assert the file-id-space contributions (contexts →
//       FrameworkGroups, LiveView → frontend, controller → gateway, router →
//       controller syntheticEdge, template → owning view). The contribute-step
//       resolves file ids to modules downstream (covered by contribute-step.test.ts).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  phoenixAdapter,
  scorePhoenix,
  gatherPhoenixSignals,
  type PhoenixSignals,
} from './phoenix.js';
import { ElixirExtractor } from '../../graph/elixir-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: PhoenixSignals = { hasPhoenix: false, hasLiveView: false };

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
// scorePhoenix (pure)

describe('scorePhoenix (pure)', () => {
  it('returns null with no phoenix dep (generic-Elixir fallthrough)', () => {
    expect(scorePhoenix(NO_SIGNALS)).toBeNull();
    // phoenix_live_view alone is not a claim (it never ships without phoenix, but
    // guard the invariant anyway).
    expect(scorePhoenix({ hasPhoenix: false, hasLiveView: true })).toBeNull();
  });

  it('detects Phoenix on the phoenix dep', () => {
    const m = scorePhoenix({ ...NO_SIGNALS, hasPhoenix: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('phoenix');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('raises confidence with phoenix_live_view', () => {
    const m = scorePhoenix({ hasPhoenix: true, hasLiveView: true });
    expect(m!.confidence).toBeGreaterThan(0.85);
    expect((m!.metadata?.signals as Record<string, boolean>).phoenix_live_view).toBe(true);
  });

  it('passes rootPath through', () => {
    const m = scorePhoenix({ ...NO_SIGNALS, hasPhoenix: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('phoenixAdapter.detect (fs fixtures)', () => {
  let phoenixRepo: string;
  let plainElixir: string;
  let tsRepo: string;

  beforeAll(() => {
    phoenixRepo = mkdtempSync(join(tmpdir(), 'bt-phx-ok-'));
    writeFileSync(join(phoenixRepo, 'mix.exs'), mixExs(['phoenix', 'phoenix_live_view', 'ecto_sql']));

    plainElixir = mkdtempSync(join(tmpdir(), 'bt-phx-plain-'));
    writeFileSync(join(plainElixir, 'mix.exs'), mixExs(['jason', 'ecto', 'oban']));

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-phx-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [phoenixRepo, plainElixir, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects Phoenix from mix.exs deps (with live_view confidence)', async () => {
    const m = await phoenixAdapter.detect({ repoDir: phoenixRepo });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('phoenix');
    expect(m!.confidence).toBeGreaterThan(0.85);
  });

  it('does NOT detect a non-Phoenix Elixir repo', async () => {
    expect(await phoenixAdapter.detect({ repoDir: plainElixir })).toBeNull();
  });

  it('does NOT detect a TS repo (no mix manifest)', async () => {
    expect(await phoenixAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED Phoenix app and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-phx-nested-'));
    // A polyglot monorepo: no root mix.exs; phoenix under backend/.
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'mix.exs'), mixExs(['phoenix']));
    try {
      const m = await phoenixAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherPhoenixSignals reads deps from mix.exs', () => {
    const s = gatherPhoenixSignals(phoenixRepo);
    expect(s.hasPhoenix).toBe(true);
    expect(s.hasLiveView).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real Phoenix fixture

describe('phoenixAdapter analysis (groupingPrior / syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let groups: Awaited<ReturnType<NonNullable<typeof phoenixAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-phx-app-'));

    // ── Contexts (lib/<app>/<context>/…) ──
    write(dir, 'lib/my_app/accounts.ex', 'defmodule MyApp.Accounts do\n  def list_users, do: []\nend\n');
    write(
      dir,
      'lib/my_app/accounts/user.ex',
      'defmodule MyApp.Accounts.User do\n  use Ecto.Schema\n  schema "users" do\n    field :email, :string\n  end\nend\n',
    );
    write(
      dir,
      'lib/my_app/accounts/service.ex',
      'defmodule MyApp.Accounts.Service do\n  def do_work, do: :ok\nend\n',
    );
    write(
      dir,
      'lib/my_app/billing/invoice.ex',
      'defmodule MyApp.Billing.Invoice do\n  def total, do: 0\nend\n',
    );
    // A scattered top-level file directly under lib/<app>/ — NOT a context (no dir).
    write(dir, 'lib/my_app/application.ex', 'defmodule MyApp.Application do\n  def start(_, _), do: :ok\nend\n');

    // ── Web tree (lib/<app>_web/…) — left to directory grouping ──
    write(
      dir,
      'lib/my_app_web/endpoint.ex',
      'defmodule MyAppWeb.Endpoint do\n  use Phoenix.Endpoint, otp_app: :my_app\nend\n',
    );
    write(
      dir,
      'lib/my_app_web/router.ex',
      [
        'defmodule MyAppWeb.Router do',
        '  use MyAppWeb, :router',
        '  scope "/", MyAppWeb do',
        '    get "/", PageController, :index',
        '    live "/dashboard", DashboardLive, :index',
        '  end',
        '  scope "/api", MyAppWeb.Api do',
        '    post "/reports", ReportController, :create',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    write(
      dir,
      'lib/my_app_web/controllers/page_controller.ex',
      'defmodule MyAppWeb.PageController do\n  use MyAppWeb, :controller\n  def index(conn, _params), do: conn\nend\n',
    );
    write(
      dir,
      'lib/my_app_web/controllers/api/report_controller.ex',
      'defmodule MyAppWeb.Api.ReportController do\n  use MyAppWeb, :controller\n  def create(conn, _params), do: conn\nend\n',
    );
    write(
      dir,
      'lib/my_app_web/live/dashboard_live.ex',
      'defmodule MyAppWeb.DashboardLive do\n  use MyAppWeb, :live_view\n  def render(assigns), do: ~H""\nend\n',
    );
    write(
      dir,
      'lib/my_app_web/live/counter_component.ex',
      'defmodule MyAppWeb.CounterComponent do\n  use Phoenix.LiveComponent\n  def render(assigns), do: ~H""\nend\n',
    );
    write(
      dir,
      'lib/my_app_web/views/page_view.ex',
      'defmodule MyAppWeb.PageView do\n  use Phoenix.View, root: "lib/my_app_web/templates"\nend\n',
    );
    write(dir, 'lib/my_app_web/templates/page/index.html.heex', '<h1>Home</h1>\n');

    graph = await new ElixirExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'phoenix', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    ({ groups } = await phoenixAdapter.groupingPrior!(ctx));
    edges = await phoenixAdapter.syntheticEdges!(ctx);
    roles = await phoenixAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('groups each Phoenix context into its own named subsystem (web tree excluded)', () => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get('accounts')?.label).toBe('Accounts');
    // The context group carries the dir files + the sibling context-head module.
    expect(byId.get('accounts')?.fileIds).toEqual([
      'lib/my_app/accounts.ex',
      'lib/my_app/accounts/service.ex',
      'lib/my_app/accounts/user.ex',
    ]);
    expect(byId.get('billing')?.label).toBe('Billing');
    // The web tree is NOT a context; a scattered top-level file isn't one either.
    expect([...byId.keys()].some((id) => id.includes('web'))).toBe(false);
    expect(byId.has('application')).toBe(false);
  });

  it('tags roles onto locked MODULE_KINDS', () => {
    // Web request entries → gateway.
    expect(roles.get('lib/my_app_web/endpoint.ex')).toMatchObject({ role: 'endpoint', kind: 'gateway' });
    expect(roles.get('lib/my_app_web/router.ex')).toMatchObject({ role: 'router', kind: 'gateway' });
    expect(roles.get('lib/my_app_web/controllers/page_controller.ex')).toMatchObject({
      role: 'controller',
      kind: 'gateway',
    });
    // LiveView / LiveComponent → frontend.
    expect(roles.get('lib/my_app_web/live/dashboard_live.ex')).toMatchObject({
      role: 'live-view',
      kind: 'frontend',
    });
    expect(roles.get('lib/my_app_web/live/counter_component.ex')).toMatchObject({
      role: 'live-component',
      kind: 'frontend',
    });
    // A non-schema context module → service.
    expect(roles.get('lib/my_app/accounts/service.ex')).toMatchObject({ role: 'context', kind: 'service' });
    // A schema under a context dir is NOT tagged 'context' (Ecto owns it).
    expect(roles.get('lib/my_app/accounts/user.ex')).toBeUndefined();
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'frontend', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('emits the router route spine (kind calls), resolving across scope aliases', () => {
    const keys = new Set(edges.map(edgeKey));
    // Default `scope "/", MyAppWeb` → controller + live resolved via the web ns.
    expect(keys).toContain('lib/my_app_web/router.ex→lib/my_app_web/controllers/page_controller.ex:calls');
    expect(keys).toContain('lib/my_app_web/router.ex→lib/my_app_web/live/dashboard_live.ex:calls');
    // Nested `scope "/api", MyAppWeb.Api` → resolves via the longer alias prefix.
    expect(keys).toContain(
      'lib/my_app_web/router.ex→lib/my_app_web/controllers/api/report_controller.ex:calls',
    );
    // All route edges are the locked `calls` verb.
    const routeEdges = edges.filter((e) => String(e.metadata?.relation).startsWith('route-'));
    expect(routeEdges.length).toBeGreaterThanOrEqual(3);
    expect(routeEdges.every((e) => e.kind === 'calls')).toBe(true);
  });

  it('attaches a template to its owning view module (renders-template)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain(
      'lib/my_app_web/views/page_view.ex→lib/my_app_web/templates/page/index.html.heex:calls',
    );
    const tmpl = edges.find((e) => e.metadata?.relation === 'renders-template');
    expect(tmpl?.kind).toBe('calls');
  });

  it('is deterministic across two runs (stable ids + ordering)', async () => {
    const g2 = (await phoenixAdapter.groupingPrior!(ctx)).groups;
    const e2 = await phoenixAdapter.syntheticEdges!(ctx);
    const r2 = await phoenixAdapter.roleTags!(ctx);
    expect(g2).toEqual(groups);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
    expect([...r2.keys()].sort()).toEqual([...roles.keys()].sort());
  });
});
