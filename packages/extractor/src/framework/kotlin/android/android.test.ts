// The Android FrameworkAdapter — supertype/@Composable/manifest role tags, feature-folder
// grouping, Intent + Navigation-Compose nav edges, and detection.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  roleFromSupertypes,
  buildFeatureGroups,
  scanNavTargets,
  gatherAndroidSignals,
  scoreAndroid,
  androidAdapter,
} from './android.js';
import { parseAndroidManifest, resolveComponentName } from './android-manifest.js';
import { parseKotlinScope } from '../analyze.js';
import type { FrameworkContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

describe('roleFromSupertypes', () => {
  it('maps Android base classes onto roles', () => {
    expect(roleFromSupertypes(['ComponentActivity'])).toBe('activity');
    expect(roleFromSupertypes(['AppCompatActivity'])).toBe('activity');
    expect(roleFromSupertypes(['Fragment'])).toBe('fragment');
    expect(roleFromSupertypes(['BaseViewModel', 'ViewModel'])).toBe('view-model');
    expect(roleFromSupertypes(['CoroutineWorker'])).toBe('worker');
    expect(roleFromSupertypes(['IntentService'])).toBe('service');
    expect(roleFromSupertypes(['BroadcastReceiver'])).toBe('receiver');
    expect(roleFromSupertypes(['ContentProvider'])).toBe('provider');
    expect(roleFromSupertypes(['View'])).toBe('view');
  });
  it('does NOT mislabel a domain *Service that extends no Android base', () => {
    expect(roleFromSupertypes(['UserRepository'])).toBeUndefined();
    expect(roleFromSupertypes([])).toBeUndefined();
  });
});

describe('parseAndroidManifest', () => {
  it('reads components + resolves names against the manifest package', () => {
    const xml = [
      '<manifest package="com.example.app">',
      '  <application>',
      '    <activity android:name=".MainActivity" android:exported="true" />',
      '    <service android:name="com.other.SyncService" />',
      '    <receiver android:name="BootReceiver" />',
      '    <provider android:name=".data.FilesProvider" />',
      '  </application>',
      '</manifest>',
    ].join('\n');
    const comps = parseAndroidManifest(xml);
    expect(comps).toContainEqual({ tag: 'activity', fqn: 'com.example.app.MainActivity', simpleName: 'MainActivity' });
    expect(comps).toContainEqual({ tag: 'service', fqn: 'com.other.SyncService', simpleName: 'SyncService' });
    expect(comps).toContainEqual({ tag: 'receiver', fqn: 'com.example.app.BootReceiver', simpleName: 'BootReceiver' });
    expect(comps).toContainEqual({ tag: 'provider', fqn: 'com.example.app.data.FilesProvider', simpleName: 'FilesProvider' });
  });
  it('falls back to simple name when the manifest has no package (modern AGP namespace)', () => {
    const c = resolveComponentName('activity', '.HomeActivity', undefined);
    expect(c.fqn).toBe('');
    expect(c.simpleName).toBe('HomeActivity');
  });
});

describe('buildFeatureGroups', () => {
  it('groups by feature/<name>/ directory', () => {
    const files = [
      'app/src/main/kotlin/com/x/feature/home/HomeScreen.kt',
      'app/src/main/kotlin/com/x/feature/home/HomeViewModel.kt',
      'app/src/main/kotlin/com/x/feature/detail/DetailScreen.kt',
      'app/src/main/kotlin/com/x/feature/detail/DetailViewModel.kt',
      'app/src/main/kotlin/com/x/core/Util.kt',
    ];
    const groups = buildFeatureGroups(files);
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get('home')?.fileIds.length).toBe(2);
    expect(byId.get('detail')?.label).toBe('Detail');
    expect(byId.has('core')).toBe(false); // not under a feature/ segment
  });
});

describe('detection', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-android-'));
    dirs.push(dir);
    for (const [rel, c] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, c);
    }
    return dir;
  }

  it('detects via androidx deps', async () => {
    const dir = await repo({
      'build.gradle.kts': 'dependencies { implementation("androidx.core:core-ktx:1.12.0") }',
    });
    expect(gatherAndroidSignals(dir).hasAndroidx).toBe(true);
    expect(scoreAndroid(gatherAndroidSignals(dir))).not.toBeNull();
  });
  it('detects via an AndroidManifest.xml', async () => {
    const dir = await repo({
      'build.gradle': '// no deps',
      'app/src/main/AndroidManifest.xml': '<manifest package="com.x"><application/></manifest>',
    });
    expect(gatherAndroidSignals(dir).hasManifest).toBe(true);
  });
  it('does NOT detect a plain (non-Android) Gradle repo', () => {
    expect(scoreAndroid({ hasAndroidx: false, hasManifest: false })).toBeNull();
  });
});

describe('roleTags + nav edges (integration)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'bt-android-int-'));
    dirs.push(dir);
    for (const [rel, c] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, c);
    }
    return dir;
  }
  function ctx(repoDir: string, files: Array<[string, string]>): FrameworkContext {
    const graph: NormalizedGraph = {
      root: repoDir,
      files: files.map(([id]) => ({ id, loc: 5, language: 'kt' })),
      edges: [],
      externals: [],
    };
    return {
      repoDir,
      rootPath: '',
      match: { adapter: 'android', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set() },
    };
  }

  it('tags activities/composables frontend, ViewModels service, workers job', async () => {
    const files: Array<[string, string]> = [
      ['app/src/main/kotlin/com/x/MainActivity.kt', 'package com.x\nimport androidx.activity.ComponentActivity\nclass MainActivity : ComponentActivity()'],
      ['app/src/main/kotlin/com/x/HomeScreen.kt', 'package com.x\nimport androidx.compose.runtime.Composable\n@Composable\nfun HomeScreen() {}'],
      ['app/src/main/kotlin/com/x/HomeViewModel.kt', 'package com.x\nimport androidx.lifecycle.ViewModel\nclass HomeViewModel : ViewModel()'],
      ['app/src/main/kotlin/com/x/SyncWorker.kt', 'package com.x\nimport androidx.work.CoroutineWorker\nclass SyncWorker : CoroutineWorker(a, b)'],
    ];
    const dir = await repo(Object.fromEntries(files));
    const roles = await androidAdapter.roleTags!(ctx(dir, files));
    expect(roles.get('app/src/main/kotlin/com/x/MainActivity.kt')?.kind).toBe('frontend');
    expect(roles.get('app/src/main/kotlin/com/x/HomeScreen.kt')?.role).toBe('composable');
    expect(roles.get('app/src/main/kotlin/com/x/HomeScreen.kt')?.kind).toBe('frontend');
    expect(roles.get('app/src/main/kotlin/com/x/HomeViewModel.kt')?.kind).toBe('service');
    expect(roles.get('app/src/main/kotlin/com/x/SyncWorker.kt')?.kind).toBe('job');
    expect(roles.get('app/src/main/kotlin/com/x/SyncWorker.kt')?.role).toBe('worker');
  });

  it('emits an Intent launch nav edge', async () => {
    const files: Array<[string, string]> = [
      ['a/Home.kt', 'package com.x\nimport android.content.Intent\nclass HomeActivity {\n  fun open() { startActivity(Intent(this, DetailActivity::class.java)) }\n}'],
      ['a/Detail.kt', 'package com.x\nclass DetailActivity'],
    ];
    const dir = await repo(Object.fromEntries(files));
    const edges = await androidAdapter.syntheticEdges!(ctx(dir, files));
    expect(edges).toContainEqual(
      expect.objectContaining({ source: 'a/Home.kt', target: 'a/Detail.kt', kind: 'calls' }),
    );
  });

  it('emits a Navigation-Compose route destination edge', async () => {
    const files: Array<[string, string]> = [
      ['a/Nav.kt', 'package com.x\nfun graph() {\n  composable("home") {\n    HomeRoute()\n  }\n}'],
      ['a/HomeRoute.kt', 'package com.x\nimport androidx.compose.runtime.Composable\n@Composable\nfun HomeRoute() {}'],
    ];
    const dir = await repo(Object.fromEntries(files));
    const scope = parseKotlinScope(ctx(dir, files));
    const nav = scanNavTargets(scope.parsed.get('a/Nav.kt')!, scope);
    expect(nav.edges.map((e) => e.target)).toContain('a/HomeRoute.kt');
  });

  it('resolves a SINGLE-LINE composable route destination', async () => {
    const files: Array<[string, string]> = [
      ['a/Nav.kt', 'package com.x\nfun graph() { composable("home") { HomeRoute() } }'],
      ['a/HomeRoute.kt', 'package com.x\nimport androidx.compose.runtime.Composable\n@Composable\nfun HomeRoute() {}'],
    ];
    const dir = await repo(Object.fromEntries(files));
    const scope = parseKotlinScope(ctx(dir, files));
    const nav = scanNavTargets(scope.parsed.get('a/Nav.kt')!, scope);
    expect(nav.edges.map((e) => e.target)).toContain('a/HomeRoute.kt');
  });
});
