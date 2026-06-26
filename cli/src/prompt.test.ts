// prompt.test.ts — the yes/no prompt + its load-bearing TTY guard.
//
// Drives readline over in-memory PassThrough streams (with .isTTY toggled) so no real
// stdin/terminal is touched. The interactive tests carry a timeout so a regression that
// reintroduces a hang fails FAST instead of stalling the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { promptYesNo } from './prompt.js';

type FakeStream = PassThrough & { isTTY?: boolean };

function streams(isTTY: boolean): { input: FakeStream; output: FakeStream } {
  const input = new PassThrough() as FakeStream;
  const output = new PassThrough() as FakeStream;
  input.isTTY = isTTY;
  output.isTTY = isTTY;
  return { input, output };
}

// --- the TTY guard (the whole point) -----------------------------------------

test('non-TTY resolves the default WITHOUT prompting or reading stdin (never hangs)', async () => {
  const { input, output } = streams(false);
  assert.equal(await promptYesNo('Wire it? [Y/n] ', { input, output, defaultAnswer: false }), false);
  assert.equal(await promptYesNo('Wire it? [Y/n] ', { input, output, defaultAnswer: true }), true);
  // Nothing was prompted — the question never reached output.
  assert.equal(output.read(), null, 'no prompt is written on a non-TTY');
});

test('default defaultAnswer is false (safe non-interactive answer)', async () => {
  const { input, output } = streams(false);
  assert.equal(await promptYesNo('q? ', { input, output }), false);
});

// --- the interactive TTY path ------------------------------------------------

test('TTY: empty input returns the default', { timeout: 5000 }, async () => {
  const { input, output } = streams(true);
  const p = promptYesNo('Wire it? [Y/n] ', { input, output, defaultAnswer: true });
  input.write('\n');
  assert.equal(await p, true);
});

test('TTY: y / yes (any case) → true', { timeout: 5000 }, async () => {
  for (const ans of ['y', 'Y', 'yes', 'YES']) {
    const { input, output } = streams(true);
    const p = promptYesNo('q ', { input, output, defaultAnswer: false });
    input.write(ans + '\n');
    assert.equal(await p, true, `"${ans}" → true`);
  }
});

test('TTY: n / no / anything-else → false (even when default is yes)', { timeout: 5000 }, async () => {
  for (const ans of ['n', 'no', 'nope', 'x']) {
    const { input, output } = streams(true);
    const p = promptYesNo('q ', { input, output, defaultAnswer: true });
    input.write(ans + '\n');
    assert.equal(await p, false, `"${ans}" → false`);
  }
});
