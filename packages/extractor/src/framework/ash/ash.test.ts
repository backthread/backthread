// Ash adapter tests (DATA) — mirroring ecto.test.ts's three tiers:
//   (1) scoreAsh is PURE (dep present/absent, extension confidence bump, rootPath).
//   (2) detect() runs against real tmp mix.exs dirs (+ an extension bump, a
//       non-Ash Elixir no-match, a TS no-match, a nested app).
//   (3) the analysis hooks run over a REAL ElixirExtractor graph of a small on-disk
//       Ash fixture and assert the file-id-space contributions (resource → service
//       role 'ash-resource'; Api/Domain → gateway role 'ash-api'; belongs_to/
//       has_many/has_one/many_to_many → 'calls' relationship edges; a declared
//       domain → a domain group). The contribute-step resolves file ids to modules
//       downstream.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ashAdapter, scoreAsh, gatherAshSignals, type AshSignals } from './ash.js';
import { ElixirExtractor } from '../../graph/elixir-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: AshSignals = {
  hasAsh: false,
  hasAshPostgres: false,
  hasAshGraphql: false,
  hasAshPhoenix: false,
};

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// A mix.exs whose deps/0 declares the given dep atoms.
function mixExs(deps: string[]): string {
  const tuples = deps.map((d) => `      {:${d}, "~> 3.0"},`).join('\n');
  return `defmodule App.MixProject do\n  use Mix.Project\n  defp deps do\n    [\n${tuples}\n    ]\n  end\nend\n`;
}

// ---------------------------------------------------------------------------
// scoreAsh (pure)

describe('scoreAsh (pure)', () => {
  it('returns null with no ash dep (generic-Elixir fallthrough)', () => {
    expect(scoreAsh(NO_SIGNALS)).toBeNull();
  });

  it('returns null when only an extension is present without ash (ash authoritative)', () => {
    expect(scoreAsh({ ...NO_SIGNALS, hasAshPostgres: true })).toBeNull();
  });

  it('detects Ash on the ash dep', () => {
    const m = scoreAsh({ ...NO_SIGNALS, hasAsh: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('ash');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('raises confidence with an Ash extension (ash_postgres/ash_graphql/ash_phoenix)', () => {
    const bare = scoreAsh({ ...NO_SIGNALS, hasAsh: true })!;
    const withPg = scoreAsh({ ...NO_SIGNALS, hasAsh: true, hasAshPostgres: true })!;
    const withGql = scoreAsh({ ...NO_SIGNALS, hasAsh: true, hasAshGraphql: true })!;
    const withPhx = scoreAsh({ ...NO_SIGNALS, hasAsh: true, hasAshPhoenix: true })!;
    expect(withPg.confidence).toBeGreaterThan(bare.confidence);
    expect(withGql.confidence).toBeGreaterThan(bare.confidence);
    expect(withPhx.confidence).toBeGreaterThan(bare.confidence);
    expect((withPg.metadata?.signals as Record<string, boolean>).ash_postgres).toBe(true);
  });

  it('passes rootPath through', () => {
    const m = scoreAsh({ ...NO_SIGNALS, hasAsh: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('ashAdapter.detect (fs fixtures)', () => {
  let ashRepo: string;
  let ashBare: string;
  let plainElixir: string;
  let tsRepo: string;

  beforeAll(() => {
    ashRepo = mkdtempSync(join(tmpdir(), 'bt-ash-ok-'));
    writeFileSync(join(ashRepo, 'mix.exs'), mixExs(['ash', 'ash_postgres', 'postgrex']));

    ashBare = mkdtempSync(join(tmpdir(), 'bt-ash-bare-'));
    writeFileSync(join(ashBare, 'mix.exs'), mixExs(['ash', 'jason']));

    plainElixir = mkdtempSync(join(tmpdir(), 'bt-ash-plain-'));
    writeFileSync(join(plainElixir, 'mix.exs'), mixExs(['ecto', 'jason', 'plug']));

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-ash-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [ashRepo, ashBare, plainElixir, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects Ash from mix.exs deps (with extension confidence bump)', async () => {
    const m = await ashAdapter.detect({ repoDir: ashRepo });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('ash');
    expect(m!.confidence).toBeGreaterThan(0.8);
  });

  it('detects Ash on the ash dep alone (no extension)', async () => {
    const m = await ashAdapter.detect({ repoDir: ashBare });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('ash');
    expect(m!.confidence).toBeCloseTo(0.8, 5);
  });

  it('does NOT detect a non-Ash Elixir repo (ecto only)', async () => {
    expect(await ashAdapter.detect({ repoDir: plainElixir })).toBeNull();
  });

  it('does NOT detect a TS repo (no mix manifest)', async () => {
    expect(await ashAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED Ash app and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-ash-nested-'));
    // A polyglot monorepo: no root mix.exs; ash under backend/.
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'mix.exs'), mixExs(['ash', 'ash_postgres']));
    try {
      const m = await ashAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherAshSignals reads deps from mix.exs', () => {
    const s = gatherAshSignals(ashRepo);
    expect(s.hasAsh).toBe(true);
    expect(s.hasAshPostgres).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real Ash fixture

describe('ashAdapter analysis (groupingPrior / syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let groups: Awaited<ReturnType<NonNullable<typeof ashAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-ash-app-'));

    // ── The Domain (Ash 3.0 `use Ash.Domain`) ──
    write(
      dir,
      'lib/my_app/blog.ex',
      [
        'defmodule MyApp.Blog do',
        '  use Ash.Domain',
        '  resources do',
        '    resource MyApp.Blog.Post',
        '    resource MyApp.Blog.Comment',
        '    resource MyApp.Blog.Tag',
        '  end',
        'end',
        '',
      ].join('\n'),
    );

    // ── An Ash 2.x-style Api (use Ash.Api) — both must classify as ash-api ──
    write(
      dir,
      'lib/my_app/accounts_api.ex',
      [
        'defmodule MyApp.AccountsApi do',
        '  use Ash.Api',
        'end',
        '',
      ].join('\n'),
    );

    // ── Blog domain: three resources with relationships (a domain group) ──
    // Post declares its domain on a MULTI-LINE use (the shape useDirectives joins).
    write(
      dir,
      'lib/my_app/blog/post.ex',
      [
        'defmodule MyApp.Blog.Post do',
        '  use Ash.Resource,',
        '    domain: MyApp.Blog,',
        '    data_layer: AshPostgres.DataLayer',
        '',
        '  relationships do',
        '    belongs_to :author, MyApp.Accounts.User',
        '    has_many :comments, MyApp.Blog.Comment',
        '    many_to_many :tags, MyApp.Blog.Tag, through: MyApp.Blog.PostTag',
        '    belongs_to :editor do',
        '      destination MyApp.Accounts.User',
        '    end',
        '    has_many :legacy, MyApp.External.Thing',
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
        '  use Ash.Resource, domain: MyApp.Blog',
        '  relationships do',
        '    belongs_to :post, MyApp.Blog.Post',
        '    belongs_to :ghost',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    write(
      dir,
      'lib/my_app/blog/tag.ex',
      [
        'defmodule MyApp.Blog.Tag do',
        '  use Ash.Resource, domain: MyApp.Blog',
        '  relationships do',
        '    many_to_many :posts, MyApp.Blog.Post, through: MyApp.Blog.PostTag',
        '  end',
        'end',
        '',
      ].join('\n'),
    );

    // ── An Accounts resource in its OWN dir with a domain (grouped by domain) ──
    write(
      dir,
      'lib/my_app/accounts/user.ex',
      [
        'defmodule MyApp.Accounts.User do',
        '  use Ash.Resource, domain: MyApp.Accounts',
        '  relationships do',
        '    has_one :profile, MyApp.Accounts.Profile',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
    write(
      dir,
      'lib/my_app/accounts/profile.ex',
      [
        'defmodule MyApp.Accounts.Profile do',
        '  use Ash.Resource, domain: MyApp.Accounts',
        '  relationships do',
        '    belongs_to :user, MyApp.Accounts.User',
        '  end',
        'end',
        '',
      ].join('\n'),
    );

    // ── A domain-less resource pair in a resources/ dir → directory fallback ──
    write(
      dir,
      'lib/my_app/resources/widget.ex',
      [
        'defmodule MyApp.Resources.Widget do',
        '  use Ash.Resource',
        'end',
        '',
      ].join('\n'),
    );
    write(
      dir,
      'lib/my_app/resources/gadget.ex',
      [
        'defmodule MyApp.Resources.Gadget do',
        '  use Ash.Resource',
        'end',
        '',
      ].join('\n'),
    );

    // ── A plain module — not an Ash resource; a stray has_many must NOT emit ──
    write(
      dir,
      'lib/my_app/plain.ex',
      [
        'defmodule MyApp.Plain do',
        '  def hello, do: :world',
        '  # a stray relationship-looking macro in a NON-Ash module',
        '  has_many :ignored, MyApp.Blog.Post',
        'end',
        '',
      ].join('\n'),
    );

    graph = await new ElixirExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'ash', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    ({ groups } = await ashAdapter.groupingPrior!(ctx));
    edges = await ashAdapter.syntheticEdges!(ctx);
    roles = await ashAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags resource modules as service (role ash-resource) with the domain', () => {
    expect(roles.get('lib/my_app/blog/post.ex')).toMatchObject({
      role: 'ash-resource',
      kind: 'service',
      metadata: { framework: 'ash', domain: 'MyApp.Blog' },
    });
    expect(roles.get('lib/my_app/accounts/user.ex')).toMatchObject({
      role: 'ash-resource',
      kind: 'service',
      metadata: { domain: 'MyApp.Accounts' },
    });
    // A domain-less resource still gets the role (no domain in metadata).
    expect(roles.get('lib/my_app/resources/widget.ex')).toMatchObject({ role: 'ash-resource', kind: 'service' });
    expect(roles.get('lib/my_app/resources/widget.ex')?.metadata?.domain).toBeUndefined();
    // A plain module is untouched.
    expect(roles.get('lib/my_app/plain.ex')).toBeUndefined();
  });

  it('tags Api (use Ash.Api) and Domain (use Ash.Domain) modules as gateway (role ash-api)', () => {
    expect(roles.get('lib/my_app/blog.ex')).toMatchObject({ role: 'ash-api', kind: 'gateway' });
    expect(roles.get('lib/my_app/accounts_api.ex')).toMatchObject({ role: 'ash-api', kind: 'gateway' });
    // Api/Domain is an ENTRY = gateway, NEVER the infra `datastore` kind.
    expect(roles.get('lib/my_app/blog.ex')?.kind).not.toBe('datastore');
    // Every role kind is a locked CODE-altitude value — never an infra kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'frontend', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('emits relationship edges (kind calls) resolving belongs_to/has_many/has_one/many_to_many', () => {
    const keys = new Set(edges.map(edgeKey));
    // belongs_to → the referenced resource file.
    expect(keys).toContain('lib/my_app/blog/comment.ex→lib/my_app/blog/post.ex:calls');
    // has_many → the referenced resource file.
    expect(keys).toContain('lib/my_app/blog/post.ex→lib/my_app/blog/comment.ex:calls');
    // many_to_many → the related resource (Tag), from Tag's own side to Post too.
    expect(keys).toContain('lib/my_app/blog/tag.ex→lib/my_app/blog/post.ex:calls');
    // belongs_to :author → the User resource in another dir.
    expect(keys).toContain('lib/my_app/blog/post.ex→lib/my_app/accounts/user.ex:calls');
    // has_one → the related resource file.
    expect(keys).toContain('lib/my_app/accounts/user.ex→lib/my_app/accounts/profile.ex:calls');
    // Every relationship edge is the locked `calls` verb + carries the relation.
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
    expect(edges.every((e) => e.metadata?.framework === 'ash')).toBe(true);
    const relations = new Set(edges.map((e) => String(e.metadata?.relation)));
    expect(relations).toContain('belongs_to');
    expect(relations).toContain('has_many');
    expect(relations).toContain('has_one');
    expect(relations).toContain('many_to_many');
  });

  it('drops block-form / name-inferred / unresolvable (external) targets, and the stray non-Ash macro', () => {
    const keys = new Set(edges.map(edgeKey));
    // `belongs_to :editor do destination ... end` (block form) names no module on the
    // macro line → no edge (the `destination` line is not a relationship macro); the
    // has_many :legacy → MyApp.External.Thing is unresolved (external) → no edge.
    expect([...keys].some((k) => k.includes('External'))).toBe(false);
    // `belongs_to :ghost` (name-inferred, no module) emits nothing.
    // The stray `has_many :ignored, MyApp.Blog.Post` in the NON-Ash MyApp.Plain
    // module must NOT produce an edge (only Ash.Resource modules are walked).
    expect([...keys].some((k) => k.startsWith('lib/my_app/plain.ex'))).toBe(false);
    // No edge points out of the first-party file set.
    const fileIds = new Set(graph.files.map((f) => f.id));
    for (const e of edges) {
      expect(fileIds.has(e.source)).toBe(true);
      expect(fileIds.has(e.target)).toBe(true);
    }
  });

  it('groups resources by declared Ash domain (Blog + Accounts), dir fallback for domain-less', () => {
    const blog = groups.find((g) => g.label === 'Blog');
    expect(blog).toBeDefined();
    // Blog domain holds post, comment, tag (all `domain: MyApp.Blog`).
    expect(blog!.fileIds).toEqual([
      'lib/my_app/blog/comment.ex',
      'lib/my_app/blog/post.ex',
      'lib/my_app/blog/tag.ex',
    ]);
    // Accounts domain holds user + profile (grouped by domain, NOT dir).
    const accounts = groups.find((g) => g.label === 'Accounts');
    expect(accounts).toBeDefined();
    expect(accounts!.fileIds).toEqual([
      'lib/my_app/accounts/profile.ex',
      'lib/my_app/accounts/user.ex',
    ]);
    // The domain-less resources/ dir (≥2) falls back to a 'Data Model' group
    // (resources/ is a models-ish dir name).
    const dataModel = groups.find((g) => g.label === 'Data Model');
    expect(dataModel).toBeDefined();
    expect(dataModel!.fileIds).toEqual([
      'lib/my_app/resources/gadget.ex',
      'lib/my_app/resources/widget.ex',
    ]);
  });

  it('is deterministic across a genuinely fresh re-parse (stable ids, ordering + values)', async () => {
    // A NEW context object → the WeakMap analysis cache MISSES → analyzeAsh re-reads
    // + re-parses the fixture from disk (reusing `ctx` would short-circuit on the
    // cache and compare identical references — not a real determinism check).
    const ctx2: FrameworkContext = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'ash', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    const g2 = (await ashAdapter.groupingPrior!(ctx2)).groups;
    const e2 = await ashAdapter.syntheticEdges!(ctx2);
    const r2 = await ashAdapter.roleTags!(ctx2);
    expect(g2).toEqual(groups);
    expect(e2).toEqual(edges);
    const entries = (m: Map<string, RoleTag>) =>
      [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(r2)).toEqual(entries(roles));
  });
});
