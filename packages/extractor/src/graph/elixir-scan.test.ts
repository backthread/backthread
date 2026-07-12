// Pure Elixir syntactic scanner — module defs, directives, multi-alias sugar,
// heredoc skipping, and external-id derivation.

import { describe, it, expect } from '../testkit.js';
import {
  scanModuleDefs,
  scanDirectives,
  expandDirectiveTargets,
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
