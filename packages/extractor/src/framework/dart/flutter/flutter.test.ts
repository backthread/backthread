// The Flutter adapter over a small on-disk go_router-shaped app: widget/app-entry
// roles, the navigation spine (route builder + string nav → widget), feature-folder
// grouping, and detection (root + nested).

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { extractGraph } from '../../../graph/extract.js';
import { flutterAdapter, scoreFlutter } from './flutter.js';
import type { FrameworkContext } from '../../types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-flutter-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

/** Build a FrameworkContext for the adapter hooks from a real extract of `dir`. */
async function ctxFor(dir: string): Promise<FrameworkContext> {
  const graph = await extractGraph(dir);
  return {
    repoDir: dir,
    rootPath: '',
    match: { adapter: 'flutter', confidence: 0.9, rootPath: '' },
    graph,
    cluster: { fileModuleMap: {}, moduleIds: new Set() },
  };
}

const APP: Record<string, string> = {
  'pubspec.yaml':
    'name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\n  go_router: ^13.0.0\n',
  'lib/main.dart': "import 'app.dart';\nvoid main() {\n  runApp(const MyApp());\n}\n",
  'lib/app.dart':
    "import 'package:flutter/material.dart';\nclass MyApp extends StatelessWidget {\n  const MyApp({super.key});\n  @override\n  Widget build(BuildContext context) => Container();\n}\n",
  'lib/router.dart':
    "import 'features/home/home_screen.dart';\nimport 'features/detail/detail_screen.dart';\n" +
    "final router = GoRouter(routes: [\n" +
    "  GoRoute(path: '/', builder: (c, s) => const HomeScreen()),\n" +
    "  GoRoute(path: '/detail', name: 'detail', builder: (c, s) => const DetailScreen()),\n" +
    ']);\n',
  'lib/features/home/home_screen.dart':
    "import 'package:flutter/material.dart';\nclass HomeScreen extends StatelessWidget {\n  void _open(BuildContext context) => context.go('/detail');\n  @override\n  Widget build(BuildContext context) => Container();\n}\n",
  'lib/features/home/home_card.dart':
    "import 'package:flutter/material.dart';\nclass HomeCard extends StatelessWidget {\n  @override\n  Widget build(BuildContext context) => Container();\n}\n",
  'lib/features/detail/detail_screen.dart':
    "import 'package:flutter/material.dart';\nclass DetailScreen extends StatefulWidget {\n  @override\n  State<DetailScreen> createState() => _DetailScreenState();\n}\nclass _DetailScreenState extends State<DetailScreen> {\n  @override\n  Widget build(BuildContext context) => Container();\n}\n",
};

describe('flutterAdapter', () => {
  it('detects the flutter dep', async () => {
    const dir = await makeRepo(APP);
    const m = await flutterAdapter.detect({ repoDir: dir });
    expect(m?.adapter).toBe('flutter');
  });

  it('detects a nested Flutter app under mobile/', async () => {
    const dir = await makeRepo({
      'package.json': '{"name":"server"}',
      'mobile/pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n',
      'mobile/lib/main.dart': 'void main() {}\n',
    });
    const m = await flutterAdapter.detect({ repoDir: dir });
    expect(m?.adapter).toBe('flutter');
    expect(m?.rootPath).toBe('mobile');
  });

  it('tags widgets frontend (screen/component) and the app entry gateway', async () => {
    const roles = await flutterAdapter.roleTags!(await ctxFor(await makeRepo(APP)));
    expect(roles.get('lib/main.dart')).toMatchObject({ role: 'app-entry', kind: 'gateway' });
    expect(roles.get('lib/features/home/home_screen.dart')).toMatchObject({ role: 'screen', kind: 'frontend' });
    expect(roles.get('lib/features/detail/detail_screen.dart')).toMatchObject({ role: 'screen', kind: 'frontend' });
    expect(roles.get('lib/features/home/home_card.dart')).toMatchObject({ role: 'component', kind: 'frontend' });
    expect(roles.get('lib/app.dart')).toMatchObject({ role: 'component', kind: 'frontend' });
  });

  it('emits the navigation spine (route builder + string nav + runApp)', async () => {
    const edges = await flutterAdapter.syntheticEdges!(await ctxFor(await makeRepo(APP)));
    const keys = new Set(edges.map((e) => `${e.source} -> ${e.target}`));
    // GoRoute builder → screen
    expect(keys.has('lib/router.dart -> lib/features/home/home_screen.dart')).toBe(true);
    expect(keys.has('lib/router.dart -> lib/features/detail/detail_screen.dart')).toBe(true);
    // context.go('/detail') resolved through the route table
    expect(keys.has('lib/features/home/home_screen.dart -> lib/features/detail/detail_screen.dart')).toBe(true);
    // runApp(MyApp()) → the app shell
    expect(keys.has('lib/main.dart -> lib/app.dart')).toBe(true);
    // all nav edges are the neutral 'calls' verb
    expect(edges.every((e) => e.kind === 'calls')).toBe(true);
  });

  it('groups a feature folder of ≥2 widgets into a subsystem', async () => {
    const { groups } = await flutterAdapter.groupingPrior!(await ctxFor(await makeRepo(APP)));
    const home = groups.find((g) => g.id === 'home');
    expect(home).toBeDefined();
    expect(home!.fileIds).toEqual([
      'lib/features/home/home_card.dart',
      'lib/features/home/home_screen.dart',
    ]);
    // the lone detail screen doesn't form a singleton group
    expect(groups.find((g) => g.id === 'detail')).toBeUndefined();
  });

  it('is deterministic across runs', async () => {
    const ctx = await ctxFor(await makeRepo(APP));
    const a = await flutterAdapter.syntheticEdges!(ctx);
    const b = await flutterAdapter.syntheticEdges!(ctx);
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
  });
});

describe('scoreFlutter (pure)', () => {
  it('requires the flutter dep', () => {
    expect(scoreFlutter({ hasFlutter: false })).toBeNull();
    expect(scoreFlutter({ hasFlutter: true })?.adapter).toBe('flutter');
  });
});
