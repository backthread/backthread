// The state-management adapter over a small on-disk app using all four libraries:
// Bloc/Cubit, Provider (ChangeNotifier), Riverpod (Notifier + provider), and GetX.
// Asserts state holders are tagged `service` and the consumption spine (`reads`).

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { extractGraph } from '../../../graph/extract.js';
import { stateAdapter, scoreState } from './state.js';
import type { FrameworkContext } from '../../types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-dart-state-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

async function ctxFor(dir: string): Promise<FrameworkContext> {
  const graph = await extractGraph(dir);
  return {
    repoDir: dir,
    rootPath: '',
    match: { adapter: 'flutter-state', confidence: 0.8, rootPath: '' },
    graph,
    cluster: { fileModuleMap: {}, moduleIds: new Set() },
  };
}

const APP: Record<string, string> = {
  'pubspec.yaml':
    'name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_bloc: ^8.0.0\n  provider: ^6.0.0\n  flutter_riverpod: ^2.0.0\n  get: ^4.0.0\n',
  // Bloc/Cubit
  'lib/counter/counter_cubit.dart': 'class CounterCubit extends Cubit<int> {\n  CounterCubit() : super(0);\n}\n',
  'lib/counter/counter_view.dart':
    "import 'counter_cubit.dart';\nWidget build() => BlocBuilder<CounterCubit, int>(builder: (c, s) => Text('$s'));\n",
  // Provider
  'lib/settings/settings_model.dart': 'class SettingsModel extends ChangeNotifier {\n  bool dark = false;\n}\n',
  'lib/settings/settings_view.dart':
    "import 'settings_model.dart';\nWidget build(context) {\n  final m = context.watch<SettingsModel>();\n  return Text('$m');\n}\n",
  // Riverpod (explicit NotifierProvider)
  'lib/rp/counter_notifier.dart':
    "import 'package:flutter_riverpod/flutter_riverpod.dart';\nclass CounterNotifier extends Notifier<int> {\n  @override\n  int build() => 0;\n}\nfinal counterProvider = NotifierProvider<CounterNotifier, int>(CounterNotifier.new);\n",
  'lib/rp/counter_screen.dart':
    "import 'counter_notifier.dart';\nWidget build(ref) {\n  final n = ref.watch(counterProvider);\n  return Text('$n');\n}\n",
  // GetX (role only, no consumption edge)
  'lib/auth/auth_controller.dart': 'class AuthController extends GetxController {\n  final loggedIn = false;\n}\n',
};

describe('stateAdapter', () => {
  it('detects the state libs', async () => {
    const m = await stateAdapter.detect({ repoDir: await makeRepo(APP) });
    expect(m?.adapter).toBe('flutter-state');
  });

  it('tags every state holder `service` with the right role', async () => {
    const roles = await stateAdapter.roleTags!(await ctxFor(await makeRepo(APP)));
    expect(roles.get('lib/counter/counter_cubit.dart')).toMatchObject({ role: 'cubit', kind: 'service' });
    expect(roles.get('lib/settings/settings_model.dart')).toMatchObject({ role: 'provider', kind: 'service' });
    expect(roles.get('lib/rp/counter_notifier.dart')).toMatchObject({ role: 'notifier', kind: 'service' });
    expect(roles.get('lib/auth/auth_controller.dart')).toMatchObject({ role: 'controller', kind: 'service' });
    // a plain view is not a state holder
    expect(roles.has('lib/counter/counter_view.dart')).toBe(false);
  });

  it('emits `reads` consumption edges for the resolvable forms', async () => {
    const edges = await stateAdapter.syntheticEdges!(await ctxFor(await makeRepo(APP)));
    const keys = new Set(edges.map((e) => `${e.source} -> ${e.target}`));
    // BlocBuilder<CounterCubit>
    expect(keys.has('lib/counter/counter_view.dart -> lib/counter/counter_cubit.dart')).toBe(true);
    // context.watch<SettingsModel>()
    expect(keys.has('lib/settings/settings_view.dart -> lib/settings/settings_model.dart')).toBe(true);
    // ref.watch(counterProvider) → NotifierProvider<CounterNotifier> → CounterNotifier
    expect(keys.has('lib/rp/counter_screen.dart -> lib/rp/counter_notifier.dart')).toBe(true);
    expect(edges.every((e) => e.kind === 'reads')).toBe(true);
  });

  it('resolves a codegen provider name (fooProvider → Foo) heuristically', async () => {
    const dir = await makeRepo({
      'pubspec.yaml': 'name: app\ndependencies:\n  flutter_riverpod: ^2.0.0\n',
      'lib/foo.dart':
        "import 'package:flutter_riverpod/flutter_riverpod.dart';\n@riverpod\nclass Foo extends _\$Foo {\n  @override\n  int build() => 0;\n}\n",
      'lib/foo_view.dart':
        "import 'foo.dart';\nWidget b(WidgetRef ref) {\n  final v = ref.watch(fooProvider);\n  return Text('x');\n}\n",
    });
    const roles = await stateAdapter.roleTags!(await ctxFor(dir));
    expect(roles.get('lib/foo.dart')).toMatchObject({ role: 'notifier', kind: 'service' });
    const edges = await stateAdapter.syntheticEdges!(await ctxFor(dir));
    expect(new Set(edges.map((e) => `${e.source} -> ${e.target}`)).has('lib/foo_view.dart -> lib/foo.dart')).toBe(true);
  });

  it('detects library variants (HydratedCubit) + the `with ChangeNotifier` mixin form', async () => {
    const dir = await makeRepo({
      'pubspec.yaml': 'name: app\ndependencies:\n  flutter_bloc: ^8.0.0\n  provider: ^6.0.0\n  hydrated_bloc: ^9.0.0\n',
      'lib/weather_cubit.dart': 'class WeatherCubit extends HydratedCubit<int> {\n  WeatherCubit() : super(0);\n}\n',
      'lib/store.dart': 'class Store with ChangeNotifier {\n  int count = 0;\n}\n',
    });
    const roles = await stateAdapter.roleTags!(await ctxFor(dir));
    expect(roles.get('lib/weather_cubit.dart')).toMatchObject({ role: 'cubit', kind: 'service' });
    expect(roles.get('lib/store.dart')).toMatchObject({ role: 'provider', kind: 'service' });
  });

  it('is deterministic across runs', async () => {
    const ctx = await ctxFor(await makeRepo(APP));
    const a = await stateAdapter.syntheticEdges!(ctx);
    const b = await stateAdapter.syntheticEdges!(ctx);
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
  });
});

describe('scoreState (pure)', () => {
  it('matches any of the four libs, null on none', () => {
    expect(scoreState({ hasBloc: false, hasProvider: false, hasRiverpod: false, hasGetx: false })).toBeNull();
    expect(scoreState({ hasBloc: true, hasProvider: false, hasRiverpod: false, hasGetx: false })?.adapter).toBe(
      'flutter-state',
    );
  });
});
