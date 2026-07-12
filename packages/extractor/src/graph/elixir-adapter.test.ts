// The Elixir import-graph extractor, over a small on-disk Phoenix-shaped fixture.
// Asserts the directive-driven internal edges, external dependency collapse, the
// mix.exs skip, that an internal app namespace never leaks as an external, and
// determinism across runs.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ElixirExtractor } from './elixir-adapter.js';
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
