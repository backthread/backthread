// The API Platform adapter (protocol) — detection + #[ApiResource] → gateway roles.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { apiPlatformAdapter, gatherApiPlatformSignals, scoreApiPlatform } from './api-platform.js';
import type { FrameworkContext, FrameworkDetectContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function apiPlatformRepo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-apiplatform-'));
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
    match: { adapter: 'api-platform', confidence: 0.9, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

const COMPOSER = JSON.stringify({
  autoload: { 'psr-4': { 'App\\': 'src/' } },
  require: { 'api-platform/core': '^3.0', 'doctrine/orm': '^3.0' },
});

describe('api-platform detect', () => {
  it('scores on any api-platform/* dep, null otherwise', () => {
    expect(scoreApiPlatform({ hasApiPlatform: true })?.adapter).toBe('api-platform');
    expect(scoreApiPlatform({ hasApiPlatform: false })).toBeNull();
  });

  it('detects api-platform/core and the split 4.x packages', async () => {
    const core = await apiPlatformRepo({ 'composer.json': COMPOSER, 'src/Kernel.php': '<?php\nnamespace App;\nclass Kernel {}\n' });
    expect((await apiPlatformAdapter.detect({ repoDir: core.repoDir } as FrameworkDetectContext))?.adapter).toBe('api-platform');

    const split = await mkdtemp(join(tmpdir(), 'bt-ap-split-'));
    dirs.push(split);
    await writeFile(join(split, 'composer.json'), JSON.stringify({ require: { 'api-platform/symfony': '^4.0' } }));
    expect((await apiPlatformAdapter.detect({ repoDir: split } as FrameworkDetectContext))?.adapter).toBe('api-platform');
  });

  it('does not detect a non-api-platform composer repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-'));
    dirs.push(dir);
    await writeFile(join(dir, 'composer.json'), JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } }));
    expect(gatherApiPlatformSignals(dir).hasApiPlatform).toBe(false);
  });
});

describe('api-platform roleTags', () => {
  it('tags an #[ApiResource] class as gateway with resource-tier priority', async () => {
    const ctx = await apiPlatformRepo({
      'composer.json': COMPOSER,
      'src/Entity/Book.php':
        '<?php\nnamespace App\\Entity;\nuse ApiPlatform\\Metadata\\ApiResource;\nuse Doctrine\\ORM\\Mapping as ORM;\n' +
        '#[ORM\\Entity]\n#[ApiResource]\nclass Book {}\n',
      'src/Entity/Plain.php': '<?php\nnamespace App\\Entity;\nclass Plain {}\n',
    });
    const roles = await apiPlatformAdapter.roleTags!(ctx);
    const book = roles.get('src/Entity/Book.php');
    expect(book?.role).toBe('api-resource');
    expect(book?.kind).toBe('gateway');
    // Above php-orm's entity priority (2), below Symfony's controller priority (8),
    // so an #[ApiResource] Doctrine entity collapses to gateway.
    expect(book?.priority).toBe(7);
    // A plain entity carrying no #[ApiResource] is not tagged by this adapter.
    expect(roles.has('src/Entity/Plain.php')).toBe(false);
  });

  it('tags a legacy `@ApiResource` docblock-annotated class too', async () => {
    const ctx = await apiPlatformRepo({
      'composer.json': COMPOSER,
      'src/Entity/Legacy.php':
        '<?php\nnamespace App\\Entity;\nuse ApiPlatform\\Core\\Annotation\\ApiResource;\n' +
        '/**\n * @ApiResource\n */\nclass Legacy {}\n',
    });
    const roles = await apiPlatformAdapter.roleTags!(ctx);
    expect(roles.get('src/Entity/Legacy.php')?.role).toBe('api-resource');
  });
});
