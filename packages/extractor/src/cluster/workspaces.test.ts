// Stage C — workspace/package boundary detection tests (// manifest-first). Fixtures are real on-disk temp dirs (detectWorkspaceLayout
// is fs-reading by design), torn down per test.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, afterEach } from '../testkit.js';
import { detectWorkspaceLayout, isWorkspaceManifestPath } from './workspaces.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Materialize a fixture repo: repo-relative posix path → file content. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bt-ws-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const pkgJson = (o: object): string => JSON.stringify(o);

function rootsOf(layout: ReturnType<typeof detectWorkspaceLayout>): string[] {
  return layout.packages.map((p) => p.root);
}

// ── declared globs ──────────────────────────────────────────────────────────

test('pnpm-workspace.yaml globs declare packages (named and unnamed)', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'mono' }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!packages/fixtures'\n",
    'packages/a/package.json': pkgJson({ name: '@mono/a' }),
    'packages/b/package.json': pkgJson({}), // unnamed but declared → still a boundary
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['', 'packages/a', 'packages/b']);
  const a = layout.packages.find((p) => p.root === 'packages/a')!;
  const b = layout.packages.find((p) => p.root === 'packages/b')!;
  expect(a).toMatchObject({ name: '@mono/a', slug: 'a', declared: true });
  expect(b).toMatchObject({ name: null, slug: 'b', declared: true });
  expect(layout.nameToPackage.get('@mono/a')).toBe(a);
  expect(layout.nameToPackage.has('b')).toBe(false); // unnamed → not name-addressable
});

test('package.json workspaces — array form', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'mono', workspaces: ['libs/*'] }),
    'libs/util/package.json': pkgJson({ name: '@mono/util' }),
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['', 'libs/util']);
  expect(layout.packages[1].declared).toBe(true);
});

test('package.json workspaces — yarn object form ({packages})', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'mono', workspaces: { packages: ['libs/**'] } }),
    'libs/deep/nested/package.json': pkgJson({}), // unnamed, matched by `libs/**`
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['', 'libs/deep/nested']);
  expect(layout.packages[1].declared).toBe(true);
});

test('lerna.json packages declare boundaries', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'mono' }),
    'lerna.json': pkgJson({ packages: ['modules/*'] }),
    'modules/x/package.json': pkgJson({}),
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['', 'modules/x']);
  expect(layout.packages[1].declared).toBe(true);
});

// ── inferred boundaries ─────────────────────────────────────────────────────

test('a nested NAMED package.json is inferred even when undeclared; unnamed+undeclared is not', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'app' }), // no workspaces declared
    'worker/package.json': pkgJson({ name: 'app-worker' }),
    'fixtures/noise/package.json': pkgJson({ type: 'module' }), // marker file, not a boundary
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['', 'worker']);
  expect(layout.packages[1]).toMatchObject({ name: 'app-worker', declared: false });
});

// ── membership ──────────────────────────────────────────────────────────────

test('nested-in-nested: membership goes to the LONGEST matching root', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'app' }),
    'worker/package.json': pkgJson({ name: 'app-worker' }),
    'worker/container/package.json': pkgJson({ name: 'app-container' }),
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['', 'worker', 'worker/container']);
  expect(layout.packageOf('worker/container/src/x.ts').root).toBe('worker/container');
  expect(layout.packageOf('worker/src/x.ts').root).toBe('worker');
  expect(layout.packageOf('src/x.ts').root).toBe(''); // root-scope fallback
  expect(layout.packageOf('workerish/x.ts').root).toBe(''); // prefix is segment-wise, not string-wise
});

// ── pruning ─────────────────────────────────────────────────────────────────

test('EXCLUDE_DIRS and dot-directories are pruned from the walk', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'app' }),
    'node_modules/dep/package.json': pkgJson({ name: 'dep' }),
    'dist/package.json': pkgJson({ name: 'built' }),
    '.hidden/pkg/package.json': pkgJson({ name: 'hidden' }),
    'src/real/package.json': pkgJson({ name: 'real' }),
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['', 'src/real']);
});

// ── failure posture ─────────────────────────────────────────────────────────

test('malformed manifests degrade per-source, never throw', () => {
  const dir = fixture({
    'package.json': '{ this is not json',
    'pnpm-workspace.yaml': 'packages: [unclosed',
    'lerna.json': 'also { not json',
    'worker/package.json': pkgJson({ name: 'still-found' }), // inferred path survives
    'broken/package.json': '{{{', // malformed nested → unnamed+undeclared → skipped
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['', 'worker']);
  expect(layout.packages[0].name).toBe(null); // root manifest unreadable → unnamed root scope
  expect(layout.packages[0].slug).toBe('root');
});

test('a repo with no manifests at all yields the single root-scope layout', () => {
  const dir = fixture({ 'src/index.ts': 'export {}' });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['']);
  expect(layout.packages[0]).toMatchObject({ name: null, slug: 'root', declared: true });
  expect(layout.packageOf('src/index.ts').root).toBe('');
});

test('single-package repos (root package.json only) yield a length-1 layout', () => {
  const dir = fixture({ 'package.json': pkgJson({ name: 'solo', main: './src/index.ts' }) });
  const layout = detectWorkspaceLayout(dir);
  expect(layout.packages).toHaveLength(1);
  expect(layout.packages[0].slug).toBe('solo');
});

// ── entry candidates ────────────────────────────────────────────────────────

test('entry candidates: main/module/exports resolved + ts variants + fallbacks, best-first', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'mono', workspaces: ['libs/*'] }),
    'libs/u/package.json': pkgJson({
      name: '@mono/u',
      main: './dist/index.js',
      module: './dist/index.mjs',
      exports: { '.': { import: './src/entry.ts' } },
    }),
  });
  const layout = detectWorkspaceLayout(dir);
  const u = layout.packages.find((p) => p.root === 'libs/u')!;
  expect(u.entryFileIds).toEqual([
    'libs/u/dist/index.js',
    'libs/u/dist/index.ts', // .js → .ts/.tsx siblings (dist points at transpiled output;
    'libs/u/dist/index.tsx', // the SOURCE graph holds the sibling, if anything)
    'libs/u/dist/index.mjs',
    'libs/u/dist/index.mts',
    'libs/u/src/entry.ts',
    'libs/u/index.ts', // conventional fallbacks, always appended
    'libs/u/index.tsx',
    'libs/u/src/index.ts',
    'libs/u/src/index.tsx',
  ]);
});

test('entry candidates: exports string + top-level conditions forms; escapes rejected', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'mono', workspaces: ['libs/*'] }),
    'libs/s/package.json': pkgJson({ name: 's', exports: './src/index.ts' }),
    'libs/c/package.json': pkgJson({ name: 'c', exports: { default: './lib/main.cjs' } }),
    'libs/e/package.json': pkgJson({ name: 'e', main: '../../escape.js' }),
  });
  const layout = detectWorkspaceLayout(dir);
  const entries = (root: string) => layout.packages.find((p) => p.root === root)!.entryFileIds;
  expect(entries('libs/s')[0]).toBe('libs/s/src/index.ts');
  expect(entries('libs/c').slice(0, 2)).toEqual(['libs/c/lib/main.cjs', 'libs/c/lib/main.cts']);
  // the escaping main is refused; only the fallbacks remain
  expect(entries('libs/e')).toEqual([
    'libs/e/index.ts',
    'libs/e/index.tsx',
    'libs/e/src/index.ts',
    'libs/e/src/index.tsx',
  ]);
});

// ── manifest-path trigger ───────────────────────────────────────────────────

test('isWorkspaceManifestPath matches exactly the layout-defining manifests', () => {
  expect(isWorkspaceManifestPath('package.json')).toBe(true);
  expect(isWorkspaceManifestPath('worker/container/package.json')).toBe(true);
  expect(isWorkspaceManifestPath('pnpm-workspace.yaml')).toBe(true);
  expect(isWorkspaceManifestPath('lerna.json')).toBe(true);
  expect(isWorkspaceManifestPath('package-lock.json')).toBe(false);
  expect(isWorkspaceManifestPath('src/index.ts')).toBe(false);
  expect(isWorkspaceManifestPath('docs/lerna.json.md')).toBe(false);
});

// ── roles (app / lib / tooling) ────────────────────────────────────

test(' roles: apps/* → app, packages/* → lib, tools/config-name → tooling', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'mono', workspaces: ['apps/*', 'packages/*', 'tools/*'] }),
    'turbo.json': pkgJson({ tasks: {} }), // turborepo recognized; adds no globs of its own
    'apps/web/package.json': pkgJson({ name: '@mono/web', scripts: { dev: 'vite' } }),
    // a `packages/` member with a build script stays `lib` — the dir convention
    // dominates the runnable-script heuristic.
    'packages/ui/package.json': pkgJson({ name: '@mono/ui', scripts: { build: 'tsc' } }),
    'tools/lint/package.json': pkgJson({ name: '@mono/eslint-config' }),
  });
  const layout = detectWorkspaceLayout(dir);
  const roleOf = (root: string) => layout.packages.find((p) => p.root === root)!.role;
  expect(roleOf('apps/web')).toBe('app');
  expect(roleOf('packages/ui')).toBe('lib');
  expect(roleOf('tools/lint')).toBe('tooling');
});

test(' roles: non-conventional dir falls back to scripts/bin (runnable → app, else lib)', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'mono', workspaces: ['services/*'] }),
    'services/api/package.json': pkgJson({ name: 'api', scripts: { start: 'node .' } }),
    'services/types/package.json': pkgJson({ name: 'types' }), // no script, no bin → lib
  });
  const layout = detectWorkspaceLayout(dir);
  const roleOf = (root: string) => layout.packages.find((p) => p.root === root)!.role;
  expect(roleOf('services/api')).toBe('app');
  expect(roleOf('services/types')).toBe('lib');
});

// ── nx.json layout ──────────────────────────────────────────────────

test(' nx.json workspaceLayout seeds apps/libs DECLARED globs + roles', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'mono' }),
    'nx.json': pkgJson({ workspaceLayout: { appsDir: 'applications', libsDir: 'libraries' } }),
    'applications/web/package.json': pkgJson({ name: 'web' }),
    'libraries/ui/package.json': pkgJson({ name: 'ui' }),
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['', 'applications/web', 'libraries/ui']);
  const get = (root: string) => layout.packages.find((p) => p.root === root)!;
  expect(get('applications/web')).toMatchObject({ declared: true, role: 'app' });
  expect(get('libraries/ui')).toMatchObject({ declared: true, role: 'lib' });
});

// ── declaredDeps (package.json sibling deps only) ───────────────────

test(' declaredDeps: workspace siblings named in package.json deps, sorted; externals + self excluded', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'mono', workspaces: ['apps/*', 'packages/*'] }),
    'apps/web/package.json': pkgJson({
      name: '@mono/web',
      dependencies: { '@mono/ui': 'workspace:*', react: '^18' }, // react is a true external
      devDependencies: { '@mono/utils': 'workspace:*' },
    }),
    'packages/ui/package.json': pkgJson({
      name: '@mono/ui',
      dependencies: { '@mono/utils': 'workspace:*' },
    }),
    'packages/utils/package.json': pkgJson({ name: '@mono/utils' }), // leaf
  });
  const layout = detectWorkspaceLayout(dir);
  const depsOf = (root: string) => layout.packages.find((p) => p.root === root)!.declaredDeps;
  expect(depsOf('apps/web')).toEqual(['packages/ui', 'packages/utils']); // sorted; react excluded
  expect(depsOf('packages/ui')).toEqual(['packages/utils']);
  expect(depsOf('packages/utils')).toEqual([]); // leaf has none
});

// ── Python package/workspace detection ─────────────────────────────

test('uv workspace: root [tool.uv.workspace].members declare Python packages', () => {
  const dir = fixture({
    'pyproject.toml': '[project]\nname = "root"\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
    'packages/core/pyproject.toml': '[project]\nname = "core"\n',
    'packages/core/core/__init__.py': '',
    'packages/api/pyproject.toml': '[project]\nname = "api"\ndependencies = ["core"]\n[tool.uv.sources]\ncore = { workspace = true }\n',
    'packages/api/api/__init__.py': '',
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['', 'packages/api', 'packages/core']);
  const api = layout.packages.find((p) => p.root === 'packages/api')!;
  const core = layout.packages.find((p) => p.root === 'packages/core')!;
  expect(api).toMatchObject({ name: 'api', slug: 'api', declared: true });
  expect(core).toMatchObject({ name: 'core', declared: true });
  // api depends on core (by dep name → sibling), materialized as a declared dep.
  expect(api.declaredDeps).toEqual(['packages/core']);
  expect(layout.packageOf('packages/api/api/main.py').root).toBe('packages/api');
});

test('an inferred (named, undeclared) nested pyproject is a Python package boundary', () => {
  const dir = fixture({
    'pyproject.toml': '[project]\nname = "root"\n',
    'services/worker/pyproject.toml': '[tool.poetry]\nname = "worker"\n',
    'services/worker/worker/__init__.py': '',
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toContain('services/worker');
  const w = layout.packages.find((p) => p.root === 'services/worker')!;
  expect(w).toMatchObject({ name: 'worker', declared: false });
});

test('poetry {path=...} dep resolves to a sibling declaredDep', () => {
  const dir = fixture({
    'pyproject.toml': '[project]\nname = "root"\n[tool.uv.workspace]\nmembers = ["libs/*", "apps/*"]\n',
    'libs/shared/pyproject.toml': '[project]\nname = "shared"\n',
    'libs/shared/shared/__init__.py': '',
    'apps/web/pyproject.toml': '[tool.poetry]\nname = "web"\n[tool.poetry.dependencies]\nshared = { path = "../../libs/shared" }\n',
    'apps/web/web/__init__.py': '',
  });
  const layout = detectWorkspaceLayout(dir);
  const web = layout.packages.find((p) => p.root === 'apps/web')!;
  expect(web.role).toBe('app'); // apps/ dir convention
  expect(web.declaredDeps).toEqual(['libs/shared']);
});

test('polyglot repo: an npm frontend + a Python backend are BOTH packages', () => {
  const dir = fixture({
    'frontend/package.json': pkgJson({ name: 'web', scripts: { dev: 'vite' } }),
    'frontend/src/index.ts': 'export const x = 1;',
    'backend/pyproject.toml': '[project]\nname = "api"\ndependencies = ["fastapi"]\n',
    'backend/app/__init__.py': '',
  });
  const layout = detectWorkspaceLayout(dir);
  const roots = new Set(rootsOf(layout));
  expect(roots.has('frontend')).toBe(true);
  expect(roots.has('backend')).toBe(true);
  expect(layout.packages.find((p) => p.root === 'frontend')!.role).toBe('app');
  expect(layout.packages.find((p) => p.root === 'backend')!.name).toBe('api');
});

test('a stray unnamed, undeclared pyproject is NOT a boundary (npm repo unregressed)', () => {
  const dir = fixture({
    'package.json': pkgJson({ name: 'web' }),
    'src/index.ts': 'export const x = 1;',
    // a tooling pyproject with no [project]/[tool.poetry] name, not declared
    'scripts/pyproject.toml': '[tool.black]\nline-length = 100\n',
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toEqual(['']); // only the root scope — no boundary added
});

test('isWorkspaceManifestPath recognizes Python manifests (recompute trigger)', () => {
  expect(isWorkspaceManifestPath('backend/pyproject.toml')).toBe(true);
  expect(isWorkspaceManifestPath('pkg/setup.py')).toBe(true);
  expect(isWorkspaceManifestPath('pkg/setup.cfg')).toBe(true);
});

test('elixir umbrella: each apps/* mix.exs project becomes a package', () => {
  const dir = fixture({
    'mix.exs':
      'defmodule MyUmbrella.MixProject do\n  use Mix.Project\n  def project do\n    [apps_path: "apps", version: "0.1.0"]\n  end\nend\n',
    'apps/core/mix.exs':
      'defmodule Core.MixProject do\n  def project do\n    [app: :core, version: "0.1.0"]\n  end\nend\n',
    'apps/core/lib/core.ex': 'defmodule Core do\nend\n',
    'apps/web/mix.exs': 'defmodule Web.MixProject do\n  def project do\n    [app: :web]\n  end\nend\n',
    'apps/web/lib/web.ex': 'defmodule Web do\nend\n',
  });
  const layout = detectWorkspaceLayout(dir);
  const roots = rootsOf(layout);
  expect(roots).toContain('apps/core');
  expect(roots).toContain('apps/web');
  const core = layout.packages.find((p) => p.root === 'apps/core');
  expect(core?.name).toBe('core'); // from `app: :core`
  expect(core?.role).toBe('app'); // apps/* → app
  // a file under apps/core resolves to the core package (longest-prefix membership)
  expect(layout.packageOf('apps/core/lib/core.ex').root).toBe('apps/core');
  expect(isWorkspaceManifestPath('apps/core/mix.exs')).toBe(true);
});

test('non-umbrella Phoenix repo (single root mix.exs) stays one package', () => {
  const dir = fixture({
    'mix.exs': 'defmodule MyApp.MixProject do\n  def project do\n    [app: :my_app]\n  end\nend\n',
    'lib/my_app.ex': 'defmodule MyApp do\nend\n',
  });
  expect(rootsOf(detectWorkspaceLayout(dir))).toEqual(['']); // only the root scope
});

test('a *.gemspec dir is a package boundary — a mountable Rails engine is partitioned', () => {
  const dir = fixture({
    Gemfile: "gem 'rails'\n",
    'app/models/user.rb': 'class User; end\n',
    // an in-repo mountable engine (its gemspec = the boundary; no workspace glob)
    'engines/billing/billing.gemspec': 'Gem::Specification.new\n',
    'engines/billing/lib/billing/engine.rb': 'module Billing; class Engine < Rails::Engine; end; end\n',
    'engines/billing/app/models/invoice.rb': 'class Invoice; end\n',
  });
  const layout = detectWorkspaceLayout(dir);
  expect(rootsOf(layout)).toContain('engines/billing');
  const engine = layout.packages.find((p) => p.root === 'engines/billing')!;
  expect(engine.name).toBe('billing');
  expect(engine.role).toBe('lib');
  // files inside the engine belong to the engine, not the root scope
  expect(layout.packageOf('engines/billing/app/models/invoice.rb').root).toBe('engines/billing');
  expect(layout.packageOf('app/models/user.rb').root).toBe('');
});
