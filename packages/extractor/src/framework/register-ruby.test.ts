// The Gemfile-gated Ruby-fleet registration seam. The isolation guarantee — a
// TS/Python repo never module-loads the Ruby toolchain — is enforced structurally
// by `registerLanguageScopedFrameworkAdapters` dynamically importing the fleet
// only when a Ruby manifest is present. (node --test isolates each test file in
// its own process, so the module-level once-flag starts fresh here.)

import { describe, it, expect } from '../testkit.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearFrameworkAdapters,
  listFrameworkAdapters,
} from './registry.js';
import {
  registerBuiltinFrameworkAdapters,
  registerLanguageScopedFrameworkAdapters,
} from './register.js';
import { registerRubyFrameworkAdapters } from './register-ruby.js';

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-ruby-gate-'));
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(dir, rel), content);
  }
  return dir;
}

describe('registerLanguageScopedFrameworkAdapters (Ruby gate)', () => {
  it('does not load the Ruby fleet for a repo without a Ruby manifest', async () => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
    const before = listFrameworkAdapters().length;
    const dir = await repo({ 'package.json': '{"name":"x"}' });
    await registerLanguageScopedFrameworkAdapters(dir); // no Gemfile → no-op
    expect(listFrameworkAdapters().length).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('registers the Ruby fleet when a Ruby manifest is present', async () => {
    clearFrameworkAdapters();
    const dir = await repo({ Gemfile: "gem 'rails'\n" });
    await registerLanguageScopedFrameworkAdapters(dir);
    const names = listFrameworkAdapters().map((a) => a.name);
    expect(names).toContain('rails');
    expect(names).toContain('activerecord');
    expect(names).toContain('sidekiq');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('registerRubyFrameworkAdapters (fleet order)', () => {
  it('registers the full Ruby fleet in priority order (web → data → async → protocol)', () => {
    clearFrameworkAdapters();
    registerRubyFrameworkAdapters();
    expect(listFrameworkAdapters().map((a) => a.name)).toEqual([
      'rails',
      'sinatra',
      'hanami',
      'activerecord',
      'sidekiq',
      'graphql-ruby',
      'grpc-ruby',
    ]);
  });
});
