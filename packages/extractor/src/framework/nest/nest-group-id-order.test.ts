// the @Module group-id dedup must be ORDER-INDEPENDENT.
//
// Two @Module classes can share a class name across files (→ the same bare slug).
// The old dedup walked ts-morph's getSourceFiles() iteration order and gave the
// bare slug to whichever file it hit first — a different id set run-to-run, which
// breaks the grouping-stability invariant (the time-slider relies on a module's
// subsystem id being identical across snapshots). The fix assigns ids in a
// separate pass sorted by fileId, so the SMALLEST fileId deterministically wins
// the bare slug and collisions take a `-<dirSegment>` suffix.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TsMorphExtractor } from '../../graph/ts-morph-adapter.js';
import { nestAdapter } from './nest.js';
import type { FrameworkContext } from '../types.js';

// Two @Module classes with the IDENTICAL class name (BillingModule) in two
// different feature dirs (`a/` and `z/`) → both slug to 'billing-module'.
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'dup-nest',
    dependencies: { '@nestjs/core': '10.0.0', '@nestjs/common': '10.0.0' },
  }),
  'nest-cli.json': JSON.stringify({ collection: '@nestjs/schematics' }),
  'a/billing.module.ts': `
import { Module } from '@nestjs/common';
import { ACtrl } from './a.controller';
@Module({ controllers: [ACtrl] })
export class BillingModule {}
`,
  'a/a.controller.ts': `
import { Controller } from '@nestjs/common';
@Controller('a')
export class ACtrl {}
`,
  'z/billing.module.ts': `
import { Module } from '@nestjs/common';
import { ZCtrl } from './z.controller';
@Module({ controllers: [ZCtrl] })
export class BillingModule {}
`,
  'z/z.controller.ts': `
import { Controller } from '@nestjs/common';
@Controller('z')
export class ZCtrl {}
`,
};

async function writeFixture(dir: string): Promise<void> {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content.startsWith('\n') ? content.slice(1) : content);
  }
}

async function groupIds(dir: string): Promise<string[]> {
  const graph = await new TsMorphExtractor().extract(dir);
  const ctx: FrameworkContext = {
    repoDir: dir,
    rootPath: '',
    match: { adapter: 'nest', confidence: 1, rootPath: '' },
    graph,
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  };
  const { groups } = await nestAdapter.groupingPrior!(ctx);
  return groups.map((g) => g.id).sort();
}

describe('Nest @Module group ids are order-independent on duplicate class names', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'backthread-nest-dup-'));
    await writeFixture(dir);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('the SMALLEST fileId wins the bare slug; the collision takes a -<dirSegment> suffix', async () => {
    // fileId 'a/billing.module.ts' < 'z/billing.module.ts' → 'a' keeps the bare
    // slug, 'z' is disambiguated by its dir segment.
    expect(await groupIds(dir)).toEqual(['billing-module', 'billing-module-z']);
  });

  it('is deterministic — repeated full analyses yield the identical id set', async () => {
    const a = await groupIds(dir);
    const b = await groupIds(dir);
    expect(a).toEqual(b);
  });
});
