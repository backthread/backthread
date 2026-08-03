// editNudge.test.ts — the pre-edit line's two contracts: it speaks ONLY on a clean
// `uncovered`, and it says its piece at most once per session.
//
// Everything here is offline: fetch, config, the git-remote reader and the repo-root
// resolver are all injected, and the throttle writes into a temp HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  interpretCoverageResponse,
  editNudgeMessage,
  extractEditPath,
  toRepoRelativePath,
  runEditNudge,
  EDIT_NUDGE_FILE,
  MAX_PREFLIGHTS_PER_SESSION,
} from './editNudge.js';
import { throttleStatePath } from './sessionThrottle.js';

// --- the pure verdict ----------------------------------------------------------

test('only a clean 200 `uncovered` speaks', () => {
  const v = interpretCoverageResponse(true, 200, { ok: true, signal: 'uncovered', subsystem: 'Billing' });
  assert.equal(v.speak, true);
  assert.equal(v.signal, 'uncovered');
  assert.equal(v.subsystem, 'Billing');
});

test('every other outcome is silent', () => {
  const cases: Array<[string, boolean, number, unknown]> = [
    ['covered', true, 200, { ok: true, signal: 'covered', subsystem: 'Billing' }],
    ['unresolved', true, 200, { ok: true, signal: 'unresolved', subsystem: null }],
    ['unknown signal', true, 200, { ok: true, signal: 'something-new' }],
    ['absent signal', true, 200, { ok: true }],
    ['null body', true, 200, null],
    ['array body', true, 200, []],
    ['401', true, 401, { error: 'unauthorized' }],
    ['403', true, 403, { error: 'forbidden' }],
    ['500', true, 500, { error: 'boom' }],
    // The nastiest one: a 500 whose body happens to carry an `uncovered` signal.
    ['non-200 carrying uncovered', true, 500, { signal: 'uncovered', subsystem: 'Billing' }],
    ['fetch threw', false, 0, null],
  ];
  for (const [label, ok, status, payload] of cases) {
    const v = interpretCoverageResponse(ok, status, payload);
    assert.equal(v.speak, false, `${label} must stay silent`);
    assert.equal(v.subsystem, null, `${label} must not carry a subsystem`);
  }
});

test('an uncovered verdict with no subsystem still speaks, generically', () => {
  const v = interpretCoverageResponse(true, 200, { ok: true, signal: 'uncovered', subsystem: null });
  assert.equal(v.speak, true);
  assert.equal(v.subsystem, null);
  assert.match(editNudgeMessage(null), /this part of the codebase/);
});

test('the line names the area, points at the how command, and never says the forbidden noun', () => {
  const msg = editNudgeMessage('Billing');
  assert.match(msg, /"Billing"/);
  assert.match(msg, /\/backthread:how Billing/);
  assert.doesNotMatch(msg, /architectural memory/i);
  assert.equal(msg.includes('\n'), false, 'exactly one line');
});

// --- payload parsing -----------------------------------------------------------

test('the edited path comes off file_path, and an unknown shape yields nothing', () => {
  assert.equal(extractEditPath({ file_path: '/repo/src/a.ts' }), '/repo/src/a.ts');
  assert.equal(extractEditPath({ path: '/repo/src/a.ts' }), '/repo/src/a.ts');
  assert.equal(extractEditPath({ old_string: 'x', new_string: 'y' }), '');
  assert.equal(extractEditPath({ file_path: '   ' }), '');
  assert.equal(extractEditPath(null), '');
  assert.equal(extractEditPath('nope'), '');
});

test('paths are made repo-relative + POSIX, and an escape yields null', () => {
  assert.equal(toRepoRelativePath('/repo', '/repo/src', '/repo/src/a.ts'), 'src/a.ts');
  assert.equal(toRepoRelativePath('/repo', '/repo/src', 'a.ts'), 'src/a.ts');
  assert.equal(toRepoRelativePath('/repo', '/repo', './a.ts'), 'a.ts');
  assert.equal(toRepoRelativePath('/repo', '/repo', '/elsewhere/a.ts'), null);
  assert.equal(toRepoRelativePath('/repo', '/repo', '/repo'), null, 'the root itself is not a file');
});

// --- the hook end to end -------------------------------------------------------

async function withTempHome(fn: (env: NodeJS.ProcessEnv, home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bt-edit-nudge-'));
  try {
    // BACKTHREAD_CONFIG_DIR is the config-dir override (configDir() otherwise reads
    // the real homedir) — without it these tests would write into the developer's
    // own ~/.backthread and leak state between runs.
    await fn({ BACKTHREAD_CONFIG_DIR: home } as NodeJS.ProcessEnv, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sess-1',
    cwd: '/repo/src',
    tool_name: 'Edit',
    tool_input: { file_path: '/repo/src/billing/charge.ts' },
    ...overrides,
  });
}

function deps(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  calls?: { n: number },
): Parameters<typeof runEditNudge>[1] {
  return {
    env,
    fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      if (calls) calls.n += 1;
      return fetchImpl(...args);
    }) as typeof fetch,
    readConfigImpl: async () => ({ device_token: 'bt_test_token' }),
    readRemoteImpl: () => 'git@github.com:acme/widgets.git',
    resolveRepoRootImpl: () => '/repo',
  };
}

const uncovered = (async () =>
  new Response(JSON.stringify({ ok: true, signal: 'uncovered', subsystem: 'Billing' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;

const covered = (async () =>
  new Response(JSON.stringify({ ok: true, signal: 'covered', subsystem: 'Billing' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;

test('an uncovered edit gets exactly one line, and the session never gets a second', async () => {
  await withTempHome(async (env) => {
    const calls = { n: 0 };
    const first = await runEditNudge(payload(), deps(env, uncovered, calls));
    assert.match(String(first.systemMessage), /Billing/);
    assert.equal(calls.n, 1);

    // Same session, another uncovered edit → silent, and no second round-trip.
    const second = await runEditNudge(
      payload({ tool_input: { file_path: '/repo/src/billing/refund.ts' } }),
      deps(env, uncovered, calls),
    );
    assert.deepEqual(second, {});
    assert.equal(calls.n, 1, 'a session that already spoke must not call the endpoint again');

    // A DIFFERENT session gets its own line.
    const other = await runEditNudge(payload({ session_id: 'sess-2' }), deps(env, uncovered, calls));
    assert.match(String(other.systemMessage), /Billing/);
    assert.equal(calls.n, 2);
  });
});

test('a covered area says nothing, and the session keeps its remaining lookups', async () => {
  await withTempHome(async (env) => {
    const calls = { n: 0 };
    assert.deepEqual(await runEditNudge(payload(), deps(env, covered, calls)), {});
    assert.equal(calls.n, 1);
    // The line was never spent, so a later uncovered edit in the same session still speaks.
    const later = await runEditNudge(payload(), deps(env, uncovered, calls));
    assert.match(String(later.systemMessage), /Billing/);
    assert.equal(calls.n, 2);
  });
});

test('a session stops paying for lookups once its budget is spent', async () => {
  await withTempHome(async (env) => {
    const calls = { n: 0 };
    for (let i = 0; i < MAX_PREFLIGHTS_PER_SESSION + 3; i++) {
      assert.deepEqual(await runEditNudge(payload(), deps(env, covered, calls)), {});
    }
    assert.equal(calls.n, MAX_PREFLIGHTS_PER_SESSION, 'the budget bounds the round-trips');
  });
});

test('every failure mode is silent and costs the caller nothing', async () => {
  const boom = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const rejected = (async () =>
    new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })) as unknown as typeof fetch;
  const garbage = (async () => new Response('<html>nope', { status: 200 })) as unknown as typeof fetch;

  for (const impl of [boom, rejected, garbage]) {
    await withTempHome(async (env) => {
      assert.deepEqual(await runEditNudge(payload(), deps(env, impl)), {});
    });
  }
});

test('no session id, no path, no token, no git repo → silent, and never a network call', async () => {
  await withTempHome(async (env) => {
    const calls = { n: 0 };
    const d = deps(env, uncovered, calls);

    assert.deepEqual(await runEditNudge(payload({ session_id: '' }), d), {});
    assert.deepEqual(await runEditNudge(payload({ tool_input: {} }), d), {});
    assert.deepEqual(await runEditNudge('not json at all {{{', d), {});
    assert.deepEqual(
      await runEditNudge(payload({ session_id: 's-token' }), { ...d, readConfigImpl: async () => ({}) }),
      {},
    );
    assert.deepEqual(
      await runEditNudge(payload({ session_id: 's-nogit' }), { ...d, readRemoteImpl: () => null }),
      {},
    );
    // The file lives outside the repo root → nothing to ask about.
    assert.deepEqual(
      await runEditNudge(
        payload({ session_id: 's-outside', tool_input: { file_path: '/elsewhere/x.ts' } }),
        d,
      ),
      {},
    );
    assert.equal(calls.n, 0, 'none of these may reach the endpoint');
  });
});

test('the throttle state is written to its OWN file, not the connect nudge ring', async () => {
  await withTempHome(async (env) => {
    await runEditNudge(payload(), deps(env, uncovered));
    const raw = await readFile(throttleStatePath(EDIT_NUDGE_FILE, env), 'utf8');
    assert.match(raw, /sess-1/);
    await assert.rejects(readFile(throttleStatePath('connect-nudge.json', env), 'utf8'));
  });
});

test('it never returns a blocking decision, whatever the server says', async () => {
  await withTempHome(async (env) => {
    const out = await runEditNudge(payload(), deps(env, uncovered));
    // The only key this hook may ever emit is systemMessage — no permissionDecision,
    // no `continue: false`, nothing that could stop or delay the edit.
    assert.deepEqual(Object.keys(out), ['systemMessage']);
  });
});
