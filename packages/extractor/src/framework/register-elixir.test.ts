// The mix.exs-gated Elixir-fleet registration seam. The isolation guarantee — a
// TS/Python/Ruby repo never module-loads the Elixir scanner — is enforced
// structurally by `registerLanguageScopedFrameworkAdapters` dynamically importing
// the fleet only when a mix.exs is present. (node --test isolates each test file
// in its own process, so the module-level once-flag starts fresh here.)

import { describe, it, expect } from '../testkit.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFrameworkAdapters, listFrameworkAdapters } from './registry.js';
import {
  registerBuiltinFrameworkAdapters,
  registerLanguageScopedFrameworkAdapters,
} from './register.js';

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-elixir-gate-'));
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(dir, rel), content);
  }
  return dir;
}

describe('registerLanguageScopedFrameworkAdapters (Elixir gate)', () => {
  it('does not load the Elixir fleet for a repo without a mix.exs', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const before = listFrameworkAdapters().length;
    const dir = await repo({ 'package.json': '{"name":"x"}' });
    await registerLanguageScopedFrameworkAdapters(dir); // no mix.exs → no-op
    expect(listFrameworkAdapters().length).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the mix.exs gate without throwing when an Elixir manifest is present', async () => {
    // The gate now registers the Phoenix adapter (the fleet grows as each further
    // adapter lands); this asserts the gate + dynamic import of register-elixir.ts
    // are wired and safe. The concrete adapters registering are covered by their own
    // suites (e.g. framework/phoenix/phoenix.test.ts).
    const dir = await repo({ 'mix.exs': 'defmodule X.MixProject do\nend\n' });
    await expect(registerLanguageScopedFrameworkAdapters(dir)).resolves.toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});
