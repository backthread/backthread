// Ecto adapter tests (DATA) — mirroring phoenix.test.ts's / python-orm.test.ts's
// three tiers:
//   (1) scoreEcto is PURE (dep present/absent, ecto_sql confidence, rootPath).
//   (2) detect() runs against real tmp mix.exs dirs (+ an ecto_sql-only match, a
//       non-Ecto Elixir no-match, a TS no-match, a nested app).
//   (3) the analysis hooks run over a REAL ElixirExtractor graph of a small on-disk
//       Ecto fixture and assert the file-id-space contributions (schema → service
//       role 'schema'; Repo → service role 'repo'; has_many/belongs_to/many_to_many
//       → 'calls' association edges; a ≥2-schema dir → a data-model group). The
//       contribute-step resolves file ids to modules downstream.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ectoAdapter, scoreEcto, gatherEctoSignals, type EctoSignals } from './ecto.js';
import { ElixirExtractor } from '../../graph/elixir-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: EctoSignals = { hasEcto: false, hasEctoSql: false };

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
// scoreEcto (pure)

describe('scoreEcto (pure)', () => {
  it('returns null with no ecto/ecto_sql dep (generic-Elixir fallthrough)', () => {
    expect(scoreEcto(NO_SIGNALS)).toBeNull();
  });

  it('detects Ecto on the ecto dep', () => {
    const m = scoreEcto({ ...NO_SIGNALS, hasEcto: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('ecto');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects Ecto on ecto_sql alone (pulls ecto transitively)', () => {
    const m = scoreEcto({ hasEcto: false, hasEctoSql: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('ecto');
  });

  it('raises confidence with ecto_sql', () => {
    const bare = scoreEcto({ hasEcto: true, hasEctoSql: false })!;
    const sql = scoreEcto({ hasEcto: true, hasEctoSql: true })!;
    expect(sql.confidence).toBeGreaterThan(bare.confidence);
    expect((sql.metadata?.signals as Record<string, boolean>).ecto_sql).toBe(true);
  });

  it('passes rootPath through', () => {
    const m = scoreEcto({ ...NO_SIGNALS, hasEcto: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('ectoAdapter.detect (fs fixtures)', () => {
  let ectoRepo: string;
  let ectoSqlOnly: string;
  let plainElixir: string;
  let tsRepo: string;

  beforeAll(() => {
    ectoRepo = mkdtempSync(join(tmpdir(), 'bt-ecto-ok-'));
    writeFileSync(join(ectoRepo, 'mix.exs'), mixExs(['ecto', 'ecto_sql', 'postgrex']));

    ectoSqlOnly = mkdtempSync(join(tmpdir(), 'bt-ecto-sql-'));
    writeFileSync(join(ectoSqlOnly, 'mix.exs'), mixExs(['ecto_sql', 'postgrex']));

    plainElixir = mkdtempSync(join(tmpdir(), 'bt-ecto-plain-'));
    writeFileSync(join(plainElixir, 'mix.exs'), mixExs(['jason', 'oban', 'plug']));

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-ecto-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [ectoRepo, ectoSqlOnly, plainElixir, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects Ecto from mix.exs deps (with ecto_sql confidence)', async () => {
    const m = await ectoAdapter.detect({ repoDir: ectoRepo });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('ecto');
    expect(m!.confidence).toBeGreaterThan(0.8);
  });

  it('detects Ecto from ecto_sql alone', async () => {
    const m = await ectoAdapter.detect({ repoDir: ectoSqlOnly });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('ecto');
  });

  it('does NOT detect a non-Ecto Elixir repo', async () => {
    expect(await ectoAdapter.detect({ repoDir: plainElixir })).toBeNull();
  });

  it('does NOT detect a TS repo (no mix manifest)', async () => {
    expect(await ectoAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED Ecto app and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-ecto-nested-'));
    // A polyglot monorepo: no root mix.exs; ecto under backend/.
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'mix.exs'), mixExs(['ecto_sql']));
    try {
      const m = await ectoAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherEctoSignals reads deps from mix.exs', () => {
    const s = gatherEctoSignals(ectoRepo);
    expect(s.hasEcto).toBe(true);
    expect(s.hasEctoSql).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real Ecto fixture

describe('ectoAdapter analysis (groupingPrior / syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let groups: Awaited<ReturnType<NonNullable<typeof ectoAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-ecto-app-'));

    // ── The Repo (multi-line `use Ecto.Repo,` — the shape useDirectives misses) ──
    write(
      dir,
      'lib/my_app/repo.ex',
      [
        'defmodule MyApp.Repo do',
        '  use Ecto.Repo,',
        '    otp_app: :my_app,',
        '    adapter: Ecto.Adapters.Postgres',
        'end',
        '',
      ].join('\n'),
    );

    // ── Blog context: two schemas with associations (a ≥2-schema dir) ──
    write(
      dir,
      'lib/my_app/blog/post.ex',
      [
        'defmodule MyApp.Blog.Post do',
        '  use Ecto.Schema',
        '  schema "posts" do',
        '    field :title, :string',
        '    belongs_to :author, MyApp.Accounts.User',
        '    has_many :comments, MyApp.Blog.Comment',
        '    many_to_many :tags, MyApp.Blog.Tag, join_through: "posts_tags"',
        '    has_many :orphan_links, through: [:comments, :links]',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    write(
      dir,
      'lib/my_app/blog/comment.ex',
      [
        'defmodule MyApp.Blog.Comment do',
        '  use Ecto.Schema',
        '  schema "comments" do',
        '    field :body, :string',
        '    belongs_to :post, MyApp.Blog.Post',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    // A tag schema referenced by the many_to_many (resolves to a first-party file).
    write(
      dir,
      'lib/my_app/blog/tag.ex',
      [
        'defmodule MyApp.Blog.Tag do',
        '  use Ecto.Schema',
        '  schema "tags" do',
        '    field :name, :string',
        '  end',
        'end',
        '',
      ].join('\n'),
    );

    // ── A lone schema in its own dir (accounts/) — NOT grouped (single file) ──
    write(
      dir,
      'lib/my_app/accounts/user.ex',
      [
        'defmodule MyApp.Accounts.User do',
        '  use Ecto.Schema',
        '  schema "users" do',
        '    field :email, :string',
        '    has_one :profile, MyApp.External.Profile',
        '  end',
        'end',
        '',
      ].join('\n'),
    );

    // ── An embedded schema (no table) + a plain module — neither is an entity ──
    write(
      dir,
      'lib/my_app/blog/settings.ex',
      [
        'defmodule MyApp.Blog.Settings do',
        '  use Ecto.Schema',
        '  embedded_schema do',
        '    field :theme, :string',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    write(
      dir,
      'lib/my_app/plain.ex',
      'defmodule MyApp.Plain do\n  def hello, do: :world\nend\n',
    );

    graph = await new ElixirExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'ecto', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    ({ groups } = await ectoAdapter.groupingPrior!(ctx));
    edges = await ectoAdapter.syntheticEdges!(ctx);
    roles = await ectoAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags schema modules as service (role schema) with the table name', () => {
    expect(roles.get('lib/my_app/blog/post.ex')).toMatchObject({
      role: 'schema',
      kind: 'service',
      metadata: { framework: 'ecto', table: 'posts' },
    });
    expect(roles.get('lib/my_app/accounts/user.ex')).toMatchObject({ role: 'schema', kind: 'service' });
    // An embedded schema (no table) is NOT an entity → no role.
    expect(roles.get('lib/my_app/blog/settings.ex')).toBeUndefined();
    // A plain module is untouched.
    expect(roles.get('lib/my_app/plain.ex')).toBeUndefined();
  });

  it('tags the Repo module as service (role repo), reading the multi-line use', () => {
    expect(roles.get('lib/my_app/repo.ex')).toMatchObject({ role: 'repo', kind: 'service' });
    // Repo is data-access CODE = service, NEVER the infra `datastore` kind.
    expect(roles.get('lib/my_app/repo.ex')?.kind).not.toBe('datastore');
    // Every role kind is a locked CODE-altitude value — never an infra kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'frontend', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('emits association edges (kind calls) resolving has_many/belongs_to/many_to_many', () => {
    const keys = new Set(edges.map(edgeKey));
    // belongs_to → the referenced schema file.
    expect(keys).toContain('lib/my_app/blog/comment.ex→lib/my_app/blog/post.ex:calls');
    // has_many → the referenced schema file.
    expect(keys).toContain('lib/my_app/blog/post.ex→lib/my_app/blog/comment.ex:calls');
    // many_to_many → the associated queryable (Tag), NOT the join_through string.
    expect(keys).toContain('lib/my_app/blog/post.ex→lib/my_app/blog/tag.ex:calls');
    // belongs_to :author → the User schema in another dir.
    expect(keys).toContain('lib/my_app/blog/post.ex→lib/my_app/accounts/user.ex:calls');
    // Every association edge is the locked `calls` verb + carries the relation.
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
    expect(edges.every((e) => e.metadata?.framework === 'ecto')).toBe(true);
    const relations = new Set(edges.map((e) => String(e.metadata?.relation)));
    expect(relations).toContain('belongs_to');
    expect(relations).toContain('has_many');
    expect(relations).toContain('many_to_many');
  });

  it('drops through-associations and unresolvable (external) targets, without throwing', () => {
    const keys = new Set(edges.map(edgeKey));
    // `has_many :orphan_links, through: [...]` names no module → no edge.
    // `has_one :profile, MyApp.External.Profile` → unresolved (external) → no edge.
    expect([...keys].some((k) => k.includes('External'))).toBe(false);
    // No edge points out of the first-party file set.
    const fileIds = new Set(graph.files.map((f) => f.id));
    for (const e of edges) {
      expect(fileIds.has(e.source)).toBe(true);
      expect(fileIds.has(e.target)).toBe(true);
    }
  });

  it('groups a ≥2-schema directory into a data subsystem (single-schema dir excluded)', () => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    // blog/ holds 3 table schemas (post, comment, tag) → one 'Blog' data group.
    const blog = groups.find((g) => g.label === 'Blog');
    expect(blog).toBeDefined();
    expect(blog!.fileIds).toEqual([
      'lib/my_app/blog/comment.ex',
      'lib/my_app/blog/post.ex',
      'lib/my_app/blog/tag.ex',
    ]);
    // accounts/ holds a single schema → NOT grouped (left to directory grouping).
    expect([...byId.values()].some((g) => g.fileIds.includes('lib/my_app/accounts/user.ex'))).toBe(false);
    // The embedded (non-entity) schema is not in any data group.
    expect([...byId.values()].some((g) => g.fileIds.includes('lib/my_app/blog/settings.ex'))).toBe(false);
  });

  it('is deterministic across a genuinely fresh re-parse (stable ids, ordering + values)', async () => {
    // A NEW context object → the WeakMap analysis cache MISSES → analyzeEcto re-reads
    // + re-parses the fixture from disk (reusing `ctx` would short-circuit on the
    // cache and compare identical references — not a real determinism check).
    const ctx2: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'ecto', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const g2 = (await ectoAdapter.groupingPrior!(ctx2)).groups;
    const e2 = await ectoAdapter.syntheticEdges!(ctx2);
    const r2 = await ectoAdapter.roleTags!(ctx2);
    expect(g2).toEqual(groups);
    expect(e2).toEqual(edges);
    const entries = (m: Map<string, RoleTag>) =>
      [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(r2)).toEqual(entries(roles));
  });
});
