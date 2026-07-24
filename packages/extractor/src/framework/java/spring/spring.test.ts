// The Java Spring FrameworkAdapter — stereotype/route/async role tagging, Spring-Data
// repository detection, controller→collaborator edges, detection.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { javaSpringAdapter, springRole, gatherSpringSignal, scoreSpring } from './spring.js';
import type { FrameworkContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

describe('springRole', () => {
  it('maps stereotypes, route mappings, async, and repositories onto roles (priority-ordered)', () => {
    expect(springRole(new Set(['RestController']), [])).toBe('controller');
    expect(springRole(new Set(['GetMapping']), [])).toBe('controller'); // route-spine only
    expect(springRole(new Set(['Scheduled']), [])).toBe('job');
    expect(springRole(new Set(['KafkaListener']), [])).toBe('job');
    expect(springRole(new Set(['Service']), [])).toBe('service');
    expect(springRole(new Set(['Component']), [])).toBe('component');
    expect(springRole(new Set(['Repository']), [])).toBe('repository');
    expect(springRole(new Set(), ['JpaRepository'])).toBe('repository'); // Spring-Data base
    expect(springRole(new Set(['Entity']), [])).toBeUndefined(); // JPA's concern
    // controller wins over an also-present async annotation.
    expect(springRole(new Set(['RestController', 'Scheduled']), [])).toBe('controller');
  });
});

describe('detection', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-jspring-'));
    dirs.push(dir);
    for (const [rel, c] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, c);
    }
    return dir;
  }
  it('detects via a Maven org.springframework groupId', async () => {
    const dir = await repo({
      'pom.xml': '<project><dependency><groupId>org.springframework.boot</groupId></dependency></project>',
    });
    expect(gatherSpringSignal(dir)).toBe(true);
    expect(scoreSpring(true)?.adapter).toBe('java-spring');
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
    const dir = await mkdtemp(join(tmpdir(), 'bt-jspring-int-'));
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
      files: files.map(([id]) => ({ id, loc: 5, language: 'java' })),
      edges: [],
      externals: [],
    };
    return {
      repoDir,
      rootPath: '',
      match: { adapter: 'java-spring', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set() },
    };
  }

  it('tags controllers gateway, services service, repos service, jobs job; edges controller→repo', async () => {
    const files: Array<[string, string]> = [
      [
        'a/OwnerController.java',
        'package com.x;\nimport org.springframework.web.bind.annotation.RestController;\nimport com.x.OwnerRepository;\n@RestController\npublic class OwnerController {\n  private final OwnerRepository repo;\n  @GetMapping("/owners")\n  public void list() {}\n}',
      ],
      [
        'a/OwnerRepository.java',
        'package com.x;\nimport org.springframework.data.jpa.repository.JpaRepository;\npublic interface OwnerRepository extends JpaRepository<Owner, Long> {}',
      ],
      ['a/BillingService.java', 'package com.x;\nimport org.springframework.stereotype.Service;\n@Service\npublic class BillingService {}'],
      [
        'a/CleanupJob.java',
        'package com.x;\nimport org.springframework.scheduling.annotation.Scheduled;\npublic class CleanupJob {\n  @Scheduled(fixedRate = 1000)\n  public void run() {}\n}',
      ],
      ['a/Owner.java', 'package com.x;\npublic class Owner { Long id; }'], // an entity, not a collaborator
    ];
    const dir = await repo(Object.fromEntries(files));
    const c = ctx(dir, files);
    const roles = await javaSpringAdapter.roleTags!(c);
    expect(roles.get('a/OwnerController.java')?.kind).toBe('gateway');
    expect(roles.get('a/OwnerRepository.java')?.kind).toBe('service');
    expect(roles.get('a/OwnerRepository.java')?.role).toBe('repository'); // via JpaRepository base
    expect(roles.get('a/BillingService.java')?.kind).toBe('service');
    expect(roles.get('a/CleanupJob.java')?.kind).toBe('job');
    expect(roles.has('a/Owner.java')).toBe(false);
    // controller → its imported *Repository collaborator (not the Owner entity).
    const edges = await javaSpringAdapter.syntheticEdges!(c);
    expect(edges).toContainEqual(
      expect.objectContaining({ source: 'a/OwnerController.java', target: 'a/OwnerRepository.java', kind: 'calls' }),
    );
    expect(edges.some((e) => e.target === 'a/Owner.java')).toBe(false);
  });
});
