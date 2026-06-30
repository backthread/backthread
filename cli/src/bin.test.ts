import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, runOnboarding, stripFlag } from './bin/backthread.js';
import type { QueryOutcome } from './query.js';

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

// --- `how` / `ask` → deterministic grounded ask (ARP-759) --------------------

test('stripFlag removes a flag and its value, leaving the free-text question', () => {
  assert.deepEqual(stripFlag(['--cwd', '/p', 'does', 'auth', 'work?'], '--cwd'), ['does', 'auth', 'work?']);
  assert.deepEqual(stripFlag(['how', 'does', 'it', 'work'], '--cwd'), ['how', 'does', 'it', 'work']); // absent → unchanged
  // a trailing flag with no value is dropped without eating a non-existent value
  assert.deepEqual(stripFlag(['q', '--cwd'], '--cwd'), ['q']);
});

test('`backthread how <question>` strips --cwd, relays the question, prints the answer, exits 0', async () => {
  let seen: unknown;
  const outcome: QueryOutcome = {
    status: 'ok',
    detail: '',
    answer: 'Auth uses device tokens [1].\n\nOpen the "How it works" diagram: https://app.backthread.dev/o/r',
  };
  const { out, result } = await captureConsole(() =>
    main(['how', '--cwd', '/repo', 'does', 'auth', 'work?'], {
      queryDecisionsImpl: async (input) => {
        seen = input;
        return outcome;
      },
    }),
  );
  assert.deepEqual(seen, { question: 'does auth work?', cwd: '/repo' });
  assert.match(out, /Auth uses device tokens \[1\]\./); // the answer is printed verbatim
  assert.equal(result, 0);
});

test('`backthread ask` is an alias for `how`', async () => {
  let called = false;
  const { result } = await captureConsole(() =>
    main(['ask', 'how', 'does', 'it', 'work'], {
      queryDecisionsImpl: async () => {
        called = true;
        return { status: 'ok', detail: '', answer: 'a' };
      },
    }),
  );
  assert.equal(called, true);
  assert.equal(result, 0);
});

test('`backthread how` with a non-ok outcome exits 1 (failure visible)', async () => {
  const { out, result } = await captureConsole(() =>
    main(['how', 'q'], {
      queryDecisionsImpl: async () => ({ status: 'no-auth', detail: 'run `backthread login`' }),
    }),
  );
  assert.equal(result, 1);
  assert.match(out, /no-auth/);
});

// --- the default runOnboarding is wired (smoke: it is a function) ------------

test('runOnboarding is exported and callable (default dispatch target)', () => {
  assert.equal(typeof runOnboarding, 'function');
});
