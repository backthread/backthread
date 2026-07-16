// The Swift-manifest-gated Swift-fleet registration seam. The isolation guarantee — a
// TS/Python/Ruby/Elixir/Dart/PHP/Kotlin repo never module-loads the Swift scanner — is
// enforced structurally by `registerLanguageScopedFrameworkAdapters` dynamically
// importing the fleet only when a Swift manifest is present. (node --test isolates each
// test file in its own process, so the module-level once-flag starts fresh here.)

import { describe, it, expect } from '../testkit.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFrameworkAdapters, listFrameworkAdapters } from './registry.js';
import { registerBuiltinFrameworkAdapters, registerLanguageScopedFrameworkAdapters } from './register.js';
import { registerSwiftFrameworkAdapters } from './register-swift.js';

// The full Swift fleet, in registration = co-fire priority order (web → data).
const SWIFT_FLEET = ['swift-ui', 'vapor', 'swift-data'];

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-swift-gate-'));
  for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content);
  return dir;
}

describe('registerLanguageScopedFrameworkAdapters (Swift gate)', () => {
  it('does not load the Swift fleet for a repo without a Swift manifest', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const before = listFrameworkAdapters().length;
    const dir = await repo({ 'package.json': '{"name":"x"}' });
    await registerLanguageScopedFrameworkAdapters(dir); // no Package.swift → no-op
    expect(listFrameworkAdapters().length).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('registers the Swift fleet when a Package.swift is present', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const dir = await repo({ 'Package.swift': 'let p = Package(name: "X")\n' });
    await registerLanguageScopedFrameworkAdapters(dir);
    const names = listFrameworkAdapters().map((a) => a.name);
    for (const adapter of SWIFT_FLEET) expect(names).toContain(adapter);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('registerSwiftFrameworkAdapters (fleet order)', () => {
  it('registers the Swift fleet in priority order (web → data)', () => {
    clearFrameworkAdapters();
    registerSwiftFrameworkAdapters();
    expect(listFrameworkAdapters().map((a) => a.name)).toEqual(SWIFT_FLEET);
  });
});
