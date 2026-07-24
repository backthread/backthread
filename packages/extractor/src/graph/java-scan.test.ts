// Pure Java syntactic scanner — package/import/decl scanning, comment + string
// stripping (NON-nesting blocks, text blocks), and external-id bucketing.

import { describe, it, expect } from '../testkit.js';
import {
  stripCommentsAndStrings,
  scanPackage,
  scanImports,
  scanTopLevelDecls,
  javaExternalId,
} from './java-scan.js';

describe('scanPackage', () => {
  it('reads the (semicolon-terminated) package declaration', () => {
    expect(scanPackage('package com.example.app;\n\nclass Foo {}')).toBe('com.example.app');
  });
  it('is empty for the default/unnamed package', () => {
    expect(scanPackage('class Foo {}\n')).toBe('');
  });
  it('ignores a package keyword inside a comment', () => {
    expect(scanPackage('// package fake.one;\npackage real.one;\n')).toBe('real.one');
  });
});

describe('scanImports', () => {
  it('reads plain, wildcard, and both static forms', () => {
    const src = [
      'package com.example;',
      'import com.foo.Bar;',
      'import com.foo.baz.*;',
      'import static com.util.Assertions.assertThat;',
      'import static com.util.Constants.*;',
    ].join('\n');
    expect(scanImports(src)).toEqual([
      { fqn: 'com.foo.Bar', wildcard: false, static: false },
      { fqn: 'com.foo.baz', wildcard: true, static: false },
      { fqn: 'com.util.Assertions.assertThat', wildcard: false, static: true },
      { fqn: 'com.util.Constants', wildcard: true, static: true },
    ]);
  });
  it('does not read an import inside a block comment or string', () => {
    const src =
      'package x;\n/* import fake.commented.Out; */\nString s = "import fake.string.Out";\nimport real.Kept;\n';
    expect(scanImports(src).map((i) => i.fqn)).toEqual(['real.Kept']);
  });
});

describe('scanTopLevelDecls', () => {
  it('captures top-level types (class/interface/enum/record/@interface), skips members + nested', () => {
    const src = [
      'package com.example;',
      'public class User {',
      '  void member() {}', // member — not top-level
      '  class Inner {}', // nested — not top-level
      '}',
      'interface Repo {}',
      'enum Color { RED, GREEN }',
      'public @interface Marker {}',
      'record Point(int x, int y) {}',
      'final class Helper {}',
    ].join('\n');
    expect(scanTopLevelDecls(src)).toEqual(['User', 'Repo', 'Color', 'Marker', 'Point', 'Helper']);
  });
  it('captures a type decorated by an own-line annotation with parenthesized args', () => {
    const src = [
      'package x;',
      '@RequestMapping("/api")',
      'public class Controller {}',
      '@Table(',
      '  name = "t"',
      ')',
      'class Entity {}',
    ].join('\n');
    expect(scanTopLevelDecls(src)).toEqual(['Controller', 'Entity']);
  });
  it('does not capture a constructor-parameter or field as a top-level decl', () => {
    const src = 'package x;\nclass Point {\n  private int x;\n  Point(int x) { this.x = x; }\n}\n';
    expect(scanTopLevelDecls(src)).toEqual(['Point']);
  });
});

describe('stripCommentsAndStrings', () => {
  it('blanks comments + strings but preserves line count', () => {
    const src = 'int a = 1; // trailing\nString b = "hello";\n/* block\n comment */\nint c = 3;\n';
    const out = stripCommentsAndStrings(src);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toContain('hello');
    expect(out).not.toContain('trailing');
    expect(out).not.toContain('block');
    expect(out).toContain('int a');
    expect(out).toContain('int c');
  });
  it('treats block comments as NON-nesting (Java semantics: first */ closes)', () => {
    // The first `*/` ends the comment, so `class RealDecl` after it is real code.
    const src = 'package x;\n/* outer /* not-nested */\nclass RealDecl {}\n';
    expect(scanTopLevelDecls(src)).toEqual(['RealDecl']);
  });
  it('handles Java text blocks spanning lines', () => {
    const src = 'package x;\nString q = """\nclass NotADecl {}\n""";\nclass RealDecl {}\n';
    expect(scanTopLevelDecls(src)).toEqual(['RealDecl']);
  });
});

describe('javaExternalId', () => {
  const groups = new Set(['org.springframework', 'com.google.guava', 'jakarta.persistence']);
  it('buckets by the LONGEST declared group prefix', () => {
    expect(javaExternalId('org.springframework.web.bind.annotation', groups).id).toBe(
      'ext:org.springframework',
    );
    expect(javaExternalId('jakarta.persistence.Entity', groups).id).toBe('ext:jakarta.persistence');
  });
  it('falls back to two segments when no group matches (no mega-node)', () => {
    // Guava packages `com.google.common.*`, which does NOT prefix-match its group
    // `com.google.guava` — so it falls back to the sensible `ext:com.google`.
    expect(javaExternalId('com.google.common.collect', groups).id).toBe('ext:com.google');
    expect(javaExternalId('retrofit2', groups).id).toBe('ext:retrofit2');
  });
  it('does not false-match a group that is not a dot-aligned prefix', () => {
    expect(javaExternalId('org.springframeworkx', groups).id).toBe('ext:org.springframeworkx');
  });
});
