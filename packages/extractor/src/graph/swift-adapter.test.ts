// The Swift import-graph extractor, over small on-disk fixtures. Asserts the
// type-reference backbone (single-module), cross-module edges + first-party module
// imports (multi-target SPM), external collapse, Apple-SDK drop, the ambiguity gate,
// the Package.swift skip, no self-edges, and determinism.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { SwiftExtractor, assignFilesToTargets, extractFileCalls } from './swift-adapter.js';
import type { NormalizedGraph } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-swift-ext-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

function internalEdges(g: NormalizedGraph): Set<string> {
  return new Set(g.edges.filter((e) => !e.external).map((e) => `${e.from} -> ${e.to}`));
}
function externalIds(g: NormalizedGraph): Set<string> {
  return new Set(g.edges.filter((e) => e.external).map((e) => e.to));
}
function callEdges(g: NormalizedGraph): Set<string> {
  return new Set(g.edges.filter((e) => e.kind === 'call' && !e.external).map((e) => `${e.from} -> ${e.to}`));
}

// A single-module SwiftUI app: no Package.swift, types in separate files referencing
// each other — the type-reference backbone must connect them.
const SINGLE_MODULE: Record<string, string> = {
  'Sources/App/App.swift':
    'import SwiftUI\n@main\nstruct MyApp: App {\n  var body: some Scene {\n    WindowGroup { HomeView() }\n  }\n}\n',
  'Sources/App/HomeView.swift':
    'import SwiftUI\nstruct HomeView: View {\n  let store: UserStore\n  var body: some View { Text("hi") }\n}\n',
  'Sources/App/UserStore.swift':
    'import Foundation\nimport Alamofire\nfinal class UserStore {\n  var users: [User] = []\n}\n',
  'Sources/App/User.swift': 'struct User: Codable {\n  let id: Int\n}\n',
};

describe('SwiftExtractor — single-module type-reference backbone', () => {
  it('connects files via type references (no import edges needed)', async () => {
    const dir = await repo(SINGLE_MODULE);
    const g = await new SwiftExtractor().extract(dir);
    const edges = internalEdges(g);
    // App references HomeView; HomeView references UserStore; UserStore references User.
    expect(edges).toContain('Sources/App/App.swift -> Sources/App/HomeView.swift');
    expect(edges).toContain('Sources/App/HomeView.swift -> Sources/App/UserStore.swift');
    expect(edges).toContain('Sources/App/UserStore.swift -> Sources/App/User.swift');
  });

  it('drops Apple SDK imports, keeps third-party as externals', async () => {
    const dir = await repo(SINGLE_MODULE);
    const g = await new SwiftExtractor().extract(dir);
    const ext = externalIds(g);
    expect(ext).toContain('ext:Alamofire');
    expect(ext).not.toContain('ext:SwiftUI');
    expect(ext).not.toContain('ext:Foundation');
  });

  it('emits no self-edges', async () => {
    const dir = await repo(SINGLE_MODULE);
    const g = await new SwiftExtractor().extract(dir);
    expect(g.edges.every((e) => e.from !== e.to)).toBe(true);
  });

  it('is deterministic across runs', async () => {
    const dir = await repo(SINGLE_MODULE);
    const a = await new SwiftExtractor().extract(dir);
    const b = await new SwiftExtractor().extract(dir);
    expect(internalEdges(a)).toEqual(internalEdges(b));
    expect(externalIds(a)).toEqual(externalIds(b));
  });
});

describe('SwiftExtractor — ambiguity gate', () => {
  it('drops a type name declared in ≥2 files (no guessed edge)', async () => {
    const dir = await repo({
      'Sources/A/Thing.swift': 'struct Thing {}\n',
      'Sources/B/Thing.swift': 'struct Thing {}\n', // same name, different file → ambiguous
      'Sources/C/Use.swift': 'struct Use {\n  let t: Thing\n}\n',
    });
    const g = await new SwiftExtractor().extract(dir);
    const edges = internalEdges(g);
    // `Thing` is ambiguous → no edge from Use to either declaration.
    expect([...edges].some((e) => e.startsWith('Sources/C/Use.swift ->'))).toBe(false);
  });
});

describe('SwiftExtractor — multi-module SPM', () => {
  const MULTI: Record<string, string> = {
    'Package.swift':
      'let p = Package(name: "M", targets: [\n' +
      '  .target(name: "Models"),\n' +
      '  .target(name: "Feature", dependencies: ["Models"]),\n' +
      '])\n',
    'Sources/Models/Todo.swift': 'public struct Todo {\n  public let title: String\n}\n',
    'Sources/Feature/FeatureView.swift':
      'import SwiftUI\nimport Models\nstruct FeatureView: View {\n  let todo: Todo\n  var body: some View { Text(todo.title) }\n}\n',
  };

  it('draws cross-module edges (type-ref) + skips Package.swift as a node', async () => {
    const dir = await repo(MULTI);
    const g = await new SwiftExtractor().extract(dir);
    // Package.swift is a manifest, never a graph node.
    expect(g.files.some((f) => f.id === 'Package.swift')).toBe(false);
    // Feature references Todo (declared in Models) → cross-module edge.
    expect(internalEdges(g)).toContain('Sources/Feature/FeatureView.swift -> Sources/Models/Todo.swift');
    // `Models` is a first-party target, so `import Models` is NOT an external node.
    expect(externalIds(g)).not.toContain('ext:Models');
  });

  it('draws a first-party module-import edge even without a resolvable type ref', async () => {
    const dir = await repo({
      'Package.swift':
        'let p = Package(targets: [.target(name: "Core"), .target(name: "UI")])\n',
      'Sources/Core/Helpers.swift': 'public func helper() {}\n', // no type, only a free func
      'Sources/UI/Screen.swift': 'import Core\nfunc render() { helper() }\n',
    });
    const g = await new SwiftExtractor().extract(dir);
    // No type ref resolves, but `import Core` draws a module-boundary edge to Core's
    // representative file.
    expect(internalEdges(g)).toContain('Sources/UI/Screen.swift -> Sources/Core/Helpers.swift');
  });
});

describe('SwiftExtractor — call edges (v2)', () => {
  it('resolves an unambiguous in-repo initializer / static call to a call edge', async () => {
    const dir = await repo({
      'Sources/App/Home.swift': 'struct Home {\n  func body() { let s = UserStore(); Analytics.track() }\n}\n',
      'Sources/App/UserStore.swift': 'final class UserStore {}\n',
      'Sources/App/Analytics.swift': 'enum Analytics { static func track() {} }\n',
    });
    const g = await new SwiftExtractor().extract(dir);
    const calls = callEdges(g);
    expect(calls).toContain('Sources/App/Home.swift -> Sources/App/UserStore.swift'); // initializer
    expect(calls).toContain('Sources/App/Home.swift -> Sources/App/Analytics.swift'); // static call
  });

  it('drops an ambiguous callee (declared in ≥2 files) — no guessed call edge', async () => {
    const dir = await repo({
      'Sources/A/Thing.swift': 'struct Thing {}\n',
      'Sources/B/Thing.swift': 'struct Thing {}\n', // ambiguous → dropped from the registry
      'Sources/C/Use.swift': 'struct Use { func f() { let t = Thing() } }\n',
    });
    const g = await new SwiftExtractor().extract(dir);
    expect([...callEdges(g)].some((e) => e.startsWith('Sources/C/Use.swift ->'))).toBe(false);
  });

  it('drops external / Apple-SDK call heads (only in-repo types resolve)', async () => {
    const dir = await repo({
      'Sources/App/V.swift': 'import SwiftUI\nimport Foundation\nstruct V { func f() { Text("x"); let u = URLSession() } }\n',
    });
    const g = await new SwiftExtractor().extract(dir);
    expect(callEdges(g).size).toBe(0); // Text (SwiftUI) + URLSession (Foundation) are not in-repo
  });

  it('drops a self call but keeps a cross-file call', async () => {
    const dir = await repo({
      'Sources/App/Factory.swift': 'struct Factory {\n  func make() { let x = Factory(); let y = Widget() }\n}\n',
      'Sources/App/Widget.swift': 'struct Widget {}\n',
    });
    const g = await new SwiftExtractor().extract(dir);
    const calls = callEdges(g);
    expect(calls).toContain('Sources/App/Factory.swift -> Sources/App/Widget.swift'); // cross-file kept
    expect(g.edges.filter((e) => e.kind === 'call').every((e) => e.from !== e.to)).toBe(true); // no self-edge
  });

  it('is deterministic across runs (call edges included)', async () => {
    const dir = await repo({
      'Sources/App/A.swift': 'struct A { func f() { B(); C.go() } }\n',
      'Sources/App/B.swift': 'struct B {}\n',
      'Sources/App/C.swift': 'enum C { static func go() {} }\n',
    });
    const x = await new SwiftExtractor().extract(dir);
    const y = await new SwiftExtractor().extract(dir);
    expect(callEdges(x)).toEqual(callEdges(y));
  });
});

describe('extractFileCalls', () => {
  it('resolves unambiguous heads, drops unresolved/self, weights by count, sorts by target', () => {
    const nameToFile = new Map([
      ['Foo', 'a/Foo.swift'],
      ['Bar', 'a/Bar.swift'],
    ]);
    // Foo×2, Bar×1; Unknown unresolved (not in registry); Caller is self-ish (not in map).
    const edges = extractFileCalls('a/Caller.swift', ['Foo', 'Bar', 'Foo', 'Unknown', 'Caller'], nameToFile);
    expect(edges).toEqual([
      { to: 'a/Bar.swift', weight: 1 },
      { to: 'a/Foo.swift', weight: 2 },
    ]);
  });

  it('drops a self head (target === fromId)', () => {
    const nameToFile = new Map([['SelfType', 'a/SelfType.swift']]);
    expect(extractFileCalls('a/SelfType.swift', ['SelfType', 'SelfType'], nameToFile)).toEqual([]);
  });

  it('degrades a god-file (over the per-file call-site cap) to import-only', () => {
    const nameToFile = new Map([['Foo', 'a/Foo.swift']]);
    const many = Array.from({ length: 2501 }, () => 'Foo'); // > MAX_CALL_SITES_PER_FILE (2500)
    expect(extractFileCalls('a/Caller.swift', many, nameToFile)).toEqual([]);
  });
});

describe('assignFilesToTargets', () => {
  it('maps files to the longest-prefix target dir', () => {
    const { fileToTarget } = assignFilesToTargets(
      ['Sources/App/A.swift', 'Sources/App/Sub/B.swift', 'Sources/Core/C.swift', 'loose.swift'],
      [
        { name: 'App', dir: 'Sources/App' },
        { name: 'Core', dir: 'Sources/Core' },
      ],
    );
    expect(fileToTarget.get('Sources/App/A.swift')).toBe('App');
    expect(fileToTarget.get('Sources/App/Sub/B.swift')).toBe('App');
    expect(fileToTarget.get('Sources/Core/C.swift')).toBe('Core');
    expect(fileToTarget.get('loose.swift')).toBeUndefined();
  });
});
