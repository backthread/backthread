// The ORM adapter — Eloquent + Doctrine model/entity roles, association edges,
// Data-Model grouping, and co-firing.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ormAdapter, gatherOrmSignals, scoreOrm } from './orm.js';
import type { FrameworkContext, FrameworkDetectContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function ormRepo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-php-orm-'));
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
    match: { adapter: 'php-orm', confidence: 0.85, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

const edgeKey = (e: { source: string; target: string }): string => `${e.source}→${e.target}`;

describe('php-orm detect', () => {
  it('scores on Eloquent or Doctrine deps, null otherwise', () => {
    expect(scoreOrm({ hasEloquent: true, hasDoctrine: false })?.adapter).toBe('php-orm');
    expect(scoreOrm({ hasEloquent: false, hasDoctrine: true })?.adapter).toBe('php-orm');
    expect(scoreOrm({ hasEloquent: false, hasDoctrine: false })).toBeNull();
  });
  it('detects illuminate/database and doctrine/orm', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-'));
    dirs.push(dir);
    await writeFile(join(dir, 'composer.json'), JSON.stringify({ require: { 'doctrine/orm': '^3.0' } }));
    const s = gatherOrmSignals(dir);
    expect(s.hasDoctrine).toBe(true);
    expect(s.hasEloquent).toBe(false);
  });
});

const ELOQUENT_COMPOSER = JSON.stringify({
  autoload: { 'psr-4': { 'App\\': 'app/' } },
  require: { 'laravel/framework': '^11.0' },
});

describe('php-orm — Eloquent', () => {
  it('tags models service, draws association calls, groups app/Models as Data Model', async () => {
    const ctx = await ormRepo({
      'composer.json': ELOQUENT_COMPOSER,
      'app/Models/User.php':
        '<?php\nnamespace App\\Models;\nuse Illuminate\\Foundation\\Auth\\User as Authenticatable;\nuse App\\Models\\Post;\nclass User extends Authenticatable {\n  public function posts() { return $this->hasMany(Post::class); }\n  public function roles() { return $this->belongsToMany(\'App\\Models\\Role\'); }\n}\n',
      'app/Models/Post.php':
        '<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Post extends Model {\n  public function author() { return $this->belongsTo(User::class); }\n}\n',
      'app/Models/Role.php':
        '<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Role extends Model {}\n',
    });
    const [roles, edges, grouping] = await Promise.all([
      ormAdapter.roleTags!(ctx),
      ormAdapter.syntheticEdges!(ctx),
      ormAdapter.groupingPrior!(ctx),
    ]);
    expect(roles.get('app/Models/User.php')).toMatchObject({ role: 'model', kind: 'service' });
    expect(roles.get('app/Models/Post.php')).toMatchObject({ role: 'model', kind: 'service' });
    // hasMany(Post::class) → User→Post; belongsToMany('App\Models\Role') → User→Role.
    const keys = edges.map(edgeKey);
    expect(keys).toContain('app/Models/User.php→app/Models/Post.php');
    expect(keys).toContain('app/Models/User.php→app/Models/Role.php');
    expect(keys).toContain('app/Models/Post.php→app/Models/User.php');
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
    // Data-Model grouping.
    const dm = grouping.groups.find((g) => g.label === 'Data Model');
    expect(dm).toBeTruthy();
    expect(dm!.fileIds).toContain('app/Models/User.php');
  });
});

const DOCTRINE_COMPOSER = JSON.stringify({
  autoload: { 'psr-4': { 'App\\': 'src/' } },
  require: { 'doctrine/orm': '^3.0' },
});

describe('php-orm — Doctrine', () => {
  it('tags entities service (attribute + annotation), draws targetEntity + typed associations', async () => {
    const ctx = await ormRepo({
      'composer.json': DOCTRINE_COMPOSER,
      'src/Entity/Product.php':
        "<?php\nnamespace App\\Entity;\nuse Doctrine\\ORM\\Mapping as ORM;\nuse App\\Entity\\Category;\n#[ORM\\Entity]\nclass Product {\n  #[ORM\\ManyToOne(targetEntity: Category::class)]\n  private $category;\n  #[ORM\\ManyToOne]\n  private ?Supplier $supplier = null;\n}\n",
      'src/Entity/Category.php':
        "<?php\nnamespace App\\Entity;\nuse Doctrine\\ORM\\Mapping as ORM;\n#[ORM\\Entity]\nclass Category {}\n",
      'src/Entity/Supplier.php':
        "<?php\nnamespace App\\Entity;\nuse Doctrine\\ORM\\Mapping as ORM;\n#[ORM\\Entity]\nclass Supplier {}\n",
      // A docblock-annotation entity (legacy style).
      'src/Entity/Order.php':
        "<?php\nnamespace App\\Entity;\n/**\n * @ORM\\Entity\n */\nclass Order {\n  /**\n   * @ORM\\ManyToOne(targetEntity=\"App\\Entity\\Product\")\n   */\n  private $product;\n}\n",
    });
    const [roles, edges] = await Promise.all([ormAdapter.roleTags!(ctx), ormAdapter.syntheticEdges!(ctx)]);
    expect(roles.get('src/Entity/Product.php')).toMatchObject({ role: 'entity', kind: 'service' });
    expect(roles.get('src/Entity/Order.php')).toMatchObject({ role: 'entity', kind: 'service' });
    const keys = edges.map(edgeKey);
    // targetEntity: Category::class
    expect(keys).toContain('src/Entity/Product.php→src/Entity/Category.php');
    // typed-property fallback (#[ORM\ManyToOne] private ?Supplier $supplier)
    expect(keys).toContain('src/Entity/Product.php→src/Entity/Supplier.php');
    // docblock @ORM\ManyToOne(targetEntity="App\Entity\Product")
    expect(keys).toContain('src/Entity/Order.php→src/Entity/Product.php');
  });
});

describe('php-orm — co-firing', () => {
  it('detects both ORMs when both deps are present', () => {
    expect(scoreOrm({ hasEloquent: true, hasDoctrine: true })?.metadata).toMatchObject({ orms: ['eloquent', 'doctrine'] });
  });
});
