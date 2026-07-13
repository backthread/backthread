// The Elixir import-graph extractor, over a small on-disk Phoenix-shaped fixture.
// Asserts the directive-driven internal edges, external dependency collapse, the
// mix.exs skip, that an internal app namespace never leaks as an external, and
// determinism across runs.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ElixirExtractor, extractFileCalls } from './elixir-adapter.js';
import type { NormalizedGraph } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-elixir-ext-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

const PHOENIXish: Record<string, string> = {
  'mix.exs': 'defmodule MyApp.MixProject do\n  use Mix.Project\nend\n',
  'lib/my_app.ex': 'defmodule MyApp do\nend\n',
  'lib/my_app/repo.ex': 'defmodule MyApp.Repo do\n  use Ecto.Repo, otp_app: :my_app\nend\n',
  'lib/my_app/accounts/user.ex':
    'defmodule MyApp.Accounts.User do\n  use Ecto.Schema\n  import Ecto.Changeset\nend\n',
  'lib/my_app/accounts.ex':
    'defmodule MyApp.Accounts do\n  alias MyApp.Repo\n  alias MyApp.Accounts.User\nend\n',
  'lib/my_app_web.ex': 'defmodule MyAppWeb do\n  def controller do\n  end\nend\n',
  'lib/my_app_web/router.ex':
    'defmodule MyAppWeb.Router do\n  use MyAppWeb, :router\n  alias MyApp.Accounts\nend\n',
  'lib/my_app_web/controllers/user_controller.ex':
    'defmodule MyAppWeb.UserController do\n  use MyAppWeb, :controller\n  alias MyApp.Accounts.{User, Team}\nend\n',
};

function edgeKeys(g: NormalizedGraph): Set<string> {
  return new Set(g.edges.filter((e) => !e.external).map((e) => `${e.from} -> ${e.to}`));
}

function callEdgeKeys(g: NormalizedGraph): Set<string> {
  return new Set(g.edges.filter((e) => e.kind === 'call').map((e) => `${e.from} -> ${e.to}`));
}

function callWeight(g: NormalizedGraph, from: string, to: string): number | undefined {
  return g.edges.find((e) => e.kind === 'call' && e.from === from && e.to === to)?.weight;
}

// A small fixture exercising inline call resolution: aliased calls, a context-alias
// call, a fully-qualified call, and the drops (stdlib / dynamic / self).
const CALLSish: Record<string, string> = {
  'mix.exs': 'defmodule MyApp.MixProject do\nend\n',
  'lib/my_app/repo.ex': 'defmodule MyApp.Repo do\n  use Ecto.Repo, otp_app: :my_app\nend\n',
  'lib/my_app/mailer.ex': 'defmodule MyApp.Mailer do\n  def deliver(_x), do: :ok\nend\n',
  'lib/my_app/accounts/user.ex':
    'defmodule MyApp.Accounts.User do\n  use Ecto.Schema\n  def changeset(u, _a), do: u\n' +
    // a self-referential fully-qualified call must NOT produce a self-edge
    '  def touch(u), do: MyApp.Accounts.User.changeset(u, %{})\nend\n',
  'lib/my_app/accounts.ex':
    'defmodule MyApp.Accounts do\n' +
    '  alias MyApp.Repo\n' +
    '  alias MyApp.Accounts.User\n' +
    '\n' +
    '  def create(attrs) do\n' +
    '    attrs\n' +
    '    |> User.changeset(%{})\n' +
    '    |> Repo.insert()\n' +
    '    Repo.insert(attrs)\n' + // 2nd Repo.insert → weight 2
    '    MyApp.Mailer.deliver(attrs)\n' + // fully-qualified
    '    Enum.map([1, 2], fn x -> x end)\n' + // stdlib → dropped
    '    apply(MyApp.Repo, :insert, [attrs])\n' + // dynamic dispatch → not a Module.fn callee
    '  end\nend\n',
};

describe('ElixirExtractor', () => {
  it('builds a connected import graph from directives, and skips mix.exs', async () => {
    const dir = await repo(PHOENIXish);
    const g = await new ElixirExtractor().extract(dir);

    const fileIds = g.files.map((f) => f.id);
    // mix.exs is a manifest, never a node.
    expect(fileIds).not.toContain('mix.exs');
    expect(fileIds).toContain('lib/my_app/accounts.ex');
    expect(fileIds).toContain('lib/my_app_web/controllers/user_controller.ex');

    const edges = edgeKeys(g);
    // accounts context → repo + user (alias)
    expect(edges).toContain('lib/my_app/accounts.ex -> lib/my_app/repo.ex');
    expect(edges).toContain('lib/my_app/accounts.ex -> lib/my_app/accounts/user.ex');
    // router uses the web base module + aliases the accounts context
    expect(edges).toContain('lib/my_app_web/router.ex -> lib/my_app_web.ex');
    expect(edges).toContain('lib/my_app_web/router.ex -> lib/my_app/accounts.ex');
    // controller: `use MyAppWeb` + multi-alias `{User, Team}` (User resolves; Team is undefined → no edge)
    expect(edges).toContain('lib/my_app_web/controllers/user_controller.ex -> lib/my_app_web.ex');
    expect(edges).toContain('lib/my_app_web/controllers/user_controller.ex -> lib/my_app/accounts/user.ex');
  });

  it('collapses dependency families to externals and never leaks the internal app namespace', async () => {
    const dir = await repo(PHOENIXish);
    const g = await new ElixirExtractor().extract(dir);
    const extIds = g.externals.map((x) => x.id);
    expect(extIds).toContain('ext:ecto'); // Ecto.Repo / Ecto.Schema / Ecto.Changeset
    // MyApp / MyAppWeb are internal — never an external node.
    expect(extIds.some((id) => id.includes('my_app') || id.includes('myapp'))).toBe(false);
    // Mix (from the skipped mix.exs) never appears.
    expect(extIds).not.toContain('ext:mix');
  });

  it('tags nodes with the file extension and a real loc', async () => {
    const dir = await repo(PHOENIXish);
    const g = await new ElixirExtractor().extract(dir);
    const user = g.files.find((f) => f.id === 'lib/my_app/accounts/user.ex')!;
    expect(user.language).toBe('ex');
    expect(user.loc).toBeGreaterThan(0);
  });

  it('is deterministic across runs', async () => {
    const dir = await repo(PHOENIXish);
    const a = await new ElixirExtractor().extract(dir);
    const b = await new ElixirExtractor().extract(dir);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('returns an empty graph for a repo with no Elixir source', async () => {
    const dir = await repo({ 'README.md': '# hi\n' });
    const g = await new ElixirExtractor().extract(dir);
    expect(g.files).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});

describe('ElixirExtractor — call edges (v2)', () => {
  it('resolves aliased, context, and fully-qualified calls to internal call edges', async () => {
    const dir = await repo(CALLSish);
    const g = await new ElixirExtractor().extract(dir);
    const calls = callEdgeKeys(g);
    // alias User → user.ex; alias Repo → repo.ex; fully-qualified MyApp.Mailer → mailer.ex
    expect(calls).toContain('lib/my_app/accounts.ex -> lib/my_app/accounts/user.ex');
    expect(calls).toContain('lib/my_app/accounts.ex -> lib/my_app/repo.ex');
    expect(calls).toContain('lib/my_app/accounts.ex -> lib/my_app/mailer.ex');
  });

  it('weights a call edge by call count', async () => {
    const dir = await repo(CALLSish);
    const g = await new ElixirExtractor().extract(dir);
    // two Repo.insert calls → weight 2; one User.changeset → weight 1
    expect(callWeight(g, 'lib/my_app/accounts.ex', 'lib/my_app/repo.ex')).toBe(2);
    expect(callWeight(g, 'lib/my_app/accounts.ex', 'lib/my_app/accounts/user.ex')).toBe(1);
  });

  it('drops stdlib, dynamic-dispatch, and self calls', async () => {
    const dir = await repo(CALLSish);
    const g = await new ElixirExtractor().extract(dir);
    const calls = callEdgeKeys(g);
    // Enum.map is stdlib (no internal target); apply/3 is not a Module.fn callee.
    expect([...calls].some((k) => k.includes('enum') || k.includes('Enum'))).toBe(false);
    // MyApp.Accounts.User.changeset inside user.ex is a self-call → no self-edge.
    expect(calls).not.toContain('lib/my_app/accounts/user.ex -> lib/my_app/accounts/user.ex');
  });

  it('keeps call edges deterministic across runs', async () => {
    const dir = await repo(CALLSish);
    const a = await new ElixirExtractor().extract(dir);
    const b = await new ElixirExtractor().extract(dir);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('extractFileCalls (unit)', () => {
  const registry = new Map([
    ['MyApp.Accounts', 'lib/my_app/accounts.ex'],
    ['MyApp.Repo', 'lib/my_app/repo.ex'],
  ]);

  it('resolves a fully-qualified call to its file', () => {
    const calls = extractFileCalls(
      'lib/my_app/web.ex',
      'defmodule W do\n  def go, do: MyApp.Repo.insert(%{})\nend\n',
      registry,
    );
    expect(calls).toEqual([{ to: 'lib/my_app/repo.ex', weight: 1 }]);
  });

  it('degrades a god-file (> the call-site cap) to import-only, deterministically', () => {
    // 2501 resolvable call sites > MAX_CALL_SITES_PER_FILE (2500) → call edges skipped.
    const body = Array.from({ length: 2501 }, () => 'MyApp.Repo.insert(%{})').join('\n');
    const calls = extractFileCalls('lib/my_app/big.ex', `defmodule Big do\n${body}\nend\n`, registry);
    expect(calls).toEqual([]);
  });
});
