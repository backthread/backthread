// The Laravel adapter — detection, role tags, and the route spine.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { laravelAdapter, gatherLaravelSignals, scoreLaravel } from './laravel.js';
import type { FrameworkContext, FrameworkDetectContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function laravelRepo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-laravel-'));
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
    match: { adapter: 'laravel', confidence: 0.9, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

const edgeKey = (e: { source: string; target: string }): string => `${e.source}→${e.target}`;

describe('laravel detect', () => {
  it('scores laravel on a laravel/framework dep, null otherwise', () => {
    expect(scoreLaravel({ hasLaravel: true })?.adapter).toBe('laravel');
    expect(scoreLaravel({ hasLaravel: false })).toBeNull();
  });
  it('detects via composer.json require', async () => {
    const ctx = await laravelRepo({
      'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
      'app/Models/User.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
    });
    const m = await laravelAdapter.detect({ repoDir: ctx.repoDir } as FrameworkDetectContext);
    expect(m?.adapter).toBe('laravel');
  });
  it('does not detect a non-laravel composer repo', async () => {
    expect(gatherLaravelSignals(await mkdtemp(join(tmpdir(), 'x-'))).hasLaravel).toBe(false);
  });
});

const COMPOSER = JSON.stringify({
  autoload: { 'psr-4': { 'App\\': 'app/' } },
  require: { 'laravel/framework': '^11.0' },
});

describe('laravel roleTags', () => {
  it('tags controllers gateway, console commands job, events/listeners service', async () => {
    const ctx = await laravelRepo({
      'composer.json': COMPOSER,
      'app/Http/Controllers/UserController.php':
        '<?php\nnamespace App\\Http\\Controllers;\nclass UserController extends Controller {}\n',
      'app/Console/Commands/SyncCommand.php':
        '<?php\nnamespace App\\Console\\Commands;\nuse Illuminate\\Console\\Command;\nclass SyncCommand extends Command {}\n',
      'app/Events/OrderShipped.php': '<?php\nnamespace App\\Events;\nclass OrderShipped {}\n',
      'app/Listeners/SendShipmentNotification.php':
        '<?php\nnamespace App\\Listeners;\nclass SendShipmentNotification {}\n',
    });
    const roles = await laravelAdapter.roleTags!(ctx);
    expect(roles.get('app/Http/Controllers/UserController.php')).toMatchObject({ role: 'controller', kind: 'gateway' });
    expect(roles.get('app/Console/Commands/SyncCommand.php')).toMatchObject({ role: 'command', kind: 'job' });
    expect(roles.get('app/Events/OrderShipped.php')).toMatchObject({ role: 'event', kind: 'service' });
    expect(roles.get('app/Listeners/SendShipmentNotification.php')).toMatchObject({ role: 'listener', kind: 'service' });
  });
});

describe('laravel route spine', () => {
  it('maps verb, resource, controller-group, prefix-group, and legacy routes to controllers', async () => {
    const ctx = await laravelRepo({
      'composer.json': COMPOSER,
      'app/Http/Controllers/UserController.php':
        '<?php\nnamespace App\\Http\\Controllers;\nclass UserController extends Controller {}\n',
      'app/Http/Controllers/PostController.php':
        '<?php\nnamespace App\\Http\\Controllers;\nclass PostController extends Controller {}\n',
      'app/Http/Controllers/DashController.php':
        '<?php\nnamespace App\\Http\\Controllers;\nclass DashController extends Controller {}\n',
      'routes/web.php':
        "<?php\nuse App\\Http\\Controllers\\UserController;\nuse App\\Http\\Controllers\\PostController;\nuse App\\Http\\Controllers\\DashController;\n" +
        "Route::get('/users', [UserController::class, 'index']);\n" +
        "Route::resource('posts', PostController::class);\n" +
        "Route::controller(UserController::class)->group(function () {\n  Route::get('/profile', 'profile');\n});\n" +
        "Route::prefix('admin')->group(function () {\n  Route::get('/dash', [DashController::class, 'show']);\n});\n" +
        "Route::get('/closure', function () { return 1; });\n",
    });
    const edges = await laravelAdapter.syntheticEdges!(ctx);
    const keys = edges.map(edgeKey);
    // verb + tuple action
    expect(keys).toContain('routes/web.php→app/Http/Controllers/UserController.php');
    // resource
    expect(keys).toContain('routes/web.php→app/Http/Controllers/PostController.php');
    // nested prefix->group with a tuple action
    expect(keys).toContain('routes/web.php→app/Http/Controllers/DashController.php');
    // every edge is a 'calls' edge from the route file
    expect(edges.every((e) => e.kind === 'calls' && e.source === 'routes/web.php')).toBe(true);
    // the closure route produced no controller edge (3 controllers, 3 edges)
    expect(edges.length).toBe(3);
  });

  it('resolves a legacy Ctrl@method string best-effort', async () => {
    const ctx = await laravelRepo({
      'composer.json': COMPOSER,
      'app/Http/Controllers/LegacyController.php':
        '<?php\nnamespace App\\Http\\Controllers;\nclass LegacyController extends Controller {}\n',
      'routes/api.php': "<?php\nRoute::get('/x', 'LegacyController@show');\n",
    });
    const edges = await laravelAdapter.syntheticEdges!(ctx);
    expect(edges.map(edgeKey)).toContain('routes/api.php→app/Http/Controllers/LegacyController.php');
  });
});
