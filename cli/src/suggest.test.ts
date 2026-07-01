// suggest.test.ts — the "did you mean …?" nearest-command matcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, nearestCommand } from './suggest.js';

const COMMANDS = ['start', 'login', 'logout', 'whoami', 'how', 'ask', 'capture', 'mcp', 'install', 'version', 'help'];

test('editDistance is the classic Levenshtein metric', () => {
  assert.equal(editDistance('', ''), 0);
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('abc', ''), 3);
  assert.equal(editDistance('lgoin', 'login'), 2); // two transposed letters → 2 subs
  assert.equal(editDistance('instal', 'install'), 1); // one dropped letter
  assert.equal(editDistance('kitten', 'sitting'), 3); // textbook example
});

test('nearestCommand suggests the obvious typo', () => {
  assert.equal(nearestCommand('lgoin', COMMANDS), 'login');
  assert.equal(nearestCommand('instal', COMMANDS), 'install');
  assert.equal(nearestCommand('verison', COMMANDS), 'version');
  assert.equal(nearestCommand('logot', COMMANDS), 'logout');
  assert.equal(nearestCommand('captur', COMMANDS), 'capture');
});

test('nearestCommand is case-insensitive', () => {
  assert.equal(nearestCommand('LOGIN', COMMANDS), 'login');
  assert.equal(nearestCommand('Instal', COMMANDS), 'install');
});

test('nearestCommand returns null when nothing is close', () => {
  assert.equal(nearestCommand('frobnicate', COMMANDS), null);
  assert.equal(nearestCommand('xyzzy', COMMANDS), null);
  assert.equal(nearestCommand('', COMMANDS), null);
});

test('nearestCommand will not match a short typo to an unrelated same-length command', () => {
  // 'xyz' is length 3; every distance to a real command is >= 3 (== len), so no match —
  // guards against "did you mean how?" for a totally unrelated 3-letter string.
  assert.equal(nearestCommand('xyz', COMMANDS), null);
});

test('nearestCommand is deterministic under ties (shortest, then alphabetical)', () => {
  // Two candidates equally near (distance 1) but different length → the shorter wins,
  // regardless of listing order ('cats' before 'car').
  assert.equal(nearestCommand('cat', ['cats', 'car']), 'car');
  // Same length + same distance → alphabetical. 'aa' is distance 1 from both 'ab' and 'ba'.
  assert.equal(nearestCommand('aa', ['ba', 'ab']), 'ab');
});
