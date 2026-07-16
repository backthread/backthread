// The state-consumption scanners: type-arg consumers (Bloc/Provider), Riverpod
// provider declarations, and ref.watch reads (+ dynamic counting).

import { describe, it, expect } from '../../../testkit.js';
import { scanTypeArgConsumers, scanProviderDecls, scanRefReads } from './state-scan.js';

describe('scanTypeArgConsumers', () => {
  it('reads the state-holder class from bloc + provider type args', () => {
    const src = `
      BlocBuilder<CounterCubit, int>(builder: (c, s) => Text('$s'));
      BlocSelector<WeatherBloc, WeatherState, Temp>(selector: (s) => s.temp);
      Consumer<SettingsModel>(builder: (c, m, _) => Text(m.name));
      final v = context.watch<ThemeModel>();
      final t = Provider.of<AuthModel>(context);`;
    expect(scanTypeArgConsumers(src)).toEqual([
      'CounterCubit',
      'WeatherBloc',
      'SettingsModel',
      'ThemeModel',
      'AuthModel',
    ]);
  });
  it('ignores a commented-out consumer', () => {
    expect(scanTypeArgConsumers('// BlocBuilder<Ghost, int>()')).toEqual([]);
  });
});

describe('scanProviderDecls', () => {
  it('binds a provider var to its notifier type arg', () => {
    const decls = scanProviderDecls(
      'final counterProvider = NotifierProvider<CounterNotifier, int>(CounterNotifier.new);',
    );
    expect(decls).toEqual([{ providerVar: 'counterProvider', notifierClass: 'CounterNotifier' }]);
  });
  it('falls back to a create-closure class when there is no type arg', () => {
    const decls = scanProviderDecls('final authProvider = ChangeNotifierProvider((ref) => AuthModel());');
    expect(decls[0]).toMatchObject({ providerVar: 'authProvider', notifierClass: 'AuthModel' });
  });
});

describe('scanRefReads', () => {
  it('captures provider vars (incl. a `.select` head) and counts non-identifier reads', () => {
    const src = `
      final count = ref.watch(counterProvider);
      ref.listen(authProvider, (a, b) {});
      final x = ref.watch(userProvider.select((u) => u.name));
      final y = ref.watch(MyProviders.counter);`;
    const { providerVars, dynamic } = scanRefReads(src);
    // a leading lowercase identifier is captured (resolved/logged later); a
    // non-identifier target (`MyProviders.counter`) is a dynamic read.
    expect(providerVars).toEqual(['counterProvider', 'authProvider', 'userProvider']);
    expect(dynamic).toBe(1);
  });
});
