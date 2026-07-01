// npm.test.ts — the shared Windows-safe npm spawn. We don't hit the real registry; we run a
// cheap, deterministic npm subcommand (`npm help`... no — that can be slow/networky). Instead
// we assert the never-throws contract on a guaranteed-failing invocation, which exercises the
// error path without a network dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNpm } from './npm.js';

test('runNpm resolves (never throws) on a bogus subcommand', async () => {
  // A subcommand npm doesn't know → non-zero exit + stderr, but a resolved value, not a throw.
  const res = await runNpm(['this-is-not-a-real-npm-subcommand-xyzzy']);
  assert.equal(typeof res.ok, 'boolean');
  assert.equal(res.ok, false);
  assert.equal(typeof res.stdout, 'string');
  assert.equal(typeof res.stderr, 'string');
});
