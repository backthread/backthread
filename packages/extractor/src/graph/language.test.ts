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
});

describe('detectRepoLanguages (multi-language)', () => {
  const ts = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`frontend/src/f${i}.ts`, `export const x${i}=1;\n`]));
  const py = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`backend/app/m${i}.py`, `x = ${i}\n`]));
  const rb = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`app/models/m${i}.rb`, `class M${i}; end\n`]));

  it('returns a SINGLE language for a single-language repo (no behavior change)', async () => {
    expect(await detectRepoLanguages(await repo({ 'package.json': '{}', ...ts(6) }))).toEqual(['ts']);
    expect(await detectRepoLanguages(await repo({ 'pyproject.toml': '[project]\nname="x"\n', ...py(6) }))).toEqual(['python']);
    expect(await detectRepoLanguages(await repo({ Gemfile: "gem 'rails'\n", ...rb(6) }))).toEqual(['ruby']);
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
  it('is python for py/pyi, ruby for rb, else ts', () => {
    expect(graphLanguage(g(['ts', 'tsx']))).toBe('ts');
    expect(graphLanguage(g(['py']))).toBe('python');
    expect(graphLanguage(g(['pyi']))).toBe('python');
    expect(graphLanguage(g(['rb']))).toBe('ruby');
    expect(graphLanguage(g([]))).toBe('ts');
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
