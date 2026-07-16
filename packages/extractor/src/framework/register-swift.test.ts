// The Swift-manifest-gated Swift-fleet registration seam. The isolation guarantee — a
// TS/Python/Ruby/Elixir/Dart/PHP/Kotlin repo never module-loads the Swift scanner — is
// enforced structurally by `registerLanguageScopedFrameworkAdapters` dynamically
// importing the fleet only when a Swift manifest is present. (node --test isolates each
// test file in its own process, so the module-level once-flag starts fresh here.)

import { describe, it, expect } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { clearFrameworkAdapters, listFrameworkAdapters } from './registry.js';
import { registerBuiltinFrameworkAdapters, registerLanguageScopedFrameworkAdapters } from './register.js';
import { registerSwiftFrameworkAdapters } from './register-swift.js';

// The full Swift fleet, in registration = co-fire priority order (web → data).
const SWIFT_FLEET = ['swift-ui', 'vapor', 'swift-data'];

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-swift-gate-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

// NOTE: register.ts keeps a module-level `swiftRegistered` once-flag that
// clearFrameworkAdapters() does NOT reset, so only ONE test per process may drive the
// gate to registration. That test uses a NESTED-only manifest — the case ARP-1344 adds
// (the deep gate). The root short-circuit is covered by language.test.ts's
// hasSwiftManifestDeep predicate test. (node --test isolates each file in its own
// process, so the flag starts fresh here.)
describe('registerLanguageScopedFrameworkAdapters (Swift gate)', () => {
  it('does not load the Swift fleet for a repo without any Swift manifest', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const before = listFrameworkAdapters().length;
    const dir = await repo({ 'package.json': '{"name":"x"}' });
    await registerLanguageScopedFrameworkAdapters(dir); // no Swift manifest → no-op
    expect(listFrameworkAdapters().length).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('registers the Swift fleet for a NESTED-only Swift package under a JS root', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    // JS-root monorepo, iOS app under `mobile/MyApp/` — no root Swift manifest, so the
    // fleet loads only via the nested-aware deep gate (hasSwiftManifestDeep).
    const dir = await repo({
      'package.json': '{"name":"web"}',
      'mobile/MyApp/Package.swift': 'let p = Package(name: "MyApp")\n',
      'mobile/MyApp/Sources/App/App.swift': 'import SwiftUI\n',
    });
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
