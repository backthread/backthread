// (Slice 1) — framework registry + detection-gate tests.
//
// Targets the documented behavior (registration-order priority, idempotent-on-
// name, the empty-manifest fallthrough), mirroring infra/registry.test.ts.

import { describe, it, expect, beforeEach, beforeAll, afterAll } from '../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearFrameworkAdapters,
  detectFrameworks,
  listFrameworkAdapters,
  registerFrameworkAdapter,
} from './registry.js';
import { registerBuiltinFrameworkAdapters } from './register.js';
import type { DetectMatch, FrameworkAdapter } from './types.js';

// A trivial mock adapter that matches (or not) on a fixed verdict.
function mockAdapter(name: string, match: boolean, confidence = 0.7): FrameworkAdapter {
  return {
    name,
    async detect(): Promise<DetectMatch | null> {
      return match ? { adapter: name, confidence, rootPath: '' } : null;
    },
  };
}

describe('framework adapter registry', () => {
  beforeEach(() => clearFrameworkAdapters());

  it('preserves registration order', () => {
    registerFrameworkAdapter(mockAdapter('a', false));
    registerFrameworkAdapter(mockAdapter('b', false));
    expect(listFrameworkAdapters().map((a) => a.name)).toEqual(['a', 'b']);
  });

  it('replaces by name on re-registration (mock-swap pattern)', () => {
    const v1 = mockAdapter('rn', true, 0.1);
    const v2 = mockAdapter('rn', true, 0.9);
    registerFrameworkAdapter(v1);
    registerFrameworkAdapter(v2);
    expect(listFrameworkAdapters()).toHaveLength(1);
    expect(listFrameworkAdapters()[0]).toBe(v2);
  });

  it('clear() wipes the registry', () => {
    registerFrameworkAdapter(mockAdapter('a', true));
    clearFrameworkAdapters();
    expect(listFrameworkAdapters()).toHaveLength(0);
  });
});

describe('detectFrameworks', () => {
  beforeEach(() => clearFrameworkAdapters());

  it('returns matched adapters in registration order, dropping non-matches', async () => {
    registerFrameworkAdapter(mockAdapter('first', true));
    registerFrameworkAdapter(mockAdapter('skip', false));
    registerFrameworkAdapter(mockAdapter('second', true));
    const manifest = await detectFrameworks('/repo');
    expect(manifest.root).toBe('/repo');
    expect(manifest.matches.map((m) => m.adapter)).toEqual(['first', 'second']);
  });

  it('returns an EMPTY manifest when nothing matches (generic-TS fallthrough)', async () => {
    registerFrameworkAdapter(mockAdapter('a', false));
    registerFrameworkAdapter(mockAdapter('b', false));
    const manifest = await detectFrameworks('/repo');
    expect(manifest.matches).toEqual([]);
  });

  it('returns an EMPTY manifest when no adapters are registered', async () => {
    const manifest = await detectFrameworks('/repo');
    expect(manifest.matches).toEqual([]);
  });

  it('stamps each match with the producing adapter name (defensive)', async () => {
    // Adapter lies about its name in the returned match; the registry overrides.
    const liar: FrameworkAdapter = {
      name: 'truth',
      async detect() {
        return { adapter: 'WRONG', confidence: 0.5, rootPath: '' };
      },
    };
    registerFrameworkAdapter(liar);
    const manifest = await detectFrameworks('/repo');
    expect(manifest.matches[0].adapter).toBe('truth');
  });
});

// The HEADLINE acceptance test ( constraint 6): with the REAL builtin
// adapters registered, a plain-TS repo yields an empty manifest → generic-TS
// behavior is preserved; an RN repo is detected. Slice 2 adds the multi-adapter
// co-apply case (Next + Prisma → both detected, in registration order).
describe('detectFrameworks with builtins', () => {
  let rn: string;
  let plain: string;
  let nextPrisma: string;

  beforeEach(() => {
    clearFrameworkAdapters();
    registerBuiltinFrameworkAdapters();
  });

  // ..1004 — the full builtin fleet is registered, in priority order:
  // JS adapters, then the Python fleet (web → data → async → protocol).
  it('registers the full builtin adapter fleet in priority order', () => {
    expect(listFrameworkAdapters().map((a) => a.name)).toEqual([
      'react-native',
      'next',
      'nest',
      'node',
      'orm',
      'fastapi',
      'django',
      'flask',
      'litestar',
      'python-orm',
      'celery',
      'faststream',
      'orchestrator',
      'grpc',
      'graphql',
    ]);
  });

  beforeAll(() => {
    rn = mkdtempSync(join(tmpdir(), 'backthread-fw-rn-'));
    writeFileSync(
      join(rn, 'package.json'),
      JSON.stringify({ name: 'rn', dependencies: { 'react-native': '0.74.0' } }),
    );
    writeFileSync(join(rn, 'metro.config.js'), 'module.exports = {};');

    // Genuinely framework-less: no dep any builtin adapter recognizes (NB: an
    // `express`/`next`/ORM dep would now legitimately match a Slice-2 adapter).
    plain = mkdtempSync(join(tmpdir(), 'backthread-fw-plain-'));
    writeFileSync(
      join(plain, 'package.json'),
      JSON.stringify({ name: 'plain', dependencies: { lodash: '4.17.21', typescript: '5.4.0' } }),
    );
    mkdirSync(join(plain, 'src'), { recursive: true });
    writeFileSync(join(plain, 'src', 'index.ts'), 'export const x = 1;');

    // A Next.js app that also uses Prisma → BOTH adapters co-apply.
    nextPrisma = mkdtempSync(join(tmpdir(), 'backthread-fw-next-prisma-'));
    writeFileSync(
      join(nextPrisma, 'package.json'),
      JSON.stringify({
        name: 'next-prisma',
        dependencies: { next: '14.2.0', react: '18.2.0', '@prisma/client': '5.0.0' },
      }),
    );
    writeFileSync(join(nextPrisma, 'next.config.js'), 'module.exports = {};');
    mkdirSync(join(nextPrisma, 'app'), { recursive: true });
    mkdirSync(join(nextPrisma, 'prisma'), { recursive: true });
    writeFileSync(join(nextPrisma, 'prisma', 'schema.prisma'), 'generator client {}');
  });

  afterAll(() => {
    for (const d of [rn, plain, nextPrisma]) rmSync(d, { recursive: true, force: true });
  });

  it('detects React Native via the builtin adapter', async () => {
    const manifest = await detectFrameworks(rn);
    expect(manifest.matches.map((m) => m.adapter)).toContain('react-native');
  });

  it('plain-TS repo → EMPTY manifest (headline fallthrough preserved)', async () => {
    const manifest = await detectFrameworks(plain);
    expect(manifest.matches).toEqual([]);
  });

  it('co-applies Next + ORM and orders them by registration (next before orm)', async () => {
    const manifest = await detectFrameworks(nextPrisma);
    const adapters = manifest.matches.map((m) => m.adapter);
    expect(adapters).toContain('next');
    expect(adapters).toContain('orm');
    // Registration order = react-native, next, nest, node, orm → next precedes orm.
    expect(adapters.indexOf('next')).toBeLessThan(adapters.indexOf('orm'));
  });
});
