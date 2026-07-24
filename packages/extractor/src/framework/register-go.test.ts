// The Go-manifest-gated Go-fleet registration seam. The isolation guarantee — a non-Go repo
// never module-loads the Go adapters — is enforced structurally by
// `registerLanguageScopedFrameworkAdapters` dynamically importing the fleet only when a Go
// manifest (go.mod / go.work) is present. (node --test isolates each test file in its own
// process, so the module-level once-flag starts fresh here.)

import { describe, it, expect } from '../testkit.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFrameworkAdapters, listFrameworkAdapters } from './registry.js';
import { registerBuiltinFrameworkAdapters, registerLanguageScopedFrameworkAdapters } from './register.js';
import { registerGoFrameworkAdapters } from './register-go.js';

// The full Go fleet, in registration = co-fire priority order (web → data).
const GO_FLEET = ['go-web', 'go-gorm'];

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-go-gate-'));
  for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content);
  return dir;
}

describe('registerLanguageScopedFrameworkAdapters (Go gate)', () => {
  it('does not load the Go fleet for a repo without a Go manifest', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const before = listFrameworkAdapters().length;
    const dir = await repo({ 'package.json': '{"name":"x"}' }); // no go.mod / go.work
    await registerLanguageScopedFrameworkAdapters(dir);
    expect(listFrameworkAdapters().length).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('registers the Go fleet when a go.mod is present', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const dir = await repo({ 'go.mod': 'module github.com/x/y\n' });
    await registerLanguageScopedFrameworkAdapters(dir);
    const names = listFrameworkAdapters().map((a) => a.name);
    for (const adapter of GO_FLEET) expect(names).toContain(adapter);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('registerGoFrameworkAdapters (fleet order)', () => {
  it('registers the full Go fleet in priority order (web → data)', () => {
    clearFrameworkAdapters();
    registerGoFrameworkAdapters();
    expect(listFrameworkAdapters().map((a) => a.name)).toEqual(GO_FLEET);
  });
});
