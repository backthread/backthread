// (Slice 1) — convention-agnostic route-tree resolver tests.
// `buildHrefResolver` + `normalizeHref` are pure; cover the bracket dynamic-
// segment matching (`[param]` / `[...rest]`) shared by Expo Router + Next.

import { describe, it, expect } from '../../testkit.js';
import { buildHrefResolver, normalizeHref, ROUTE_ROLES, type RouteNode } from './route-tree.js';

describe('normalizeHref', () => {
  it('keeps absolute hrefs, strips query + hash + trailing slash', () => {
    expect(normalizeHref('/profile/42')).toBe('/profile/42');
    expect(normalizeHref('/profile/42?tab=a#x')).toBe('/profile/42');
    expect(normalizeHref('/settings/')).toBe('/settings');
    expect(normalizeHref('/')).toBe('/');
    expect(normalizeHref('//a//b')).toBe('/a/b');
  });

  it('returns null for relative / bare / empty hrefs (deferred, logged + skipped)', () => {
    expect(normalizeHref('./x')).toBeNull();
    expect(normalizeHref('../x')).toBeNull();
    expect(normalizeHref('profile')).toBeNull();
    expect(normalizeHref('   ')).toBeNull();
  });
});

describe('buildHrefResolver', () => {
  const routes: RouteNode[] = [
    { routePath: '/', fileId: 'app/index.tsx', role: 'page' },
    { routePath: '/home', fileId: 'app/(tabs)/home.tsx', role: 'page' },
    { routePath: '/profile/[id]', fileId: 'app/profile/[id].tsx', role: 'page' },
    { routePath: '/blog/[...slug]', fileId: 'app/blog/[...slug].tsx', role: 'page' },
    { routePath: '/hello', fileId: 'app/hello+api.ts', role: 'endpoint' }, // NOT navigable
    { routePath: '/', fileId: 'app/_layout.tsx', role: 'layout' }, // NOT navigable
  ];
  const resolve = buildHrefResolver(routes);

  it('resolves an exact static path to its page (not a layout sharing the path)', () => {
    expect(resolve('/')).toBe('app/index.tsx');
    expect(resolve('/home')).toBe('app/(tabs)/home.tsx');
  });

  it('resolves a concrete value to a dynamic [param] route', () => {
    expect(resolve('/profile/42')).toBe('app/profile/[id].tsx');
  });

  it('resolves a literal bracket href to the dynamic route exactly', () => {
    expect(resolve('/profile/[id]')).toBe('app/profile/[id].tsx');
  });

  it('resolves multi-segment values to a catch-all [...slug] route', () => {
    expect(resolve('/blog/2026/06/post')).toBe('app/blog/[...slug].tsx');
    expect(resolve('/blog/x')).toBe('app/blog/[...slug].tsx');
  });

  it('never resolves to an endpoint or a layout (only page/route are navigable)', () => {
    // /hello is an endpoint → not a Link target.
    expect(resolve('/hello')).toBeNull();
  });

  it('returns null for an unmatched path + relative href', () => {
    expect(resolve('/does/not/exist')).toBeNull();
    expect(resolve('./relative')).toBeNull();
  });

  it('the role enum is exactly route/page/layout/endpoint', () => {
    expect([...ROUTE_ROLES].sort()).toEqual(['endpoint', 'layout', 'page', 'route']);
  });
});
