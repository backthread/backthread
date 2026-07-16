// Swift manifest reading — Package.swift deps + targets, Package.resolved pins,
// Podfile pods. Pure parse functions + the fs-backed readSwiftTargets walk.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  parsePackageSwiftDeps,
  parsePackageResolvedDeps,
  parsePodfileDeps,
  parsePackageSwiftTargets,
  readSwiftDeps,
  readSwiftTargets,
} from './swift-manifest.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-swift-mf-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

const PACKAGE_SWIFT = `// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "MyApp",
  dependencies: [
    .package(url: "https://github.com/pointfreeco/swift-composable-architecture", from: "1.0.0"),
    .package(url: "https://github.com/vapor/vapor.git", from: "4.0.0"),
  ],
  targets: [
    .target(name: "AppFeature", dependencies: [
      .product(name: "ComposableArchitecture", package: "swift-composable-architecture"),
    ]),
    .target(name: "Models", path: "Sources/Domain/Models"),
    .executableTarget(name: "Server"),
    .testTarget(name: "AppFeatureTests", dependencies: ["AppFeature"]),
  ]
)`;

describe('parsePackageSwiftDeps', () => {
  it('reads dep repo-names from .package(url:) (nested .product is ignored)', () => {
    const deps = parsePackageSwiftDeps(PACKAGE_SWIFT);
    expect(deps).toContain('swift-composable-architecture');
    expect(deps).toContain('vapor');
    // The nested `.product(name: "ComposableArchitecture", …)` is NOT a package decl.
    expect(deps).not.toContain('ComposableArchitecture');
  });
});

describe('parsePackageSwiftTargets', () => {
  it('reads target names + their source dirs (convention + explicit path)', () => {
    const targets = parsePackageSwiftTargets(PACKAGE_SWIFT, '');
    const byName = Object.fromEntries(targets.map((t) => [t.name, t.dir]));
    expect(byName['AppFeature']).toBe('Sources/AppFeature');
    expect(byName['Models']).toBe('Sources/Domain/Models'); // explicit path:
    expect(byName['Server']).toBe('Sources/Server'); // executableTarget convention
    expect(byName['AppFeatureTests']).toBe('Tests/AppFeatureTests'); // testTarget → Tests/
    // The nested `.product(name:)` did not leak in as a target.
    expect(byName['ComposableArchitecture']).toBeUndefined();
  });

  it('resolves target dirs under a nested package dir', () => {
    const targets = parsePackageSwiftTargets('let p = Package(targets: [.target(name: "Core")])', 'Frameworks/Core');
    expect(targets).toEqual([{ name: 'Core', dir: 'Frameworks/Core/Sources/Core' }]);
  });
});

describe('parsePackageResolvedDeps', () => {
  it('reads v2 pins[].identity', () => {
    const json = JSON.stringify({
      pins: [{ identity: 'alamofire', location: 'https://github.com/Alamofire/Alamofire' }],
      version: 2,
    });
    expect(parsePackageResolvedDeps(json)).toEqual(['alamofire']);
  });
  it('reads v1 object.pins[].package', () => {
    const json = JSON.stringify({ object: { pins: [{ package: 'SnapKit' }] }, version: 1 });
    expect(parsePackageResolvedDeps(json)).toEqual(['SnapKit']);
  });
  it('degrades to [] on malformed JSON', () => {
    expect(parsePackageResolvedDeps('{ not json')).toEqual([]);
  });
});

describe('parsePodfileDeps', () => {
  it('reads pod names, dropping subspecs', () => {
    const podfile = `platform :ios, '15.0'
target 'App' do
  pod 'Alamofire'
  pod "SnapKit/Core"
end`;
    expect(parsePodfileDeps(podfile)).toEqual(['Alamofire', 'SnapKit']);
  });
});

describe('readSwiftDeps (fs, lowercased union)', () => {
  it('unions Package.swift + Package.resolved + Podfile, lowercased', async () => {
    const dir = await repo({
      'Package.swift': PACKAGE_SWIFT,
      'Package.resolved': JSON.stringify({ pins: [{ identity: 'snapkit' }], version: 2 }),
      'Podfile': "pod 'Alamofire'",
    });
    const deps = readSwiftDeps(dir);
    expect(deps.has('vapor')).toBe(true);
    expect(deps.has('swift-composable-architecture')).toBe(true);
    expect(deps.has('snapkit')).toBe(true);
    expect(deps.has('alamofire')).toBe(true);
  });
});

describe('readSwiftTargets (fs, monorepo union)', () => {
  it('unions targets across the root + a nested Package.swift, sorted', async () => {
    const dir = await repo({
      'Package.swift': 'let p = Package(targets: [.target(name: "Root")])',
      'Frameworks/Widgets/Package.swift': 'let p = Package(targets: [.target(name: "Widgets")])',
      '.build/vendored/Package.swift': 'let p = Package(targets: [.target(name: "ShouldSkip")])',
    });
    const targets = readSwiftTargets(dir);
    const names = targets.map((t) => t.name);
    expect(names).toEqual(['Root', 'Widgets']); // sorted; .build skipped
    expect(targets.find((t) => t.name === 'Widgets')?.dir).toBe('Frameworks/Widgets/Sources/Widgets');
  });
});
