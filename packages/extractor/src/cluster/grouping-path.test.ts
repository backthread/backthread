// ARP-1423 — the pure namespace-grouping model behind the JVM fix.
import { describe, it, expect } from '../testkit.js';
import {
  commonDir,
  commonPrefixSegments,
  dominantTopSegment,
  leafSegment,
  stripCommonPrefix,
} from './grouping-path.js';

describe('commonPrefixSegments', () => {
  it('finds the shared reverse-DNS prefix', () => {
    expect(
      commonPrefixSegments([
        'ai/luun/investigation/adapter/slack',
        'ai/luun/investigation/adapter/database',
        'ai/luun/investigation/domain/alert',
      ]),
    ).toEqual(['ai', 'luun', 'investigation']);
  });

  it('never swallows a distinguishing segment', () => {
    expect(commonPrefixSegments(['com/a/x', 'com/b/y'])).toEqual(['com']);
    expect(commonPrefixSegments(['com/a', 'org/b'])).toEqual([]);
  });

  it('ignores empty paths rather than letting one veto the prefix', () => {
    // A default-package file declares no namespace, so it cannot constrain what
    // the others share — without this, one such file disables the strip repo-wide.
    expect(commonPrefixSegments(['com/acme/a', '', 'com/acme/b'])).toEqual(['com', 'acme']);
  });

  it('is order-independent (time-slider stability)', () => {
    const paths = ['com/acme/b/x', 'com/acme/a/y', 'com/acme/a/z'];
    expect(commonPrefixSegments(paths)).toEqual(commonPrefixSegments([...paths].reverse()));
  });

  it('returns [] for an empty input', () => {
    expect(commonPrefixSegments([])).toEqual([]);
  });
});

describe('stripCommonPrefix', () => {
  it('leaves the feature packages behind', () => {
    const out = stripCommonPrefix(
      new Map([
        ['A.java', 'ai/luun/investigation/adapter/slack'],
        ['B.java', 'ai/luun/investigation/adapter/database'],
        ['C.java', 'ai/luun/investigation/domain/alert'],
      ]),
    );
    expect(out.get('A.java')).toBe('adapter/slack');
    expect(out.get('B.java')).toBe('adapter/database');
    expect(out.get('C.java')).toBe('domain/alert');
  });

  it('keeps the namespace ROOT for a file whose package IS the prefix', () => {
    // The app-entry class. Falling back to its physical path would put it back on
    // the build source root and leave a stray "Main" box beside the real features.
    const out = stripCommonPrefix(
      new Map([
        ['App.java', 'com/acme/app'],
        ['S.java', 'com/acme/app/orders'],
      ]),
    );
    expect(out.get('App.java')).toBe('app');
    expect(out.get('S.java')).toBe('orders');
  });

  it('yields NOTHING when every file sits in exactly one package (the guard)', () => {
    // The degenerate case: the namespace distinguishes nothing, so grouping by it
    // would collapse the repo into one bucket. Fall back to physical paths instead.
    const out = stripCommonPrefix(
      new Map([
        ['A.java', 'com/acme/app'],
        ['B.java', 'com/acme/app'],
      ]),
    );
    expect(out.size).toBe(0);
  });

  it('drops files with no namespace', () => {
    // The lone namespaced file IS the whole prefix, so — exactly like the
    // one-package repo above — there is nothing left to group by and the caller
    // falls back to physical paths.
    const out = stripCommonPrefix(new Map([['A.java', ''], ['B.java', 'com/acme/x']]));
    expect(out.size).toBe(0);
  });
});

describe('commonDir / leafSegment', () => {
  it('takes the leaf of a module living in one feature package', () => {
    expect(leafSegment(commonDir(['adapter/database', 'adapter/database']))).toBe('database');
  });

  it('falls back to the shared parent across sibling features', () => {
    expect(leafSegment(commonDir(['adapter/database', 'adapter/slack']))).toBe('adapter');
  });

  it('yields null across unrelated roots', () => {
    expect(leafSegment(commonDir(['adapter/db', 'domain/alert']))).toBe(null);
  });
});

describe('dominantTopSegment', () => {
  it('picks the most common top-level segment', () => {
    expect(dominantTopSegment(['adapter/a', 'adapter/b', 'domain/c'])).toBe('adapter');
  });

  it('breaks ties alphabetically, order-independently', () => {
    expect(dominantTopSegment(['zulu/a', 'alpha/b'])).toBe('alpha');
    expect(dominantTopSegment(['alpha/b', 'zulu/a'])).toBe('alpha');
  });

  it('is null with nothing to group by', () => {
    expect(dominantTopSegment([])).toBe(null);
  });
});
