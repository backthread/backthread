// The Java JPA/Hibernate FrameworkAdapter — @Entity role tagging, association edges from
// @OneToMany/@ManyToOne field types, Data-Model grouping, detection.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { javaJpaAdapter, scanAssociations, gatherJpaSignal, scoreJpa } from './jpa.js';
import type { FrameworkContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

describe('scanAssociations', () => {
  it('reads the associated entity from the field type (collection element + bare)', () => {
    const src = [
      'package x;',
      '@Entity',
      'public class Owner {',
      '  @OneToMany(mappedBy = "owner")',
      '  private Set<Pet> pets;',
      '  @ManyToOne',
      '  @JoinColumn(name = "vet_id")', // an intervening annotation before the field
      '  private Vet vet;',
      '}',
    ].join('\n');
    const assocs = scanAssociations(src);
    const targets = new Set(assocs.map((a) => a.typeName));
    expect(targets.has('Pet')).toBe(true); // collection element, not Set
    expect(targets.has('Vet')).toBe(true); // via the @JoinColumn skip
    expect(targets.has('Set')).toBe(false);
  });
  it('reads an explicit targetEntity = X.class', () => {
    const src = 'package x;\n@Entity\nclass A {\n  @OneToMany(targetEntity = B.class)\n  private Collection things;\n}';
    expect(scanAssociations(src).some((a) => a.typeName === 'B')).toBe(true);
  });
});

describe('detection', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-jjpa-'));
    dirs.push(dir);
    for (const [rel, c] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, c);
    }
    return dir;
  }
  it('detects via a jakarta.persistence / org.hibernate groupId', async () => {
    const dir = await repo({
      'pom.xml': '<project><dependency><groupId>org.hibernate.orm</groupId></dependency></project>',
    });
    expect(gatherJpaSignal(dir)).toBe(true);
    expect(scoreJpa(true)?.adapter).toBe('java-jpa');
  });
  it('does not detect a non-JPA repo', () => {
    expect(scoreJpa(false)).toBeNull();
  });
});

describe('roleTags + association edges + grouping', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-jjpa-int-'));
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
      match: { adapter: 'java-jpa', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set() },
    };
  }

  it('tags @Entity service, edges Owner→Pet, groups the entities dir as Data Model', async () => {
    const files: Array<[string, string]> = [
      [
        'model/Owner.java',
        'package com.x.model;\nimport jakarta.persistence.Entity;\n@Entity\npublic class Owner {\n  @OneToMany(mappedBy = "owner")\n  private Set<Pet> pets;\n}',
      ],
      ['model/Pet.java', 'package com.x.model;\nimport jakarta.persistence.Entity;\n@Entity\npublic class Pet {\n  @ManyToOne\n  private Owner owner;\n}'],
      ['web/HomeController.java', 'package com.x.web;\npublic class HomeController {}'], // not an entity
    ];
    const dir = await repo(Object.fromEntries(files));
    const c = ctx(dir, files);

    const roles = await javaJpaAdapter.roleTags!(c);
    expect(roles.get('model/Owner.java')?.kind).toBe('service'); // NOT datastore
    expect(roles.get('model/Owner.java')?.role).toBe('entity');
    expect(roles.get('model/Pet.java')?.kind).toBe('service');
    expect(roles.has('web/HomeController.java')).toBe(false);

    const edges = await javaJpaAdapter.syntheticEdges!(c);
    expect(edges).toContainEqual(expect.objectContaining({ source: 'model/Owner.java', target: 'model/Pet.java', kind: 'calls' }));
    expect(edges).toContainEqual(expect.objectContaining({ source: 'model/Pet.java', target: 'model/Owner.java', kind: 'calls' }));

    const prior = await javaJpaAdapter.groupingPrior!(c);
    expect(prior.groups.some((g) => g.label === 'Data Model' && g.fileIds.includes('model/Owner.java'))).toBe(true);
  });

  it('emits no stores-in edge and never the datastore kind', async () => {
    const files: Array<[string, string]> = [
      ['m/A.java', 'package m;\nimport jakarta.persistence.Entity;\n@Entity\nclass A {}'],
    ];
    const dir = await repo(Object.fromEntries(files));
    const c = ctx(dir, files);
    const roles = await javaJpaAdapter.roleTags!(c);
    const edges = await javaJpaAdapter.syntheticEdges!(c);
    for (const r of roles.values()) expect(r.kind).toBe('service');
    expect(edges.every((e) => e.kind !== 'stores-in')).toBe(true);
  });
});
