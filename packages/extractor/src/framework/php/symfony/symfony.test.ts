// The Symfony adapter — detection + role tags (controllers, commands).

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { symfonyAdapter, gatherSymfonySignals, scoreSymfony } from './symfony.js';
import type { FrameworkContext, FrameworkDetectContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function symfonyRepo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-symfony-'));
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
    match: { adapter: 'symfony', confidence: 0.9, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

const COMPOSER = JSON.stringify({
  autoload: { 'psr-4': { 'App\\': 'src/' } },
  require: { 'symfony/framework-bundle': '^7.0' },
});

describe('symfony detect', () => {
  it('scores symfony on a symfony/framework-bundle dep, null otherwise', () => {
    expect(scoreSymfony({ hasSymfony: true })?.adapter).toBe('symfony');
    expect(scoreSymfony({ hasSymfony: false })).toBeNull();
  });
  it('detects via composer.json require', async () => {
    const ctx = await symfonyRepo({
      'composer.json': COMPOSER,
      'src/Kernel.php': '<?php\nnamespace App;\nclass Kernel {}\n',
    });
    const m = await symfonyAdapter.detect({ repoDir: ctx.repoDir } as FrameworkDetectContext);
    expect(m?.adapter).toBe('symfony');
  });
  it('does not detect a non-symfony composer repo', async () => {
    expect(gatherSymfonySignals(await mkdtemp(join(tmpdir(), 'x-'))).hasSymfony).toBe(false);
  });
});

describe('symfony roleTags', () => {
  it('tags src/Controller gateway (attribute + docblock + AbstractController) and src/Command job', async () => {
    const ctx = await symfonyRepo({
      'composer.json': COMPOSER,
      // Attribute-routed controller in src/Controller.
      'src/Controller/BlogController.php':
        "<?php\nnamespace App\\Controller;\nuse Symfony\\Component\\Routing\\Attribute\\Route;\nuse Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;\n#[Route('/blog')]\nclass BlogController extends AbstractController {\n  #[Route('/', name: 'blog_index')]\n  public function index() {}\n}\n",
      // Docblock-annotation controller OUTSIDE src/Controller (content fallback).
      'src/Web/LegacyController.php':
        "<?php\nnamespace App\\Web;\n/**\n * @Route(\"/legacy\")\n */\nclass LegacyController {\n  /**\n   * @Route(\"/x\", name=\"legacy_x\")\n   */\n  public function x() {}\n}\n",
      // A command via #[AsCommand].
      'src/Command/SyncCommand.php':
        "<?php\nnamespace App\\Command;\nuse Symfony\\Component\\Console\\Attribute\\AsCommand;\nuse Symfony\\Component\\Console\\Command\\Command;\n#[AsCommand(name: 'app:sync')]\nclass SyncCommand extends Command {}\n",
      // A plain service — no role.
      'src/Service/Mailer.php': '<?php\nnamespace App\\Service;\nclass Mailer {}\n',
    });
    const roles = await symfonyAdapter.roleTags!(ctx);
    expect(roles.get('src/Controller/BlogController.php')).toMatchObject({ role: 'controller', kind: 'gateway' });
    expect(roles.get('src/Web/LegacyController.php')).toMatchObject({ role: 'controller', kind: 'gateway' });
    expect(roles.get('src/Command/SyncCommand.php')).toMatchObject({ role: 'command', kind: 'job' });
    expect(roles.has('src/Service/Mailer.php')).toBe(false);
  });

  it('tags controllers in a modular bundle Controller/ dir (not just src/Controller)', async () => {
    const ctx = await symfonyRepo({
      'composer.json': COMPOSER,
      // A Sylius-style bundle controller: nested Controller/ dir, extends a
      // ResourceController base (NOT AbstractController), no #[Route].
      'src/App/UserBundle/Controller/UserController.php':
        '<?php\nnamespace App\\UserBundle\\Controller;\nuse App\\ResourceBundle\\Controller\\ResourceController;\nclass UserController extends ResourceController {}\n',
      'src/App/UserBundle/Command/CleanupCommand.php':
        '<?php\nnamespace App\\UserBundle\\Command;\nuse Symfony\\Component\\Console\\Command\\Command;\nclass CleanupCommand extends Command {}\n',
    });
    const roles = await symfonyAdapter.roleTags!(ctx);
    expect(roles.get('src/App/UserBundle/Controller/UserController.php')).toMatchObject({ role: 'controller', kind: 'gateway' });
    expect(roles.get('src/App/UserBundle/Command/CleanupCommand.php')).toMatchObject({ role: 'command', kind: 'job' });
  });

  it('has no route-spine syntheticEdges hook (routes self-declare on controllers)', () => {
    expect(symfonyAdapter.syntheticEdges).toBeUndefined();
  });
});
