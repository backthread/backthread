// — unit tests for the cli's version module: the value it reads from
// package.json and the request-header helper the three request sites use. No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliVersion, versionHeaders, VERSION_HEADER } from './version.js';

test('VERSION_HEADER is the lowercase x-backthread-version contract', () => {
  assert.equal(VERSION_HEADER, 'x-backthread-version');
});

test('cliVersion reads a semver-shaped version from the package (read-only)', () => {
  const v = cliVersion();
  // We don't assert a specific literal (a concurrent build agent owns package.json's
  // version) — just that we read a parseable major.minor.patch, never an empty/crash.
  assert.match(v, /^\d+\.\d+\.\d+/);
});

test('cliVersion is stable across calls (cached)', () => {
  assert.equal(cliVersion(), cliVersion());
});

test('versionHeaders stamps exactly the version header with the cli version', () => {
  const h = versionHeaders();
  assert.deepEqual(Object.keys(h), [VERSION_HEADER]);
  assert.equal(h[VERSION_HEADER], cliVersion());
});
