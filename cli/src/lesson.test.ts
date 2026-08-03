// lesson.test.ts — the /backthread:learn relay.
//
// The product rules are the assertions: the verdict is binary and unscored, a
// caught-up or teaching-card lesson is a real completion, "I disagree" and "Bad
// question" are offered on every lesson and are never treated as wrong answers,
// and an open question is presented as a contribution rather than a test.
//
// Offline throughout — fetch, config and the git-remote reader are injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  startLesson,
  answerLesson,
  formatLesson,
  formatLessonAnswer,
  normalizeLesson,
  normalizeAnswer,
  learnInvocation,
  type LessonStartOutcome,
} from './lesson.js';

const CONFIG = { device_token: 'bt_test_token', repo: 'acme/widgets' };

function deps(fetchImpl: typeof fetch) {
  return {
    env: {} as NodeJS.ProcessEnv,
    fetchImpl,
    readConfigImpl: async () => CONFIG,
    readRemoteImpl: () => 'git@github.com:acme/widgets.git',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const GRADED_LESSON = {
  lesson: {
    id: 'lesson-1',
    kind: 'graded',
    repo: 'acme/widgets',
    createdAt: '2026-08-03T09:00:00Z',
    cached: false,
    items: [
      { id: 'q0', ordinal: 1, rung: 'teach', shape: null, subsystem: 'Billing', body: 'Charges are idempotent.', isOpen: false },
      { id: 'q1', ordinal: 2, rung: 'produce', shape: 'why', subsystem: 'Billing', body: 'Why is the charge keyed on the order id?', isOpen: false },
      { id: 'q2', ordinal: 3, rung: 'produce', shape: 'open', subsystem: 'Ingest', body: 'Why does the walk restart from HEAD?', isOpen: true },
    ],
  },
};

// --- start ----------------------------------------------------------------------

test('a graded lesson comes back with its items and question ids', async () => {
  const outcome = await startLesson({ cwd: '/repo' }, deps((async () => jsonResponse(GRADED_LESSON)) as unknown as typeof fetch));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.lesson?.kind, 'graded');
  assert.equal(outcome.lesson?.items.length, 3);
  assert.equal(outcome.lesson?.items[2].isOpen, true);
});

test('the request carries the repo slug and the bearer token, and never logs it', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const impl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return jsonResponse(GRADED_LESSON);
  }) as unknown as typeof fetch;
  const outcome = await startLesson({ cwd: '/repo' }, deps(impl));
  assert.equal(outcome.status, 'ok');
  assert.match(seen!.url, /\/lesson\/start$/);
  assert.equal(JSON.parse(String(seen!.init.body)).repo, 'acme/widgets');
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, 'Bearer bt_test_token');
  // Nothing about the machine's files goes out — only the slug.
  assert.deepEqual(Object.keys(JSON.parse(String(seen!.init.body))), ['repo']);
});

test('no token and no repo are reported, not thrown', async () => {
  const never = (async () => {
    throw new Error('should not be called');
  }) as unknown as typeof fetch;
  const noAuth = await startLesson({ cwd: '/repo' }, { ...deps(never), readConfigImpl: async () => ({}) });
  assert.equal(noAuth.status, 'no-auth');
  const noRepo = await startLesson(
    {},
    { ...deps(never), readConfigImpl: async () => ({ device_token: 't' }), readRemoteImpl: () => null },
  );
  assert.equal(noRepo.status, 'no-repo');
});

test('a build already in flight is its own status, not a failure', async () => {
  const impl = (async () =>
    jsonResponse({ error: 'lesson_in_progress', message: 'a lesson is already being prepared — try again in a moment' }, 409)) as unknown as typeof fetch;
  const outcome = await startLesson({ cwd: '/repo' }, deps(impl));
  assert.equal(outcome.status, 'in-progress');
  assert.match(outcome.detail, /already being prepared/);
});

test('a network failure resolves rather than throwing', async () => {
  const impl = (async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  const outcome = await startLesson({ cwd: '/repo' }, deps(impl));
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail, /socket hang up/);
});

// --- rendering the lesson --------------------------------------------------------

function okLesson(body: unknown): LessonStartOutcome {
  const lesson = normalizeLesson(body, 'acme/widgets')!;
  return { status: 'ok', detail: '', lesson, repo: { owner: 'acme', name: 'widgets' } };
}

test('a graded lesson prints its questions, ids, and both no-cost replies', () => {
  const text = formatLesson(okLesson(GRADED_LESSON), 'node "/x/backthread.js" learn');
  assert.match(text, /Why is the charge keyed on the order id\?/);
  assert.match(text, /question-id: q1/);
  assert.match(text, /--disagree/);
  assert.match(text, /--bad-question/);
  assert.match(text, /neither costs anything/i);
  // The teach card is presented as having nothing to answer.
  assert.match(text, /TEACH — nothing to answer/);
  // An open question is labelled a contribution, not a test.
  assert.match(text, /OPEN — no recorded answer/);
  // Nothing anywhere resembles a score.
  assert.doesNotMatch(text, /\bscore\b|\d+\s*%|\d+\s*\/\s*\d+\s*correct/i);
});

test('a caught-up day is rendered as a finished lesson, not a shortfall', () => {
  const text = formatLesson(
    okLesson({ lesson: { id: 'l2', kind: 'caught-up', repo: 'acme/widgets', createdAt: '', cached: false, items: [] } }),
    'node "/x/backthread.js" learn',
  );
  assert.match(text, /You're caught up/);
  assert.match(text, /finished lesson, not a short one/);
  // It must not ask for anything or imply more was owed.
  assert.doesNotMatch(text, /question-id:/);
});

test('a teaching-card day says why it is short without blaming the reader', () => {
  const text = formatLesson(
    okLesson({
      lesson: {
        id: 'l3',
        kind: 'teaching-card',
        repo: 'acme/widgets',
        createdAt: '',
        cached: false,
        items: [{ id: 't1', ordinal: 1, rung: 'teach', subsystem: 'Ingest', body: 'The walk now seeds from HEAD.', isOpen: false }],
      },
    }),
    'node "/x/backthread.js" learn',
  );
  assert.match(text, /Reading it is the whole lesson/);
  assert.match(text, /The walk now seeds from HEAD\./);
  // Nothing is answerable, so the submit instructions must not appear — printing
  // them would invite an answer to a teach card, which the server refuses.
  assert.doesNotMatch(text, /how to submit an answer/);
  assert.match(text, /Nothing to answer here/);
});

test('a resumed lesson says so', () => {
  const body = JSON.parse(JSON.stringify(GRADED_LESSON));
  body.lesson.cached = true;
  const text = formatLesson(okLesson(body), 'node "/x/backthread.js" learn');
  assert.match(text, /resuming the one you left unfinished/);
});

test('a failure renders as a message, with the login hint when that is the cause', () => {
  assert.match(formatLesson({ status: 'no-auth', detail: 'not authenticated' }, 'x'), /backthread login/);
  assert.match(formatLesson({ status: 'failed', detail: 'boom' }, 'x'), /boom/);
});

// --- answering --------------------------------------------------------------------

const REVEAL = {
  decided: 'Key charges on the order id',
  why: 'Retries must not double-charge.',
  rationale: 'A uuid per attempt was rejected: retries generate a new one.',
  since: [],
};

test('a correct answer prints the binary verdict and then the rationale', async () => {
  const impl = (async () =>
    jsonResponse({
      questionId: 'q1',
      outcome: 'got-it',
      verdict: 'got-it',
      graded: true,
      note: 'Right — idempotency is the reason.',
      reveal: REVEAL,
      effect: { kind: 'none', reason: 'a verdict has no effect on the record' },
      lesson: { id: 'lesson-1', completed: false },
    })) as unknown as typeof fetch;
  const outcome = await answerLesson({ questionId: 'q1', answer: 'so retries do not double-charge' }, deps(impl));
  assert.equal(outcome.status, 'ok');
  const text = formatLessonAnswer(outcome);
  assert.match(text, /^Got it\./);
  assert.match(text, /A uuid per attempt was rejected/);
  assert.doesNotMatch(text, /\bscore\b|\d+\s*%/i);
});

test('a wrong answer is still followed by the rationale, and nothing is tallied', async () => {
  const impl = (async () =>
    jsonResponse({
      questionId: 'q1',
      outcome: 'not-yet',
      verdict: 'not-yet',
      graded: true,
      note: 'Not quite — it is about retries.',
      reveal: REVEAL,
      effect: { kind: 'none', reason: '' },
      lesson: { id: 'lesson-1', completed: false },
    })) as unknown as typeof fetch;
  const text = formatLessonAnswer(await answerLesson({ questionId: 'q1', answer: 'for speed' }, deps(impl)));
  assert.match(text, /^Not yet\./);
  assert.match(text, /--- what the record says ---/);
  assert.doesNotMatch(text, /wrong so far|attempts|streak of/i);
});

test('"I disagree" is recorded, not graded, and is said to cost nothing', async () => {
  let body: Record<string, unknown> | null = null;
  const impl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return jsonResponse({
      questionId: 'q1',
      outcome: 'disagree',
      verdict: null,
      graded: false,
      note: null,
      reveal: REVEAL,
      effect: { kind: 'drift-signal', decisionId: 'd1' },
      lesson: { id: 'lesson-1', completed: false },
    });
  }) as unknown as typeof fetch;
  const outcome = await answerLesson({ questionId: 'q1', outcome: 'disagree' }, deps(impl));
  assert.equal(body!.outcome, 'disagree');
  const text = formatLessonAnswer(outcome);
  assert.doesNotMatch(text, /Not yet\./);
  assert.match(text, /cost you nothing/);
  assert.match(text, /possibly out of date/);
});

test('"Bad question" is recorded the same way', async () => {
  const impl = (async () =>
    jsonResponse({
      questionId: 'q1',
      outcome: 'bad-question',
      verdict: null,
      graded: false,
      note: null,
      reveal: REVEAL,
      effect: { kind: 'question-killed', materialKey: 'm1' },
      lesson: { id: 'lesson-1', completed: false },
    })) as unknown as typeof fetch;
  const text = formatLessonAnswer(await answerLesson({ questionId: 'q1', outcome: 'bad-question' }, deps(impl)));
  assert.match(text, /won't be asked again/);
  assert.match(text, /cost you nothing/);
  assert.doesNotMatch(text, /Not yet\./);
});

test('an open answer reads as a contribution, never as a mark', async () => {
  const impl = (async () =>
    jsonResponse({
      questionId: 'q2',
      outcome: 'answered-open',
      verdict: null,
      graded: false,
      note: null,
      reveal: { decided: null, why: null, rationale: null, since: [] },
      effect: { kind: 'rationale-recorded', decisionId: 'd2' },
      lesson: { id: 'lesson-1', completed: true },
    })) as unknown as typeof fetch;
  const text = formatLessonAnswer(await answerLesson({ questionId: 'q2', answer: 'because the walk is cheap' }, deps(impl)));
  assert.match(text, /not graded/);
  assert.match(text, /your answer is now the record/);
  assert.doesNotMatch(text, /Not yet\./);
  assert.match(text, /done for today/);
});

test('a declared outcome may be sent with no text; a bare answer may not be empty', async () => {
  const never = (async () => {
    throw new Error('should not be called');
  }) as unknown as typeof fetch;
  const empty = await answerLesson({ questionId: 'q1', answer: '   ' }, deps(never));
  assert.equal(empty.status, 'failed');
  assert.match(empty.detail, /answer is required/);
  const noId = await answerLesson({ questionId: '  ' }, deps(never));
  assert.equal(noId.status, 'failed');
  assert.match(noId.detail, /question id is required/);
});

test('the client cannot declare itself correct', async () => {
  let body: Record<string, unknown> | null = null;
  const impl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return jsonResponse({
      questionId: 'q1',
      outcome: 'not-yet',
      verdict: 'not-yet',
      graded: true,
      note: null,
      reveal: REVEAL,
      effect: { kind: 'none', reason: '' },
      lesson: { id: 'l', completed: false },
    });
  }) as unknown as typeof fetch;
  // `got-it` is not a declarable outcome — it is dropped rather than relayed.
  await answerLesson({ questionId: 'q1', answer: 'a', outcome: 'got-it' as never }, deps(impl));
  assert.equal('outcome' in body!, false, 'a self-granted verdict never reaches the server');
});

// --- normalizers + invocation -------------------------------------------------------

test('a malformed payload degrades instead of throwing', () => {
  assert.equal(normalizeLesson(null, 'a/b'), null);
  assert.equal(normalizeLesson({ lesson: null }, 'a/b'), null);
  const l = normalizeLesson({ lesson: { id: 'x', kind: 'nonsense', items: 'not-an-array' } }, 'a/b')!;
  assert.equal(l.kind, 'graded');
  assert.deepEqual(l.items, []);
  assert.equal(l.repo, 'a/b');

  const a = normalizeAnswer({ outcome: 'invented', verdict: 'perfect' }, 'q9');
  assert.equal(a.questionId, 'q9');
  assert.equal(a.verdict, null, 'an unrecognized verdict is no verdict at all');
  assert.equal(a.outcome, null, 'and it is NEVER coerced into the negative verdict');
});

test('an unrecognized payload never renders as "Not yet." — the one label we must not invent', () => {
  const text = formatLessonAnswer({
    status: 'ok',
    detail: '',
    result: normalizeAnswer({ outcome: 'something-new', reveal: REVEAL }, 'q9'),
  });
  assert.doesNotMatch(text, /Not yet\./);
  assert.doesNotMatch(text, /Got it\./);
  assert.match(text, /^Recorded\./, 'it says the neutral, true thing instead');
  assert.match(text, /A uuid per attempt was rejected/, 'and still shows the rationale');
});

test('the submit invocation is absolute, because the host shell has no plugin root', () => {
  assert.equal(learnInvocation(['/usr/bin/node', '/plug/dist-bundle/backthread.js']), 'node "/plug/dist-bundle/backthread.js" learn');
  assert.equal(learnInvocation(['/usr/bin/node']), 'backthread learn');
});
