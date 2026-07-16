// language detection + source-file enumeration for the adapter dispatch.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  detectRepoLanguage,
  detectRepoLanguages,
  listSourceFiles,
  graphLanguage,
  hasRubyManifest,
  hasMixManifest,
  hasMixManifestDeep,
  hasComposerManifest,
  hasSwiftManifest,
  hasSwiftManifestDeep,
} from './language.js';
import type { NormalizedGraph } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-lang-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

describe('detectRepoLanguage', () => {
  it('selects python for a Python-manifest repo with no TS manifest', async () => {
    const dir = await repo({ 'pyproject.toml': '[project]\nname="x"\n', 'app/main.py': 'x=1\n' });
    expect(detectRepoLanguage(dir)).toBe('python');
  });

  it('defaults to ts for a package.json repo', async () => {
    const dir = await repo({ 'package.json': '{"name":"x"}', 'src/index.ts': 'export const x=1;\n' });
    expect(detectRepoLanguage(dir)).toBe('ts');
  });

  it('keeps ts when a TS repo merely ships a helper .py script (both manifests → count wins)', async () => {
    const dir = await repo({
      'package.json': '{"name":"x"}',
      'pyproject.toml': '[project]\nname="x"\n',
      'src/a.ts': 'export const a=1;\n',
      'src/b.ts': 'export const b=2;\n',
      'src/c.ts': 'export const c=3;\n',
      'scripts/gen.py': 'print(1)\n',
    });
    expect(detectRepoLanguage(dir)).toBe('ts');
  });

  it('selects python by file count when Python dominates and no manifest disambiguates', async () => {
    const dir = await repo({
      'a.py': 'x=1\n',
      'b.py': 'y=2\n',
      'c.py': 'z=3\n',
      'tool.ts': 'export const t=1;\n',
    });
    expect(detectRepoLanguage(dir)).toBe('python');
  });

  it('selects ruby for a Gemfile repo with no TS/Python manifest', async () => {
    const dir = await repo({ Gemfile: "source 'https://rubygems.org'\n", 'app/models/user.rb': 'class User; end\n' });
    expect(detectRepoLanguage(dir)).toBe('ruby');
  });

  it('selects ruby for a bare *.gemspec repo', async () => {
    const dir = await repo({ 'mygem.gemspec': 'Gem::Specification.new\n', 'lib/mygem.rb': 'module MyGem; end\n' });
    expect(detectRepoLanguage(dir)).toBe('ruby');
  });

  it('selects ruby for a Rails app that also ships a package.json (JS bundler) — .rb dominates', async () => {
    const dir = await repo({
      Gemfile: "gem 'rails'\n",
      'package.json': '{"name":"app"}',
      'app/models/user.rb': 'class User; end\n',
      'app/controllers/users_controller.rb': 'class UsersController; end\n',
      'app/jobs/mail_job.rb': 'class MailJob; end\n',
      'app/javascript/app.js': 'console.log(1)\n',
    });
    expect(detectRepoLanguage(dir)).toBe('ruby');
  });

  it('selects elixir for a mix.exs repo (Phoenix keeps its JS toolchain under assets/)', async () => {
    const dir = await repo({
      'mix.exs': 'defmodule MyApp.MixProject do\n  use Mix.Project\nend\n',
      'mix.lock': '%{}\n',
      'lib/my_app/accounts/user.ex': 'defmodule MyApp.Accounts.User do\nend\n',
      'lib/my_app_web/router.ex': 'defmodule MyAppWeb.Router do\nend\n',
      // A nested assets/package.json must NOT flip the repo to TS — it is not a
      // root manifest, and detectRepoLanguage only reads root manifests.
      'assets/package.json': '{"name":"assets"}',
      'assets/js/app.js': 'console.log(1);\n',
    });
    expect(detectRepoLanguage(dir)).toBe('elixir');
  });

  it('selects elixir for a Phoenix app that also ships a root package.json — .ex dominates', async () => {
    const dir = await repo({
      'mix.exs': 'defmodule MyApp.MixProject do\nend\n',
      'package.json': '{"name":"app"}',
      'lib/my_app/accounts.ex': 'defmodule MyApp.Accounts do\nend\n',
      'lib/my_app_web/router.ex': 'defmodule MyAppWeb.Router do\nend\n',
      'lib/my_app_web/endpoint.ex': 'defmodule MyAppWeb.Endpoint do\nend\n',
      'assets/js/app.js': 'console.log(1)\n',
    });
    expect(detectRepoLanguage(dir)).toBe('elixir');
  });

  it('selects elixir by file count when .ex dominates and no manifest disambiguates', async () => {
    const dir = await repo({
      'a.ex': 'defmodule A do\nend\n',
      'b.ex': 'defmodule B do\nend\n',
      'c.ex': 'defmodule C do\nend\n',
      'tool.ts': 'export const t=1;\n',
    });
    expect(detectRepoLanguage(dir)).toBe('elixir');
  });

  it('selects php for a composer.json repo with no other manifest', async () => {
    const dir = await repo({
      'composer.json': '{"require":{"laravel/framework":"^11.0"}}',
      'app/Models/User.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
    });
    expect(detectRepoLanguage(dir)).toBe('php');
  });

  it('selects php for a Laravel app that also ships a package.json (Vite) — .php dominates', async () => {
    const dir = await repo({
      'composer.json': '{"require":{"laravel/framework":"^11.0"}}',
      'package.json': '{"name":"app"}',
      'app/Models/User.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
      'app/Http/Controllers/UserController.php': '<?php\nnamespace App\\Http\\Controllers;\nclass UserController {}\n',
      'app/Console/Kernel.php': '<?php\nnamespace App\\Console;\nclass Kernel {}\n',
      'resources/js/app.js': 'console.log(1)\n',
    });
    expect(detectRepoLanguage(dir)).toBe('php');
  });

  it('selects swift for a Package.swift repo', async () => {
    const dir = await repo({
      'Package.swift': 'let p = Package(name: "X")\n',
      'Sources/X/App.swift': 'struct App {}\n',
    });
    expect(detectRepoLanguage(dir)).toBe('swift');
  });

  it('selects swift for a Podfile-only iOS app', async () => {
    const dir = await repo({ Podfile: "pod 'Alamofire'\n", 'App/AppDelegate.swift': 'class AppDelegate {}\n' });
    expect(detectRepoLanguage(dir)).toBe('swift');
  });

  it('selects swift by file count for a manifest-less pure-Xcode app', async () => {
    const dir = await repo({
      'App/AppDelegate.swift': 'class AppDelegate {}\n',
      'App/ViewController.swift': 'class ViewController {}\n',
      'App/Model.swift': 'struct Model {}\n',
    });
    expect(detectRepoLanguage(dir)).toBe('swift');
  });

  it('keeps a TS repo as ts (swift adapter never selected — isolation probe)', async () => {
    const dir = await repo({ 'package.json': '{"name":"x"}', 'src/index.ts': 'export const x=1;\n' });
    expect(detectRepoLanguage(dir)).toBe('ts');
    expect(detectRepoLanguages(dir)).toEqual(['ts']);
  });
});

describe('listSourceFiles', () => {
  it('lists .py/.pyi and skips excluded + dot-prefixed dirs', async () => {
    const dir = await repo({
      'app/__init__.py': '',
      'app/main.py': 'x=1\n',
      'app/types.pyi': 'x: int\n',
      'app/readme.md': '# no\n',
      '.venv/lib/dep.py': 'installed=1\n',
      '__pycache__/main.cpython-312.pyc': 'bytecode',
      '.git/hooks/x.py': 'hook=1\n',
      'tests/test_main.py': 'def test(): pass\n', // kept here — noise-filter drops it later, not the walker
    });
    const files = listSourceFiles(dir, 'python');
    expect(files).toContain('app/__init__.py');
    expect(files).toContain('app/main.py');
    expect(files).toContain('app/types.pyi');
    expect(files).toContain('tests/test_main.py');
    // excluded / dot dirs never appear
    expect(files.some((f) => f.startsWith('.venv/'))).toBe(false);
    expect(files.some((f) => f.startsWith('__pycache__/'))).toBe(false);
    expect(files.some((f) => f.startsWith('.git/'))).toBe(false);
    // non-source files never appear
    expect(files.some((f) => f.endsWith('.md') || f.endsWith('.pyc'))).toBe(false);
  });

  it('lists .rb/.rake/.ru + Rakefile and skips vendor/tmp/log + dot dirs (ruby)', async () => {
    const dir = await repo({
      'app/models/user.rb': 'class User; end\n',
      'lib/tasks/db.rake': 'task :db\n',
      'config.ru': 'run App\n',
      Rakefile: "require 'rake'\n",
      Gemfile: "gem 'rails'\n",
      'mygem.gemspec': 'Gem::Specification.new\n',
      'README.md': '# no\n',
      'vendor/bundle/gems/rails/lib/rails.rb': 'module Rails; end\n',
      'tmp/cache/x.rb': 'x=1\n',
      'log/dev.rb': 'x=1\n',
      '.bundle/gem.rb': 'x=1\n',
    });
    const files = listSourceFiles(dir, 'ruby');
    expect(files).toContain('app/models/user.rb');
    expect(files).toContain('lib/tasks/db.rake');
    expect(files).toContain('config.ru');
    expect(files).toContain('Rakefile');
    // manifests + non-source never appear
    expect(files).not.toContain('Gemfile');
    expect(files.some((f) => f.endsWith('.gemspec') || f.endsWith('.md'))).toBe(false);
    // vendored / scratch / dot dirs never appear
    expect(files.some((f) => f.startsWith('vendor/'))).toBe(false);
    expect(files.some((f) => f.startsWith('tmp/'))).toBe(false);
    expect(files.some((f) => f.startsWith('log/'))).toBe(false);
    expect(files.some((f) => f.startsWith('.bundle/'))).toBe(false);
  });

  it('lists .ex/.exs/.heex and skips _build/deps/.elixir_ls + dot dirs (elixir)', async () => {
    const dir = await repo({
      'lib/my_app/user.ex': 'defmodule MyApp.User do\nend\n',
      'lib/my_app_web/router.ex': 'defmodule MyAppWeb.Router do\nend\n',
      'lib/my_app_web/controllers/page_html/index.html.heex': '<h1>hi</h1>\n',
      'config/config.exs': 'import Config\n',
      'test/my_app_test.exs': 'defmodule MyAppTest do\nend\n', // kept — noise-filter drops tests later
      'README.md': '# no\n',
      '_build/dev/lib/my_app/ebin/x.ex': 'compiled=1\n',
      'deps/phoenix/lib/phoenix.ex': 'vendored=1\n',
      '.elixir_ls/cache.ex': 'cache=1\n',
    });
    const files = listSourceFiles(dir, 'elixir');
    expect(files).toContain('lib/my_app/user.ex');
    expect(files).toContain('lib/my_app_web/controllers/page_html/index.html.heex');
    expect(files).toContain('config/config.exs');
    expect(files).toContain('test/my_app_test.exs');
    // build artifacts / vendored deps / LS cache never appear
    expect(files.some((f) => f.startsWith('_build/'))).toBe(false);
    expect(files.some((f) => f.startsWith('deps/'))).toBe(false);
    expect(files.some((f) => f.startsWith('.elixir_ls/'))).toBe(false);
    // non-source files never appear
    expect(files.some((f) => f.endsWith('.md'))).toBe(false);
  });

  it('lists .swift and skips .build/Pods/DerivedData + Xcode container dirs (swift)', async () => {
    const dir = await repo({
      'Sources/App/App.swift': 'struct App {}\n',
      'Sources/App/View.swift': 'struct View {}\n',
      'Package.swift': 'let p = Package(name: "X")\n', // kept by walker; adapter skips it
      'README.md': '# no\n',
      '.build/checkouts/dep/Dep.swift': 'struct Dep {}\n',
      'Pods/Alamofire/Source/AF.swift': 'struct AF {}\n',
      'DerivedData/Build/x.swift': 'struct Built {}\n',
      'MyApp.xcodeproj/GeneratedModuleMap.swift': 'struct Gen {}\n',
      'Assets.xcassets/Gen.swift': 'struct AssetGen {}\n',
    });
    const files = listSourceFiles(dir, 'swift');
    expect(files).toContain('Sources/App/App.swift');
    expect(files).toContain('Sources/App/View.swift');
    expect(files).toContain('Package.swift'); // walker includes it; SwiftExtractor filters it
    // build/vendor + Xcode container dirs never appear
    expect(files.some((f) => f.startsWith('.build/'))).toBe(false);
    expect(files.some((f) => f.startsWith('Pods/'))).toBe(false);
    expect(files.some((f) => f.startsWith('DerivedData/'))).toBe(false);
    expect(files.some((f) => f.includes('.xcodeproj/'))).toBe(false);
    expect(files.some((f) => f.includes('.xcassets/'))).toBe(false);
    expect(files.some((f) => f.endsWith('.md'))).toBe(false);
  });
});

describe('detectRepoLanguages (multi-language)', () => {
  const ts = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`frontend/src/f${i}.ts`, `export const x${i}=1;\n`]));
  const py = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`backend/app/m${i}.py`, `x = ${i}\n`]));
  const rb = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`app/models/m${i}.rb`, `class M${i}; end\n`]));
  const ex = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`lib/my_app/m${i}.ex`, `defmodule M${i} do\nend\n`]));
  const php = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`app/M${i}.php`, `<?php\nnamespace App;\nclass M${i} {}\n`]));

  it('returns a SINGLE language for a single-language repo (no behavior change)', async () => {
    expect(await detectRepoLanguages(await repo({ 'package.json': '{}', ...ts(6) }))).toEqual(['ts']);
    expect(await detectRepoLanguages(await repo({ 'pyproject.toml': '[project]\nname="x"\n', ...py(6) }))).toEqual(['python']);
    expect(await detectRepoLanguages(await repo({ Gemfile: "gem 'rails'\n", ...rb(6) }))).toEqual(['ruby']);
    expect(await detectRepoLanguages(await repo({ 'mix.exs': 'defmodule X.MixProject do\nend\n', ...ex(6) }))).toEqual(['elixir']);
    expect(await detectRepoLanguages(await repo({ 'composer.json': '{}', ...php(6) }))).toEqual(['php']);
  });

  it('returns BOTH languages (php dominant) for a Laravel backend + large Vue/Inertia frontend', async () => {
    const dir = await repo({ 'composer.json': '{"require":{"laravel/framework":"^11"}}', 'package.json': '{}', ...php(40), ...ts(20) });
    expect(detectRepoLanguages(dir)).toEqual(['php', 'ts']);
  });

  it('keeps a Phoenix repo single-language (elixir) despite an assets/ JS toolchain below threshold', async () => {
    const dir = await repo({ 'mix.exs': 'defmodule X.MixProject do\nend\n', ...ex(40), 'assets/js/app.js': 'x=1;\n', 'assets/js/hooks.js': 'y=2;\n' });
    expect(detectRepoLanguages(dir)).toEqual(['elixir']);
  });

  it('returns BOTH languages (dominant first) for an Elixir backend + large JS frontend', async () => {
    const dir = await repo({ 'mix.exs': 'defmodule X.MixProject do\nend\n', ...ex(20), ...ts(40) });
    expect(detectRepoLanguages(dir)).toEqual(['ts', 'elixir']);
  });

  it('keeps a TS repo single-language when it only ships a couple of .py scripts (below threshold)', async () => {
    const dir = await repo({ 'package.json': '{}', ...ts(40), 'scripts/gen.py': 'print(1)\n', 'scripts/two.py': 'print(2)\n' });
    expect(detectRepoLanguages(dir)).toEqual(['ts']);
  });

  it('returns BOTH languages (dominant first) for a genuine polyglot repo', async () => {
    const dir = await repo({ 'package.json': '{}', 'backend/pyproject.toml': '[project]\nname="be"\n', ...ts(40), ...py(20) });
    expect(detectRepoLanguages(dir)).toEqual(['ts', 'python']);
  });

  it('orders by dominance (python-heavy → python first)', async () => {
    const dir = await repo({ 'package.json': '{}', 'backend/pyproject.toml': '[project]\nname="be"\n', ...ts(15), ...py(40) });
    expect(detectRepoLanguages(dir)).toEqual(['python', 'ts']);
  });
});

describe('graphLanguage', () => {
  const g = (langs: string[]): NormalizedGraph => ({
    root: '/x',
    files: langs.map((language, i) => ({ id: `f${i}`, loc: 1, language })),
    edges: [],
    externals: [],
  });
  it('is python for py/pyi, ruby for rb, elixir for ex/exs/heex, php for php, swift for swift, else ts', () => {
    expect(graphLanguage(g(['ts', 'tsx']))).toBe('ts');
    expect(graphLanguage(g(['py']))).toBe('python');
    expect(graphLanguage(g(['pyi']))).toBe('python');
    expect(graphLanguage(g(['rb']))).toBe('ruby');
    expect(graphLanguage(g(['ex']))).toBe('elixir');
    expect(graphLanguage(g(['exs']))).toBe('elixir');
    expect(graphLanguage(g(['heex']))).toBe('elixir');
    expect(graphLanguage(g(['php']))).toBe('php');
    expect(graphLanguage(g(['swift']))).toBe('swift');
    expect(graphLanguage(g([]))).toBe('ts');
  });
});

describe('hasSwiftManifest', () => {
  it('detects Package.swift / Package.resolved / Podfile / *.xcodeproj dir, else false', async () => {
    expect(hasSwiftManifest(await repo({ 'Package.swift': 'let p = Package(name: "X")\n' }))).toBe(true);
    expect(hasSwiftManifest(await repo({ 'Package.resolved': '{"pins":[],"version":2}\n' }))).toBe(true);
    expect(hasSwiftManifest(await repo({ Podfile: "pod 'AF'\n" }))).toBe(true);
    expect(hasSwiftManifest(await repo({ 'MyApp.xcodeproj/project.pbxproj': '// proj\n' }))).toBe(true);
    expect(hasSwiftManifest(await repo({ 'App.xcworkspace/contents.xcworkspacedata': '<x/>\n' }))).toBe(true);
    expect(hasSwiftManifest(await repo({ 'package.json': '{}' }))).toBe(false);
    expect(hasSwiftManifest(await repo({ Gemfile: "gem 'rails'\n" }))).toBe(false);
  });
});

describe('hasSwiftManifestDeep', () => {
  it('matches hasSwiftManifest at the root (cheap short-circuit)', async () => {
    expect(hasSwiftManifestDeep(await repo({ 'Package.swift': 'let p = Package(name: "X")\n' }))).toBe(true);
    expect(hasSwiftManifestDeep(await repo({ Podfile: "pod 'AF'\n" }))).toBe(true);
    expect(hasSwiftManifestDeep(await repo({ 'MyApp.xcodeproj/project.pbxproj': '// proj\n' }))).toBe(true);
  });

  it('finds a nested-only Swift package the root-only check misses', async () => {
    // A JS-root monorepo with the iOS app under `mobile/MyApp/` — no root Swift manifest.
    const dir = await repo({
      'package.json': '{"name":"web"}',
      'mobile/MyApp/Package.swift': 'let p = Package(name: "MyApp")\n',
      'mobile/MyApp/Sources/App/App.swift': 'import SwiftUI\n',
    });
    expect(hasSwiftManifest(dir)).toBe(false); // root-only selector still says no
    expect(hasSwiftManifestDeep(dir)).toBe(true); // the fleet gate says yes
  });

  it('finds a nested-only Xcode project (no plain-file manifest)', async () => {
    const dir = await repo({
      'package.json': '{"name":"web"}',
      'ios/MyApp.xcodeproj/project.pbxproj': '// proj\n',
    });
    expect(hasSwiftManifest(dir)).toBe(false);
    expect(hasSwiftManifestDeep(dir)).toBe(true);
  });

  it('ignores a vendored/build manifest and returns false for a non-Swift repo', async () => {
    const dir = await repo({
      'package.json': '{}',
      '.build/checkouts/SomeDep/Package.swift': 'let p = Package(name: "Dep")\n',
      'Pods/Vendored/Vendored.xcodeproj/project.pbxproj': '// proj\n',
    });
    expect(hasSwiftManifestDeep(dir)).toBe(false);
    expect(hasSwiftManifestDeep(await repo({ 'README.md': '# hi\n' }))).toBe(false);
  });
});

describe('hasRubyManifest', () => {
  it('detects Gemfile / Gemfile.lock / *.gemspec, else false', async () => {
    expect(hasRubyManifest(await repo({ Gemfile: "gem 'rails'\n" }))).toBe(true);
    expect(hasRubyManifest(await repo({ 'Gemfile.lock': 'GEM\n' }))).toBe(true);
    expect(hasRubyManifest(await repo({ 'foo.gemspec': 'Gem::Specification.new\n' }))).toBe(true);
    expect(hasRubyManifest(await repo({ 'package.json': '{}' }))).toBe(false);
  });
});

describe('hasComposerManifest', () => {
  it('detects composer.json / composer.lock, else false', async () => {
    expect(hasComposerManifest(await repo({ 'composer.json': '{}' }))).toBe(true);
    expect(hasComposerManifest(await repo({ 'composer.lock': '{"packages":[]}' }))).toBe(true);
    expect(hasComposerManifest(await repo({ 'package.json': '{}' }))).toBe(false);
    expect(hasComposerManifest(await repo({ Gemfile: "gem 'rails'\n" }))).toBe(false);
  });
});

describe('hasMixManifest', () => {
  it('detects mix.exs / mix.lock, else false', async () => {
    expect(hasMixManifest(await repo({ 'mix.exs': 'defmodule X.MixProject do\nend\n' }))).toBe(true);
    expect(hasMixManifest(await repo({ 'mix.lock': '%{}\n' }))).toBe(true);
    expect(hasMixManifest(await repo({ 'package.json': '{}' }))).toBe(false);
    expect(hasMixManifest(await repo({ Gemfile: "gem 'rails'\n" }))).toBe(false);
  });
});

describe('hasMixManifestDeep', () => {
  it('matches hasMixManifest at the root (cheap short-circuit)', async () => {
    expect(hasMixManifestDeep(await repo({ 'mix.exs': 'defmodule X do\nend\n' }))).toBe(true);
    expect(hasMixManifestDeep(await repo({ 'mix.lock': '%{}\n' }))).toBe(true);
  });

  it('finds a nested/umbrella Elixir app the root-only check misses (Firezone shape)', async () => {
    // Rust at the root, Phoenix under `elixir/apps/web/` — no root mix.exs.
    const dir = await repo({
      'Cargo.toml': '[package]\nname = "fw"\n',
      'elixir/mix.exs': 'defmodule Umbrella do\nend\n',
      'elixir/apps/web/mix.exs': 'defmodule Web do\nend\n',
    });
    expect(hasMixManifest(dir)).toBe(false); // root-only selector still says no
    expect(hasMixManifestDeep(dir)).toBe(true); // the fleet gate says yes
  });

  it('ignores a vendored/build mix.exs and returns false for a non-Elixir repo', async () => {
    const dir = await repo({
      'package.json': '{}',
      'deps/some_lib/mix.exs': 'defmodule Vendored do\nend\n',
      '_build/dev/lib/gen/mix.exs': 'defmodule Built do\nend\n',
    });
    expect(hasMixManifestDeep(dir)).toBe(false);
    expect(hasMixManifestDeep(await repo({ 'README.md': '# hi\n' }))).toBe(false);
  });
});
