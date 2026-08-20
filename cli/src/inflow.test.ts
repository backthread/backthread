// inflow.test.ts — the in-flow ask relay and what it renders.
//
// Everything here is offline: fetch, config and the git-remote reader are injected.
// The NEGATIVE properties — no counts, no spool, no pre-edit trigger, an ignored ask
// leaving nothing — live in `inflowGuards.test.ts`, which is written so that adding
// the forbidden thing turns it red.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  requestAsk,
  answerAsk,
  formatAsk,
  formatAskBlock,
  formatAskAnswer,
  formatPromise,
  normalizeAsk,
  normalizePromise,
  askInvocation,
  INFLOW_TRIGGERS,
} from './inflow.js';
import { TOKEN, ASK, PROMISE, stubFetch, SIGNED_IN } from './inflowFixtures.test.js';

// --- the guard suite is present and ran ------------------------------------------

test('the guard suite exists and still guards every property it claims to', async () => {
  // A TRIPWIRE, because `node --test src/*.test.ts` is a glob: deleting
  // `inflowGuards.test.ts` outright leaves the suite GREEN and every negative property
  // in this feature unguarded, with nothing to notice. Measured — it did.
  //
  // Named properties rather than a bare count, so that renaming a guard is fine and
  // dropping the thing it protects is not.
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'inflowGuards.test.ts'),
    'utf8',
  );
  const REQUIRED = [
    'PostToolUse and nowhere else',
    'matcher names no editing tool',
    'refuses every editing tool',
    'trigger vocabulary',
    'routes to a known subcommand',
    'byte-identical whether a question came back',
    'byte-identical whether the ask was answered or ignored',
    'aged ring is still a spent ring',
    'writes to stdout, stderr or the environment',
    'exactly one channel',
    'never writes the token anywhere',
    'produce a re-ask from what was stored',
    'closed allowlist of url, method and body keys',
    'carries a quantity, on any branch',
    'names a participation quantity',
    'first-class completion',
    'holds no promise sentences of its own',
    'only client-held framing is the pinned epilogue',
    'permission to ignore rides with the question',
  ];
  for (const name of REQUIRED) {
    assert.ok(src.includes(name), `the guard for "${name}" is gone`);
  }
});

// --- the two triggers ------------------------------------------------------------

test('the trigger list is exactly the two in-flow moments', () => {
  assert.deepEqual([...INFLOW_TRIGGERS], ['dead-time', 'on-demand']);
});

test('a served ask comes back whole, with the promise beside it', async () => {
  const { fetchImpl, calls } = stubFetch(200, { ask: ASK, reason: 'served', promise: PROMISE });
  const outcome = await requestAsk(
    { trigger: 'on-demand', repo: 'acme/widgets' },
    { fetchImpl, readConfigImpl: SIGNED_IN },
  );
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.reason, 'served');
  assert.equal(outcome.ask?.token, TOKEN);
  assert.equal(outcome.promise?.short, PROMISE.short);
  assert.match(calls[0].url, /\/inflow\/ask$/);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    repo: 'acme/widgets',
    trigger: 'on-demand',
  });
});

test('an empty reply is an ok outcome, not a failure', async () => {
  for (const reason of ['nothing-banked', 'nothing-new']) {
    const { fetchImpl } = stubFetch(200, { ask: null, reason, promise: PROMISE });
    const outcome = await requestAsk(
      { trigger: 'dead-time', repo: 'acme/widgets' },
      { fetchImpl, readConfigImpl: SIGNED_IN },
    );
    assert.equal(outcome.status, 'ok', `${reason} must be ok`);
    assert.equal(outcome.ask, null);
    assert.equal(outcome.reason, reason);
  }
});

test('an unrecognised reason reads as "nothing to ask", never as a question', async () => {
  const { fetchImpl } = stubFetch(200, { ask: null, reason: 'something-new', promise: PROMISE });
  const outcome = await requestAsk(
    { trigger: 'on-demand', repo: 'acme/widgets' },
    { fetchImpl, readConfigImpl: SIGNED_IN },
  );
  assert.equal(outcome.reason, 'nothing-new');
});

test('`served` with an unparseable ask is a failure, not half a question', async () => {
  const { fetchImpl } = stubFetch(200, { ask: { body: 'no token here' }, reason: 'served' });
  const outcome = await requestAsk(
    { trigger: 'on-demand', repo: 'acme/widgets' },
    { fetchImpl, readConfigImpl: SIGNED_IN },
  );
  assert.equal(outcome.status, 'failed');
});

test('no device token stops before any request', async () => {
  const { fetchImpl, calls } = stubFetch(200, {});
  const outcome = await requestAsk(
    { trigger: 'on-demand', repo: 'acme/widgets' },
    { fetchImpl, readConfigImpl: async () => ({}) as never },
  );
  assert.equal(outcome.status, 'no-auth');
  assert.equal(calls.length, 0);
});

test('no resolvable repo stops before any request', async () => {
  const { fetchImpl, calls } = stubFetch(200, {});
  const outcome = await requestAsk(
    { trigger: 'on-demand' },
    { fetchImpl, readConfigImpl: async () => ({ device_token: 'dt' }) as never },
  );
  assert.equal(outcome.status, 'no-repo');
  assert.equal(calls.length, 0);
});

test('a non-200 and a thrown fetch both resolve, never throw', async () => {
  const { fetchImpl } = stubFetch(500, { error: 'boom' });
  const bad = await requestAsk(
    { trigger: 'on-demand', repo: 'acme/widgets' },
    { fetchImpl, readConfigImpl: SIGNED_IN },
  );
  assert.equal(bad.status, 'failed');

  const threw = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const down = await requestAsk(
    { trigger: 'on-demand', repo: 'acme/widgets' },
    { fetchImpl: threw, readConfigImpl: SIGNED_IN },
  );
  assert.equal(down.status, 'failed');
});

// --- answering ---------------------------------------------------------------------

test('an answer posts the opaque token and the typed words, and nothing else', async () => {
  const { fetchImpl, calls } = stubFetch(200, {
    questionId: 'q1',
    outcome: 'got-it',
    verdict: 'got-it',
    graded: true,
    note: 'Right — the gate is about merge, not about capture.',
    reveal: { decided: 'Hold until merge', why: 'because', rationale: 'the record', since: [] },
    effect: { kind: 'coverage' },
    lesson: { id: 'l1', completed: true },
  });
  const outcome = await answerAsk({ token: TOKEN, answer: 'because it merged' }, {
    fetchImpl,
    readConfigImpl: SIGNED_IN,
  });
  assert.equal(outcome.status, 'ok');
  assert.match(calls[0].url, /\/inflow\/answer$/);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    token: TOKEN,
    answer: 'because it merged',
  });
  const text = formatAskAnswer(outcome);
  assert.match(text, /^Got it\./);
  assert.match(text, /what the record says/);
});

test('a declared outcome replaces the answer rather than riding alongside it', async () => {
  const { fetchImpl, calls } = stubFetch(200, {
    outcome: 'disagree',
    reveal: { since: [] },
    effect: {},
    lesson: {},
  });
  await answerAsk({ token: TOKEN, outcome: 'disagree' }, { fetchImpl, readConfigImpl: SIGNED_IN });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { token: TOKEN, outcome: 'disagree' });
});

test('an expired ask is reported as the design working, never as a fault', async () => {
  const { fetchImpl } = stubFetch(410, { error: 'ask_expired' });
  const outcome = await answerAsk({ token: TOKEN, answer: 'late' }, {
    fetchImpl,
    readConfigImpl: SIGNED_IN,
  });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail, /nothing is owed/);
  assert.doesNotMatch(outcome.detail, /fail|wrong|missed/i);
});

test('a BARE 410 — no body at all — still gets the reassurance, not a status line', async () => {
  // The status check in expiryAwareDetail exists for exactly this shape, and without this
  // case deleting it is invisible: every other 410 test sends `{error:'ask_expired'}`,
  // which the override table catches on its own.
  const { fetchImpl } = stubFetch(410, {});
  const outcome = await answerAsk(
    { token: TOKEN, answer: 'because' },
    { env: {} as NodeJS.ProcessEnv, fetchImpl, readConfigImpl: SIGNED_IN },
  );
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail, /nothing is owed and nothing is missing/);
  assert.doesNotMatch(outcome.detail, /HTTP 410/);
});

test('material that moved is reported honestly, and not against the person', async () => {
  const { fetchImpl } = stubFetch(409, { error: 'ask_material_moved' });
  const outcome = await answerAsk({ token: TOKEN, answer: 'x' }, {
    fetchImpl,
    readConfigImpl: SIGNED_IN,
  });
  assert.match(outcome.detail, /Nothing was recorded against you/);
});

test('an empty reply with no declared outcome never reaches the network', async () => {
  const { fetchImpl, calls } = stubFetch(200, {});
  const outcome = await answerAsk({ token: TOKEN, answer: '   ' }, {
    fetchImpl,
    readConfigImpl: SIGNED_IN,
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(calls.length, 0);
});

test('a missing token never reaches the network', async () => {
  const { fetchImpl, calls } = stubFetch(200, {});
  const outcome = await answerAsk({ token: '', answer: 'hi' }, {
    fetchImpl,
    readConfigImpl: SIGNED_IN,
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(calls.length, 0);
});

// --- normalizers ---------------------------------------------------------------------

test('an ask with no token or no body is not a question', () => {
  assert.equal(normalizeAsk({ ...ASK, token: '' }), null);
  assert.equal(normalizeAsk({ ...ASK, body: '  ' }), null);
  assert.equal(normalizeAsk(null), null);
  assert.equal(normalizeAsk('nope'), null);
});

test('an unknown rung degrades to recognise rather than to teach', () => {
  assert.equal(normalizeAsk({ ...ASK, rung: 'invented' })?.rung, 'recognise');
});

test('a promise with nothing in it is null, not an empty reassurance', () => {
  assert.equal(normalizePromise({ short: '', title: '', points: [] }), null);
  assert.equal(normalizePromise(null), null);
  assert.deepEqual(normalizePromise({ short: 'a', title: 'b', points: ['c', 7] }), {
    short: 'a',
    title: 'b',
    points: ['c'],
  });
});

// --- rendering ------------------------------------------------------------------------

test('the question block leads with the permission to ignore, then asks', () => {
  const text = formatAskBlock(ASK, PROMISE, 'bt ask-me');
  assert.ok(text.startsWith(PROMISE.short), 'the permission to ignore comes first');
  assert.ok(text.includes(ASK.body));
  assert.ok(text.includes(`bt ask-me --answer '${TOKEN}'`));
  assert.match(text, /--disagree/);
  assert.match(text, /--bad-question/);
});

test('an open question is labelled a contribution, never a graded one', () => {
  const text = formatAskBlock({ ...ASK, isOpen: true }, PROMISE, 'bt ask-me');
  assert.match(text, /OPEN/);
  assert.match(text, /becomes the record/);
});

test('nothing on record renders as a complete answer with no zero and no percentage', () => {
  for (const reason of ['nothing-banked', 'nothing-new'] as const) {
    const text = formatAsk({ status: 'ok', detail: reason, ask: null, reason }, 'bt ask-me');
    assert.match(text, /Nothing on record here/);
    assert.doesNotMatch(text, /%|caught up|skipped|error|warning/i);
    assert.doesNotMatch(text, /\d/, 'a quiet repo is never reported as a number');
  }
});

test('the promise renders every sentence the server sent, and none of its own', () => {
  const text = formatPromise({ status: 'ok', detail: 'served', promise: PROMISE });
  assert.ok(text.includes(PROMISE.title));
  for (const point of PROMISE.points) assert.ok(text.includes(point), `missing: ${point}`);
});

test('the promise is the SERVER\'s words — change the payload and the output changes', () => {
  // The point of this one: it fails if anybody ever hardcodes the sentences here.
  const text = formatPromise({
    status: 'ok',
    detail: 'served',
    promise: { short: 's', title: 'A DIFFERENT TITLE', points: ['a different point'] },
  });
  assert.ok(text.includes('A DIFFERENT TITLE'));
  assert.ok(text.includes('a different point'));
  assert.ok(!text.includes(PROMISE.title));
});

test('no promise from the server produces no invented reassurance', () => {
  const text = formatPromise({ status: 'ok', detail: 'served' });
  assert.match(text, /sent no statement/);
});

test('a failure renders as itself, and login failures point at login', () => {
  assert.match(formatAsk({ status: 'no-auth', detail: 'nope' }, 'bt'), /backthread login/);
  assert.match(formatAskAnswer({ status: 'failed', detail: 'nope' }), /nope/);
});

test('a graded in-flow answer never claims the person is done for the day', () => {
  const done = formatAskAnswer({
    status: 'ok',
    detail: 'ok',
    result: {
      questionId: 'q',
      outcome: 'got-it',
      verdict: 'got-it',
      graded: true,
      note: null,
      reveal: { decided: null, why: null, rationale: null, since: [] },
      effect: { kind: 'none' },
      lesson: { id: 'l', completed: true },
    },
  });
  assert.equal(done, 'Got it.');
  assert.doesNotMatch(done, /today|done|last question/i);
});

test('the submit invocation is derived from how this process started', () => {
  assert.equal(askInvocation(['node', '/plugins/bt/dist-bundle/backthread.js']), 'node "/plugins/bt/dist-bundle/backthread.js" ask-me');
  assert.equal(askInvocation(['node']), 'backthread ask-me');
});
