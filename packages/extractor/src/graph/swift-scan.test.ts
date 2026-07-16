// The Swift syntactic scanner — comment/string stripping, imports, primary type
// declarations, and reference tokens. Pure, deterministic; no fs.

import { describe, it, expect } from '../testkit.js';
import {
  stripCommentsAndStrings,
  scanImports,
  scanTypeDecls,
  scanTypeReferences,
  scanSwiftFile,
} from './swift-scan.js';

describe('stripCommentsAndStrings', () => {
  it('blanks line + nested block comments, keeping newlines', () => {
    const src = 'let a = 1 // class Fake\n/* class Also /* nested class Deep */ still */ let b = 2\n';
    const out = stripCommentsAndStrings(src);
    expect(out).not.toContain('Fake');
    expect(out).not.toContain('Also');
    expect(out).not.toContain('Deep');
    expect(out).toContain('let a = 1');
    expect(out).toContain('let b = 2');
    // Line count preserved (indices stable).
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('blanks regular, multiline, and raw string interiors + interpolation', () => {
    const src = [
      'let s = "class Nope \\(Widget.name)"',
      'let m = """',
      'protocol AlsoNope',
      '"""',
      'let r = #"struct RawNope"#',
    ].join('\n');
    const out = stripCommentsAndStrings(src);
    expect(out).not.toContain('Nope');
    expect(out).not.toContain('AlsoNope');
    expect(out).not.toContain('RawNope');
    // A type referenced only inside interpolation is (by design) not preserved.
    expect(out).not.toContain('Widget');
  });

  it('keeps a `#if` / `#selector` directive (not a raw string)', () => {
    const out = stripCommentsAndStrings('#if os(iOS)\nlet x = #selector(foo)\n#endif');
    expect(out).toContain('#if');
    expect(out).toContain('#selector');
  });
});

describe('scanImports', () => {
  it('reads the module name across import forms', () => {
    const src = [
      'import Foundation',
      '@testable import MyLib',
      'public import SwiftUI',
      'import class Foundation.NSData',
      'import struct Vapor.Request',
      '@_exported import Shared',
      '  import ComposableArchitecture',
    ].join('\n');
    expect(scanImports(src)).toEqual([
      'Foundation',
      'MyLib',
      'SwiftUI',
      'Foundation',
      'Vapor',
      'Shared',
      'ComposableArchitecture',
    ]);
  });

  it('ignores a commented-out import', () => {
    expect(scanImports('// import Ghost\nimport Real')).toEqual(['Real']);
  });
});

describe('scanTypeDecls', () => {
  it('captures the primary nominal declarations', () => {
    const src = [
      'public final class UserStore {}',
      'struct Profile: Codable {}',
      'enum Route { case home }',
      'indirect enum Tree {}',
      'protocol Repository {}',
      'actor Cache {}',
      'typealias Handler = () -> Void',
      'extension String { }', // extension is NOT a declaration
    ].join('\n');
    expect(scanTypeDecls(src)).toEqual([
      'UserStore',
      'Profile',
      'Route',
      'Tree',
      'Repository',
      'Cache',
      'Handler',
    ]);
  });

  it('does not treat `class func` / `class var` as a type declaration', () => {
    expect(scanTypeDecls('class Widget {\n  class func make() {}\n  class var shared = 1\n}')).toEqual([
      'Widget',
    ]);
  });

  it('ignores a commented-out declaration (so the real one stays unambiguous)', () => {
    expect(scanTypeDecls('// class User {}\nclass User {}')).toEqual(['User']);
  });
});

describe('scanTypeReferences', () => {
  it('collects UpperCamelCase tokens from the body, excluding import lines', () => {
    const src = ['import SwiftUI', 'struct HomeView: View {', '  let store: UserStore', '}'].join('\n');
    const refs = scanTypeReferences(src);
    expect(refs).toContain('View');
    expect(refs).toContain('UserStore');
    expect(refs).toContain('HomeView'); // the decl name is a token too (self-edge dropped later)
    expect(refs).not.toContain('SwiftUI'); // import line excluded
  });

  it('ignores tokens inside comments and strings', () => {
    const refs = scanTypeReferences('let x = "PaymentGateway" // AuthService\nlet y = Real');
    expect(refs).not.toContain('PaymentGateway');
    expect(refs).not.toContain('AuthService');
    expect(refs).toContain('Real');
  });
});

describe('scanSwiftFile (one-pass)', () => {
  it('derives imports + decls + references consistently', () => {
    const src = ['import Combine', 'final class ViewModel {', '  let user: User', '}'].join('\n');
    const s = scanSwiftFile(src);
    expect(s.imports).toEqual(['Combine']);
    expect(s.decls).toEqual(['ViewModel']);
    expect(s.references).toContain('User');
    expect(s.references).not.toContain('Combine');
  });
});
