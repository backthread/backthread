// The Spring Boot FrameworkAdapter — stereotype/route-mapping role tagging,
// controller→collaborator edges, detection.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { springAdapter, roleFromAnnotations, gatherSpringSignal, scoreSpring } from './spring.js';
import type { FrameworkContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

describe('roleFromAnnotations', () => {
  it('maps stereotypes + route mappings onto roles', () => {
    expect(roleFromAnnotations(new Set(['RestController']))).toBe('controller');
    expect(roleFromAnnotations(new Set(['Controller']))).toBe('controller');
    expect(roleFromAnnotations(new Set(['GetMapping']))).toBe('controller'); // route-spine only
    expect(roleFromAnnotations(new Set(['Service']))).toBe('service');
    expect(roleFromAnnotations(new Set(['Repository']))).toBe('repository');
    expect(roleFromAnnotations(new Set(['Entity']))).toBeUndefined();
  });
});

describe('detection', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-spring-'));
    dirs.push(dir);
    for (const [rel, c] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, c);
    }
    return dir;
  }
  it('detects via org.springframework.boot deps', async () => {
    const dir = await repo({
      'build.gradle.kts': 'dependencies { implementation("org.springframework.boot:spring-boot-starter-web:3.2.0") }',
    });
    expect(gatherSpringSignal(dir)).toBe(true);
    expect(scoreSpring(true)).not.toBeNull();
  });
  it('does not detect a non-Spring repo', () => {
    expect(scoreSpring(false)).toBeNull();
  });
});

describe('roleTags + controller→collaborator edges', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-spring-int-'));
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
      match: { adapter: 'spring', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set() },
    };
  }

  it('tags controllers gateway, services/repos service, edges controller→repository', async () => {
    const files: Array<[string, string]> = [
      [
        'a/OwnerController.kt',
        'package com.x\nimport org.springframework.stereotype.Controller\nimport com.x.OwnerRepository\n@Controller\nclass OwnerController(val repo: OwnerRepository) {\n  @GetMapping("/owners")\n  fun list() {}\n}',
      ],
      ['a/OwnerRepository.kt', 'package com.x\nimport org.springframework.stereotype.Repository\n@Repository\nclass OwnerRepository'],
      ['a/BillingService.kt', 'package com.x\nimport org.springframework.stereotype.Service\n@Service\nclass BillingService'],
      ['a/Owner.kt', 'package com.x\nclass Owner(val id: Long)'], // an entity, not a collaborator
    ];
    const dir = await repo(Object.fromEntries(files));
    const c = ctx(dir, files);
    const roles = await springAdapter.roleTags!(c);
    expect(roles.get('a/OwnerController.kt')?.kind).toBe('gateway');
    expect(roles.get('a/OwnerRepository.kt')?.kind).toBe('service');
    expect(roles.get('a/OwnerRepository.kt')?.role).toBe('repository');
    expect(roles.get('a/BillingService.kt')?.kind).toBe('service');
    expect(roles.has('a/Owner.kt')).toBe(false);
    // controller → its imported *Repository collaborator (not the Owner entity).
    const edges = await springAdapter.syntheticEdges!(c);
    expect(edges).toContainEqual(
      expect.objectContaining({ source: 'a/OwnerController.kt', target: 'a/OwnerRepository.kt', kind: 'calls' }),
    );
    expect(edges.some((e) => e.target === 'a/Owner.kt')).toBe(false);
  });
});
