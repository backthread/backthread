// PHP structural extractor — the php-parser-driven PSR-4 import backbone.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PhpExtractor } from './php-adapter.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-php-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

const internalEdges = (g: { edges: Array<{ from: string; to: string; external: boolean }> }): string[] =>
  g.edges.filter((e) => !e.external).map((e) => `${e.from}->${e.to}`);

const COMPOSER = JSON.stringify({
  autoload: { 'psr-4': { 'App\\': 'app/' } },
  require: { 'laravel/framework': '^11.0' },
});

describe('PhpExtractor', () => {
  it('builds PSR-4 import edges from `use` statements + externals from vendor namespaces', async () => {
    const dir = await repo({
      'composer.json': COMPOSER,
      'app/Models/User.php':
        '<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nuse App\\Support\\Loggable;\nclass User extends Model {\n    use Loggable;\n}\n',
      'app/Support/Loggable.php': '<?php\nnamespace App\\Support;\ntrait Loggable {}\n',
      'app/Http/Controllers/Controller.php':
        '<?php\nnamespace App\\Http\\Controllers;\nabstract class Controller {}\n',
      'app/Http/Controllers/UserController.php':
        '<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\User;\nuse Illuminate\\Http\\Request;\nuse Symfony\\Component\\HttpFoundation\\Response;\nclass UserController extends Controller {\n  public function index(Request $r) { return User::all(); }\n}\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    const edges = internalEdges(graph);

    // `use App\Models\User` → first-party edge, resolved via PSR-4 (App\ → app/).
    expect(edges).toContain('app/Http/Controllers/UserController.php->app/Models/User.php');
    // `use App\Support\Loggable` + trait use → first-party edge.
    expect(edges).toContain('app/Models/User.php->app/Support/Loggable.php');

    // Vendor namespaces collapse to a single top-segment external box.
    const exts = graph.externals.map((x) => x.id);
    expect(exts).toContain('ext:Illuminate'); // Model + Request
    expect(exts).toContain('ext:Symfony'); // Response
    // The PHP file that instantiates them is a node; composer.json is not.
    expect(graph.files.map((f) => f.id)).not.toContain('composer.json');
  });

  it('recovers same-namespace inheritance with no `use` (extends in the same dir)', async () => {
    const dir = await repo({
      'composer.json': COMPOSER,
      'app/Models/User.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
      'app/Models/Admin.php': '<?php\nnamespace App\\Models;\nclass Admin extends User {}\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    // `extends User` has no `use` — resolved via current namespace + PSR-4.
    expect(internalEdges(graph)).toContain('app/Models/Admin.php->app/Models/User.php');
  });

  it('expands grouped `use` and drops single-segment PHP globals', async () => {
    const dir = await repo({
      'composer.json': COMPOSER,
      'app/Support/Loggable.php': '<?php\nnamespace App\\Support;\ntrait Loggable {}\n',
      'app/Support/Cacheable.php': '<?php\nnamespace App\\Support;\ntrait Cacheable {}\n',
      'app/Services/Billing.php':
        '<?php\nnamespace App\\Services;\nuse App\\Support\\{Loggable, Cacheable};\nuse Exception;\nclass Billing {\n  use Loggable, Cacheable;\n}\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    const edges = internalEdges(graph);
    // Grouped use expands under the App\Support\ prefix → two first-party edges.
    expect(edges).toContain('app/Services/Billing.php->app/Support/Loggable.php');
    expect(edges).toContain('app/Services/Billing.php->app/Support/Cacheable.php');
    // `use Exception` is a global class, not a package — no ext:Exception noise box.
    expect(graph.externals.map((x) => x.id)).not.toContain('ext:Exception');
  });

  it('excludes Blade views + vendored/storage dirs from the graph', async () => {
    const dir = await repo({
      'composer.json': COMPOSER,
      'app/Models/User.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
      'resources/views/users/index.blade.php': '<h1>{{ $title }}</h1>\n',
      'public/build/assets/app.php': '<?php // built asset\n',
      'vendor/laravel/framework/src/Foundation/Application.php': '<?php\nnamespace X;\nclass Application {}\n',
      'storage/framework/views/abc123.php': '<?php echo 1;\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    const ids = graph.files.map((f) => f.id);
    expect(ids).toContain('app/Models/User.php');
    expect(ids).not.toContain('resources/views/users/index.blade.php'); // Blade — excluded
    expect(ids).not.toContain('public/build/assets/app.php'); // build output — excluded
    expect(ids.some((i) => i.startsWith('vendor/'))).toBe(false); // vendored deps — excluded
    expect(ids.some((i) => i.startsWith('storage/'))).toBe(false); // runtime scratch — excluded
  });

  it('degrades an unparseable file to an edgeless node without sinking the extract', async () => {
    const dir = await repo({
      'composer.json': COMPOSER,
      'app/Models/User.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
      'app/Broken.php': '<?php this is not really ??? valid <<< php',
    });
    const graph = await new PhpExtractor().extract(dir);
    // Both files are nodes; the broken one just carries no edges.
    expect(graph.files.map((f) => f.id).sort()).toEqual(['app/Broken.php', 'app/Models/User.php']);
  });
});
