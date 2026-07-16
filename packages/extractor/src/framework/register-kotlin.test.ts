// The Gradle-manifest-gated Kotlin-fleet registration seam. The isolation guarantee — a
// TS/Python/Ruby/Elixir/Dart/PHP repo never module-loads the Kotlin scanner — is enforced
// structurally by `registerLanguageScopedFrameworkAdapters` dynamically importing the fleet
// only when a Gradle manifest is present. (node --test isolates each test file in its own
// process, so the module-level once-flag starts fresh here.)

import { describe, it, expect } from '../testkit.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFrameworkAdapters, listFrameworkAdapters } from './registry.js';
import { registerBuiltinFrameworkAdapters, registerLanguageScopedFrameworkAdapters } from './register.js';
import { registerKotlinFrameworkAdapters } from './register-kotlin.js';

// The full Kotlin fleet, in registration = co-fire priority order (web → data).
const KOTLIN_FLEET = ['android', 'ktor', 'spring', 'kotlin-orm'];

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-kotlin-gate-'));
  for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content);
  return dir;
}

describe('registerLanguageScopedFrameworkAdapters (Kotlin gate)', () => {
  it('does not load the Kotlin fleet for a repo without a Gradle manifest', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const before = listFrameworkAdapters().length;
    const dir = await repo({ 'package.json': '{"name":"x"}' });
    await registerLanguageScopedFrameworkAdapters(dir); // no build.gradle → no-op
    expect(listFrameworkAdapters().length).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('registers the Kotlin fleet when a Gradle manifest is present', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const dir = await repo({ 'settings.gradle.kts': 'include(":app")' });
    await registerLanguageScopedFrameworkAdapters(dir);
    const names = listFrameworkAdapters().map((a) => a.name);
    for (const adapter of KOTLIN_FLEET) expect(names).toContain(adapter);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('registerKotlinFrameworkAdapters (fleet order)', () => {
  it('registers the full Kotlin fleet in priority order (web → data)', () => {
    clearFrameworkAdapters();
    registerKotlinFrameworkAdapters();
    expect(listFrameworkAdapters().map((a) => a.name)).toEqual(KOTLIN_FLEET);
  });
});
