// The composer.json-gated PHP-fleet registration seam. The isolation guarantee —
// a TS/Python/Ruby/Elixir/Dart repo never module-loads php-parser — is enforced
// structurally by `registerLanguageScopedFrameworkAdapters` dynamically importing
// the fleet only when a composer manifest is present. (node --test isolates each
// test file in its own process, so the module-level once-flag starts fresh here.)

import { describe, it, expect } from '../testkit.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFrameworkAdapters, listFrameworkAdapters } from './registry.js';
import { registerBuiltinFrameworkAdapters, registerLanguageScopedFrameworkAdapters } from './register.js';
import { registerPhpFrameworkAdapters } from './register-php.js';

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-php-gate-'));
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(dir, rel), content);
  }
  return dir;
}

describe('registerLanguageScopedFrameworkAdapters (PHP gate)', () => {
  it('does not load the PHP fleet for a repo without a composer manifest', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const before = listFrameworkAdapters().length;
    const dir = await repo({ 'package.json': '{"name":"x"}' });
    await registerLanguageScopedFrameworkAdapters(dir); // no composer.json → no-op
    expect(listFrameworkAdapters().length).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('registers the PHP fleet when a composer manifest is present', async () => {
    clearFrameworkAdapters();
    const dir = await repo({ 'composer.json': '{"require":{"laravel/framework":"^11.0"}}' });
    await registerLanguageScopedFrameworkAdapters(dir);
    const names = listFrameworkAdapters().map((a) => a.name);
    expect(names).toContain('laravel');
    expect(names).toContain('symfony');
    expect(names).toContain('php-orm');
    expect(names).toContain('php-async');
    expect(names).toContain('api-platform');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('registerPhpFrameworkAdapters (fleet order)', () => {
  it('registers the full PHP fleet in priority order (web → data → async → protocol)', () => {
    clearFrameworkAdapters();
    registerPhpFrameworkAdapters();
    expect(listFrameworkAdapters().map((a) => a.name)).toEqual([
      'laravel',
      'symfony',
      'php-orm',
      'php-async',
      'api-platform',
    ]);
  });
});
