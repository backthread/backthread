// inflowGuards.test.ts — the promises the in-flow ask makes, held against the code
// that actually runs.
//
// ═══ WHY THIS FILE EXISTS SEPARATELY ═══
//
// Every property here is a NEGATIVE one: no pre-edit trigger, no local spool, no
// counts, no re-ask, no trace left by an ignored ask. Negative properties are where
// vacuous guards breed — "assert there is no counter" passes trivially in a codebase
// that never had one, and keeps passing for exactly as long as nobody adds one.
//
// So each guard below is written as a CLOSED ALLOWLIST rather than a blocklist, over
// the thing that actually leaves the process: the requests on the wire (URL, method
// AND body keys), the bytes left in the config directory, the text that is rendered.
// A blocklist is only as good as the author's imagination; an allowlist can still be
// widened deliberately, but it cannot be side-stepped by somebody who simply did not
// think of the shape.
//
// Every one was mutation-proven: the forbidden thing was added, the guard was watched
// go red, and the mutation was reverted. If you change one of these, do the same.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runInflowDeadTime, DEAD_TIME_TOOLS, INFLOW_SESSION_FILE } from './inflowHook.js';
import { requestAsk, answerAsk, formatAsk, formatAskBlock, formatPromise, INFLOW_TRIGGERS } from './inflow.js';
import { inflowHookContext } from './inflowHook.js';
import { ASK, PROMISE, TOKEN, stubFetch, SIGNED_IN } from './inflowFixtures.test.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTE = () => 'git@github.com:acme/widgets.git';

/** Every tool that means somebody is about to change a file. None may ever fire this. */
const EDITING_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: 'sess-1', tool_name: 'Bash', cwd: '/repo', ...over });
}

async function withTempHome<T>(fn: (env: NodeJS.ProcessEnv, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-guard-'));
  try {
    return await fn({ BACKTHREAD_CONFIG_DIR: dir }, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Every byte this path left on disk, as a sorted list of `name contents`.
 *
 * Deliberately the WHOLE directory rather than one known file: a spool written to a
 * filename nobody thought of is exactly the failure a named-file check misses.
 */
async function snapshotDir(dir: string): Promise<string[]> {
  const names = (await readdir(dir).catch(() => [])).sort();
  const out: string[] = [];
  for (const name of names) {
    out.push(`${name} ${await readFile(join(dir, name), 'utf8').catch(() => '<unreadable>')}`);
  }
  return out;
}

/**
 * Run `fn` with the GLOBAL fetch replaced, so a request made through anything other
 * than the injected seam is caught rather than quietly escaping into the network.
 */
async function withGlobalFetchForbidden<T>(fn: () => Promise<T>): Promise<{ value: T; escaped: string[] }> {
  const escaped: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    escaped.push(`${((init ?? {}) as RequestInit).method ?? 'GET'} ${String(url)}`);
    return { status: 204, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    return { value: await fn(), escaped };
  } finally {
    globalThis.fetch = real;
  }
}

const SERVED = () => stubFetch(200, { ask: ASK, reason: 'served', promise: PROMISE });
const EMPTY = () => stubFetch(200, { ask: null, reason: 'nothing-banked', promise: PROMISE });
const BROKEN = () => stubFetch(500, { error: 'boom' });

// ═══ PROPERTY 1 — THERE IS NO PRE-EDIT TRIGGER ═════════════════════════════════════

test('GUARD: the manifest registers the in-flow hook under PostToolUse and nowhere else', async () => {
  const manifest = JSON.parse(await readFile(join(HERE, '..', 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };
  const events = Object.entries(manifest.hooks).filter(([, entries]) =>
    entries.some((e) => e.hooks.some((h) => h.command.includes('inflow-context'))),
  );
  assert.deepEqual(
    events.map(([name]) => name),
    ['PostToolUse'],
    'the in-flow ask fires AFTER a tool the person waited on — never before one, and never before an edit',
  );
});

test('GUARD: the in-flow hook matcher names no editing tool', async () => {
  const manifest = JSON.parse(await readFile(join(HERE, '..', 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };
  const entries = Object.values(manifest.hooks)
    .flat()
    .filter((e) => e.hooks.some((h) => h.command.includes('inflow-context')));
  assert.equal(entries.length, 1, 'exactly one registration');
  const matcher = entries[0].matcher ?? '';
  assert.notEqual(matcher.trim(), '', 'an empty matcher would fire this on every tool, editing ones included');
  for (const tool of EDITING_TOOLS) {
    assert.ok(!matcher.includes(tool), `the matcher must not name ${tool}`);
  }
  // Closed, not merely edit-free: the matcher may only name tools the runtime
  // allowlist also accepts, so the two cannot drift apart.
  for (const named of matcher.split('|')) {
    assert.ok(DEAD_TIME_TOOLS.includes(named), `matcher names "${named}", which the code will refuse`);
  }
});

test('GUARD: the runtime allowlist refuses every editing tool, even wired to a matcher we did not write', async () => {
  for (const tool of EDITING_TOOLS) {
    await withTempHome(async (env) => {
      const { fetchImpl, calls } = SERVED();
      const out = await runInflowDeadTime(payload({ tool_name: tool }), {
        env,
        fetchImpl,
        readConfigImpl: SIGNED_IN,
        readRemoteImpl: REMOTE,
      });
      assert.deepEqual(out, {}, `${tool} must produce nothing`);
      assert.equal(calls.length, 0, `${tool} must not even reach the server`);
    });
  }
  for (const tool of EDITING_TOOLS) {
    assert.ok(!DEAD_TIME_TOOLS.includes(tool), `${tool} must never be a dead-time tool`);
  }
});

test('GUARD: the trigger vocabulary is the two in-flow moments and nothing else', async () => {
  assert.deepEqual([...INFLOW_TRIGGERS], ['dead-time', 'on-demand']);
  // And nothing on this path so much as names a third one.
  for (const file of ['inflow.ts', 'inflowHook.ts']) {
    const src = await readFile(join(HERE, file), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n');
    assert.ok(!/'pre-edit'|"pre-edit"/.test(code), `${file} must not carry a pre-edit trigger value`);
  }
});

// ═══ PROPERTY 2 — AN IGNORED ASK LEAVES NOTHING BEHIND ═════════════════════════════

test('GUARD: the disk is byte-identical whether a question came back, none did, or it failed', async () => {
  const snapshots: Record<string, string[]> = {};
  for (const [label, factory] of [
    ['served', SERVED],
    ['empty', EMPTY],
    ['failed', BROKEN],
  ] as const) {
    await withTempHome(async (env, dir) => {
      await runInflowDeadTime(payload(), {
        env,
        fetchImpl: factory().fetchImpl,
        readConfigImpl: SIGNED_IN,
        readRemoteImpl: REMOTE,
      });
      snapshots[label] = await snapshotDir(dir);
    });
  }
  // "Asked and ignored" and "never asked" are indistinguishable in the database by
  // construction. This is the same property, held locally: if the client wrote down
  // ANYTHING that differed between these three, it would have rebuilt the record the
  // server refuses to keep.
  assert.deepEqual(snapshots.served, snapshots.empty, 'a served ask must leave no more than an empty one');
  assert.deepEqual(snapshots.served, snapshots.failed, 'a served ask must leave no more than a failed one');
  assert.deepEqual(snapshots.served, [`${INFLOW_SESSION_FILE} {"nudged":["sess-1"]}\n`]);
});

test('GUARD: the token is never written anywhere on the machine', async () => {
  await withTempHome(async (env, dir) => {
    const { fetchImpl } = SERVED();
    const out = await runInflowDeadTime(payload(), {
      env,
      fetchImpl,
      readConfigImpl: SIGNED_IN,
      readRemoteImpl: REMOTE,
    });
    assert.ok(out.hookSpecificOutput, 'precondition: this run really did serve a question');
    const onDisk = (await snapshotDir(dir)).join('\n');
    assert.ok(!onDisk.includes(TOKEN), 'the token must live in the scrollback and nowhere else');
    // Nor any of the question it carries — a spool of bodies is the same queue by
    // another name.
    assert.ok(!onDisk.includes(ASK.body), 'the question body must not be written down');
    assert.ok(!onDisk.includes(ASK.materialKey), 'the material must not be written down');
  });
});

test('GUARD: nothing on the ask path can produce a re-ask from what was stored', async () => {
  await withTempHome(async (env) => {
    const { fetchImpl, calls } = SERVED();
    const deps = { env, fetchImpl, readConfigImpl: SIGNED_IN, readRemoteImpl: REMOTE };
    await runInflowDeadTime(payload({ session_id: 'first' }), deps);
    await runInflowDeadTime(payload({ session_id: 'second' }), deps);
    assert.equal(calls.length, 2);
    // The second session's request is IDENTICAL to the first: nothing about the
    // question that went unanswered rides along, so nothing can be re-asked or
    // excluded on the strength of it.
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), JSON.parse(String(calls[1].init.body)));
  });
});

// ═══ PROPERTY 3 — NO COUNTS, ANYWHERE ═════════════════════════════════════════════

test('GUARD: every request this path makes is on a closed allowlist of url, method and body keys', async () => {
  const ALLOWED: Record<string, string[]> = {
    '/inflow/ask': ['repo', 'trigger'],
    '/inflow/answer': ['token', 'answer', 'outcome'],
  };
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const record = (calls: Array<{ url: string; init: RequestInit }>): void => {
    seen.push(...calls);
  };

  const { escaped } = await withGlobalFetchForbidden(async () => {
    await withTempHome(async (env) => {
      const served = SERVED();
      await runInflowDeadTime(payload(), {
        env,
        fetchImpl: served.fetchImpl,
        readConfigImpl: SIGNED_IN,
        readRemoteImpl: REMOTE,
      });
      record(served.calls);
    });
    const onDemand = SERVED();
    await requestAsk({ trigger: 'on-demand', repo: 'acme/widgets' }, {
      fetchImpl: onDemand.fetchImpl,
      readConfigImpl: SIGNED_IN,
    });
    record(onDemand.calls);
    const answered = stubFetch(200, { outcome: 'got-it', verdict: 'got-it', reveal: { since: [] }, effect: {}, lesson: {} });
    await answerAsk({ token: TOKEN, answer: 'because' }, {
      fetchImpl: answered.fetchImpl,
      readConfigImpl: SIGNED_IN,
    });
    record(answered.calls);
  });

  // A request made through the global rather than the injected seam is the classic
  // way a "no writes" guard gets side-stepped — a GET to a third-party host carries
  // the whole leak in its query string and never touches a body at all.
  assert.deepEqual(escaped, [], 'nothing on this path may call fetch outside the injected seam');
  assert.equal(seen.length, 3, 'one ask from the hook, one on demand, one answer');
  for (const { url, init } of seen) {
    const path = new URL(url).pathname;
    assert.ok(path in ALLOWED, `unexpected endpoint: ${path}`);
    assert.equal(init.method, 'POST', `${path} must be a POST`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      assert.ok(ALLOWED[path].includes(key), `${path} sent an unexpected field: ${key}`);
    }
    for (const value of Object.values(body)) {
      assert.equal(typeof value, 'string', `${path} sent a non-string field — a quantity has no business here`);
    }
  }
});

test('GUARD: nothing rendered to a person carries a number of any kind', () => {
  // The server's own fields are stripped first, so this is a claim about OUR copy:
  // a tally, a streak, a "3rd this week" or a percentage would survive the strip and
  // turn this red.
  // The one place the counting words legitimately appear is the sentence that
  // FORBIDS them. It is asserted present and then removed, so the scan below is
  // about what we would show somebody rather than about what we tell the agent not
  // to invent — and deleting that sentence to quiet this guard turns it red instead.
  const PROHIBITION = 'never add a score, a tally, or a';
  const agentRules = inflowHookContext('');
  assert.ok(agentRules.includes(PROHIBITION), 'the agent is still told not to invent a tally');

  const strip = (text: string): string => {
    let out = text;
    for (const s of [
      TOKEN,
      ASK.body,
      ASK.subsystem ?? '',
      ASK.expiresAt,
      ASK.materialKey,
      PROMISE.short,
      PROMISE.title,
      ...PROMISE.points,
      PROHIBITION,
    ]) {
      if (s) out = out.split(s).join('');
    }
    return out;
  };
  const surfaces: Record<string, string> = {
    'the question block': formatAskBlock(ASK, PROMISE, 'bt ask-me'),
    'the injected instructions': inflowHookContext(formatAskBlock(ASK, PROMISE, 'bt ask-me')),
    'a served on-demand ask': formatAsk({ status: 'ok', detail: 'served', ask: ASK, reason: 'served', promise: PROMISE }, 'bt ask-me'),
    'an empty on-demand ask': formatAsk({ status: 'ok', detail: 'nothing-banked', ask: null, reason: 'nothing-banked' }, 'bt ask-me'),
    'the full statement': formatPromise({ status: 'ok', detail: 'served', promise: PROMISE }),
  };
  for (const [label, text] of Object.entries(surfaces)) {
    assert.doesNotMatch(strip(text), /\d/, `${label} must contain no number of our own`);
    assert.doesNotMatch(
      strip(text),
      /streak|tally|so far|in a row|out of|remaining|pending|score|%|\bstats?\b/i,
      `${label} must not imply a running total`,
    );
  }
});

test('GUARD: nothing on this path names a participation quantity', async () => {
  // A blunt one, and it earns its place: two of these got as far as a code review on
  // the server before anybody noticed the field was the whole objection.
  const forbidden =
    /\b(askCount|asksAsked|answeredCount|skippedCount|participation|streak|record_lesson_completion|askedAt|lastAskedAt)\b/;
  for (const file of ['inflow.ts', 'inflowHook.ts']) {
    const src = await readFile(join(HERE, file), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n');
    assert.doesNotMatch(code, forbidden, `${file} names a participation quantity`);
  }
});

// ═══ PROPERTY 4 — A QUIET SESSION IS A FIRST-CLASS COMPLETION ══════════════════════

test('GUARD: an empty record is silence in the flow and a complete answer on demand', async () => {
  await withTempHome(async (env) => {
    const out = await runInflowDeadTime(payload(), {
      env,
      fetchImpl: EMPTY().fetchImpl,
      readConfigImpl: SIGNED_IN,
      readRemoteImpl: REMOTE,
    });
    assert.deepEqual(out, {}, 'in the flow, nothing to ask means the person hears nothing');
  });

  const onDemand = await requestAsk({ trigger: 'on-demand', repo: 'acme/widgets' }, {
    fetchImpl: EMPTY().fetchImpl,
    readConfigImpl: SIGNED_IN,
  });
  assert.equal(onDemand.status, 'ok', 'an empty record is a success, so the command exits 0');
  const text = formatAsk(onDemand, 'bt ask-me');
  assert.doesNotMatch(text, /error|warning|fail|sorry|unfortunately|skipped|caught up|nothing left/i);
  assert.match(text, /Nothing on record here/);
});

// ═══ PROPERTY 5 — THE PROMISE IS STATED IN-PRODUCT, AND IT IS THE SERVER'S ═════════

test('GUARD: the client holds no promise sentences of its own', () => {
  // Rendered with NOTHING from the server, it must state nothing. A hardcoded
  // fallback — however true it is today — is a sentence that can drift away from the
  // behaviour it describes, and a promise nobody can check is not a promise.
  const bare = formatPromise({ status: 'ok', detail: 'served', promise: { short: '', title: '', points: [] } });
  assert.doesNotMatch(bare, /nothing is recorded|no row|never|not counted|your lead/i);
  assert.match(bare, /sent no statement/);

  // And rendered WITH the server's words, every one of them appears.
  const full = formatPromise({ status: 'ok', detail: 'served', promise: PROMISE });
  for (const point of PROMISE.points) assert.ok(full.includes(point), `dropped: ${point}`);
  assert.ok(full.includes(PROMISE.title));
});

test('GUARD: the permission to ignore rides with the question itself, not only behind a command', () => {
  const block = formatAskBlock(ASK, PROMISE, 'bt ask-me');
  assert.ok(block.startsWith(PROMISE.short), 'it is the first thing anybody reads');
  assert.ok(inflowHookContext(block).includes(PROMISE.short), 'and it survives into the flow');
});
