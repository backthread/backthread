// browser.test.ts — the platform→launcher mapping. Pure (no spawn), so we can assert the
// security-relevant invariant without opening anything: the URL always rides as its own
// argv element through a DIRECT executable — never a shell (ARP-796).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserCommand } from './browser.js';

test('darwin → open, no prefix args', () => {
  assert.deepEqual(browserCommand('darwin'), { cmd: 'open', prefixArgs: [] });
});

test('linux → xdg-open, no prefix args', () => {
  assert.deepEqual(browserCommand('linux'), { cmd: 'xdg-open', prefixArgs: [] });
});

test('win32 → rundll32 FileProtocolHandler (NOT cmd — no shell in the URL-open path)', () => {
  const win = browserCommand('win32');
  assert.deepEqual(win, { cmd: 'rundll32', prefixArgs: ['url.dll,FileProtocolHandler'] });
  // Regression guard: never route the URL back through cmd.exe (it re-parses `&`/`%…`).
  assert.notEqual(win?.cmd, 'cmd', 'Windows must not open URLs via the cmd shell');
});

test('an unknown platform still resolves to a direct launcher (default xdg-open)', () => {
  // browserCommand never returns null for the platforms Node reports; the default arm is
  // xdg-open. This documents that the URL is never handed to a shell on any arm.
  const cmds = (['darwin', 'linux', 'win32', 'freebsd', 'openbsd'] as NodeJS.Platform[]).map((p) => browserCommand(p)?.cmd);
  assert.ok(!cmds.includes('cmd'), 'no arm opens URLs through cmd.exe');
  assert.ok(!cmds.includes('sh'), 'no arm opens URLs through a POSIX shell');
});

// NEGATIVE CONTROL — a deliberate TYPE error in a test-only file. Breaks Typecheck
// (tsconfig.test.json includes it), not the tests (tsx strips types), not the bundle.
const negativeControlTypeError: number = 'not a number';
void negativeControlTypeError;
