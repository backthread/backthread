// (Slice 2) — ORM adapter tests.
//
// scoreOrm is pure; the adapter's detect() runs against real tmp dirs (Prisma via
// schema, Drizzle via config, and a no-match). Covers dep+config union + the
// config-only (no dep) path.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ormAdapter, scoreOrm, gatherOrmSignals, type OrmSignals } from './orm.js';

const NO_SIGNALS: OrmSignals = { depOrms: [], hasPrismaSchema: false, hasDrizzleConfig: false };

describe('scoreOrm (pure)', () => {
  it('returns null when no ORM signal is present (generic-TS fallthrough)', () => {
    expect(scoreOrm(NO_SIGNALS)).toBeNull();
  });

  it('detects Prisma from the dep + schema.prisma; orms recorded', () => {
    const m = scoreOrm({ depOrms: ['prisma'], hasPrismaSchema: true, hasDrizzleConfig: false });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('orm');
    expect(m!.metadata?.orms).toEqual(['prisma']);
    expect(m!.metadata?.variant).toBe('prisma');
    expect(m!.confidence).toBe(0.8); // 0.6 dep + 0.2 schema corroboration
  });

  it('matches on a Prisma schema alone (no dep) at lower confidence + implies the ORM', () => {
    const m = scoreOrm({ ...NO_SIGNALS, hasPrismaSchema: true });
    expect(m).not.toBeNull();
    expect(m!.metadata?.orms).toEqual(['prisma']);
    expect(m!.confidence).toBe(0.4);
  });

  it('matches on a Drizzle config alone (no dep)', () => {
    const m = scoreOrm({ ...NO_SIGNALS, hasDrizzleConfig: true });
    expect(m).not.toBeNull();
    expect(m!.metadata?.orms).toEqual(['drizzle']);
  });

  it('records every co-present ORM in canonical order', () => {
    const m = scoreOrm({ depOrms: ['drizzle', 'typeorm'], hasPrismaSchema: true, hasDrizzleConfig: false });
    // prisma (from schema) + drizzle + typeorm, sorted by ORM_ORDER.
    expect(m!.metadata?.orms).toEqual(['prisma', 'drizzle', 'typeorm']);
    expect(m!.metadata?.variant).toBe('prisma+drizzle+typeorm');
  });

  it('detects the non-config ORMs (typeorm / mongoose / sequelize) from deps', () => {
    for (const o of ['typeorm', 'mongoose', 'sequelize'] as const) {
      const m = scoreOrm({ ...NO_SIGNALS, depOrms: [o] });
      expect(m!.metadata?.orms).toEqual([o]);
    }
  });

  it('passes rootPath through', () => {
    const m = scoreOrm({ ...NO_SIGNALS, depOrms: ['prisma'] }, 'packages/db');
    expect(m!.rootPath).toBe('packages/db');
  });
});

describe('ormAdapter.detect (fs fixtures)', () => {
  let prisma: string;
  let drizzle: string;
  let plain: string;

  beforeAll(() => {
    // Prisma fixture: @prisma/client dep + prisma/schema.prisma.
    prisma = mkdtempSync(join(tmpdir(), 'backthread-orm-prisma-'));
    writeFileSync(
      join(prisma, 'package.json'),
      JSON.stringify({ name: 'prisma-app', dependencies: { '@prisma/client': '5.0.0' }, devDependencies: { prisma: '5.0.0' } }),
    );
    mkdirSync(join(prisma, 'prisma'), { recursive: true });
    writeFileSync(join(prisma, 'prisma', 'schema.prisma'), 'generator client { provider = "prisma-client-js" }');

    // Drizzle fixture: drizzle-orm dep + drizzle.config.ts.
    drizzle = mkdtempSync(join(tmpdir(), 'backthread-orm-drizzle-'));
    writeFileSync(
      join(drizzle, 'package.json'),
      JSON.stringify({ name: 'drizzle-app', dependencies: { 'drizzle-orm': '0.30.0' } }),
    );
    writeFileSync(join(drizzle, 'drizzle.config.ts'), 'export default {};');

    // Plain fixture: no ORM signal → must NOT detect.
    plain = mkdtempSync(join(tmpdir(), 'backthread-orm-plain-'));
    writeFileSync(
      join(plain, 'package.json'),
      JSON.stringify({ name: 'plain', dependencies: { typescript: '5.4.0' } }),
    );
  });

  afterAll(() => {
    for (const d of [prisma, drizzle, plain]) rmSync(d, { recursive: true, force: true });
  });

  it('detects a Prisma repo (prisma dep + prisma/schema.prisma)', async () => {
    const m = await ormAdapter.detect({ repoDir: prisma });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('orm');
    expect(m!.metadata?.orms).toEqual(['prisma']);
    expect((m!.metadata?.signals as Record<string, unknown>).prismaSchema).toBe(true);
  });

  it('detects a Drizzle repo (drizzle-orm dep + drizzle.config.ts)', async () => {
    const m = await ormAdapter.detect({ repoDir: drizzle });
    expect(m).not.toBeNull();
    expect(m!.metadata?.orms).toEqual(['drizzle']);
    expect((m!.metadata?.signals as Record<string, unknown>).drizzleConfig).toBe(true);
  });

  it('does NOT detect a plain repo (empty → generic-TS fallthrough)', async () => {
    expect(await ormAdapter.detect({ repoDir: plain })).toBeNull();
  });

  it('gatherOrmSignals reads deps + config existence from disk', () => {
    const s = gatherOrmSignals(prisma);
    expect(s.depOrms).toEqual(['prisma']);
    expect(s.hasPrismaSchema).toBe(true);
    expect(s.hasDrizzleConfig).toBe(false);
  });
});
