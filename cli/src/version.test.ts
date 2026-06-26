// version.test.ts — unit tests for the cli's version + operational-metadata header
// module: the values it reads (cli version, redact version, platform, node major) and
// the shared header builder every request site uses. No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cliVersion,
  redactVersion,
  platformTag,
  nodeMajor,
  setRequestAgent,
  currentAgent,
  versionHeaders,
  VERSION_HEADER,
  AGENT_HEADER,
  REDACT_VERSION_HEADER,
  PLATFORM_HEADER,
  NODE_HEADER,
} from './version.js';

test('header name constants are the lowercase x-backthread-* contract', () => {
  assert.equal(VERSION_HEADER, 'x-backthread-version');
  assert.equal(AGENT_HEADER, 'x-backthread-agent');
  assert.equal(REDACT_VERSION_HEADER, 'x-backthread-redact-version');
  assert.equal(PLATFORM_HEADER, 'x-backthread-platform');
  assert.equal(NODE_HEADER, 'x-backthread-node');
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

test('redactVersion resolves the REAL @backthread/redact version (dev disk fallback)', () => {
  const v = redactVersion();
  // In dev/tsx the build-time inline is absent, so this exercises the disk walk-up.
  // It must resolve the real workspace version — NOT the '0.0.0' ultimate fallback.
  assert.match(v, /^\d+\.\d+\.\d+/);
  assert.notEqual(v, '0.0.0', 'the disk fallback must find the real redact package.json');
  assert.equal(redactVersion(), v, 'cached');
});

test('platformTag is process.platform', () => {
  assert.equal(platformTag(), process.platform);
});

test('nodeMajor is the integer major of process.versions.node', () => {
  assert.equal(nodeMajor(), process.versions.node.split('.')[0]);
  assert.match(nodeMajor(), /^\d+$/);
});

test('the agent register defaults to "unknown" and ignores blank sets', () => {
  // Asserted BEFORE any real set below — the register is module-level state.
  assert.equal(currentAgent(), 'unknown');
  setRequestAgent('');
  setRequestAgent('   ');
  setRequestAgent(undefined);
  setRequestAgent(null);
  assert.equal(currentAgent(), 'unknown', 'blank/absent sets are no-ops');
});

test('setRequestAgent records + trims the provider, reflected in versionHeaders', () => {
  setRequestAgent('  cursor  ');
  assert.equal(currentAgent(), 'cursor');
  assert.equal(versionHeaders()[AGENT_HEADER], 'cursor');
});

test('versionHeaders stamps all five operational-metadata headers', () => {
  setRequestAgent('claude-code');
  const h = versionHeaders();
  assert.deepEqual(
    Object.keys(h).sort(),
    [AGENT_HEADER, NODE_HEADER, PLATFORM_HEADER, REDACT_VERSION_HEADER, VERSION_HEADER].sort(),
  );
  assert.equal(h[VERSION_HEADER], cliVersion());
  assert.equal(h[AGENT_HEADER], 'claude-code');
  assert.equal(h[REDACT_VERSION_HEADER], redactVersion());
  assert.equal(h[PLATFORM_HEADER], process.platform);
  assert.equal(h[NODE_HEADER], process.versions.node.split('.')[0]);
  // No empty values — the server tolerates absence, but we never stamp a blank.
  for (const v of Object.values(h)) assert.ok(v.length > 0);
});
