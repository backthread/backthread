// central tsconfig path-alias robustness in the structural extractor.
//
// The shared readTsconfigPaths feeding the in-memory ts-morph Project must
// resolve two real-world tsconfig shapes that previously dropped every alias —
// silently re-routing aliased INTERNAL imports out of the graph as externals
// (an under-connected diagram; the root cause behind 's RN collapse):
//
//   1. `paths` with NO `baseUrl` + RELATIVE `./src/*` targets. TS ≥4.1 anchors
//      these on the tsconfig's own dir; the in-memory Project (compilerOptions
//      only, no on-disk tsconfig path) mis-anchored them → no resolution.
//   2. JSONC tsconfigs — `//` + block comments AND trailing commas (tsconfig is
//      JSONC; `JSON.parse` THROWS on a trailing comma → the whole paths block
//      was dropped).
//
// When an alias resolves, the aliased import is an INTERNAL edge; when it
// doesn't, the bare specifier falls out as an `ext:<token>` external node. Each
// fixture asserts the internal edge IS present AND the alias did NOT leak as an
// external — both would FAIL against the pre-fix resolver.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { TsMorphExtractor } from './ts-morph-adapter.js';
import type { NormalizedGraph } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function extractRepo(files: Record<string, string>): Promise<NormalizedGraph> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-ts751-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content.startsWith('\n') ? content.slice(1) : content);
  }
  return new TsMorphExtractor().extract(dir);
}

const internalEdge = (g: NormalizedGraph, from: string, to: string): boolean =>
  g.edges.some((e) => !e.external && e.from === from && e.to === to);
const externalIds = (g: NormalizedGraph): string[] => g.externals.map((n) => n.id).sort();

describe('readTsconfigPaths — alias resolution feeding the extraction Project', () => {
  it('resolves a wildcard alias with NO baseUrl + relative ./src/* target (internal edge, no external)', async () => {
    const g = await extractRepo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '#/*': ['./src/*'] } } }),
      'src/consumer.ts': `import { thing } from '#/lib/thing';\nexport const c = thing;\n`,
      'src/lib/thing.ts': `export const thing = 1;\n`,
    });
    expect(internalEdge(g, 'src/consumer.ts', 'src/lib/thing.ts')).toBe(true);
    // The '#/' alias must NOT have leaked out as `ext:#`.
    expect(externalIds(g)).toEqual([]);
  });

  it('parses a JSONC tsconfig — // + block comments AND trailing commas (the JSON.parse trap)', async () => {
    const g = await extractRepo({
      'tsconfig.json': `
{
  // alias config — JSONC: a line comment + trailing commas
  /* and a block comment */
  "compilerOptions": {
    "jsx": "react-jsx",
    "paths": {
      "@/*": ["./src/*"],
    },
  },
}
`,
      'src/a.ts': `import { b } from '@/feature/b';\nexport const a = b;\n`,
      'src/feature/b.ts': `export const b = 2;\n`,
    });
    expect(internalEdge(g, 'src/a.ts', 'src/feature/b.ts')).toBe(true);
    expect(externalIds(g)).toEqual([]);
  });

  it('resolves paths from the ROOT tsconfig even when it `extends` another (extends not followed)', async () => {
    // Bluesky's exact shape: `extends` a shared base, paths declared in the root,
    // no baseUrl, trailing comma. We never follow extends, but the root paths win.
    const g = await extractRepo({
      'base.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'tsconfig.json': `
{
  "extends": "./base.json",
  "compilerOptions": {
    "paths": {
      "#/*": ["./src/*"],
    },
  },
}
`,
      'src/x.ts': `import { y } from '#/y';\nexport const x = y;\n`,
      'src/y.ts': `export const y = 3;\n`,
    });
    expect(internalEdge(g, 'src/x.ts', 'src/y.ts')).toBe(true);
    expect(externalIds(g)).toEqual([]);
  });

  it('resolves an EXACT (non-wildcard) alias with no baseUrl', async () => {
    const g = await extractRepo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { config: ['./src/config.ts'] } } }),
      'src/main.ts': `import { cfg } from 'config';\nexport const m = cfg;\n`,
      'src/config.ts': `export const cfg = { on: true };\n`,
    });
    expect(internalEdge(g, 'src/main.ts', 'src/config.ts')).toBe(true);
    expect(externalIds(g)).toEqual([]);
  });

  it('internalizes the alias but leaves a genuine bare package external (no over-reach)', async () => {
    const g = await extractRepo({
      'tsconfig.json': `{ "compilerOptions": { "paths": { "#/*": ["./src/*"], }, }, }`,
      'src/a.ts': `import { z } from 'zod';\nimport { b } from '#/b';\nexport const a = [z, b];\n`,
      'src/b.ts': `export const b = 1;\n`,
    });
    expect(internalEdge(g, 'src/a.ts', 'src/b.ts')).toBe(true);
    expect(externalIds(g)).toEqual(['ext:zod']); // real package stays external; '#' does not appear
  });

  it('does NOT anchor baseUrl for an empty `paths: {}` (a bare specifier stays external)', async () => {
    // The empty-paths guard: setting baseUrl=repoDir here would switch on
    // baseUrl-relative resolution of BARE specifiers, mis-resolving `src/b`
    // (a package-looking import) to ./src/b. With no aliases it must stay external.
    const g = await extractRepo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: {} } }),
      'src/a.ts': `import { x } from 'src/b';\nexport const a = x;\n`,
      'src/b.ts': `export const x = 1;\n`,
    });
    expect(internalEdge(g, 'src/a.ts', 'src/b.ts')).toBe(false);
    expect(externalIds(g)).toEqual(['ext:src']);
  });

  it('degrades (never throws) on a tsconfig still malformed after comment/comma stripping', async () => {
    const g = await extractRepo({
      'tsconfig.json': `{ "compilerOptions": { "paths": { "#/*": [ } } }`, // broken array
      'src/a.ts': `import { b } from './b.js';\nexport const a = b;\n`,
      'src/b.ts': `export const b = 1;\n`,
    });
    // No aliasing, but the relative import still resolves and extraction succeeds.
    expect(internalEdge(g, 'src/a.ts', 'src/b.ts')).toBe(true);
  });
});
