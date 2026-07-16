// The SwiftUI + UIKit adapter: source-scan detection, UI role tags (require the
// construct), the navigation spine, and grouping.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { swiftUiAdapter, detectUiSignals, scoreUi, fileUiRole } from './ui.js';
import { typeDeclarations } from '../swift-ast.js';
import { SwiftExtractor } from '../../../graph/swift-adapter.js';
import type { FrameworkContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-swift-ui-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

// Build a FrameworkContext by really extracting the repo (so file `language` tags +
// ids match production), then invoke the adapter's hooks.
async function contextFor(repoDir: string): Promise<FrameworkContext> {
  const graph: NormalizedGraph = await new SwiftExtractor().extract(repoDir);
  return {
    repoDir,
    rootPath: '',
    match: { adapter: 'swift-ui', confidence: 1, rootPath: '' },
    graph,
    cluster: { fileModuleMap: {}, moduleIds: new Set() },
  };
}

describe('detectUiSignals / scoreUi', () => {
  it('detects SwiftUI and UIKit from source imports (not manifests)', async () => {
    const dir = await repo({
      'Sources/App/HomeView.swift': 'import SwiftUI\nstruct HomeView: View { var body: some View { Text("hi") } }\n',
      'Sources/App/LegacyVC.swift': 'import UIKit\nclass LegacyVC: UIViewController {}\n',
    });
    const s = detectUiSignals(dir);
    expect(s.hasSwiftUI).toBe(true);
    expect(s.hasUIKit).toBe(true);
    const match = scoreUi(s);
    expect(match?.adapter).toBe('swift-ui');
    expect(match?.metadata?.variant).toBe('swiftui+uikit');
  });

  it('returns null when neither UI framework is imported', async () => {
    const dir = await repo({ 'Sources/Lib/Math.swift': 'import Foundation\nstruct Math {}\n' });
    expect(scoreUi(detectUiSignals(dir))).toBeNull();
  });
});

describe('fileUiRole (require the construct, not just the import)', () => {
  const scan = (text: string) => ({ text, decls: typeDeclarations(text), imports: [], properties: [] });

  it('tags SwiftUI View (: View + var body) as view', () => {
    expect(fileUiRole(scan('struct HomeView: View { var body: some View { Text("x") } }'))).toBe('view');
  });
  it('does NOT tag a : View conformance with no body (not a real View)', () => {
    // A type merely named View-like without a body is not a SwiftUI View.
    expect(fileUiRole(scan('struct Config: Codable { let x: Int }'))).toBeUndefined();
  });
  it('tags a UIViewController subclass as screen', () => {
    expect(fileUiRole(scan('class DetailVC: UIViewController {}'))).toBe('screen');
  });
  it('tags a UIView subclass as view', () => {
    expect(fileUiRole(scan('class Badge: UIView {}'))).toBe('view');
  });
  it('tags @main / : App / AppDelegate / SceneDelegate as app-entry (frontend, not gateway)', () => {
    expect(fileUiRole(scan('@main\nstruct MyApp: App { var body: some Scene { WindowGroup {} } }'))).toBe('app-entry');
    expect(fileUiRole(scan('class AppDelegate: UIResponder, UIApplicationDelegate {}'))).toBe('app-entry');
  });
  it('tags a SwiftUI Scene as scene', () => {
    expect(fileUiRole(scan('struct MainScene: Scene { var body: some Scene { WindowGroup {} } }'))).toBe('scene');
  });
});

describe('roleTags + syntheticEdges (integration)', () => {
  const APP: Record<string, string> = {
    'Sources/App/MyApp.swift':
      'import SwiftUI\n@main\nstruct MyApp: App {\n  var body: some Scene { WindowGroup { HomeView() } }\n}\n',
    'Sources/App/Home/HomeView.swift':
      'import SwiftUI\nstruct HomeView: View {\n  var body: some View {\n    NavigationStack {\n      NavigationLink(destination: DetailView()) { Text("go") }\n    }\n  }\n}\n',
    'Sources/App/Detail/DetailView.swift':
      'import SwiftUI\nstruct DetailView: View {\n  var body: some View {\n    Button("settings") {}\n      .sheet(isPresented: .constant(false)) {\n        SettingsView()\n      }\n  }\n}\n',
    'Sources/App/Detail/SettingsView.swift':
      'import SwiftUI\nstruct SettingsView: View { var body: some View { Text("settings") } }\n',
  };

  it('tags all UI types frontend and app-entry frontend', async () => {
    const ctx = await contextFor(await repo(APP));
    const roles = await swiftUiAdapter.roleTags!(ctx);
    expect(roles.get('Sources/App/MyApp.swift')?.role).toBe('app-entry');
    expect(roles.get('Sources/App/MyApp.swift')?.kind).toBe('frontend');
    expect(roles.get('Sources/App/Home/HomeView.swift')?.kind).toBe('frontend');
    expect(roles.get('Sources/App/Detail/DetailView.swift')?.role).toBe('view');
    // Every UI role maps to frontend (never gateway).
    for (const tag of roles.values()) expect(tag.kind).toBe('frontend');
  });

  it('emits screen→screen navigation edges (calls)', async () => {
    const ctx = await contextFor(await repo(APP));
    const edges = await swiftUiAdapter.syntheticEdges!(ctx);
    const keys = new Set(edges.map((e) => `${e.source} -> ${e.target}`));
    // HomeView navigates to DetailView; DetailView sheets SettingsView.
    expect(keys).toContain('Sources/App/Home/HomeView.swift -> Sources/App/Detail/DetailView.swift');
    expect(keys).toContain('Sources/App/Detail/DetailView.swift -> Sources/App/Detail/SettingsView.swift');
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
  });

  it('groups a single-module app by feature folder', async () => {
    const ctx = await contextFor(await repo(APP));
    const { groups } = await swiftUiAdapter.groupingPrior!(ctx);
    const labels = new Set(groups.map((g) => g.label));
    // Detail/ holds ≥2 files → a "Detail" subsystem.
    expect(labels).toContain('Detail');
  });
});

describe('UIKit navigation', () => {
  it('emits a push/present edge between UIViewControllers', async () => {
    const ctx = await contextFor(
      await repo({
        'Sources/App/ListVC.swift':
          'import UIKit\nclass ListVC: UIViewController {\n  func open() {\n    navigationController?.pushViewController(DetailVC(), animated: true)\n  }\n}\n',
        'Sources/App/DetailVC.swift': 'import UIKit\nclass DetailVC: UIViewController {}\n',
      }),
    );
    const edges = await swiftUiAdapter.syntheticEdges!(ctx);
    const keys = new Set(edges.map((e) => `${e.source} -> ${e.target}`));
    expect(keys).toContain('Sources/App/ListVC.swift -> Sources/App/DetailVC.swift');
  });
});

describe('grouping — SPM targets primary', () => {
  it('groups by SPM target when ≥2 targets exist', async () => {
    const ctx = await contextFor(
      await repo({
        'Package.swift':
          'let p = Package(targets: [.target(name: "HomeFeature"), .target(name: "DetailFeature")])\n',
        'Sources/HomeFeature/HomeView.swift': 'import SwiftUI\nstruct HomeView: View { var body: some View { Text("h") } }\n',
        'Sources/DetailFeature/DetailView.swift': 'import SwiftUI\nstruct DetailView: View { var body: some View { Text("d") } }\n',
      }),
    );
    const { groups } = await swiftUiAdapter.groupingPrior!(ctx);
    const labels = new Set(groups.map((g) => g.label));
    expect(labels).toContain('Home Feature');
    expect(labels).toContain('Detail Feature');
  });
});
