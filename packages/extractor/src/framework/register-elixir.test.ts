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
import { registerElixirFrameworkAdapters } from './register-elixir.js';

// The full Elixir fleet, in registration = co-fire priority order.
const ELIXIR_FLEET = ['phoenix', 'otp', 'ecto', 'ash', 'oban', 'broadway', 'commanded', 'absinthe', 'grpc-elixir'];

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

  it('registers the Elixir fleet when a mix.exs is present', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const dir = await repo({ 'mix.exs': 'defmodule X.MixProject do\nend\n' });
    await registerLanguageScopedFrameworkAdapters(dir);
    const names = listFrameworkAdapters().map((a) => a.name);
    for (const adapter of ELIXIR_FLEET) expect(names).toContain(adapter);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('registerElixirFrameworkAdapters (fleet order)', () => {
  it('registers the full Elixir fleet in priority order (web → data → async → protocol)', () => {
    clearFrameworkAdapters();
    registerElixirFrameworkAdapters();
    expect(listFrameworkAdapters().map((a) => a.name)).toEqual(ELIXIR_FLEET);
  });
});
