// inflowHook.test.ts — the dead-time trigger: when it fires, and (mostly) when it
// does not.
//
// Offline throughout: fetch, config and the git-remote reader are injected, and the
// once-per-session ring writes into a temp HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runInflowDeadTime,
  isDeadTimeTool,
  inflowHookContext,
  DEAD_TIME_TOOLS,
  INFLOW_SESSION_FILE,
} from './inflowHook.js';
import { throttleStatePath } from './sessionThrottle.js';
import { ASK, PROMISE, stubFetch, SIGNED_IN } from './inflowFixtures.test.js';

const REMOTE = () => 'git@github.com:acme/widgets.git';

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sess-1',
    tool_name: 'Bash',
    cwd: '/repo',
    hook_event_name: 'PostToolUse',
    ...over,
  });
}

async function withTempHome<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-inflow-'));
  try {
    return await fn({ BACKTHREAD_CONFIG_DIR: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SERVED = () => stubFetch(200, { ask: ASK, reason: 'served', promise: PROMISE });

// --- the firing moment -------------------------------------------------------------

test('a served ask is injected for the agent to relay', async () => {
  await withTempHome(async (env) => {
    const { fetchImpl } = SERVED();
    const out = await runInflowDeadTime(payload(), {
      env,
      fetchImpl,
      readConfigImpl: SIGNED_IN,
      readRemoteImpl: REMOTE,
      argv: ['node', '/bt/backthread.js'],
    });
    assert.equal(out.hookSpecificOutput?.hookEventName, 'PostToolUse');
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes(ASK.body));
    assert.ok(ctx.includes(PROMISE.short));
    assert.ok(ctx.includes(`node "/bt/backthread.js" ask-me --answer '${ASK.token}'`));
  });
});

test('the injected instructions forbid following up on an ignored ask', () => {
  const ctx = inflowHookContext('THE QUESTION');
  assert.match(ctx, /drop it completely/i);
  assert.match(ctx, /Do not repeat it/i);
  assert.match(ctx, /do not mention it again/i);
  assert.match(ctx, /Do not answer it yourself/i);
});

test('the trigger sent on the wire is dead-time', async () => {
  await withTempHome(async (env) => {
    const { fetchImpl, calls } = SERVED();
    await runInflowDeadTime(payload(), {
      env,
      fetchImpl,
      readConfigImpl: SIGNED_IN,
      readRemoteImpl: REMOTE,
    });
    assert.equal(JSON.parse(String(calls[0].init.body)).trigger, 'dead-time');
  });
});

// --- silence, which is the default -------------------------------------------------

test('every doubt resolves to saying nothing at all', async () => {
  const cases: Array<[string, string, () => ReturnType<typeof stubFetch>]> = [
    ['unparseable payload', 'not json', SERVED],
    ['no session id', payload({ session_id: '' }), SERVED],
    ['no question in the reply', payload(), () => stubFetch(200, { ask: null, reason: 'nothing-banked', promise: PROMISE })],
    ['a 500', payload(), () => stubFetch(500, { error: 'boom' })],
    ['a 401', payload(), () => stubFetch(401, { error: 'unauthorized' })],
    ['a malformed body', payload(), () => stubFetch(200, { ask: { nope: true }, reason: 'served' })],
    ['a 500 that happens to carry a question', payload(), () => stubFetch(500, { ask: ASK, reason: 'served' })],
  ];
  for (const [label, raw, fetchFactory] of cases) {
    await withTempHome(async (env) => {
      const out = await runInflowDeadTime(raw, {
        env,
        fetchImpl: fetchFactory().fetchImpl,
        readConfigImpl: SIGNED_IN,
        readRemoteImpl: REMOTE,
      });
      assert.deepEqual(out, {}, `${label} must say nothing`);
    });
  }
});

test('a fetch that throws or times out says nothing', async () => {
  await withTempHome(async (env) => {
    const threw = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const out = await runInflowDeadTime(payload(), {
      env,
      fetchImpl: threw,
      readConfigImpl: SIGNED_IN,
      readRemoteImpl: REMOTE,
    });
    assert.deepEqual(out, {});
  });
});

test('signed out is silent, and never reaches the network', async () => {
  await withTempHome(async (env) => {
    const { fetchImpl, calls } = SERVED();
    const out = await runInflowDeadTime(payload(), {
      env,
      fetchImpl,
      readConfigImpl: async () => ({}) as never,
      readRemoteImpl: REMOTE,
    });
    assert.deepEqual(out, {});
    assert.equal(calls.length, 0);
  });
});

test('outside a git repo it is silent, and never reaches the network', async () => {
  await withTempHome(async (env) => {
    const { fetchImpl, calls } = SERVED();
    const out = await runInflowDeadTime(payload(), {
      env,
      fetchImpl,
      readConfigImpl: async () => ({ device_token: 'dt' }) as never,
      readRemoteImpl: () => null,
    });
    assert.deepEqual(out, {});
    assert.equal(calls.length, 0);
  });
});

// --- at most once per session --------------------------------------------------------

test('a session is asked at most once, and the second fire makes no request', async () => {
  await withTempHome(async (env) => {
    const { fetchImpl, calls } = SERVED();
    const deps = { env, fetchImpl, readConfigImpl: SIGNED_IN, readRemoteImpl: REMOTE };
    const first = await runInflowDeadTime(payload(), deps);
    assert.ok(first.hookSpecificOutput, 'the first fire asks');
    const second = await runInflowDeadTime(payload(), deps);
    assert.deepEqual(second, {}, 'the second fire says nothing');
    const third = await runInflowDeadTime(payload({ tool_name: 'Task' }), deps);
    assert.deepEqual(third, {}, 'and so does every one after it');
    assert.equal(calls.length, 1, 'exactly one round-trip per session, ever');
  });
});

test('after its one ask, a session does no further local work either', async () => {
  // The peek is what holds this, and it is the ONLY thing that holds it — so pin the
  // property it uniquely has: a spent session stops before the config read and the
  // git read, not just before the request. Without the peek these counters climb.
  await withTempHome(async (env) => {
    const { fetchImpl } = SERVED();
    let configReads = 0;
    let remoteReads = 0;
    const deps = {
      env,
      fetchImpl,
      readConfigImpl: async () => {
        configReads += 1;
        return SIGNED_IN();
      },
      readRemoteImpl: () => {
        remoteReads += 1;
        return REMOTE();
      },
    };
    await runInflowDeadTime(payload(), deps);
    const afterFirst = { configReads, remoteReads };
    assert.ok(afterFirst.configReads > 0 && afterFirst.remoteReads > 0, 'the first fire does the work');
    await runInflowDeadTime(payload(), deps);
    await runInflowDeadTime(payload(), deps);
    assert.equal(configReads, afterFirst.configReads, 'a spent session never reads the config again');
    assert.equal(remoteReads, afterFirst.remoteReads, 'a spent session never reads the git remote again');
  });
});

test('a different session is a different chance', async () => {
  await withTempHome(async (env) => {
    const { fetchImpl, calls } = SERVED();
    const deps = { env, fetchImpl, readConfigImpl: SIGNED_IN, readRemoteImpl: REMOTE };
    await runInflowDeadTime(payload({ session_id: 'a' }), deps);
    await runInflowDeadTime(payload({ session_id: 'b' }), deps);
    assert.equal(calls.length, 2);
  });
});

test('an empty record still spends the session — silence costs one round-trip, not forty', async () => {
  await withTempHome(async (env) => {
    const { fetchImpl, calls } = stubFetch(200, { ask: null, reason: 'nothing-banked', promise: PROMISE });
    const deps = { env, fetchImpl, readConfigImpl: SIGNED_IN, readRemoteImpl: REMOTE };
    await runInflowDeadTime(payload(), deps);
    await runInflowDeadTime(payload(), deps);
    await runInflowDeadTime(payload(), deps);
    assert.equal(calls.length, 1);
  });
});

// --- the tool allowlist ---------------------------------------------------------------

test('the dead-time tools are the ones somebody waits on', () => {
  assert.deepEqual([...DEAD_TIME_TOOLS], ['Bash', 'Task', 'WebFetch', 'WebSearch']);
  for (const tool of DEAD_TIME_TOOLS) assert.equal(isDeadTimeTool(tool), true, tool);
  assert.equal(isDeadTimeTool('Read'), false);
  assert.equal(isDeadTimeTool(undefined), false);
  assert.equal(isDeadTimeTool(42), false);
});

test('a tool outside the allowlist is silent and never reaches the network', async () => {
  await withTempHome(async (env) => {
    const { fetchImpl, calls } = SERVED();
    const out = await runInflowDeadTime(payload({ tool_name: 'Read' }), {
      env,
      fetchImpl,
      readConfigImpl: SIGNED_IN,
      readRemoteImpl: REMOTE,
    });
    assert.deepEqual(out, {});
    assert.equal(calls.length, 0);
  });
});

test('the ring holds session ids and nothing else', async () => {
  await withTempHome(async (env) => {
    const { fetchImpl } = SERVED();
    await runInflowDeadTime(payload(), {
      env,
      fetchImpl,
      readConfigImpl: SIGNED_IN,
      readRemoteImpl: REMOTE,
    });
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(throttleStatePath(INFLOW_SESSION_FILE, env), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ['nudged']);
    assert.deepEqual(parsed.nudged, ['sess-1']);
  });
});
