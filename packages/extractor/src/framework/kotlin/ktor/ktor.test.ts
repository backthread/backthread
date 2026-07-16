// The Ktor FrameworkAdapter — routing/module role tagging, route-composition edges, detect.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ktorAdapter, gatherKtorSignal, scoreKtor } from './ktor.js';
import type { FrameworkContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-ktor-'));
  dirs.push(dir);
  for (const [rel, c] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, c);
  }
  return dir;
}
function ctx(repoDir: string, files: Array<[string, string]>): FrameworkContext {
  const graph: NormalizedGraph = {
    root: repoDir,
    files: files.map(([id]) => ({ id, loc: 5, language: 'kt' })),
    edges: [],
    externals: [],
  };
  return {
    repoDir,
    rootPath: '',
    match: { adapter: 'ktor', confidence: 1, rootPath: '' },
    graph,
    cluster: { fileModuleMap: {}, moduleIds: new Set() },
  };
}

describe('detection', () => {
  it('detects via io.ktor deps', async () => {
    const dir = await repo({ 'build.gradle.kts': 'dependencies { implementation("io.ktor:ktor-server-core:2.3.0") }' });
    expect(gatherKtorSignal(dir)).toBe(true);
    expect(scoreKtor(true)).not.toBeNull();
  });
  it('does not detect a non-Ktor repo', () => {
    expect(scoreKtor(false)).toBeNull();
  });
});

describe('roleTags + route-composition edges', () => {
  it('tags module/routing files gateway and wires the route-composition spine', async () => {
    const files: Array<[string, string]> = [
      [
        'src/App.kt',
        'package x\nimport io.ktor.server.application.*\nfun Application.module() {\n  configureRouting()\n}',
      ],
      [
        'src/Routing.kt',
        'package x\nimport io.ktor.server.routing.*\nfun Application.configureRouting() {\n  routing {\n    get("/") { }\n  }\n}',
      ],
      ['src/Model.kt', 'package x\ndata class User(val id: Long)'],
    ];
    const dir = await repo(Object.fromEntries(files));
    const c = ctx(dir, files);
    const roles = await ktorAdapter.roleTags!(c);
    // Both the module file (Application.module) and the routing file (routing {}) → gateway.
    expect(roles.get('src/App.kt')?.kind).toBe('gateway');
    expect(roles.get('src/Routing.kt')?.kind).toBe('gateway');
    expect(roles.has('src/Model.kt')).toBe(false);
    // module() calls configureRouting() (an extension fun defined in Routing.kt) → edge.
    const edges = await ktorAdapter.syntheticEdges!(c);
    expect(edges).toContainEqual(
      expect.objectContaining({ source: 'src/App.kt', target: 'src/Routing.kt', kind: 'calls' }),
    );
  });

  it('does not tag a file whose only `routing {` is in a comment', async () => {
    const files: Array<[string, string]> = [
      ['src/Notes.kt', 'package x\n// TODO: add routing { get("/") } here later\nclass Notes'],
    ];
    const dir = await repo(Object.fromEntries(files));
    const roles = await ktorAdapter.roleTags!(ctx(dir, files));
    expect(roles.has('src/Notes.kt')).toBe(false);
  });

  it('drops an ambiguous function-name target (accuracy over recall)', async () => {
    const files: Array<[string, string]> = [
      ['src/App.kt', 'package x\nimport io.ktor.server.application.*\nfun Application.module() { setup() }'],
      ['src/A.kt', 'package x\nfun Application.setup() { routing { } }'],
      ['src/B.kt', 'package x\nfun Application.setup() { routing { } }'], // same name → ambiguous
    ];
    const dir = await repo(Object.fromEntries(files));
    const edges = await ktorAdapter.syntheticEdges!(ctx(dir, files));
    // `setup` is defined in two files → ambiguous → no edge from App.kt.
    expect(edges.filter((e) => e.source === 'src/App.kt')).toEqual([]);
  });
});
