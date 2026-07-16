// Pure Kotlin syntactic scanner — package/import/decl scanning, comment + string
// stripping, and external-id bucketing.

import { describe, it, expect } from '../testkit.js';
import {
  stripCommentsAndStrings,
  scanPackage,
  scanImports,
  scanTopLevelDecls,
  kotlinExternalId,
} from './kotlin-scan.js';

describe('scanPackage', () => {
  it('reads the package declaration', () => {
    expect(scanPackage('package com.example.app\n\nclass Foo')).toBe('com.example.app');
  });
  it('is empty for the default/root package', () => {
    expect(scanPackage('class Foo\n')).toBe('');
  });
  it('ignores a package keyword inside a comment', () => {
    expect(scanPackage('// package fake.one\npackage real.one\n')).toBe('real.one');
  });
});

describe('scanImports', () => {
  it('reads plain, wildcard, and aliased imports', () => {
    const src = [
      'package com.example',
      'import com.foo.Bar',
      'import com.foo.baz.*',
      'import com.other.Thing as Renamed',
    ].join('\n');
    expect(scanImports(src)).toEqual([
      { fqn: 'com.foo.Bar', wildcard: false, alias: undefined },
      { fqn: 'com.foo.baz', wildcard: true, alias: undefined },
      { fqn: 'com.other.Thing', wildcard: false, alias: 'Renamed' },
    ]);
  });
  it('does not read an import inside a block comment or string', () => {
    const src = 'package x\n/* import fake.commented.Out */\nval s = "import fake.string.Out"\nimport real.Kept\n';
    expect(scanImports(src).map((i) => i.fqn)).toEqual(['real.Kept']);
  });
});

describe('scanTopLevelDecls', () => {
  it('captures top-level types + non-extension callables, skips members', () => {
    const src = [
      'package com.example',
      'class User(val id: Long) {',
      '  fun member() {}', // member — not top-level
      '  class Inner', // nested — not top-level
      '}',
      'interface Repo',
      'object Registry',
      'enum class Color { RED, GREEN }',
      'annotation class Marker',
      'typealias Id = Long',
      'fun helper() {}',
      'val CONST = 1',
      'fun String.ext() {}', // extension — skipped (receiver dot)
    ].join('\n');
    expect(scanTopLevelDecls(src)).toEqual([
      'User',
      'Repo',
      'Registry',
      'Color',
      'Marker',
      'Id',
      'helper',
      'CONST',
    ]);
  });
  it('does not capture a constructor val parameter as a top-level decl', () => {
    const src = 'package x\nclass Point(\n  val x: Int,\n  val y: Int,\n) {\n}\n';
    expect(scanTopLevelDecls(src)).toEqual(['Point']);
  });
});

describe('stripCommentsAndStrings', () => {
  it('blanks comments + strings but preserves line count', () => {
    const src = 'val a = 1 // trailing\nval b = "hello"\n/* block\n comment */\nval c = 3\n';
    const out = stripCommentsAndStrings(src);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toContain('hello');
    expect(out).not.toContain('trailing');
    expect(out).not.toContain('block');
    expect(out).toContain('val a');
    expect(out).toContain('val c');
  });
  it('handles raw triple-quoted strings spanning lines', () => {
    const src = 'val q = """\nclass NotADecl\n"""\nclass RealDecl\n';
    expect(scanTopLevelDecls(src)).toEqual(['q', 'RealDecl']);
  });
});

describe('kotlinExternalId', () => {
  const groups = new Set(['io.ktor', 'androidx.room', 'org.springframework.boot']);
  it('buckets by the LONGEST declared group prefix', () => {
    expect(kotlinExternalId('io.ktor.server.application', groups).id).toBe('ext:io.ktor');
    expect(kotlinExternalId('androidx.room.util', groups).id).toBe('ext:androidx.room');
  });
  it('falls back to two segments when no group matches (no mega-node)', () => {
    expect(kotlinExternalId('com.google.gson', groups).id).toBe('ext:com.google');
    expect(kotlinExternalId('retrofit2', groups).id).toBe('ext:retrofit2');
  });
  it('does not false-match a group that is not a dot-aligned prefix', () => {
    // `io.ktormore` must NOT bucket to `io.ktor`.
    expect(kotlinExternalId('io.ktormore', groups).id).toBe('ext:io.ktormore');
  });
});
