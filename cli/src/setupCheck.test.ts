// setupCheck.test.ts — the SessionStart "finish setup" nudge decision.
//
// runSetupCheck is pure over two injected readers (first-run state + config), so no real
// ~/.backthread is touched. We assert the silent-when-set-up rule, the exact
// additionalContext JSON shape when setup is incomplete, and the never-throws posture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSetupCheck, SETUP_NUDGE, type SetupCheckDeps } from './setupCheck.js';

// A deps factory: onboarded + token by default (the silent case); override per test.
function deps(over: Partial<SetupCheckDeps> = {}): SetupCheckDeps {
  return {
    readStateImpl: async () => ({ onboarded: true }),
    readConfigImpl: async () => ({ device_token: 'backthread_pat_x' }),
    ...over,
  };
}

test('fully set up (onboarded + device token) → null (silent)', async () => {
  assert.equal(await runSetupCheck(deps()), null);
});

test('not onboarded → the SessionStart additionalContext JSON', async () => {
  const out = await runSetupCheck(deps({ readStateImpl: async () => ({}) }));
  assert.ok(out, 'a nudge string is returned');
  const parsed = JSON.parse(out!);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(parsed.hookSpecificOutput.additionalContext, SETUP_NUDGE);
  // The model is told the exact command, and house style is respected.
  assert.match(parsed.hookSpecificOutput.additionalContext, /\/backthread:start/);
  assert.doesNotMatch(out!, /architectural memory/i);
});

test('onboarded but NO device token → nudge (the token is half of "set up")', async () => {
  const out = await runSetupCheck(deps({ readConfigImpl: async () => ({}) }));
  assert.ok(out);
  assert.match(out!, /hookSpecificOutput/);
});

test('a reader that throws → null (never throws, stays silent)', async () => {
  const out = await runSetupCheck(
    deps({
      readStateImpl: async () => {
        throw new Error('disk gone');
      },
    }),
  );
  assert.equal(out, null);
});
