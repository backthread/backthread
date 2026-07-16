// Dart language detection + the source-file policy + the isolation gate: a Dart repo
// detects as `dart`, a nested Flutter app is found by the deep probe, and a
// non-Dart (TS) repo neither detects as Dart nor lists any Dart source.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  hasDartManifest,
  hasDartManifestDeep,
  detectRepoLanguage,
  detectRepoLanguages,
  listSourceFiles,
} from './language.js';
import { isSourceFilePath } from './file-graph.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-dart-lang-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

describe('Dart language detection', () => {
  it('detects a root pubspec.yaml as Dart', async () => {
    const dir = await repo({ 'pubspec.yaml': 'name: app\n', 'lib/main.dart': 'void main() {}\n' });
    expect(hasDartManifest(dir)).toBe(true);
    expect(detectRepoLanguage(dir)).toBe('dart');
  });

  it('finds a nested Flutter app under mobile/ via the deep probe', async () => {
    const dir = await repo({
      'package.json': '{"name":"server"}',
      'mobile/pubspec.yaml': 'name: mobile_app\n',
      'mobile/lib/main.dart': 'void main() {}\n',
    });
    // root-only check misses it; the deep probe finds it.
    expect(hasDartManifest(dir)).toBe(false);
    expect(hasDartManifestDeep(dir)).toBe(true);
  });

  it('does NOT detect a TS repo as Dart (isolation)', async () => {
    const dir = await repo({ 'package.json': '{"name":"x"}', 'src/index.ts': 'export const a = 1;\n' });
    expect(hasDartManifest(dir)).toBe(false);
    expect(hasDartManifestDeep(dir)).toBe(false);
    expect(detectRepoLanguage(dir)).toBe('ts');
    expect(listSourceFiles(dir, 'dart')).toEqual([]);
  });

  it('lists Dart source but skips native hosts + build/tool dirs', async () => {
    const dir = await repo({
      'pubspec.yaml': 'name: app\n',
      'lib/main.dart': 'void main() {}\n',
      'lib/widgets/button.dart': 'class Button {}\n',
      'ios/Runner/AppDelegate.dart': '// not real, still excluded\n',
      'android/app/x.dart': '// excluded\n',
      '.dart_tool/version': 'x\n',
      'build/gen.dart': '// excluded build output\n',
    });
    expect(listSourceFiles(dir, 'dart')).toEqual(['lib/main.dart', 'lib/widgets/button.dart']);
  });

  it('classifies a polyglot TS+Dart repo with both languages present', async () => {
    const files: Record<string, string> = {
      'package.json': '{"name":"server"}',
      'pubspec.yaml': 'name: app\n',
    };
    for (let i = 0; i < 8; i++) files[`server/src/f${i}.ts`] = 'export const x = 1;\n';
    for (let i = 0; i < 8; i++) files[`mobile/lib/f${i}.dart`] = 'class X {}\n';
    const langs = detectRepoLanguages(await repo(files));
    expect(langs).toContain('ts');
    expect(langs).toContain('dart');
  });
});

describe('isSourceFilePath (dart)', () => {
  it('matches .dart, rejects excluded segments + dot dirs', () => {
    expect(isSourceFilePath('lib/main.dart', 'dart')).toBe(true);
    expect(isSourceFilePath('lib/model.g.dart', 'dart')).toBe(true);
    expect(isSourceFilePath('ios/Runner/x.dart', 'dart')).toBe(false);
    expect(isSourceFilePath('.dart_tool/x.dart', 'dart')).toBe(false);
    expect(isSourceFilePath('build/x.dart', 'dart')).toBe(false);
    expect(isSourceFilePath('lib/main.ts', 'dart')).toBe(false);
  });
});
