// Elixir dependency-manifest reading — regex-scanned, never evaluated.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMixDeps, parseMixExsDeps, parseMixLockDeps } from './elixir-manifest.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bt-mix-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
  return dir;
}

describe('parseMixExsDeps', () => {
  it('extracts the {:name, ...} dep tuples, ignoring bare atoms and keyword lists', () => {
    const mix = `defmodule MyApp.MixProject do
  use Mix.Project
  def application do
    [extra_applications: [:logger, :runtime_tools], mod: {MyApp.Application, []}]
  end
  defp deps do
    [
      {:phoenix, "~> 1.7"},
      {:ecto_sql, "~> 3.10", only: :test},
      {:jason, "~> 1.4"},
      {:local_dep, path: "../local_dep"},
      {:from_git, github: "org/repo"}
    ]
  end
end
`;
    expect(new Set(parseMixExsDeps(mix))).toEqual(
      new Set(['phoenix', 'ecto_sql', 'jason', 'local_dep', 'from_git']),
    );
  });
});

describe('parseMixLockDeps', () => {
  it('extracts the resolved dependency map keys', () => {
    const lock = `%{
  "phoenix" => {:hex, :phoenix, "1.7.10", "abc", ...},
  "ecto" => {:hex, :ecto, "3.10.3", "def", ...},
  "telemetry" => {:hex, :telemetry, "1.2.1", "ghi", ...},
}
`;
    expect(new Set(parseMixLockDeps(lock))).toEqual(new Set(['phoenix', 'ecto', 'telemetry']));
  });
});

describe('readMixDeps', () => {
  it('unions mix.exs deps/0 and mix.lock keys', () => {
    const dir = repo({
      'mix.exs': 'defmodule X do\n  defp deps do\n    [{:phoenix, "~> 1.7"}, {:oban, "~> 2.17"}]\n  end\nend\n',
      'mix.lock': '%{\n  "phoenix" => {:hex, :phoenix, "1.7.0", ...},\n  "postgrex" => {:hex, :postgrex, "0.17.0", ...},\n}\n',
    });
    expect(readMixDeps(dir)).toEqual(new Set(['phoenix', 'oban', 'postgrex']));
  });

  it('returns an empty set (never throws) for a repo with no Mix manifests', () => {
    expect(readMixDeps(repo({ 'README.md': '# hi\n' }))).toEqual(new Set());
  });

  // The never-eval guard: mix.exs is Elixir CODE, but readMixDeps must NEVER run it.
  // A regex captures the dep atoms in BOTH branches of a conditional — proof it
  // parses rather than evaluates (an evaluator would run exactly one branch, and
  // would need an Elixir runtime we don't ship). Side-effecting code in deps/0 is
  // inert because it is never executed.
  it('never evaluates mix.exs — captures deps from both branches of a conditional', () => {
    const mix = `defmodule X do
  defp deps do
    base = [{:jason, "~> 1.4"}]

    if Mix.env() == :prod do
      base ++ [{:only_prod, "~> 1.0"}]
    else
      base ++ [{:only_dev, "~> 1.0"}, {:credo, "~> 1.7", only: :dev}]
    end
  end
end
`;
    const dir = repo({ 'mix.exs': mix });
    const deps = readMixDeps(dir);
    // Both the prod-only and dev-only deps are present — impossible if evaluated.
    expect(deps.has('jason')).toBe(true);
    expect(deps.has('only_prod')).toBe(true);
    expect(deps.has('only_dev')).toBe(true);
    expect(deps.has('credo')).toBe(true);
  });
});
