// Shared Kotlin framework-analysis layer — type/fun decl scanning (supertypes +
// annotations), FQN binding, no-re-scan scope, and Kotlin name resolution.

import { describe, it, expect, afterEach } from '../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { scanTypeDecls, scanFunDecls, parseSupertypes, scanCallNames } from './kotlin-ast.js';
import { buildKotlinBindings, parseKotlinScope } from './analyze.js';
import type { FrameworkContext } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

describe('scanTypeDecls', () => {
  it('reads a class with supertypes + preceding & inline annotations', () => {
    const src = [
      'package com.acme.app',
      '@RestController',
      '@RequestMapping("/api")',
      'class UserController(private val svc: UserService) : BaseController(), Loggable {',
      '  fun get() {}',
      '}',
    ].join('\n');
    const [decl] = scanTypeDecls(src);
    expect(decl.name).toBe('UserController');
    expect(decl.kind).toBe('class');
    expect(decl.annotations.sort()).toEqual(['RequestMapping', 'RestController']);
    expect(decl.supertypes.sort()).toEqual(['BaseController', 'Loggable']);
  });

  it('classifies object / interface / enum / annotation kinds', () => {
    const src = [
      'package x',
      'object Users : Table("users")',
      'interface Repo',
      'enum class Color { RED }',
      'annotation class Marker',
    ].join('\n');
    const byName = new Map(scanTypeDecls(src).map((d) => [d.name, d]));
    expect(byName.get('Users')?.kind).toBe('object');
    expect(byName.get('Users')?.supertypes).toEqual(['Table']);
    expect(byName.get('Repo')?.kind).toBe('interface');
    expect(byName.get('Color')?.kind).toBe('enum');
    expect(byName.get('Marker')?.kind).toBe('annotation');
  });

  it('reads a multi-line class header supertype', () => {
    const src = [
      'package x',
      '@AndroidEntryPoint',
      'class HomeFragment(',
      '  val vm: HomeViewModel,',
      ') : Fragment() {',
      '}',
    ].join('\n');
    const [decl] = scanTypeDecls(src);
    expect(decl.supertypes).toEqual(['Fragment']);
    expect(decl.annotations).toEqual(['AndroidEntryPoint']);
  });
});

describe('scanFunDecls', () => {
  it('reads a top-level function with its annotation + extension receiver', () => {
    const src = [
      'package x',
      '@Composable',
      'fun HomeScreen() {}',
      'fun Application.module() {}',
    ].join('\n');
    const byName = new Map(scanFunDecls(src).map((f) => [f.name, f]));
    expect(byName.get('HomeScreen')?.annotations).toEqual(['Composable']);
    expect(byName.get('module')?.receiver).toBe('Application');
  });
});

describe('parseSupertypes', () => {
  it('ignores constructor param type colons + generics', () => {
    expect(parseSupertypes('class User(val id: Long, val ts: Instant) : BaseEntity(), Comparable<User> {')).toEqual(
      ['BaseEntity', 'Comparable'],
    );
  });
  it('is empty for a class with no supertypes', () => {
    expect(parseSupertypes('class Plain(val x: Int) {')).toEqual([]);
  });
});

describe('scanCallNames', () => {
  it('reads DSL invocation callee names', () => {
    const src = 'fun Application.module() {\n  routing {\n    get("/health") { }\n    post("/x") { }\n  }\n}';
    const names = scanCallNames(src);
    expect(names).toContain('routing');
    expect(names).toContain('get');
    expect(names).toContain('post');
  });
});

describe('buildKotlinBindings', () => {
  it('keys top-level decls by <package>.<Name>', () => {
    const texts = new Map([
      ['a/User.kt', 'package com.acme.core\nclass User\nclass Team'],
      ['b/Svc.kt', 'package com.acme.app\nclass Service'],
    ]);
    const idx = buildKotlinBindings(texts);
    expect(idx.get('com.acme.core.User')).toBe('a/User.kt');
    expect(idx.get('com.acme.core.Team')).toBe('a/User.kt');
    expect(idx.get('com.acme.app.Service')).toBe('b/Svc.kt');
  });
});

describe('parseKotlinScope name resolution', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-kt-scope-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
    return dir;
  }
  function ctx(repoDir: string, files: Array<[string, string]>): FrameworkContext {
    const graph: NormalizedGraph = {
      root: repoDir,
      files: files.map(([id]) => ({ id, loc: 1, language: 'kt' })),
      edges: [],
      externals: [],
    };
    return { repoDir, rootPath: '', match: { adapter: 'x', confidence: 1, rootPath: '' }, graph, cluster: { fileModuleMap: {}, moduleIds: new Set() } };
  }

  it('resolves a simple name via same-package, explicit import, and wildcard', async () => {
    const files: Array<[string, string]> = [
      ['core/User.kt', 'package com.acme.core\nclass User'],
      ['core/Team.kt', 'package com.acme.core\nclass Team'],
      ['app/A.kt', 'package com.acme.app\nimport com.acme.core.User\nclass A'],
      ['app/B.kt', 'package com.acme.app\nimport com.acme.core.*\nclass B'],
      ['app/C.kt', 'package com.acme.app\nclass C\nclass Local'],
    ];
    const dir = await repo(Object.fromEntries(files));
    const scope = parseKotlinScope(ctx(dir, files));
    // explicit `import com.acme.core.User` in A.kt
    expect(scope.resolveTypeRef('User', scope.parsed.get('app/A.kt')!)).toBe('core/User.kt');
    // wildcard `import com.acme.core.*` in B.kt resolves Team
    expect(scope.resolveTypeRef('Team', scope.parsed.get('app/B.kt')!)).toBe('core/Team.kt');
    // same-package sibling in C.kt
    expect(scope.resolveTypeRef('Local', scope.parsed.get('app/C.kt')!)).toBe('app/C.kt');
    // qualified name via the registry
    expect(scope.resolve('com.acme.core.User')).toBe('core/User.kt');
  });
});
