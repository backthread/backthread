// Java framework-analysis primitives — annotation scanning + type-decl (supertype) scanning.

import { describe, it, expect } from '../../testkit.js';
import { scanAnnotations, scanTypeDecls } from './java-ast.js';

describe('scanAnnotations', () => {
  it('extracts every annotation simple-name (dotted → simple), excludes @interface', () => {
    const src = [
      'package com.x;',
      '@Entity',
      '@org.hibernate.annotations.Immutable', // dotted → Immutable
      'public class User {',
      '  @OneToMany(mappedBy = "owner")',
      '  private Set<Pet> pets;',
      '}',
      'public @interface Marker {}', // the @interface keyword is NOT an annotation use
    ].join('\n');
    const anns = new Set(scanAnnotations(src));
    expect(anns.has('Entity')).toBe(true);
    expect(anns.has('Immutable')).toBe(true);
    expect(anns.has('OneToMany')).toBe(true);
    expect(anns.has('interface')).toBe(false);
  });
  it('ignores an annotation-looking token inside a comment or string', () => {
    const src = 'package x;\n// @Fake\nString s = "@AlsoFake";\n@Real\nclass C {}';
    expect(new Set(scanAnnotations(src))).toEqual(new Set(['Real']));
  });
});

describe('scanTypeDecls', () => {
  it('captures a type with its own-line annotations + no supertypes', () => {
    const src = 'package x;\n@Entity\n@Table(name = "t")\npublic class User {\n  int id;\n}';
    const decls = scanTypeDecls(src);
    expect(decls).toHaveLength(1);
    expect(decls[0].name).toBe('User');
    expect(new Set(decls[0].annotations)).toEqual(new Set(['Entity', 'Table']));
    expect(decls[0].supertypes).toEqual([]);
  });
  it('captures extends + implements bases, generics stripped', () => {
    const src = 'package x;\npublic class UserService extends BaseService<User> implements Auditable, Cloneable {\n}';
    const decls = scanTypeDecls(src);
    expect(new Set(decls[0].supertypes)).toEqual(new Set(['BaseService', 'Auditable', 'Cloneable']));
  });
  it('reads a Spring-Data repository interface base (multi-generic)', () => {
    const src = 'package x;\npublic interface UserRepository extends JpaRepository<User, Long> {\n}';
    const decls = scanTypeDecls(src);
    expect(decls[0].name).toBe('UserRepository');
    expect(decls[0].supertypes).toContain('JpaRepository');
  });
  it('does not read a type-parameter bound `extends` as a supertype', () => {
    // `<T extends Comparable<T>>` is a type-param bound, not a supertype; only `Base` is.
    const src = 'package x;\nclass Box<T extends Comparable<T>> extends Base {\n}';
    expect(scanTypeDecls(src)[0].supertypes).toEqual(['Base']);
  });
  it('skips nested types + members (only top-level)', () => {
    const src = 'package x;\nclass Outer {\n  @Deprecated\n  class Inner {}\n  void m() {}\n}';
    const decls = scanTypeDecls(src);
    expect(decls.map((d) => d.name)).toEqual(['Outer']);
  });
});
