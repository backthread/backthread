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
//
// ⚠️ THE FIRST ROUND OF THESE GUARDS WAS SHAPED FOR THE ABUSES THE AUTHOR IMAGINED AND
// OPEN TO EVERY OTHER SHAPE — fifteen mutants survived an independent pass. Every one
// of them went out through a channel the guards were not watching rather than through
// one they were: a count in a REQUEST HEADER, a count in a QUERY STRING (the body
// allowlist read `new URL(url).pathname` and never the search), a spool written to
// `os.tmpdir()` (the disk snapshot walked only the config dir), a count on STDOUT (in
// a hook whose stdout is a JSON contract), a count in an ENV VAR, a count SPELLED OUT
// so it carried no digit, and counts hidden in render branches the fixture never took
// (the error branch, an open question, the `produce` rung).
//
// So the allowlists below are now over EVERY channel that leaves this process, not the
// three that were easiest to reason about: the whole request (url INCLUDING its search,
// method, header names, body keys), every byte written under a sandboxed HOME *and*
// TMPDIR, every write to stdout and stderr, the process environment, and every render
// branch rather than one fixture's. The lesson generalises past this file: a guard
// written about the shape you feared is a guard about your imagination.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runInflowDeadTime, DEAD_TIME_TOOLS, INFLOW_SESSION_FILE } from './inflowHook.js';
import {
  requestAsk,
  answerAsk,
  formatAsk,
  formatAskBlock,
  formatAskAnswer,
  formatPromise,
  INFLOW_TRIGGERS,
  PROMISE_EPILOGUE,
} from './inflow.js';
import { inflowHookContext } from './inflowHook.js';
import { throttleStatePath } from './sessionThrottle.js';
import { ASK, PROMISE, TOKEN, stubFetch, SIGNED_IN } from './inflowFixtures.test.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTE = () => 'git@github.com:acme/widgets.git';

/** Every tool that means somebody is about to change a file. None may ever fire this. */
const EDITING_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: 'sess-1', tool_name: 'Bash', cwd: '/repo', ...over });
}

/**
 * A sandbox with the config dir AND the process temp dir inside it, so a write to
 * either is visible to the snapshot below.
 *
 * ⚠️ `TMPDIR` IS REDIRECTED ON PURPOSE, and it is not tidiness. A spool written to
 * `os.tmpdir()` instead of the config dir is exactly the queue this design exists to
 * prevent, and it survived a whole round of guards that walked the config dir alone.
 * `os.tmpdir()` reads `process.env.TMPDIR` on each call, so pointing it here is enough
 * to catch it.
 */
async function withTempHome<T>(
  fn: (env: NodeJS.ProcessEnv, dir: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'bt-guard-'));
  const configHome = join(root, 'config');
  const scratch = join(root, 'tmp');
  await mkdir(configHome, { recursive: true });
  await mkdir(scratch, { recursive: true });
  const prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    return await fn({ BACKTHREAD_CONFIG_DIR: configHome, TMPDIR: scratch, HOME: root }, root);
  } finally {
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Every byte this path left on disk under `dir`, RECURSIVELY, as a sorted list of
 * `relative-path contents`.
 *
 * Deliberately the whole tree rather than one known file or one known directory: a
 * spool written to a filename nobody thought of, in a directory nobody thought of, is
 * precisely the failure a named-file check misses — and it is the failure that
 * actually happened.
 */
async function snapshotDir(dir: string, prefix = ''): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await snapshotDir(join(dir, entry.name), rel)));
    else out.push(`${rel} ${await readFile(join(dir, entry.name), 'utf8').catch(() => '<unreadable>')}`);
  }
  return out;
}

/**
 * Run `fn` with stdout, stderr and both console channels captured.
 *
 * The dead-time hook's STDOUT IS A CONTRACT — the host agent parses it as one JSON
 * object — so a stray `console.log` anywhere under it is both a leak and a corruption,
 * and nothing was watching that channel at all.
 */
async function withOutputCaptured<T>(fn: () => Promise<T>): Promise<{ value: T; wrote: string[] }> {
  const wrote: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  const realWarn = console.warn;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErrW = process.stderr.write.bind(process.stderr);
  console.log = (...a: unknown[]) => void wrote.push(`console.log ${a.join(' ')}`);
  console.error = (...a: unknown[]) => void wrote.push(`console.error ${a.join(' ')}`);
  console.warn = (...a: unknown[]) => void wrote.push(`console.warn ${a.join(' ')}`);
  process.stdout.write = ((c: unknown) => {
    wrote.push(`stdout ${String(c)}`);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    wrote.push(`stderr ${String(c)}`);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), wrote };
  } finally {
    console.log = realLog;
    console.error = realErr;
    console.warn = realWarn;
    process.stdout.write = realOut;
    process.stderr.write = realErrW;
  }
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

test('GUARD: every hook in the manifest routes to a known subcommand', async () => {
  // The two guards above key on the literal string `inflow-context`, which means a
  // SECOND registration under a different subcommand name — one that forwards to the
  // same code with the tool name rewritten — walks past both of them. Measured: it did.
  //
  // So the manifest's whole command vocabulary is closed. A new entrypoint has to be
  // named here, deliberately, before any hook may call it, and only `inflow-context`
  // may reach the in-flow ask.
  const KNOWN_HOOK_COMMANDS = ['grep-context', 'edit-context', 'session-start', 'capture', 'inflow-context'];
  const manifest = JSON.parse(await readFile(join(HERE, '..', 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };
  for (const [event, entries] of Object.entries(manifest.hooks)) {
    for (const entry of entries) {
      for (const { command } of entry.hooks) {
        const named = KNOWN_HOOK_COMMANDS.filter((c) => command.includes(c));
        assert.equal(
          named.length,
          1,
          `${event} runs a command this guard does not recognise: ${command}`,
        );
      }
    }
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
  assert.deepEqual(snapshots.served, [`config/${INFLOW_SESSION_FILE} {"nudged":["sess-1"]}\n`]);
});

test('GUARD: the disk is byte-identical whether the ask was answered or ignored', async () => {
  // THE EXPERIMENT THE README INVITES PEOPLE TO RUN. The test above stops before
  // anybody replies, so it proves "served == empty == failed" and NOT the sentence
  // the docs actually print — "diff the config directory across an ask you answered
  // and one you ignored". Answering is the one moment on this path that legitimately
  // creates data, so it is also the most plausible place for a local crumb (a cached
  // verdict, a "last answered" stamp, a spent-token note) to appear later without
  // anybody noticing. Held here rather than argued in a comment.
  const snapshots: Record<string, string[]> = {};
  for (const label of ['ignored', 'answered'] as const) {
    await withTempHome(async (env, dir) => {
      await runInflowDeadTime(payload(), {
        env,
        fetchImpl: SERVED().fetchImpl,
        readConfigImpl: SIGNED_IN,
        readRemoteImpl: REMOTE,
      });
      if (label === 'answered') {
        const graded = stubFetch(200, {
          outcome: 'got-it',
          reveal: { since: [] },
          effect: {},
          lesson: {},
        });
        const result = await answerAsk({ token: TOKEN, answer: 'because it merged' }, {
          env,
          fetchImpl: graded.fetchImpl,
          readConfigImpl: SIGNED_IN,
        });
        assert.equal(result.status, 'ok', 'precondition: this run really did grade an answer');
      }
      snapshots[label] = await snapshotDir(dir);
    });
  }
  assert.deepEqual(
    snapshots.answered,
    snapshots.ignored,
    'answering must leave no more on this machine than ignoring did',
  );
});

test('GUARD: an aged ring is still a spent ring — nothing may re-ask on the clock', async () => {
  // A re-ask does not have to write anything new to exist. Backdate the ring an hour
  // and fire again: a suppression that quietly expires leaves the bytes identical and
  // slips past every disk guard in this file, while re-asking the same person all day.
  // Every other test writes the ring milliseconds before reading it, so this branch is
  // the only thing that ever exercises an OLD one.
  await withTempHome(async (env) => {
    const { fetchImpl, calls } = SERVED();
    const deps = { env, fetchImpl, readConfigImpl: SIGNED_IN, readRemoteImpl: REMOTE };
    await runInflowDeadTime(payload(), deps);
    assert.equal(calls.length, 1);
    const ringPath = throttleStatePath(INFLOW_SESSION_FILE, env);
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(ringPath, longAgo, longAgo);
    await runInflowDeadTime(payload(), deps);
    assert.equal(calls.length, 1, 'a month-old claim is still a claim — time may not un-spend it');
  });
});

test('GUARD: nothing on this path writes to stdout, stderr or the environment', async () => {
  // The hook prints ONE JSON object and the host parses it. A stray log line under it
  // is a leak and a corruption at once, and it is the channel a "no counts" guard
  // written about request bodies never looks at. The environment is the same story:
  // a counter accumulated in a variable is still a counter.
  await withTempHome(async (env) => {
    const before = JSON.stringify(process.env);
    const { fetchImpl } = SERVED();
    const { value, wrote } = await withOutputCaptured(async () => {
      const out = await runInflowDeadTime(payload(), {
        env,
        fetchImpl,
        readConfigImpl: SIGNED_IN,
        readRemoteImpl: REMOTE,
      });
      await requestAsk({ trigger: 'on-demand', repo: 'acme/widgets' }, {
        fetchImpl: SERVED().fetchImpl,
        readConfigImpl: SIGNED_IN,
      });
      await answerAsk({ token: TOKEN, answer: 'because' }, {
        fetchImpl: stubFetch(200, { outcome: 'got-it', reveal: { since: [] }, effect: {}, lesson: {} }).fetchImpl,
        readConfigImpl: SIGNED_IN,
      });
      return out;
    });
    assert.ok(value.hookSpecificOutput, 'precondition: this run really did serve a question');
    assert.deepEqual(wrote, [], 'this path speaks only through its return value');
    assert.equal(JSON.stringify(process.env), before, 'nothing may accumulate in the environment');
  });
});

test('GUARD: the hook returns exactly one channel — the same question twice is the nag', async () => {
  // `systemMessage` alongside `additionalContext` would show the person the question
  // and tell the agent to relay it: one ask delivered twice. The header argues against
  // it at length, which historically is the best predictor that nothing checks it.
  await withTempHome(async (env) => {
    const { fetchImpl } = SERVED();
    const out = await runInflowDeadTime(payload(), {
      env,
      fetchImpl,
      readConfigImpl: SIGNED_IN,
      readRemoteImpl: REMOTE,
    });
    assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(out.hookSpecificOutput ?? {}).sort(), [
      'additionalContext',
      'hookEventName',
    ]);
  });
});

test('GUARD: this client never writes the token anywhere on the machine', async () => {
  // ⚠️ SCOPE, precisely. What is held here is that BACKTHREAD writes no token, no
  // question body and no material key. It is NOT "the token never touches disk":
  // the ask is delivered as `additionalContext`, and the host agent persists its
  // hooks' output verbatim into its own session transcript on disk. That transcript
  // is the host's, is never uploaded by capture (the redactor keeps only user and
  // assistant turns), and is outside this package's reach — but the honest claim is
  // about our writes, not about the machine, and the docs say it that way.
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
    assert.ok(!onDisk.includes(TOKEN), 'this client must not write the token down');
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
  // Header names are on the allowlist too. A count rides in a header just as happily
  // as in a body, and a guard that reads only the body waves it through.
  const ALLOWED_HEADERS = [
    'authorization',
    'content-type',
    'x-backthread-version',
    'x-backthread-agent',
    'x-backthread-redact-version',
    'x-backthread-platform',
    'x-backthread-node',
  ];
  for (const { url, init } of seen) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    assert.ok(path in ALLOWED, `unexpected endpoint: ${path}`);
    // The WHOLE url, not its pathname. A query string is the cheapest possible place
    // to put a tally and it is invisible to a pathname check.
    assert.equal(parsed.search, '', `${path} must carry no query string`);
    assert.equal(parsed.hash, '', `${path} must carry no fragment`);
    assert.equal(init.method, 'POST', `${path} must be a POST`);
    for (const name of Object.keys((init.headers ?? {}) as Record<string, string>)) {
      assert.ok(ALLOWED_HEADERS.includes(name.toLowerCase()), `${path} sent an unexpected header: ${name}`);
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      assert.ok(ALLOWED[path].includes(key), `${path} sent an unexpected field: ${key}`);
    }
    for (const value of Object.values(body)) {
      assert.equal(typeof value, 'string', `${path} sent a non-string field — a quantity has no business here`);
    }
  }
});

test('GUARD: nothing rendered to a person carries a quantity, on any branch', () => {
  // Two things went wrong the first time this was written, and both are fixed here.
  //
  // 1. IT SCANNED FOR DIGITS. "That is your third question this week" carries no digit
  //    and none of the banned words, and it walked straight through. Numbers spelled
  //    out are still numbers, so the vocabulary now covers them.
  // 2. IT SCANNED ONE FIXTURE'S HAPPY PATH. A count added under `if (ask.isOpen)`, or
  //    on the `produce` rung, or in the FAILURE branch of `formatAsk`, was invisible —
  //    the surfaces below now include every branch a person can actually reach.
  //
  // The server's own fields are stripped first, so this is a claim about OUR copy.
  // The one place the counting words legitimately appear is the sentence that FORBIDS
  // them: it is asserted present and then removed, so deleting it to quiet this guard
  // turns the guard red instead of green.
  const PROHIBITION = 'never add a score, a tally, or a';
  assert.ok(inflowHookContext('').includes(PROHIBITION), 'the agent is still told not to invent a tally');

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

  const OPEN = { ...ASK, isOpen: true };
  const PRODUCE = { ...ASK, rung: 'produce' as const };
  const ANSWER = {
    questionId: 'q',
    outcome: 'got-it' as const,
    verdict: 'got-it' as const,
    graded: true,
    note: null,
    reveal: { decided: null, why: null, rationale: null, since: [] },
    effect: { kind: 'none' },
    lesson: { id: 'l', completed: true },
  };

  const surfaces: Record<string, string> = {
    'the question block': formatAskBlock(ASK, PROMISE, 'bt ask-me'),
    'the question block, open': formatAskBlock(OPEN, PROMISE, 'bt ask-me'),
    'the question block, produce rung': formatAskBlock(PRODUCE, PROMISE, 'bt ask-me'),
    'the question block, no promise sent': formatAskBlock(ASK, null, 'bt ask-me'),
    'the injected instructions': inflowHookContext(formatAskBlock(ASK, PROMISE, 'bt ask-me')),
    'a served on-demand ask': formatAsk({ status: 'ok', detail: 'served', ask: ASK, reason: 'served', promise: PROMISE }, 'bt ask-me'),
    'an empty on-demand ask (nothing banked)': formatAsk({ status: 'ok', detail: 'nothing-banked', ask: null, reason: 'nothing-banked' }, 'bt ask-me'),
    'an empty on-demand ask (nothing new)': formatAsk({ status: 'ok', detail: 'nothing-new', ask: null, reason: 'nothing-new' }, 'bt ask-me'),
    'a failed on-demand ask': formatAsk({ status: 'failed', detail: 'the worker said no' }, 'bt ask-me'),
    'a signed-out on-demand ask': formatAsk({ status: 'no-auth', detail: 'no token' }, 'bt ask-me'),
    'a repo-less on-demand ask': formatAsk({ status: 'no-repo', detail: 'no repo' }, 'bt ask-me'),
    'a graded answer': formatAskAnswer({ status: 'ok', detail: 'ok', result: ANSWER }),
    'a failed answer': formatAskAnswer({ status: 'failed', detail: 'the worker said no' }),
    'the full statement': formatPromise({ status: 'ok', detail: 'served', promise: PROMISE }),
    'the statement, none sent': formatPromise({ status: 'ok', detail: 'served' }),
    'the statement, failed': formatPromise({ status: 'no-auth', detail: 'no token' }),
  };

  // Spelled-out ORDINALS are included, because "your third question this week" is
  // exactly what a well-meaning edit reaches for once digits are banned. Bare cardinals
  // ("one optional question") are deliberately NOT here — they are ordinary English on
  // this surface, and a guard that cries at them gets weakened rather than obeyed.
  const QUANTITY =
    /streak|tally|so far|in a row|out of|remaining|pending|score|%|\bstats?\b|\bcount(s|ed|ing)?\b|\btotal\b|\btimes\b|this week|today|\b(twice|thrice|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i;
  for (const [label, text] of Object.entries(surfaces)) {
    const ours = strip(text);
    assert.doesNotMatch(ours, /\d/, `${label} must contain no number of our own`);
    assert.doesNotMatch(ours, QUANTITY, `${label} must not imply a running total`);
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

test('GUARD: an empty record is silence in the flow and a first-class completion on demand', async () => {
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

test('GUARD: the only client-held framing is the pinned epilogue, and it claims nothing about the server', () => {
  // The bare-render guard above renders with an EMPTY promise, so the epilogue is
  // never in what it inspects — which is how an earlier wording ("...and the endpoint
  // it calls writes nothing when it asks") sat outside every drift check while making
  // a claim about server behaviour this client cannot verify. Two closed checks now:
  //
  //   (a) subtract the server's strings from the real render; whatever is left must be
  //       EXACTLY the pinned epilogue, so a new client-held sentence cannot appear
  //       without editing this test;
  //   (b) the epilogue itself may not assert what the server does.
  //
  // The expected text is written out HERE rather than imported, deliberately. Comparing
  // the render against `PROMISE_EPILOGUE` would pass for any edit that changed both at
  // once — which is every edit. Pinned literally, a reworded epilogue turns this test
  // red and somebody has to look at the new sentence.
  const PINNED = [
    'Those sentences come from the server that enforces them, not from this client, so',
    'they cannot drift from the behaviour they describe. What this client sends is',
    'readable in this open-source repo; what the server does with an answer you are',
    'taking on trust — which is why the statement is written as things you could go and',
    'check rather than as reassurance.',
  ];
  assert.deepEqual([...PROMISE_EPILOGUE], PINNED, 'the epilogue changed — read it, then update this pin');
  const full = formatPromise({ status: 'ok', detail: 'served', promise: PROMISE });
  const leftover = full
    .split('\n')
    .map((l) => l.replace(/^ {2}- /, ''))
    .filter((l) => l.trim() !== '')
    .filter((l) => l !== PROMISE.title && !PROMISE.points.includes(l));
  assert.deepEqual(
    leftover,
    PINNED,
    'the client rendered a sentence of its own that this guard has not been shown',
  );
  // A closed blocklist of server-behaviour verbs. The epilogue may say where the words
  // came from; it may not say what the other side of the wire does with them.
  const epilogue = PROMISE_EPILOGUE.join(' ');
  assert.doesNotMatch(
    epilogue,
    /\b(writes? nothing|stores? nothing|records? nothing|is not (recorded|stored|counted)|never (writes|stores|records|counts)|no row)\b/i,
    'the epilogue is claiming server behaviour this client cannot check — say it is trust, or delete it',
  );
});

test('GUARD: the permission to ignore rides with the question itself, not only behind a command', () => {
  const block = formatAskBlock(ASK, PROMISE, 'bt ask-me');
  assert.ok(block.startsWith(PROMISE.short), 'it is the first thing anybody reads');
  assert.ok(inflowHookContext(block).includes(PROMISE.short), 'and it survives into the flow');
});
