// Pure PSR-4 namespace↔path resolution — the PHP Zeitwerk analogue.

import { describe, it, expect } from '../testkit.js';
import { parsePsr4Map, resolveFqnToFile, normalizeFqn } from './php-psr4.js';

describe('parsePsr4Map', () => {
  it('reads autoload + autoload-dev psr-4, longest-prefix first', () => {
    const entries = parsePsr4Map({
      autoload: { 'psr-4': { 'App\\': 'app/', 'Database\\Factories\\': 'database/factories/' } },
      'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } },
    });
    // Longest prefix first (Database\Factories\ before App\).
    expect(entries.map((e) => e.prefix)).toEqual(['Database\\Factories\\', 'Tests\\', 'App\\']);
    expect(entries.find((e) => e.prefix === 'App\\')?.baseDirs).toEqual(['app']);
  });

  it('accepts an array of base dirs and normalizes trailing slashes', () => {
    const entries = parsePsr4Map({ autoload: { 'psr-4': { 'App\\': ['app/', 'src'] } } });
    expect(entries[0].baseDirs).toEqual(['app', 'src']);
  });

  it('handles the empty-prefix fallback root', () => {
    const entries = parsePsr4Map({ autoload: { 'psr-4': { '': 'src/' } } });
    expect(entries).toEqual([{ prefix: '', baseDirs: ['src'] }]);
  });

  it('never throws on a malformed manifest', () => {
    expect(parsePsr4Map(null)).toEqual([]);
    expect(parsePsr4Map({ autoload: 'nope' })).toEqual([]);
    expect(parsePsr4Map({ autoload: { 'psr-4': { 'App\\': 42 } } })).toEqual([]);
  });
});

describe('resolveFqnToFile', () => {
  const entries = parsePsr4Map({
    autoload: { 'psr-4': { 'App\\': 'app/', 'App\\Support\\': 'lib/support/' } },
  });
  const fileset = new Set([
    'app/Models/User.php',
    'app/Http/Controllers/UserController.php',
    'lib/support/Helper.php',
  ]);

  it('resolves an FQN under the longest matching prefix', () => {
    expect(resolveFqnToFile('App\\Models\\User', entries, fileset)).toBe('app/Models/User.php');
    expect(resolveFqnToFile('App\\Http\\Controllers\\UserController', entries, fileset)).toBe(
      'app/Http/Controllers/UserController.php',
    );
    // The more specific App\Support\ prefix (base lib/support/) wins over App\.
    expect(resolveFqnToFile('App\\Support\\Helper', entries, fileset)).toBe('lib/support/Helper.php');
  });

  it('strips a leading namespace separator (absolute FQN)', () => {
    expect(resolveFqnToFile('\\App\\Models\\User', entries, fileset)).toBe('app/Models/User.php');
  });

  it('returns undefined for an unmapped namespace or missing file', () => {
    expect(resolveFqnToFile('Symfony\\Component\\Routing\\Route', entries, fileset)).toBeUndefined();
    expect(resolveFqnToFile('App\\Models\\Missing', entries, fileset)).toBeUndefined();
  });

  it('supports the empty-prefix root and several base dirs', () => {
    const rootEntries = parsePsr4Map({ autoload: { 'psr-4': { '': ['src/', 'lib/'] } } });
    const fs2 = new Set(['lib/Foo/Bar.php']);
    expect(resolveFqnToFile('Foo\\Bar', rootEntries, fs2)).toBe('lib/Foo/Bar.php');
  });
});

describe('normalizeFqn', () => {
  it('strips leading namespace separators', () => {
    expect(normalizeFqn('\\App\\Foo')).toBe('App\\Foo');
    expect(normalizeFqn('App\\Foo')).toBe('App\\Foo');
  });
});
