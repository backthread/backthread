// The Swift syntactic scanner — comment/string stripping, imports, primary type
// declarations, and reference tokens. Pure, deterministic; no fs.

import { describe, it, expect } from '../testkit.js';
import {
  stripCommentsAndStrings,
  scanImports,
  scanTypeDecls,
  scanTypeReferences,
  scanCallSites,
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

describe('scanCallSites', () => {
  it('captures initializer and static-call heads', () => {
    const src = [
      'func make() {',
      '  let s = UserStore()', // initializer call → UserStore
      '  Analytics.track(event)', // static call → Analytics
      '  let v = HomeView(store: s)', // initializer with args → HomeView
      '}',
    ].join('\n');
    const c = scanCallSites(src);
    expect(c).toContain('UserStore');
    expect(c).toContain('Analytics');
    expect(c).toContain('HomeView');
  });

  it('does not capture instance calls, member-access heads, or type annotations', () => {
    const src = [
      'func f(store: UserStore) {', // UserStore is a param TYPE (followed by `)`, not `(`)
      '  store.reload()', // instance call — lowercase head, no resolvable type
      '  foo.Bar()', // member-access head — `Bar` preceded by `.`, excluded
      '  let x: Config = y', // type annotation, not a call
      '}',
    ].join('\n');
    expect(scanCallSites(src)).toEqual([]);
  });

  it('excludes pattern-match lines (case Enum.case(binding) / if case)', () => {
    const src = [
      'switch state {',
      'case LoadState.loaded(let items):', // pattern match — NOT a call
      '  Renderer.draw(items)', // a real static call on the body line → captured
      '}',
      'if case Status.active(let x) = s { Foo() }', // if-case line → whole line skipped
    ].join('\n');
    const c = scanCallSites(src);
    expect(c).not.toContain('LoadState'); // switch-case pattern excluded
    expect(c).not.toContain('Status'); // if-case pattern excluded
    expect(c).not.toContain('Foo'); // same line as `if case` → conservatively excluded
    expect(c).toContain('Renderer'); // a genuine call on a non-case body line is kept
  });

  it('excludes a single-line switch case pattern (`{ case Enum.val(x): … }`)', () => {
    // The `case` follows `{`, not the line start — the statement-boundary guard catches it.
    const c = scanCallSites('switch r { case Result.ok(let v): Handler.run(v) }');
    expect(c).not.toContain('Result'); // enum pattern, not a call
    expect(c).not.toContain('Handler'); // same line as the case → conservatively excluded
  });

  it('ignores call-shaped tokens inside comments and strings', () => {
    const c = scanCallSites('let s = "Widget()" // Gadget()\nlet r = Real()');
    expect(c).not.toContain('Widget');
    expect(c).not.toContain('Gadget');
    expect(c).toContain('Real');
  });

  it('excludes import lines', () => {
    expect(scanCallSites('import Foundation\nlet r = Repo()')).toEqual(['Repo']);
  });
});

describe('scanSwiftFile (one-pass)', () => {
  it('derives imports + decls + references + call sites consistently', () => {
    const src = ['import Combine', 'final class ViewModel {', '  let user: User', '  func load() { Repo.fetch() }', '}'].join('\n');
    const s = scanSwiftFile(src);
    expect(s.imports).toEqual(['Combine']);
    expect(s.decls).toEqual(['ViewModel']);
    expect(s.references).toContain('User');
    expect(s.references).not.toContain('Combine');
    expect(s.callSites).toContain('Repo'); // Repo.fetch() → call-site head
  });
});
