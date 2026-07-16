// The pubspec-gated Dart-fleet registration seam. The isolation guarantee — a
// TS/Python/Ruby/Elixir repo never module-loads the Dart scanner — is enforced
// structurally by `registerLanguageScopedFrameworkAdapters` dynamically importing the
// fleet only when a pubspec.yaml is present. (node --test isolates each test file in
// its own process, so the module-level once-flag starts fresh here.)

import { describe, it, expect } from '../testkit.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFrameworkAdapters, listFrameworkAdapters } from './registry.js';
import { registerBuiltinFrameworkAdapters, registerLanguageScopedFrameworkAdapters } from './register.js';
import { registerDartFrameworkAdapters } from './register-dart.js';

// The full Dart fleet, in registration = co-fire priority order (web/UI → state → data).
const DART_FLEET = ['flutter', 'flutter-state', 'flutter-data'];

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-dart-gate-'));
  for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content);
  return dir;
}

describe('registerLanguageScopedFrameworkAdapters (Dart gate)', () => {
  it('does not load the Dart fleet for a repo without a pubspec.yaml', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const before = listFrameworkAdapters().length;
    const dir = await repo({ 'package.json': '{"name":"x"}' });
    await registerLanguageScopedFrameworkAdapters(dir); // no pubspec → no-op
    expect(listFrameworkAdapters().length).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('registers the Dart fleet when a pubspec.yaml is present', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const dir = await repo({ 'pubspec.yaml': 'name: my_app\n' });
    await registerLanguageScopedFrameworkAdapters(dir);
    const names = listFrameworkAdapters().map((a) => a.name);
    for (const adapter of DART_FLEET) expect(names).toContain(adapter);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('registerDartFrameworkAdapters (fleet order)', () => {
  it('registers the Dart fleet in priority order (web/UI → state → data)', () => {
    clearFrameworkAdapters();
    registerDartFrameworkAdapters();
    expect(listFrameworkAdapters().map((a) => a.name)).toEqual(DART_FLEET);
  });
});
