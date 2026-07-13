// Elixir dependency-manifest reading — regex-scanned, never evaluated.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  readMixDeps,
  readMixDepsDeep,
  parseMixExsDeps,
  parseMixLockDeps,
  mixDeclaresApplicationMod,
  mixDeclaresApplicationModDeep,
} from './elixir-manifest.js';

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
// Like `repo`, but supports nested paths (`apps/web/mix.exs`) — mkdir -p first.
function nestedRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bt-mix-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}
const mixExs = (...deps: string[]) =>
  `defmodule X do\n  defp deps do\n    [${deps.map((d) => `{:${d}, "~> 1.0"}`).join(', ')}]\n  end\nend\n`;

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

describe('readMixDepsDeep', () => {
  it('equals readMixDeps on a single-root repo (single-app behavior unchanged)', () => {
    const dir = repo({
      'mix.exs': mixExs('phoenix', 'oban'),
      'mix.lock': '%{\n  "phoenix" => {:hex, :phoenix, "1.7.0", ...},\n  "postgrex" => {:hex, :postgrex, "0.17.0", ...},\n}\n',
    });
    expect(readMixDepsDeep(dir)).toEqual(readMixDeps(dir));
    expect(readMixDepsDeep(dir)).toEqual(new Set(['phoenix', 'oban', 'postgrex']));
  });

  it('unions deps from an umbrella child (apps/web/mix.exs declaring phoenix)', () => {
    // The umbrella ROOT declares no framework; the child app does — the shape a
    // depth-1 shallow scan misses but a repo-wide union catches.
    const dir = nestedRepo({
      'mix.exs': mixExs(), // bare umbrella root (apps_path project, no framework dep)
      'apps/web/mix.exs': mixExs('phoenix', 'phoenix_live_view'),
      'apps/core/mix.exs': mixExs('ecto', 'ecto_sql'),
    });
    const deps = readMixDepsDeep(dir);
    expect(deps.has('phoenix')).toBe(true);
    expect(deps.has('phoenix_live_view')).toBe(true);
    expect(deps.has('ecto')).toBe(true);
    expect(deps.has('ecto_sql')).toBe(true);
  });

  it('finds a deeply-nested Elixir app in a polyglot monorepo (Firezone shape)', () => {
    // Rust at the root, Phoenix under `elixir/apps/web/` — 3 levels deep, beyond the
    // depth-1 shallow scan. The root has NO mix.exs at all.
    const dir = nestedRepo({
      'Cargo.toml': '[package]\nname = "firewall"\n',
      'rust/src/main.rs': 'fn main() {}\n',
      'elixir/mix.exs': mixExs(), // bare umbrella root
      'elixir/apps/web/mix.exs': mixExs('phoenix'),
      'elixir/apps/domain/mix.exs': mixExs('oban', 'oban_web'),
    });
    const deps = readMixDepsDeep(dir);
    expect(deps.has('phoenix')).toBe(true);
    expect(deps.has('oban')).toBe(true);
    expect(deps.has('oban_web')).toBe(true);
  });

  it('skips _build and deps (vendored/generated mix.exs must not leak into the union)', () => {
    const dir = nestedRepo({
      'mix.exs': mixExs('phoenix'),
      // A vendored dep + a build artifact each carry their OWN mix.exs declaring a
      // dep the first-party app does not — these must be excluded.
      'deps/some_lib/mix.exs': mixExs('vendored_only_dep'),
      '_build/dev/lib/gen/mix.exs': mixExs('build_only_dep'),
      'node_modules/pkg/mix.exs': mixExs('node_only_dep'),
    });
    const deps = readMixDepsDeep(dir);
    expect(deps.has('phoenix')).toBe(true);
    expect(deps.has('vendored_only_dep')).toBe(false);
    expect(deps.has('build_only_dep')).toBe(false);
    expect(deps.has('node_only_dep')).toBe(false);
  });

  it('returns an empty set (never throws) for a repo with no mix.exs anywhere', () => {
    expect(readMixDepsDeep(repo({ 'README.md': '# hi\n' }))).toEqual(new Set());
  });
});

describe('mixDeclaresApplicationMod (OTP app callback)', () => {
  const appMix = 'defmodule X do\n  def application do\n    [mod: {MyApp.Application, []}]\n  end\nend\n';
  const libMix = 'defmodule X do\n  defp deps do\n    [{:jason, "~> 1.0"}]\n  end\nend\n';

  it('is true when the mix.exs declares a mod: application callback', () => {
    expect(mixDeclaresApplicationMod(repo({ 'mix.exs': appMix }))).toBe(true);
  });

  it('is false for a pure library (no mod: callback) or a missing mix.exs', () => {
    expect(mixDeclaresApplicationMod(repo({ 'mix.exs': libMix }))).toBe(false);
    expect(mixDeclaresApplicationMod(repo({ 'README.md': '# hi\n' }))).toBe(false);
  });

  it('deep-finds a mod: callback in a nested app', () => {
    const dir = nestedRepo({ 'package.json': '{"name":"web"}', 'backend/mix.exs': appMix });
    expect(mixDeclaresApplicationModDeep(dir)).toBe(true);
  });

  it('ignores a callback that lives only under a vendored/build dir, and a callback-less repo', () => {
    // The ONLY mod: callback is under deps/ (a vendored dep) → must be skipped → false.
    expect(mixDeclaresApplicationModDeep(nestedRepo({ 'deps/vendored/mix.exs': appMix }))).toBe(false);
    // A repo whose only first-party mix.exs is a library → false.
    expect(mixDeclaresApplicationModDeep(nestedRepo({ 'apps/lib/mix.exs': libMix }))).toBe(false);
  });
});
