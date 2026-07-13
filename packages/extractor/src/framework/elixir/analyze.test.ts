// Shared Elixir framework-analysis layer — module binding + no-re-scan scope + the
// reusable DSL accessors.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseElixirScope, buildModuleBindings } from './analyze.js';
import {
  moduleName,
  useDirectives,
  macroCalls,
  moduleAttributes,
  defCalls,
} from './elixir-ast.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function elixirRepo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-exscope-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const graph: NormalizedGraph = {
    root: dir,
    files: Object.keys(files)
      .filter((f) => f.endsWith('.ex') || f.endsWith('.exs'))
      .map((id) => ({ id, loc: 1, language: id.endsWith('.exs') ? 'exs' : 'ex' })),
    edges: [],
    externals: [],
  };
  return {
    repoDir: dir,
    rootPath: '',
    graph,
    match: { adapter: 'test', confidence: 1, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

describe('buildModuleBindings', () => {
  it('indexes files by the modules they define (first sorted-id wins a dup)', () => {
    const texts = new Map<string, string>([
      ['lib/my_app/accounts/user.ex', 'defmodule MyApp.Accounts.User do\nend\n'],
      ['lib/my_app/accounts.ex', 'defmodule MyApp.Accounts do\nend\n'],
      ['lib/my_app_web/router.ex', 'defmodule MyAppWeb.Router do\nend\n'],
    ]);
    const index = buildModuleBindings(texts);
    expect(index.get('MyApp.Accounts.User')).toBe('lib/my_app/accounts/user.ex');
    expect(index.get('MyApp.Accounts')).toBe('lib/my_app/accounts.ex');
    expect(index.get('MyAppWeb.Router')).toBe('lib/my_app_web/router.ex');
  });
});

describe('parseElixirScope', () => {
  it('scans in-scope files once, indexes modules, and resolves references', async () => {
    const ctx = await elixirRepo({
      'lib/my_app/accounts/user.ex':
        'defmodule MyApp.Accounts.User do\n  use Ecto.Schema\n  @primary_key {:id, :binary_id, autogenerate: true}\n  schema "users" do\n    field :email, :string\n    has_many :posts, MyApp.Blog.Post\n  end\n  def changeset(u, a) do\n    u\n  end\nend\n',
      'lib/my_app_web/user_controller.ex':
        'defmodule MyAppWeb.UserController do\n  use MyAppWeb, :controller\n  alias MyApp.Accounts\n  plug :authenticate\n  def index(conn, _params) do\n    conn\n  end\nend\n',
    });
    const scope = parseElixirScope(ctx);

    expect(scope.exFiles.length).toBe(2);
    expect(scope.resolve('MyApp.Accounts.User')).toBe('lib/my_app/accounts/user.ex');
    expect(scope.resolve('MyAppWeb.UserController')).toBe('lib/my_app_web/user_controller.ex');

    const user = scope.parsed.get('lib/my_app/accounts/user.ex')!;
    expect(user.modules).toEqual(['MyApp.Accounts.User']);
    expect(user.uses).toEqual([{ module: 'Ecto.Schema', args: '' }]);
    // the schema DSL macro calls are captured (name-filtered by adapters)
    const macroNames = user.macroCalls.map((c) => c.name);
    expect(macroNames).toContain('schema');
    expect(macroNames).toContain('field');
    expect(macroNames).toContain('has_many');
    // @primary_key attribute captured
    expect(user.attributes.some((a) => a.name === 'primary_key')).toBe(true);
    // def changeset captured, macro-call noise like `def` excluded
    expect(user.defs.map((d) => d.name)).toContain('changeset');
    expect(macroNames).not.toContain('def');

    const ctrl = scope.parsed.get('lib/my_app_web/user_controller.ex')!;
    expect(ctrl.uses).toEqual([{ module: 'MyAppWeb', args: ':controller' }]);
    expect(ctrl.macroCalls.map((c) => c.name)).toContain('plug');
  });
});

describe('elixir-ast accessors (pure)', () => {
  it('moduleName is the first defmodule', () => {
    expect(moduleName('defmodule A do\nend\ndefmodule B do\nend\n')).toBe('A');
  });
  it('useDirectives splits the module and its args', () => {
    expect(useDirectives('  use Oban.Worker, queue: :mailers, max_attempts: 3\n')).toEqual([
      { module: 'Oban.Worker', args: 'queue: :mailers, max_attempts: 3' },
    ]);
  });

  it('useDirectives joins a multi-line option list (trailing comma / wrapped brackets)', () => {
    expect(useDirectives('  use Ecto.Repo,\n    otp_app: :my_app,\n    adapter: Ecto.Adapters.Postgres\n')).toEqual([
      { module: 'Ecto.Repo', args: 'otp_app: :my_app, adapter: Ecto.Adapters.Postgres' },
    ]);
    // an unclosed bracket also continues the join
    expect(useDirectives('  use Broadway,\n    producer: [\n      module: {MyProducer, []}\n    ]\n')).toEqual([
      { module: 'Broadway', args: 'producer: [ module: {MyProducer, []} ]' },
    ]);
    // a plain single-line use with no args is unchanged
    expect(useDirectives('  use Ecto.Schema\n')).toEqual([{ module: 'Ecto.Schema', args: '' }]);
  });
  it('moduleAttributes reads @name value', () => {
    expect(moduleAttributes('  @behaviour Oban.Worker\n')).toEqual([
      { name: 'behaviour', value: 'Oban.Worker' },
    ]);
  });
  it('defCalls captures def/defp with names', () => {
    expect(defCalls('  def perform(job) do\n  end\n  defp helper(x), do: x\n')).toEqual([
      { kind: 'def', name: 'perform' },
      { kind: 'defp', name: 'helper' },
    ]);
  });
  it('macroCalls captures DSL invocations but not control-flow, assignments, or pipes', () => {
    const calls = macroCalls(
      '  get "/", PageController, :index\n  if x do\n  count = 1\n  conn |> put_status(200)\n  belongs_to :user\n',
    );
    expect(calls.map((c) => c.name)).toEqual(['get', 'belongs_to']);
  });
});
