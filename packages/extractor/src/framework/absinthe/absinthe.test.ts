// Absinthe adapter tests — the Elixir GraphQL protocol adapter, mirroring
// phoenix.test.ts's three tiers:
//   (1) scoreAbsinthe is PURE (dep present/absent, rootPath).
//   (2) detect() runs against real tmp mix.exs dirs (+ a non-Absinthe Elixir
//       no-match, a TS no-match, a nested app, the absinthe_plug variant).
//   (3) the analysis hooks run over a REAL ElixirExtractor graph of a small on-disk
//       Absinthe fixture and assert the file-id-space contributions (schema/notation
//       → gateway role graphql; a referenced resolver → gateway role graphql-resolver;
//       import_types → types file; resolve &Mod.fn → resolver file). The
//       contribute-step resolves file ids to modules downstream.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  absintheAdapter,
  scoreAbsinthe,
  gatherAbsintheSignals,
  type AbsintheSignals,
} from './absinthe.js';
import { ElixirExtractor } from '../../graph/elixir-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: AbsintheSignals = { hasAbsinthe: false };

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
// scoreAbsinthe (pure)

describe('scoreAbsinthe (pure)', () => {
  it('returns null with no absinthe dep (generic-Elixir fallthrough)', () => {
    expect(scoreAbsinthe(NO_SIGNALS)).toBeNull();
  });

  it('detects Absinthe on the absinthe dep', () => {
    const m = scoreAbsinthe({ hasAbsinthe: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('absinthe');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('passes rootPath through', () => {
    const m = scoreAbsinthe({ hasAbsinthe: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('absintheAdapter.detect (fs fixtures)', () => {
  let absintheRepo: string;
  let plugRepo: string;
  let plainElixir: string;
  let tsRepo: string;

  beforeAll(() => {
    absintheRepo = mkdtempSync(join(tmpdir(), 'bt-abs-ok-'));
    writeFileSync(join(absintheRepo, 'mix.exs'), mixExs(['phoenix', 'absinthe', 'ecto_sql']));

    // absinthe_plug pulls absinthe in — a valid GraphQL-over-HTTP setup.
    plugRepo = mkdtempSync(join(tmpdir(), 'bt-abs-plug-'));
    writeFileSync(join(plugRepo, 'mix.exs'), mixExs(['phoenix', 'absinthe_plug']));

    plainElixir = mkdtempSync(join(tmpdir(), 'bt-abs-plain-'));
    writeFileSync(join(plainElixir, 'mix.exs'), mixExs(['jason', 'ecto', 'phoenix']));

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-abs-ts-'));
    writeFileSync(
      join(tsRepo, 'package.json'),
      JSON.stringify({ name: 'web', dependencies: { react: '18' } }),
    );
  });

  afterAll(() => {
    for (const d of [absintheRepo, plugRepo, plainElixir, tsRepo]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('detects Absinthe from mix.exs deps', async () => {
    const m = await absintheAdapter.detect({ repoDir: absintheRepo });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('absinthe');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('detects Absinthe via the absinthe_plug integration', async () => {
    const m = await absintheAdapter.detect({ repoDir: plugRepo });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('absinthe');
  });

  it('does NOT detect a non-Absinthe Elixir repo', async () => {
    expect(await absintheAdapter.detect({ repoDir: plainElixir })).toBeNull();
  });

  it('does NOT detect a TS repo (no mix manifest)', async () => {
    expect(await absintheAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED Absinthe app and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-abs-nested-'));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'mix.exs'), mixExs(['absinthe']));
    try {
      const m = await absintheAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherAbsintheSignals reads deps from mix.exs', () => {
    expect(gatherAbsintheSignals(absintheRepo).hasAbsinthe).toBe(true);
    expect(gatherAbsintheSignals(plugRepo).hasAbsinthe).toBe(true);
    expect(gatherAbsintheSignals(plainElixir).hasAbsinthe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real Absinthe fixture

describe('absintheAdapter analysis (syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-abs-app-'));

    // The root schema — import_types (one in-repo, one external) + a resolve capture.
    write(
      dir,
      'lib/my_app_web/schema.ex',
      [
        'defmodule MyAppWeb.Schema do',
        '  use Absinthe.Schema',
        '',
        '  import_types MyAppWeb.Schema.AccountTypes',
        '  import_types Absinthe.Type.Custom',
        '',
        '  query do',
        '    field :users, list_of(:user) do',
        '      resolve &MyAppWeb.Resolvers.Accounts.list_users/3',
        '    end',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    // A types (notation) module.
    write(
      dir,
      'lib/my_app_web/schema/account_types.ex',
      [
        'defmodule MyAppWeb.Schema.AccountTypes do',
        '  use Absinthe.Schema.Notation',
        '',
        '  object :user do',
        '    field :email, :string',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    // A plain resolver module — tagged only via the schema reference.
    write(
      dir,
      'lib/my_app_web/resolvers/accounts.ex',
      [
        'defmodule MyAppWeb.Resolvers.Accounts do',
        '  def list_users(_parent, _args, _res), do: {:ok, []}',
        'end',
        '',
      ].join('\n'),
    );
    // A non-GraphQL module — must stay untagged.
    write(
      dir,
      'lib/my_app/application.ex',
      'defmodule MyApp.Application do\n  def start(_, _), do: :ok\nend\n',
    );

    graph = await new ElixirExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'absinthe', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    edges = await absintheAdapter.syntheticEdges!(ctx);
    roles = await absintheAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags schema + notation modules gateway (role graphql)', () => {
    expect(roles.get('lib/my_app_web/schema.ex')).toMatchObject({ role: 'graphql', kind: 'gateway' });
    expect(roles.get('lib/my_app_web/schema/account_types.ex')).toMatchObject({
      role: 'graphql',
      kind: 'gateway',
    });
    // A non-GraphQL module is not tagged.
    expect(roles.get('lib/my_app/application.ex')).toBeUndefined();
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'frontend', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('tags a referenced resolver module gateway (role graphql-resolver)', () => {
    expect(roles.get('lib/my_app_web/resolvers/accounts.ex')).toMatchObject({
      role: 'graphql-resolver',
      kind: 'gateway',
    });
  });

  it('emits the schema→types import_types edge (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain(
      'lib/my_app_web/schema.ex→lib/my_app_web/schema/account_types.ex:calls',
    );
    const imp = edges.find((e) => e.metadata?.relation === 'import-types');
    expect(imp?.kind).toBe('calls');
  });

  it('emits the schema→resolver resolve edge (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain(
      'lib/my_app_web/schema.ex→lib/my_app_web/resolvers/accounts.ex:calls',
    );
    const res = edges.find((e) => e.metadata?.relation === 'resolve');
    expect(res?.kind).toBe('calls');
  });

  it('drops an external import_types with no in-repo module (no edge)', () => {
    // Absinthe.Type.Custom is a library type set — never resolves to a repo file.
    expect(edges.some((e) => e.target.includes('custom'))).toBe(false);
    // Exactly the two resolvable edges (import_types + resolve), nothing spurious.
    expect(edges.length).toBe(2);
  });

  it('is deterministic across a genuinely fresh re-parse (stable ordering + values)', async () => {
    // A NEW context object → the WeakMap analysis cache MISSES → analyzeAbsinthe
    // re-reads + re-parses the fixture from disk.
    const ctx2: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'absinthe', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const e2 = await absintheAdapter.syntheticEdges!(ctx2);
    const r2 = await absintheAdapter.roleTags!(ctx2);
    expect(e2).toEqual(edges);
    const entries = (m: Map<string, RoleTag>) =>
      [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(r2)).toEqual(entries(roles));
  });
});
