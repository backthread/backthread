// The Kotlin ORM FrameworkAdapter (Room / JPA / Exposed) — role tagging onto `service`,
// association edges (JPA field types, Room @Relation/@ForeignKey, Exposed reference), the
// Data-Model grouping, and detection.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { kotlinOrmAdapter, scanAssociations, gatherOrmSignal, scoreOrm } from './room.js';

describe('scanAssociations', () => {
  it('reads a JPA @ManyToOne field type (skipping @JoinColumn)', () => {
    const src = ['@ManyToOne', '@JoinColumn(name = "owner_id")', 'var owner: Owner? = null'].join('\n');
    expect(scanAssociations(src)).toEqual([{ typeName: 'Owner', relation: 'ManyToOne' }]);
  });
  it('reads a JPA @OneToMany collection element type (not the initializer)', () => {
    const src = ['@OneToMany(mappedBy = "owner")', 'var pets: MutableSet<Pet> = HashSet()'].join('\n');
    expect(scanAssociations(src)).toEqual([{ typeName: 'Pet', relation: 'OneToMany' }]);
  });
  it('reads a multi-line Room @Relation (Junction cross-ref + property entity)', () => {
    const src = [
      '@Relation(',
      '  parentColumn = "id",',
      '  associateBy = Junction(value = CrossRef::class),',
      ')',
      'val topics: List<TopicEntity>,',
    ].join('\n');
    const targets = scanAssociations(src).map((a) => a.typeName).sort();
    expect(targets).toEqual(['CrossRef', 'TopicEntity']);
  });
  it('reads an Exposed reference() target table', () => {
    const src = 'val owner = reference("owner_id", Owners)';
    expect(scanAssociations(src)).toEqual([{ typeName: 'Owners', relation: 'reference' }]);
  });
});

describe('detection', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-orm-'));
    dirs.push(dir);
    for (const [rel, c] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, c);
    }
    return dir;
  }
  it('detects Room / JPA / Exposed dep groups', async () => {
    const room = await repo({ 'build.gradle.kts': 'dependencies { implementation("androidx.room:room-runtime:2.6") }' });
    const exposed = await repo({ 'build.gradle.kts': 'dependencies { implementation("org.jetbrains.exposed:exposed-core:0.44") }' });
    expect(gatherOrmSignal(room)).toBe(true);
    expect(gatherOrmSignal(exposed)).toBe(true);
    expect(scoreOrm(true)).not.toBeNull();
    expect(scoreOrm(false)).toBeNull();
  });
});

describe('roleTags + association edges (integration)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-orm-int-'));
    dirs.push(dir);
    for (const [rel, c] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, c);
    }
    return dir;
  }
  function ctx(repoDir: string, files: Array<[string, string]>) {
    return {
      repoDir,
      rootPath: '',
      match: { adapter: 'kotlin-orm', confidence: 1, rootPath: '' },
      graph: { root: repoDir, files: files.map(([id]) => ({ id, loc: 5, language: 'kt' })), edges: [], externals: [] },
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
  }

  it('tags JPA entities + Spring-Data repos service, edges the association, groups data', async () => {
    const files: Array<[string, string]> = [
      [
        'a/model/Owner.kt',
        'package com.x\nimport javax.persistence.Entity\nimport javax.persistence.OneToMany\n@Entity\nclass Owner {\n  @OneToMany(mappedBy = "owner")\n  var pets: MutableSet<Pet> = HashSet()\n}',
      ],
      ['a/model/Pet.kt', 'package com.x\nimport javax.persistence.Entity\n@Entity\nclass Pet'],
      [
        'a/OwnerRepository.kt',
        'package com.x\nimport org.springframework.data.repository.CrudRepository\ninterface OwnerRepository : CrudRepository<Owner, Int>',
      ],
    ];
    const dir = await repo(Object.fromEntries(files));
    const c = ctx(dir, files) as never;
    const roles = await kotlinOrmAdapter.roleTags!(c);
    expect(roles.get('a/model/Owner.kt')?.role).toBe('entity');
    expect(roles.get('a/model/Owner.kt')?.kind).toBe('service'); // NEVER datastore
    expect(roles.get('a/model/Pet.kt')?.role).toBe('entity');
    expect(roles.get('a/OwnerRepository.kt')?.role).toBe('repository');
    expect([...roles.values()].every((r) => r.kind === 'service')).toBe(true);
    // association Owner → Pet.
    const edges = await kotlinOrmAdapter.syntheticEdges!(c);
    expect(edges).toContainEqual(
      expect.objectContaining({ source: 'a/model/Owner.kt', target: 'a/model/Pet.kt', kind: 'calls' }),
    );
    // NO datastore node / stores-in edge — the framework layer only role-tags + `calls`.
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
    // grouped as data (2 entities in the model dir).
    const groups = (await kotlinOrmAdapter.groupingPrior!(c)).groups;
    expect(groups.length).toBe(1);
    expect(groups[0].fileIds.length).toBe(2);
  });

  it('tags Exposed Table objects service and edges reference()', async () => {
    const files: Array<[string, string]> = [
      ['a/Users.kt', 'package com.x\nimport org.jetbrains.exposed.sql.Table\nobject Users : Table("users")'],
      [
        'a/Posts.kt',
        'package com.x\nimport org.jetbrains.exposed.sql.Table\nobject Posts : Table("posts") {\n  val author = reference("author_id", Users)\n}',
      ],
    ];
    const dir = await repo(Object.fromEntries(files));
    const c = ctx(dir, files) as never;
    const roles = await kotlinOrmAdapter.roleTags!(c);
    expect(roles.get('a/Users.kt')?.role).toBe('table');
    expect(roles.get('a/Posts.kt')?.kind).toBe('service');
    const edges = await kotlinOrmAdapter.syntheticEdges!(c);
    expect(edges).toContainEqual(
      expect.objectContaining({ source: 'a/Posts.kt', target: 'a/Users.kt', kind: 'calls' }),
    );
  });
});
