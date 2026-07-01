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

// --- version → prints the bare version, no auth/network ----------------------

for (const arg of ['version', '--version', '-v']) {
  test(`\`backthread ${arg}\` prints the bare version, exits 0, never onboards`, async () => {
    const spy = onboardingSpy(0);
    const { out, result } = await captureConsole(() => main([arg], { runOnboardingImpl: spy.impl }));
    assert.equal(result, 0);
    assert.match(out, /^\d+\.\d+\.\d+/, 'prints a semver and nothing else');
    assert.doesNotMatch(out, /Usage:/, 'version is not help');
    // `-v` / `--version` are leading-dash args — assert they are NOT swallowed by the
    // bare-flag→onboarding fall-through (that would print nothing + run onboarding).
    assert.equal(spy.calls.length, 0, 'version never triggers onboarding');
  });
}

// --- logout → routes to the logout runner (seam keeps this off disk) ----------

test('`backthread logout` routes to the logout runner and returns its exit code', async () => {
  let called = 0;
  const { out, result } = await captureConsole(() =>
    main(['logout'], {
      runLogoutImpl: async () => {
        called += 1;
        return { ok: true, cleared: true, message: 'Signed out.' };
      },
    }),
  );
  assert.equal(called, 1, 'logout ran exactly once');
  assert.match(out, /Signed out\./, 'prints the runner message');
  assert.equal(result, 0);
});

test('`backthread logout` propagates a non-ok result as exit 1', async () => {
  const { result } = await captureConsole(() =>
    main(['logout'], {
      runLogoutImpl: async () => ({ ok: false, cleared: false, message: 'nope' }),
    }),
  );
  assert.equal(result, 1);
});

// --- update → routes to the update runner (seam keeps this off npm/network) ---

for (const arg of ['update', '--update', '-u']) {
  test(`\`backthread ${arg}\` routes to the update runner, never onboards`, async () => {
    const spy = onboardingSpy(0);
    let called = 0;
    const { out, result } = await captureConsole(() =>
      main([arg], {
        runOnboardingImpl: spy.impl,
        runUpdateImpl: async () => {
          called += 1;
          return { ok: true, context: 'global', updated: true, message: 'Updated Backthread 0.7.0 → 0.8.0.' };
        },
      }),
    );
    assert.equal(called, 1, 'update ran exactly once');
    assert.match(out, /Updated Backthread/);
    assert.equal(result, 0);
    assert.equal(spy.calls.length, 0, 'update (incl. the leading-dash -u/--update) never onboards');
  });
}

test('`backthread update` propagates a non-ok result as exit 1', async () => {
  const { result } = await captureConsole(() =>
    main(['update'], {
      runUpdateImpl: async () => ({ ok: false, context: 'global', updated: false, message: 'offline' }),
    }),
  );
  assert.equal(result, 1);
});

// --- unknown subcommand → friendly pointer (not a usage wall), exit 1 ---------

test('an unknown subcommand points at help and exits 1 (no onboarding, no usage wall)', async () => {
  const spy = onboardingSpy(0);
  const { err, result } = await captureConsole(() =>
    main(['frobnicate'], { runOnboardingImpl: spy.impl }),
  );
  assert.equal(result, 1);
  assert.match(err, /Unknown command: frobnicate/);
  assert.match(err, /backthread help/, 'points the user at help');
  assert.doesNotMatch(err, /Usage:/, 'a typo gets a pointer, not the whole usage block');
  assert.doesNotMatch(err, /Did you mean/, 'frobnicate is close to nothing');
  assert.equal(spy.calls.length, 0, 'an unknown command must not silently onboard');
});

test('a near-miss subcommand suggests the closest command', async () => {
  const spy = onboardingSpy(0);
  const { err, result } = await captureConsole(() =>
    main(['lgoin'], { runOnboardingImpl: spy.impl }),
  );
  assert.equal(result, 1);
  assert.match(err, /Did you mean `backthread login`\?/);
  assert.equal(spy.calls.length, 0);
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
