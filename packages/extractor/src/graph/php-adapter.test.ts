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

const internalEdges = (
  g: { edges: Array<{ from: string; to: string; external: boolean; kind: string }> },
): string[] => g.edges.filter((e) => !e.external && e.kind === 'import').map((e) => `${e.from}->${e.to}`);

const callEdges = (
  g: { edges: Array<{ from: string; to: string; kind: string; weight: number }> },
): Array<{ edge: string; weight: number }> =>
  g.edges.filter((e) => e.kind === 'call').map((e) => ({ edge: `${e.from}->${e.to}`, weight: e.weight }));

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

  it('ignores `use function` / `use const` imports (not class imports)', async () => {
    const dir = await repo({
      'composer.json': COMPOSER,
      'app/Services/Billing.php':
        '<?php\nnamespace App\\Services;\nuse function App\\Helpers\\format;\nuse const App\\Config\\MAX;\nuse Illuminate\\Support\\Str;\nclass Billing {}\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    const exts = graph.externals.map((x) => x.id);
    // The function/const markers live on the usegroup, not the item — they must not
    // be mistaken for class imports and mint a spurious first-party `ext:App` box.
    expect(exts).not.toContain('ext:App');
    // A real class import still becomes an external.
    expect(exts).toContain('ext:Illuminate');
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

  it('resolves first-party `use` edges in a PSR-0 repo (prefix not stripped, no ext leak)', async () => {
    const dir = await repo({
      'composer.json': JSON.stringify({ autoload: { 'psr-0': { 'Legacy\\': 'lib/' } } }),
      // PSR-0 places the FULL namespace under lib/ (Legacy\ is NOT stripped).
      'lib/Legacy/Models/User.php': '<?php\nnamespace Legacy\\Models;\nclass User {}\n',
      'lib/Legacy/Services/Billing.php':
        '<?php\nnamespace Legacy\\Services;\nuse Legacy\\Models\\User;\nclass Billing { public function u(): User { return new User; } }\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    // `use Legacy\Models\User` resolves via PSR-0 → a first-party edge, not ext:Legacy.
    expect(internalEdges(graph)).toContain('lib/Legacy/Services/Billing.php->lib/Legacy/Models/User.php');
    expect(graph.externals.map((x) => x.id)).not.toContain('ext:Legacy');
  });

  it('resolves first-party `use` edges in a classmap repo via the declared-class index', async () => {
    const dir = await repo({
      // No psr-4 / psr-0 map at all — a classmap-style repo. The declared-class
      // index (built by parsing every file) is the only resolution path.
      'composer.json': JSON.stringify({ autoload: { classmap: ['src/'] } }),
      'src/anywhere/User.php': '<?php\nnamespace Shop\\Models;\nclass User {}\n',
      'src/other/Billing.php':
        '<?php\nnamespace Shop\\Services;\nuse Shop\\Models\\User;\nclass Billing { public function u(): User { return new User; } }\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    expect(internalEdges(graph)).toContain('src/other/Billing.php->src/anywhere/User.php');
    // The class is first-party, so no spurious ext:Shop external box.
    expect(graph.externals.map((x) => x.id)).not.toContain('ext:Shop');
  });

  it('resolves a PSR-4-declared class that is NOT at its conventional path (index fallback)', async () => {
    const dir = await repo({
      'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }),
      // Declares App\Models\User but lives at a non-conventional path — PSR-4 misses,
      // the declared-class index recovers the first-party edge.
      'app/legacy/UserModel.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
      'app/Services/Billing.php':
        '<?php\nnamespace App\\Services;\nuse App\\Models\\User;\nclass Billing {}\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    expect(internalEdges(graph)).toContain('app/Services/Billing.php->app/legacy/UserModel.php');
    expect(graph.externals.map((x) => x.id)).not.toContain('ext:App');
  });

  it('resolves static + typed-instance call edges to an in-repo class (v2)', async () => {
    const dir = await repo({
      'composer.json': COMPOSER,
      'app/Services/UserService.php':
        '<?php\nnamespace App\\Services;\nclass UserService {\n  public function run(): void {}\n  public static function make(): self { return new self; }\n}\n',
      'app/Http/UserController.php':
        '<?php\nnamespace App\\Http;\n' +
        'use App\\Services\\UserService;\n' +
        'class UserController {\n' +
        '  private UserService $svc;\n' +
        '  public function index(UserService $s): void {\n' +
        '    $s->run();\n' + // typed param → call edge
        '    $this->svc->run();\n' + // typed property → call edge
        '    UserService::make();\n' + // static → call edge
        '    $local = new UserService();\n' + // new → import edge only, NOT a call edge
        '    $local->run();\n' + // typed via new-assignment → call edge
        '    $this->helper();\n' + // $this-> self call → NO edge
        '    Auth::user();\n' + // vendor facade → NO edge (unresolvable)
        '  }\n' +
        '  private function helper(): void {}\n' +
        '}\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    const calls = callEdges(graph);
    const controllerToService = calls.find(
      (c) => c.edge === 'app/Http/UserController.php->app/Services/UserService.php',
    );
    // Four resolvable receivers all point at UserService: $s, $this->svc, static, $local.
    expect(controllerToService?.weight).toBe(4);
    // The `use App\Services\UserService` still makes an IMPORT edge (independent of calls).
    expect(internalEdges(graph)).toContain('app/Http/UserController.php->app/Services/UserService.php');
    // No self-edge from `$this->helper()`, and no vendor `Auth::user()` edge.
    expect(calls.map((c) => c.edge)).not.toContain('app/Http/UserController.php->app/Http/UserController.php');
    expect(calls.every((c) => c.edge.endsWith('->app/Services/UserService.php'))).toBe(true);
  });

  it('resolves `$this->prop->m()` when the property is constructor-promoted (modern DI)', async () => {
    const dir = await repo({
      'composer.json': COMPOSER,
      'app/Services/Mailer.php': '<?php\nnamespace App\\Services;\nclass Mailer { public function send(): void {} }\n',
      'app/Http/SignupController.php':
        '<?php\nnamespace App\\Http;\nuse App\\Services\\Mailer;\n' +
        'class SignupController {\n' +
        '  public function __construct(private readonly Mailer $mailer) {}\n' +
        '  public function store(): void { $this->mailer->send(); }\n' + // promoted → call edge
        '}\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    expect(callEdges(graph).map((c) => c.edge)).toContain(
      'app/Http/SignupController.php->app/Services/Mailer.php',
    );
  });

  it('does NOT emit a call edge for a bare `new X()` (the import edge already covers it)', async () => {
    const dir = await repo({
      'composer.json': COMPOSER,
      'app/Models/Widget.php': '<?php\nnamespace App\\Models;\nclass Widget {}\n',
      'app/Services/Factory.php':
        '<?php\nnamespace App\\Services;\nuse App\\Models\\Widget;\nclass Factory {\n  public function build(): Widget { return new Widget(); }\n}\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    // `new Widget()` with no method call → an import edge, but NO call edge.
    expect(internalEdges(graph)).toContain('app/Services/Factory.php->app/Models/Widget.php');
    expect(callEdges(graph)).toEqual([]);
  });

  it('drops an untyped instance call (accuracy over recall)', async () => {
    const dir = await repo({
      'composer.json': COMPOSER,
      'app/Services/Thing.php': '<?php\nnamespace App\\Services;\nclass Thing { public function go(): void {} }\n',
      'app/Services/Runner.php':
        '<?php\nnamespace App\\Services;\nclass Runner {\n  public function run($x): void { $x->go(); }\n}\n',
    });
    const graph = await new PhpExtractor().extract(dir);
    // `$x` is untyped → its type is unknown → no call edge (would be a guess).
    expect(callEdges(graph)).toEqual([]);
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
