// Pure PSR-4 namespace↔path resolution — the PHP Zeitwerk analogue.

import { describe, it, expect } from '../testkit.js';
import {
  parsePsr4Map,
  resolveFqnToFile,
  normalizeFqn,
  parsePsr0Map,
  resolvePsr0ToFile,
  resolveAutoload,
} from './php-psr4.js';

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

describe('parsePsr0Map', () => {
  it('reads autoload + autoload-dev psr-0, longest-prefix first, prefix verbatim', () => {
    const entries = parsePsr0Map({
      autoload: { 'psr-0': { 'App\\': 'lib/', 'Twig_': 'vendor-src/' } },
      'autoload-dev': { 'psr-0': { 'Test_': 'tests/' } },
    });
    // Longest prefix first; equal-length prefixes tiebreak lexically (Test_ < Twig_);
    // underscore-style prefixes kept verbatim (no forced `\`).
    expect(entries.map((e) => e.prefix)).toEqual(['Test_', 'Twig_', 'App\\']);
    expect(entries.find((e) => e.prefix === 'App\\')?.baseDirs).toEqual(['lib']);
  });

  it('never throws on a malformed manifest', () => {
    expect(parsePsr0Map(null)).toEqual([]);
    expect(parsePsr0Map({ autoload: { 'psr-0': { 'App\\': 42 } } })).toEqual([]);
  });
});

describe('resolvePsr0ToFile', () => {
  it('places the FULL namespace under the base dir (prefix NOT stripped)', () => {
    const entries = parsePsr0Map({ autoload: { 'psr-0': { 'App\\': 'lib/' } } });
    const fileset = new Set(['lib/App/Models/User.php']);
    // Unlike PSR-4, App\ is not stripped → lib/App/Models/User.php.
    expect(resolvePsr0ToFile('App\\Models\\User', entries, fileset)).toBe('lib/App/Models/User.php');
  });

  it('converts underscores in the CLASS NAME to separators (the legacy quirk)', () => {
    const entries = parsePsr0Map({ autoload: { 'psr-0': { 'Twig_': 'src/' } } });
    const fileset = new Set(['src/Twig/Environment.php']);
    // Twig_Environment → src/Twig/Environment.php (underscores → dirs).
    expect(resolvePsr0ToFile('Twig_Environment', entries, fileset)).toBe('src/Twig/Environment.php');
  });

  it('keeps namespace underscores but splits class-name underscores', () => {
    const entries = parsePsr0Map({ autoload: { 'psr-0': { '': 'src/' } } });
    const fileset = new Set(['src/Vendor_Ns/My/Class.php']);
    // Namespace `Vendor_Ns` keeps its underscore (only `\`→`/`); the trailing class
    // name `My_Class` splits on `_` → My/Class.php (the PSR-0 legacy quirk).
    expect(resolvePsr0ToFile('Vendor_Ns\\My_Class', entries, fileset)).toBe('src/Vendor_Ns/My/Class.php');
  });

  it('returns undefined for an unmapped prefix or missing file', () => {
    const entries = parsePsr0Map({ autoload: { 'psr-0': { 'App\\': 'lib/' } } });
    expect(resolvePsr0ToFile('Other\\Thing', entries, new Set(['lib/App/X.php']))).toBeUndefined();
  });
});

describe('resolveAutoload', () => {
  const psr4 = parsePsr4Map({ autoload: { 'psr-4': { 'App\\': 'app/' } } });
  const psr0 = parsePsr0Map({ autoload: { 'psr-0': { 'Legacy\\': 'lib/' } } });

  it('tries PSR-4 first, then PSR-0, then the class index', () => {
    const fileset = new Set([
      'app/Models/User.php', // PSR-4
      'lib/Legacy/Thing.php', // PSR-0
      'weird/place/Orphan.php', // classmap-only (not at any conventional path)
    ]);
    const classIndex = new Map([['Vendor\\Orphan', 'weird/place/Orphan.php']]);
    expect(resolveAutoload('App\\Models\\User', psr4, psr0, fileset, classIndex)).toBe('app/Models/User.php');
    expect(resolveAutoload('Legacy\\Thing', psr4, psr0, fileset, classIndex)).toBe('lib/Legacy/Thing.php');
    // Neither PSR-4 nor PSR-0 maps it — the declared-class index catches it.
    expect(resolveAutoload('Vendor\\Orphan', psr4, psr0, fileset, classIndex)).toBe('weird/place/Orphan.php');
  });

  it('normalizes a leading separator against the class index', () => {
    const classIndex = new Map([['Vendor\\Orphan', 'weird/place/Orphan.php']]);
    expect(resolveAutoload('\\Vendor\\Orphan', psr4, psr0, new Set(), classIndex)).toBe('weird/place/Orphan.php');
  });

  it('returns undefined for a vendor class none of the strategies map', () => {
    expect(resolveAutoload('Symfony\\Component\\Foo', psr4, psr0, new Set(), new Map())).toBeUndefined();
  });
});
