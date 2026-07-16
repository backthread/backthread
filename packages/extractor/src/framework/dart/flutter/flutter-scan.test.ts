// The Flutter navigation/app-entry scanners: route-constructor → widget (+ path/name),
// runApp root widget, string nav targets, and dynamic-target counting.

import { describe, it, expect } from '../../../testkit.js';
import { scanRouteConstructions, scanRunAppWidget, scanNamedNavCalls } from './flutter-scan.js';

describe('scanRouteConstructions', () => {
  it('reads a go_router GoRoute path + builder widget', () => {
    const src = `
      final router = GoRouter(routes: [
        GoRoute(path: '/detail', name: 'detail', builder: (context, state) => const DetailScreen()),
        GoRoute(path: '/settings', builder: (c, s) => SettingsPage()),
      ]);`;
    const rc = scanRouteConstructions(src);
    expect(rc).toContainEqual({ ctor: 'GoRoute', widget: 'DetailScreen', path: '/detail', name: 'detail' });
    expect(rc).toContainEqual({ ctor: 'GoRoute', widget: 'SettingsPage', path: '/settings', name: undefined });
  });

  it('reads a MaterialPageRoute builder widget', () => {
    const rc = scanRouteConstructions('MaterialPageRoute(builder: (_) => ProfileScreen())');
    expect(rc[0]).toMatchObject({ ctor: 'MaterialPageRoute', widget: 'ProfileScreen' });
  });

  it('ignores a commented-out route', () => {
    expect(scanRouteConstructions("// GoRoute(builder: (c,s) => Ghost())")).toEqual([]);
  });
});

describe('scanRunAppWidget', () => {
  it('finds the root widget runApp mounts', () => {
    expect(scanRunAppWidget('void main() { runApp(const MyApp()); }')).toBe('MyApp');
    expect(scanRunAppWidget('void main() { runApp(MyApp()); }')).toBe('MyApp');
  });
  it('returns undefined when there is no runApp', () => {
    expect(scanRunAppWidget('void main() {}')).toBeUndefined();
  });
});

describe('scanNamedNavCalls', () => {
  it('captures literal path + named targets, counts dynamic ones', () => {
    const src = `
      onTap: () => context.go('/detail');
      onPressed: () => context.pushNamed('settings');
      Navigator.pushNamed(context, '/profile');
      onLongPress: () => context.go(dynamicRoute);`;
    const { targets, dynamic } = scanNamedNavCalls(src);
    expect(new Set(targets)).toEqual(new Set(['/detail', 'settings', '/profile']));
    expect(dynamic).toBe(1);
  });
});
