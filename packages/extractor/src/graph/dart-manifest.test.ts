// Dart dependency-manifest reading + the package-name→dir map that anchors
// `package:<self>` resolution. Parsed with the bundled `yaml` package; membership +
// name only, never executed.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  parsePubspecName,
  parsePubspecDeps,
  parsePubLockDeps,
  readPubDeps,
  readPubDepsDeep,
  dartPackageRoots,
} from './dart-manifest.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-dart-manifest-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

const PUBSPEC = [
  'name: my_app',
  'description: demo',
  'dependencies:',
  '  flutter:',
  '    sdk: flutter',
  '  http: ^1.0.0',
  '  provider: ^6.0.0',
  'dev_dependencies:',
  '  build_runner: ^2.0.0',
  '  flutter_test:',
  '    sdk: flutter',
].join('\n');

describe('pubspec parsing (pure)', () => {
  it('reads the package name', () => {
    expect(parsePubspecName(PUBSPEC)).toBe('my_app');
    expect(parsePubspecName('description: no name here')).toBeNull();
  });
  it('reads dependencies ∪ dev_dependencies keys', () => {
    expect(new Set(parsePubspecDeps(PUBSPEC))).toEqual(
      new Set(['flutter', 'http', 'provider', 'build_runner', 'flutter_test']),
    );
  });
  it('reads pubspec.lock package keys', () => {
    const lock = 'packages:\n  http:\n    version: "1.0.0"\n  meta:\n    version: "1.9.0"\n';
    expect(new Set(parsePubLockDeps(lock))).toEqual(new Set(['http', 'meta']));
  });
  it('degrades to empty on a malformed manifest, never throws', () => {
    expect(parsePubspecDeps(': : : not yaml : :')).toEqual([]);
  });
});

describe('readPubDeps / readPubDepsDeep', () => {
  it('unions pubspec + lock at a base dir', async () => {
    const dir = await repo({
      'pubspec.yaml': PUBSPEC,
      'pubspec.lock': 'packages:\n  meta:\n    version: "1.9.0"\n',
    });
    expect(readPubDeps(dir).has('http')).toBe(true);
    expect(readPubDeps(dir).has('meta')).toBe(true);
  });
  it('unions deps across every nested pubspec', async () => {
    const dir = await repo({
      'pubspec.yaml': 'name: root\n',
      'packages/a/pubspec.yaml': 'name: a\ndependencies:\n  dio: ^5.0.0\n',
      'packages/b/pubspec.yaml': 'name: b\ndependencies:\n  isar: ^3.0.0\n',
    });
    const deps = readPubDepsDeep(dir);
    expect(deps.has('dio')).toBe(true);
    expect(deps.has('isar')).toBe(true);
  });
});

describe('dartPackageRoots', () => {
  it('maps every internal package name to its dir', async () => {
    const dir = await repo({
      'pubspec.yaml': 'name: root_app\n',
      'packages/core/pubspec.yaml': 'name: core\n',
      'packages/ui/pubspec.yaml': 'name: ui_kit\n',
    });
    const roots = dartPackageRoots(dir);
    expect(roots.get('root_app')).toBe('');
    expect(roots.get('core')).toBe('packages/core');
    expect(roots.get('ui_kit')).toBe('packages/ui');
  });
});
