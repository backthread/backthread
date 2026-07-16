// Shared PHP framework-analysis layer — PSR-4 resolution + no-re-parse scope.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parsePhpScope, buildPhpBindings } from './analyze.js';
import {
  attributesOf,
  attrNamedArg,
  attrPositionalArgs,
  classConstRef,
  stringValue,
  callMethodName,
  baseStaticClass,
} from './php-ast.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function phpRepo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-phpscope-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const graph: NormalizedGraph = {
    root: dir,
    files: Object.keys(files)
      .filter((f) => f.endsWith('.php'))
      .map((id) => ({ id, loc: 1, language: 'php' })),
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

const COMPOSER = JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } });

describe('buildPhpBindings', () => {
  it('resolves an FQN to its file via the composer PSR-4 map', async () => {
    const ctx = await phpRepo({
      'composer.json': COMPOSER,
      'app/Models/User.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
    });
    const bindings = buildPhpBindings(ctx.repoDir, ['app/Models/User.php']);
    expect(bindings.resolve('App\\Models\\User')).toBe('app/Models/User.php');
    expect(bindings.resolve('App\\Models\\Missing')).toBeUndefined();
  });

  it('resolves an FQN via the composer PSR-0 map too (parity with the import graph)', async () => {
    const ctx = await phpRepo({
      'composer.json': JSON.stringify({ autoload: { 'psr-0': { 'Legacy\\': 'lib/' } } }),
      // PSR-0 places the FULL namespace under lib/ (Legacy\ is NOT stripped).
      'lib/Legacy/Models/User.php': '<?php\nnamespace Legacy\\Models;\nclass User {}\n',
    });
    const bindings = buildPhpBindings(ctx.repoDir, ['lib/Legacy/Models/User.php']);
    expect(bindings.resolve('Legacy\\Models\\User')).toBe('lib/Legacy/Models/User.php');
  });
});

describe('parsePhpScope', () => {
  it('parses in-scope files once, exposing classes + a use-scope-aware resolver', async () => {
    const ctx = await phpRepo({
      'composer.json': COMPOSER,
      'app/Models/User.php':
        '<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass User extends Model {}\n',
      'app/Http/Controllers/UserController.php':
        '<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\User;\nclass UserController extends Controller {\n  public function index() { return User::all(); }\n}\n',
    });
    const scope = await parsePhpScope(ctx);

    // every php file parsed exactly once
    expect(scope.parsed.size).toBe(2);

    // classes collected with FQN + extends (as written)
    const controller = scope.parsed
      .get('app/Http/Controllers/UserController.php')!
      .classes.find((c) => c.simpleName === 'UserController')!;
    expect(controller.fqn).toBe('App\\Http\\Controllers\\UserController');
    expect(controller.extends).toBe('Controller');
    expect(controller.methods.map((m) => m.name)).toContain('index');

    // class FQN → file index
    expect(scope.resolve('App\\Models\\User')).toBe('app/Models/User.php');
    // a written short ref resolves through the file's use scope
    const ctrlFile = scope.parsed.get('app/Http/Controllers/UserController.php')!;
    expect(scope.resolveRef('User', ctrlFile.useMap, ctrlFile.namespace)).toBe('app/Models/User.php');
  });

  it('excludes `use function` / `use const` from the class use-map', async () => {
    const ctx = await phpRepo({
      'composer.json': COMPOSER,
      'app/Services/Billing.php':
        '<?php\nnamespace App\\Services;\nuse function App\\Helpers\\format;\nuse const App\\Config\\MAX;\nuse App\\Models\\User;\nclass Billing {}\n',
    });
    const scope = await parsePhpScope(ctx);
    const useMap = scope.parsed.get('app/Services/Billing.php')!.useMap;
    expect(useMap.has('User')).toBe(true); // a class import
    expect(useMap.has('format')).toBe(false); // a function import — excluded
    expect(useMap.has('MAX')).toBe(false); // a const import — excluded
  });

  it('reads PHP-8 attributes + `::class` references + static-call receivers', async () => {
    const ctx = await phpRepo({
      'composer.json': COMPOSER,
      'app/Controller/BlogController.php':
        "<?php\nnamespace App\\Controller;\nuse Symfony\\Component\\Routing\\Attribute\\Route;\n#[Route('/blog', name: 'blog_index')]\nclass BlogController {\n  public function handle() {\n    SendMail::dispatch()->onQueue('mail');\n    return Post::class;\n  }\n}\n",
    });
    const scope = await parsePhpScope(ctx);
    const cls = scope.parsed.get('app/Controller/BlogController.php')!.classes[0];

    // class-level attribute: name + positional/named args
    const attrs = attributesOf(cls.body);
    const route = attrs.find((a) => a.name === 'Route')!;
    expect(route).toBeTruthy();
    expect(stringValue(attrPositionalArgs(route)[0])).toBe('/blog');
    expect(stringValue(attrNamedArg(route, 'name'))).toBe('blog_index');

    // walk the method body calls: base static receiver of a chained call
    const calls = scope.parsed.get('app/Controller/BlogController.php')!.calls;
    const dispatch = calls.find((c) => callMethodName(c) === 'dispatch');
    expect(dispatch).toBeTruthy();
    const onQueue = calls.find((c) => callMethodName(c) === 'onQueue')!;
    expect(baseStaticClass(onQueue)).toBe('SendMail');

    // find the `Post::class` reference anywhere in the tree
    const found: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const r = classConstRef(n);
      if (r) found.push(r);
      for (const v of Object.values(n as Record<string, unknown>)) {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') walk(v);
      }
    };
    walk(scope.parsed.get('app/Controller/BlogController.php')!.node);
    expect(found).toContain('Post');
  });
});
