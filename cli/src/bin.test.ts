import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, runOnboarding } from './bin/backthread.js';

// GUARDRAIL: these tests cover the COMMAND DISPATCH only — which subcommand routes
// where. They inject a fake onboarding runner (runOnboardingImpl) so a bare
// `backthread` / `backthread start` never touches real auth, a browser, or the
// network. The help/unknown paths only console.log, so they're driven directly.

/** Capture console.log + console.error for the duration of `fn`, restoring after. */
async function captureConsole(fn: () => Promise<unknown>): Promise<{ out: string; err: string; result: unknown }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  try {
    const result = await fn();
    return { out: out.join('\n'), err: err.join('\n'), result };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

/** A spy onboarding runner: records the args it was called with, returns a fixed code. */
function onboardingSpy(code = 0) {
  const calls: string[][] = [];
  const impl = async (rest: string[]) => {
    calls.push(rest);
    return code;
  };
  return { calls, impl };
}

// --- bare invocation → onboarding (the headline AC) --------------------------

test('bare `backthread` (no subcommand) routes to onboarding, NOT help', async () => {
  const spy = onboardingSpy(0);
  const { out, result } = await captureConsole(() => main([], { runOnboardingImpl: spy.impl }));
  assert.equal(result, 0, 'returns the onboarding exit code');
  assert.equal(spy.calls.length, 1, 'onboarding ran exactly once');
  assert.deepEqual(spy.calls[0], [], 'no extra args forwarded');
  // It must NOT have printed the usage block (that would be the old help fall-through).
  assert.doesNotMatch(out, /Usage:/);
});

test('bare `backthread` forwards flags (e.g. --claim) to onboarding', async () => {
  const spy = onboardingSpy(0);
  await captureConsole(() => main(['--claim', 'backthread_claim_x'], { runOnboardingImpl: spy.impl }));
  assert.deepEqual(spy.calls[0], ['--claim', 'backthread_claim_x']);
});

test('bare invocation propagates a non-zero onboarding exit code (e.g. auth failure)', async () => {
  const spy = onboardingSpy(1);
  const { result } = await captureConsole(() => main([], { runOnboardingImpl: spy.impl }));
  assert.equal(result, 1);
});

// --- `start` shares the exact same onboarding path ---------------------------

test('`backthread start` routes to the SAME onboarding runner as the bare command', async () => {
  const spy = onboardingSpy(0);
  await captureConsole(() => main(['start'], { runOnboardingImpl: spy.impl }));
  assert.equal(spy.calls.length, 1, '`start` also goes through onboarding');
  assert.deepEqual(spy.calls[0], []);
});

test('`backthread start --claim <code>` forwards the claim through onboarding', async () => {
  const spy = onboardingSpy(0);
  await captureConsole(() => main(['start', '--claim', 'backthread_claim_y'], { runOnboardingImpl: spy.impl }));
  assert.deepEqual(spy.calls[0], ['--claim', 'backthread_claim_y']);
});

// --- help still shows usage (never onboarding) -------------------------------

for (const helpArg of ['help', '--help', '-h']) {
  test(`\`backthread ${helpArg}\` prints usage and does NOT run onboarding`, async () => {
    const spy = onboardingSpy(0);
    const { out, result } = await captureConsole(() =>
      main([helpArg], { runOnboardingImpl: spy.impl }),
    );
    assert.equal(result, 0);
    assert.match(out, /Usage:/, 'usage block printed');
    assert.match(out, /backthread start/, 'usage lists the start command');
    assert.equal(spy.calls.length, 0, 'help never triggers onboarding');
  });
}

test('usage documents the bare command as the unified front door', async () => {
  const { out } = await captureConsole(() => main(['help'], { runOnboardingImpl: async () => 0 }));
  // The first usage row is the bare `backthread` invocation.
  assert.match(out, /^\s*backthread\s+Set up Backthread/m);
});

// --- unknown subcommand → error + usage, exit 1, no onboarding ---------------

test('an unknown subcommand errors with usage and exits 1 (no onboarding)', async () => {
  const spy = onboardingSpy(0);
  const { err, result } = await captureConsole(() =>
    main(['frobnicate'], { runOnboardingImpl: spy.impl }),
  );
  assert.equal(result, 1);
  assert.match(err, /Unknown command: frobnicate/);
  assert.match(err, /Usage:/);
  assert.equal(spy.calls.length, 0, 'an unknown command must not silently onboard');
});

// --- `setup-check` is the INTERNAL plugin SessionStart nudge -----------------

test('`backthread setup-check` prints the SessionStart nudge when not set up, and never onboards', async () => {
  const spy = onboardingSpy(0);
  const dir = await mkdtemp(join(tmpdir(), 'backthread-bin-setupcheck-'));
  const prev = process.env.BACKTHREAD_CONFIG_DIR;
  // An empty config dir → not onboarded + no token → the nudge fires.
  process.env.BACKTHREAD_CONFIG_DIR = join(dir, '.backthread');
  try {
    const { out, result } = await captureConsole(() =>
      main(['setup-check'], { runOnboardingImpl: spy.impl }),
    );
    assert.equal(result, 0, 'always exits 0 (non-blocking)');
    assert.equal(spy.calls.length, 0, 'setup-check must not route to onboarding');
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(parsed.hookSpecificOutput.additionalContext, /\/backthread:start/);
  } finally {
    if (prev === undefined) delete process.env.BACKTHREAD_CONFIG_DIR;
    else process.env.BACKTHREAD_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('`setup-check` is internal — not documented in usage', async () => {
  const { out } = await captureConsole(() => main(['help'], { runOnboardingImpl: async () => 0 }));
  assert.doesNotMatch(out, /setup-check/);
});

// --- the default runOnboarding is wired (smoke: it is a function) ------------

test('runOnboarding is exported and callable (default dispatch target)', () => {
  assert.equal(typeof runOnboarding, 'function');
});
