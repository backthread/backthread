// Gradle dependency-manifest reading — coordinate-group scanning, version-catalog
// parsing, settings include() module paths, and the fs-backed readGradleDeps union.

import { describe, it, expect, afterEach } from '../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseGradleBuildGroups,
  parseVersionCatalogGroups,
  parseSettingsIncludes,
  readGradleDeps,
  readGradleDepsDeep,
} from './kotlin-manifest.js';

describe('parseGradleBuildGroups', () => {
  it('reads Kotlin-DSL and Groovy coordinate strings, ignores project() deps', () => {
    const build = [
      'dependencies {',
      '  implementation("io.ktor:ktor-server-core:2.3.0")',
      "  implementation 'androidx.room:room-runtime:2.6.1'",
      '  kapt("androidx.room:room-compiler:2.6.1")',
      '  api(project(":core:common"))',
      '  implementation(libs.kotlinx.coroutines)',
      '}',
    ].join('\n');
    const groups = parseGradleBuildGroups(build);
    expect(groups).toContain('io.ktor');
    expect(groups).toContain('androidx.room');
    expect(groups).not.toContain('core'); // project(":core:common") must not become a group
  });
});

describe('parseVersionCatalogGroups', () => {
  it('reads module=, group=, and string-shorthand library entries', () => {
    const toml = [
      '[versions]',
      'ktor = "2.3.0"',
      '[libraries]',
      'ktor-server-core = { module = "io.ktor:ktor-server-core", version.ref = "ktor" }',
      'room-runtime = { group = "androidx.room", name = "room-runtime", version.ref = "room" }',
      'retrofit = "com.squareup.retrofit2:retrofit:2.9.0"',
      '[plugins]',
      'android-app = { id = "com.android.application", version = "8.0" }',
    ].join('\n');
    const groups = parseVersionCatalogGroups(toml);
    expect(groups.sort()).toEqual(['androidx.room', 'com.squareup.retrofit2', 'io.ktor']);
  });
  it('returns [] on a malformed catalog', () => {
    expect(parseVersionCatalogGroups('[libraries\nbroken = ')).toEqual([]);
  });
});

describe('parseSettingsIncludes', () => {
  it('reads leading-colon module paths from single- and multi-line includes', () => {
    const settings = [
      'rootProject.name = "myapp"', // must NOT be read as a module
      'include(":app")',
      'include(',
      '  ":feature:home",',
      '  ":core:data",',
      ')',
      "include ':legacy'", // Groovy form
    ].join('\n');
    expect(parseSettingsIncludes(settings)).toEqual(['app', 'core/data', 'feature/home', 'legacy']);
  });
});

describe('readGradleDeps / readGradleDepsDeep (fs)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-kt-manifest-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, content);
    }
    return dir;
  }

  it('unions root build.gradle + version catalog', async () => {
    const dir = await repo({
      'build.gradle.kts': 'dependencies { implementation("io.ktor:ktor-server-core:2.3.0") }',
      'gradle/libs.versions.toml': '[libraries]\nroom = { module = "androidx.room:room-runtime" }',
    });
    const deps = readGradleDeps(dir);
    expect(deps.has('io.ktor')).toBe(true);
    expect(deps.has('androidx.room')).toBe(true);
  });

  it('deep-walks submodule build scripts (multi-module)', async () => {
    const dir = await repo({
      'settings.gradle.kts': 'include(":feature:home")',
      'build.gradle.kts': '// root plugins only',
      'feature/home/build.gradle.kts': 'dependencies { implementation("androidx.compose.ui:ui:1.6.0") }',
    });
    const shallow = readGradleDeps(dir);
    const deep = readGradleDepsDeep(dir);
    expect(shallow.has('androidx.compose.ui')).toBe(false); // submodule-only dep missed at root
    expect(deep.has('androidx.compose.ui')).toBe(true); // deep walk finds it
  });
});
