// Pure Elixir syntactic scanner — module defs, directives, multi-alias sugar,
// heredoc skipping, and external-id derivation.

import { describe, it, expect } from '../testkit.js';
import {
  scanModuleDefs,
  scanDirectives,
  expandDirectiveTargets,
  scanAliasScope,
  scanCallSites,
  aliasExpand,
  topNamespace,
  elixirExternalId,
} from './elixir-scan.js';

describe('scanModuleDefs', () => {
  it('finds a single top-level module', () => {
    expect(scanModuleDefs('defmodule MyApp.Accounts.User do\nend\n')).toEqual(['MyApp.Accounts.User']);
  });

  it('finds several modules in one file (schema + changeset)', () => {
    const src = `defmodule MyApp.Accounts.User do
  use Ecto.Schema
end

defmodule MyApp.Accounts.UserToken do
end
`;
    expect(scanModuleDefs(src)).toEqual(['MyApp.Accounts.User', 'MyApp.Accounts.UserToken']);
  });

  it('matches an indented (nested) defmodule by its written name', () => {
    expect(scanModuleDefs('  defmodule Inner do\n  end\n')).toEqual(['Inner']);
  });

  it('ignores a defmodule-looking line inside a heredoc doc example', () => {
    const src = `defmodule Real do
  @moduledoc """
  Example:

      defmodule Fake do
      end
  """
end
`;
    expect(scanModuleDefs(src)).toEqual(['Real']);
  });
});

describe('scanDirectives', () => {
  it('captures alias / import / require / use targets', () => {
    const src = `defmodule X do
  alias MyApp.Accounts.User
  import MyApp.Helpers
  require Logger
  use MyAppWeb, :controller
end
`;
    expect(scanDirectives(src)).toEqual([
      { keyword: 'alias', targets: ['MyApp.Accounts.User'] },
      { keyword: 'import', targets: ['MyApp.Helpers'] },
      { keyword: 'require', targets: ['Logger'] },
      { keyword: 'use', targets: ['MyAppWeb'] },
    ]);
  });

  it('expands single-line multi-alias sugar', () => {
    const src = '  alias MyApp.Accounts.{User, Team, Account}\n';
    expect(scanDirectives(src)).toEqual([
      { keyword: 'alias', targets: ['MyApp.Accounts.User', 'MyApp.Accounts.Team', 'MyApp.Accounts.Account'] },
    ]);
  });

  it('joins and expands a multi-line multi-alias', () => {
    const src = `  alias MyApp.Accounts.{
    User,
    Team
  }
`;
    expect(scanDirectives(src)).toEqual([
      { keyword: 'alias', targets: ['MyApp.Accounts.User', 'MyApp.Accounts.Team'] },
    ]);
  });

  it('drops the option list of alias/import/use', () => {
    const src = `  alias MyApp.Repo, as: DB
  import Ecto.Query, only: [from: 2]
  use GenServer, restart: :temporary
`;
    expect(scanDirectives(src)).toEqual([
      { keyword: 'alias', targets: ['MyApp.Repo'] },
      { keyword: 'import', targets: ['Ecto.Query'] },
      { keyword: 'use', targets: ['GenServer'] },
    ]);
  });

  it('does not read a directive-looking line inside a heredoc', () => {
    const src = `defmodule X do
  @doc """
      alias Fake.Module
  """
  alias Real.Module
end
`;
    expect(scanDirectives(src)).toEqual([{ keyword: 'alias', targets: ['Real.Module'] }]);
  });
});

describe('expandDirectiveTargets', () => {
  it('returns [] for a non-module expression', () => {
    expect(expandDirectiveTargets('__MODULE__.Foo')).toEqual([]);
    expect(expandDirectiveTargets(':an_atom')).toEqual([]);
  });
});

describe('elixirExternalId', () => {
  it('collapses a dependency family to its underscore-cased top namespace', () => {
    expect(elixirExternalId('Phoenix.PubSub')).toEqual({ id: 'ext:phoenix', specifier: 'phoenix' });
    expect(elixirExternalId('Ecto.Query')).toEqual({ id: 'ext:ecto', specifier: 'ecto' });
    expect(elixirExternalId('Oban.Worker')).toEqual({ id: 'ext:oban', specifier: 'oban' });
    expect(elixirExternalId('ExAws.S3')).toEqual({ id: 'ext:ex_aws', specifier: 'ex_aws' });
  });
});

describe('topNamespace', () => {
  it('is the leftmost dotted segment', () => {
    expect(topNamespace('MyApp.Accounts.User')).toBe('MyApp');
    expect(topNamespace('Logger')).toBe('Logger');
  });
});

describe('scanAliasScope (call-edge v2)', () => {
  it('binds a plain alias by its last segment', () => {
    const scope = scanAliasScope('  alias MyApp.Accounts.User\n');
    expect(scope.get('User')).toBe('MyApp.Accounts.User');
  });

  it('binds a context alias so a bare context call resolves', () => {
    const scope = scanAliasScope('  alias MyApp.Accounts\n');
    expect(scope.get('Accounts')).toBe('MyApp.Accounts');
  });

  it('honors the `, as: X` rename', () => {
    const scope = scanAliasScope('  alias MyApp.Repo, as: DB\n');
    expect(scope.get('DB')).toBe('MyApp.Repo');
    expect(scope.has('Repo')).toBe(false);
  });

  it('expands single- and multi-line multi-alias sugar', () => {
    const single = scanAliasScope('  alias MyApp.Accounts.{User, Team}\n');
    expect(single.get('User')).toBe('MyApp.Accounts.User');
    expect(single.get('Team')).toBe('MyApp.Accounts.Team');
    const multi = scanAliasScope('  alias MyApp.Accounts.{\n    User,\n    Billing.Plan\n  }\n');
    expect(multi.get('User')).toBe('MyApp.Accounts.User');
    expect(multi.get('Plan')).toBe('MyApp.Accounts.Billing.Plan');
  });

  it('DROPS a name bound to two different modules (ambiguous → no resolution)', () => {
    const scope = scanAliasScope('  alias MyApp.Accounts.User\n  alias MyApp.Blog.User\n');
    expect(scope.has('User')).toBe(false);
  });

  it('does not read an alias inside a heredoc', () => {
    const src = 'defmodule X do\n  @doc """\n  alias Fake.Thing\n  """\n  alias Real.Thing\nend\n';
    const scope = scanAliasScope(src);
    expect(scope.get('Thing')).toBe('Real.Thing');
  });
});

describe('scanCallSites (call-edge v2)', () => {
  it('captures a fully-qualified call callee module', () => {
    expect(scanCallSites('    MyApp.Accounts.get_user(id)\n')).toEqual(['MyApp.Accounts']);
  });

  it('captures the module in a piped call', () => {
    expect(scanCallSites('    id |> MyApp.Accounts.get_user()\n')).toEqual(['MyApp.Accounts']);
  });

  it('captures an aliased call and a function capture', () => {
    expect(scanCallSites('    User.changeset(u, attrs)\n')).toEqual(['User']);
    expect(scanCallSites('    Enum.map(xs, &Worker.perform/1)\n')).toEqual(['Enum', 'Worker']);
  });

  it('emits one entry per call site (for weighting)', () => {
    const src = '    Accounts.get_user(1)\n    Accounts.get_user(2)\n';
    expect(scanCallSites(src)).toEqual(['Accounts', 'Accounts']);
  });

  it('ignores a struct literal, a bare module ref, and a variable field access', () => {
    // %User{} is not a call; `MyApp.Worker` alone (no .fn) is not a call;
    // `conn.assigns` is a variable field (lowercase head).
    expect(scanCallSites('    x = %User{name: "a"}\n    alias MyApp.Worker\n    conn.assigns.current_user\n')).toEqual([]);
  });

  it('strips strings and comments', () => {
    expect(scanCallSites('    log("Foo.bar happened") # Baz.qux here\n')).toEqual([]);
  });
});

describe('aliasExpand (call-edge v2)', () => {
  const scope = new Map([
    ['User', 'MyApp.Accounts.User'],
    ['Accounts', 'MyApp.Accounts'],
  ]);
  it('expands an aliased head, keeping any tail', () => {
    expect(aliasExpand('User', scope)).toBe('MyApp.Accounts.User');
    expect(aliasExpand('Accounts.User', scope)).toBe('MyApp.Accounts.User');
  });
  it('returns an unbound token unchanged (literal fully-qualified ref)', () => {
    expect(aliasExpand('MyApp.Billing', scope)).toBe('MyApp.Billing');
  });
});
