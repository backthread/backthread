// failureCopy.test.ts — the sentence a person reads when the server says no.
//
// Three layers, and the third is the one that matters most:
//
//   1. the renderer itself — reason → sentence, and the operator fields stay hidden;
//   2. a CONFORMANCE BATTERY that drives every real cli entry point through a stubbed
//      rejection and reads the string it actually produces. A unit test of the renderer
//      proves the renderer works; it proves nothing about whether a route CALLS it, and
//      "the route never called it" is precisely the defect this file exists about;
//   3. a REGISTRY-COMPLETENESS guard, so a NEW route cannot join the package without
//      somebody stating what a person sees when it fails.
//
// Layer 3 is the anti-recurrence mechanism. The original defect was fixed on one route
// while four identical copies sat untouched, so a fix that relied on the next author
// remembering would be a convention, and conventions get deleted. This one goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeFailure,
  verboseEnabled,
  readServerMessage,
  CLI_ENDPOINTS,
  FUNCTIONS_SLUG_COPY,
  type EndpointDisposition,
} from './failureCopy.js';
import { queryDecisions } from './query.js';
import { startLesson, answerLesson } from './lesson.js';
import { requestAsk, answerAsk } from './inflow.js';
import { serverInfer } from './infer.js';
import { syncDecisions } from './localDecisions.js';
import { runCapture } from './capture.js';
import { fetchOnboardingState } from './onboardingState.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** The canonical relayed-failure body: a machine slug, a retry verdict, a SQLSTATE. */
const OVERLOADED = { error: 'retrieval_failed', reason: 'overloaded', code: '57014' };
const UNAVAILABLE = { error: 'lesson_persist_failed', reason: 'unavailable', code: '08006' };

const PLAIN_ENV = {} as NodeJS.ProcessEnv;
const VERBOSE_ENV = { BACKTHREAD_VERBOSE: '1' } as NodeJS.ProcessEnv;

// --- 1. the renderer ---------------------------------------------------------------

test('overloaded promises a retry, because the server said the retry is worth it', () => {
  const out = describeFailure({
    lead: 'the answer did not come back',
    status: 502,
    payload: OVERLOADED,
    env: PLAIN_ENV,
  });
  assert.match(out, /The database was busy — try again in a moment\./);
});

test('unavailable refuses to promise a retry', () => {
  const out = describeFailure({
    lead: 'the answer did not come back',
    status: 502,
    payload: UNAVAILABLE,
    env: PLAIN_ENV,
  });
  assert.match(out, /It failed on our side, and retrying is unlikely to help\./);
  // The distinction is the whole contract: the two reasons must not read the same.
  assert.doesNotMatch(out, /try again in a moment/);
});

test('neither the machine slug nor the SQLSTATE is product copy', () => {
  const out = describeFailure({
    lead: 'the answer did not come back',
    status: 502,
    payload: OVERLOADED,
    env: PLAIN_ENV,
  });
  assert.doesNotMatch(out, /retrieval_failed/);
  assert.doesNotMatch(out, /57014/);
  assert.doesNotMatch(out, /502/);
});

test('an operator who asks gets the status, the slug and the SQLSTATE', () => {
  const out = describeFailure({
    lead: 'the answer did not come back',
    status: 502,
    payload: OVERLOADED,
    env: VERBOSE_ENV,
  });
  assert.match(out, /\[status=502 error=retrieval_failed reason=overloaded code=57014\]/);
  // …WITHOUT losing the sentence. Verbose adds; it never replaces.
  assert.match(out, /The database was busy/);
});

test('the operator suffix names only the fields that are actually there', () => {
  const out = describeFailure({
    lead: 'x',
    status: 502,
    payload: { error: 'lesson_build_failed', reason: 'unavailable' },
    env: VERBOSE_ENV,
  });
  assert.match(out, /\[status=502 error=lesson_build_failed reason=unavailable\]$/);
  assert.doesNotMatch(out, /code=/);
});

test('a server-AUTHORED message renders verbatim — that is how the 426 upgrade text survives', () => {
  const out = describeFailure({
    lead: 'the answer did not come back',
    status: 426,
    payload: { error: 'client_too_old', message: 'please update backthread: npm i -g backthread' },
    env: PLAIN_ENV,
  });
  assert.match(out, /please update backthread: npm i -g backthread/);
  assert.doesNotMatch(out, /client_too_old/);
});

test('a body carrying BOTH prefers the reason — a relayed failure has no message to prefer', () => {
  // Belt and braces. The worker's allow-list means this body cannot occur today; if a
  // future route sends one anyway, the retry verdict is the more actionable half.
  const out = describeFailure({
    lead: 'x',
    status: 502,
    payload: { ...OVERLOADED, message: 'canceling statement due to statement timeout' },
    env: PLAIN_ENV,
  });
  assert.match(out, /The database was busy/);
  assert.doesNotMatch(out, /canceling statement/);
});

test('an unrecognisable body says the status and stops — it never guesses', () => {
  const out = describeFailure({ lead: 'x', status: 500, payload: {}, env: PLAIN_ENV });
  assert.equal(out, 'x. The server rejected it (HTTP 500).');
});

test('a bogus reason value is not a reason', () => {
  const out = describeFailure({
    lead: 'x',
    status: 502,
    payload: { error: 'e', reason: 'busy-ish' },
    env: PLAIN_ENV,
  });
  assert.doesNotMatch(out, /The database was busy/);
  assert.match(out, /HTTP 502/);
});

test('a slug override replaces the verdict but not the operator suffix', () => {
  const out = describeFailure({
    lead: 'your answer was not recorded',
    status: 409,
    payload: { error: 'ask_expired', reason: 'unavailable' },
    env: VERBOSE_ENV,
    overrides: { ask_expired: 'that ask has expired.' },
  });
  assert.match(out, /^that ask has expired\./);
  assert.doesNotMatch(out, /retrying is unlikely/);
  assert.match(out, /\[status=409 error=ask_expired reason=unavailable\]/);
});

test('an override for a slug that did not arrive does nothing', () => {
  const out = describeFailure({
    lead: 'x',
    status: 502,
    payload: OVERLOADED,
    env: PLAIN_ENV,
    overrides: { ask_expired: 'expired.' },
  });
  assert.match(out, /The database was busy/);
});

test('describeFailure never throws and never returns nothing', () => {
  for (const payload of [
    {},
    { error: 42 },
    { reason: null },
    { message: '' },
    { code: 57014 },
  ] as Array<Record<string, unknown>>) {
    const out = describeFailure({ lead: 'x', status: 0, payload, env: PLAIN_ENV });
    assert.ok(out.length > 0);
  }
});

test('verboseEnabled accepts the obvious truthy spellings and nothing else', () => {
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
    assert.equal(verboseEnabled({ BACKTHREAD_VERBOSE: on } as NodeJS.ProcessEnv), true, on);
  }
  for (const off of ['', '0', 'false', 'no', 'off', 'maybe']) {
    assert.equal(verboseEnabled({ BACKTHREAD_VERBOSE: off } as NodeJS.ProcessEnv), false, off);
  }
  assert.equal(verboseEnabled({} as NodeJS.ProcessEnv), false);
});

test('readServerMessage reads message and NEVER falls back to the slug', () => {
  // The helper this replaced was `message ?? String(error)`. That fallback IS the bug:
  // a relayed failure body has no `message`, so the fallback was the normal path.
  assert.equal(readServerMessage({ message: 'hello' }), 'hello');
  assert.equal(readServerMessage({ error: 'retrieval_failed' }), null);
  assert.equal(readServerMessage({ message: '' }), null);
});

// --- 2. the conformance battery ------------------------------------------------------

/** Drive one real entry point against a stubbed rejection; return what a person reads. */
type Driver = (status: number, body: unknown, env: NodeJS.ProcessEnv) => Promise<string>;

function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

const CONFIG = { device_token: 'dt_test', repo: 'acme/widgets' };
const readConfigImpl = async () => CONFIG as never;
const readRemoteImpl = () => 'git@github.com:acme/widgets.git';

/**
 * One driver per `failure-body` endpoint, keyed by the SAME builder name the registry
 * uses. The key sets are asserted equal below, so a registry entry with no driver is red.
 */
const DRIVERS: Readonly<Record<string, Driver>> = {
  buildGroundedAskUrl: async (status, body, env) =>
    (
      await queryDecisions(
        { question: 'q', repo: 'acme/widgets' },
        { env, fetchImpl: stubFetch(status, body), readConfigImpl, readRemoteImpl },
      )
    ).detail,
  buildLessonStartUrl: async (status, body, env) =>
    (
      await startLesson(
        { repo: 'acme/widgets' },
        { env, fetchImpl: stubFetch(status, body), readConfigImpl, readRemoteImpl },
      )
    ).detail,
  buildLessonAnswerUrl: async (status, body, env) =>
    (
      await answerLesson(
        { questionId: 'q1', answer: 'because' },
        { env, fetchImpl: stubFetch(status, body), readConfigImpl, readRemoteImpl },
      )
    ).detail,
  buildInflowAskUrl: async (status, body, env) =>
    (
      await requestAsk(
        { repo: 'acme/widgets', trigger: 'on-demand' },
        { env, fetchImpl: stubFetch(status, body), readConfigImpl, readRemoteImpl },
      )
    ).detail,
  buildInflowAnswerUrl: async (status, body, env) =>
    (
      await answerAsk(
        { token: 'tok', answer: 'because' },
        { env, fetchImpl: stubFetch(status, body), readConfigImpl, readRemoteImpl },
      )
    ).detail,
  buildInferDecisionsUrl: async (status, body, env) =>
    (
      await serverInfer(
        { sessionId: 's', turns: [{ role: 'user', text: 'hi' }] },
        CONFIG,
        { env, fetchImpl: stubFetch(status, body) },
      )
    ).error ?? '',
  buildOnboardingStateUrl: async (status, body, env) =>
    (
      await fetchOnboardingState(
        {},
        {
          env,
          fetchImpl: stubFetch(status, body),
          readConfigImpl: async () => CONFIG as never,
          readRemoteImpl,
        },
      )
    ).detail,
  buildReadDecisionsUrl: async (status, body, env) =>
    (
      await syncDecisions(
        { cwd: '/repo', force: true },
        {
          env,
          fetchImpl: stubFetch(status, body),
          readConfigImpl: async () => CONFIG,
          resolveRepoRootImpl: () => '/repo',
          readCacheImpl: async () => null,
          writeCacheSectionImpl: async () => ({}) as never,
        },
      )
    ).detail,
  // The persist leg of a capture. Only ingest-decisions is stubbed to fail — the infer
  // hop before it must succeed, or the run never reaches the leg under test.
  buildIngestDecisionsUrl: async (status, body, env) =>
    (
      await runCapture(
        { transcript_path: '/tmp/s.jsonl', cwd: '/repo', session_id: 's' },
        {
          env,
          readConfigImpl: async () => CONFIG as never,
          readFileImpl: async () =>
            JSON.stringify({
              type: 'user',
              message: { role: 'user', content: 'why is the charge keyed on the order id?' },
            }) +
            '\n' +
            JSON.stringify({
              type: 'assistant',
              message: { role: 'assistant', content: 'Because retries must not double-charge.' },
            }),
          readRemoteImpl: () => 'git@github.com:acme/widgets.git',
          readGitImpl: () => null,
          ensureAuthImpl: () => {},
          checkScopeImpl: async () => ({ send: true, reason: 'connected' }),
          showTrustGateImpl: async () => false,
          firstCaptureConfirmImpl: async () => false,
          log: () => {},
          fetchImpl: (async (input: unknown) => {
            const url = String(input);
            const reply =
              url.includes('/ingest-decisions')
                ? { status, body }
                : {
                    status: 200,
                    body: { ok: true, persisted: false, decisions: [{ title: 'Key the charge on the order id' }] },
                  };
            return {
              ok: reply.status >= 200 && reply.status < 300,
              status: reply.status,
              headers: { get: () => null },
              json: async () => reply.body,
            } as unknown as Response;
          }) as unknown as typeof fetch,
        },
      )
    ).detail,
};

function failureBodyEndpoints(): string[] {
  return Object.entries(CLI_ENDPOINTS)
    .filter(([, d]) => d.renders === 'failure-body')
    .map(([name]) => name)
    .sort();
}

test('every endpoint declared as rendering the contract has a driver here', () => {
  // Without this, adding `{ renders: 'failure-body' }` and forgetting the driver would
  // leave the new route asserted by NOTHING while the suite stayed green.
  assert.deepEqual(Object.keys(DRIVERS).sort(), failureBodyEndpoints());
});

for (const name of failureBodyEndpoints()) {
  test(`${name}: a relayed failure reads as a sentence, not as a slug`, async () => {
    const detail = await DRIVERS[name](502, OVERLOADED, PLAIN_ENV);
    assert.match(detail, /The database was busy — try again in a moment\./, detail);
    assert.doesNotMatch(detail, /retrieval_failed/, detail);
    assert.doesNotMatch(detail, /57014/, detail);
  });

  test(`${name}: an unavailable failure does not promise a retry`, async () => {
    const detail = await DRIVERS[name](502, UNAVAILABLE, PLAIN_ENV);
    assert.match(detail, /It failed on our side, and retrying is unlikely to help\./, detail);
    assert.doesNotMatch(detail, /lesson_persist_failed/, detail);
    assert.doesNotMatch(detail, /08006/, detail);
  });

  test(`${name}: --verbose hands the operator the slug and the SQLSTATE`, async () => {
    const detail = await DRIVERS[name](502, OVERLOADED, VERBOSE_ENV);
    assert.match(detail, /error=retrieval_failed/, detail);
    assert.match(detail, /code=57014/, detail);
    assert.match(detail, /status=502/, detail);
  });

  test(`${name}: a body with no contract at all still never prints the slug`, async () => {
    // The pre-contract shape, and the one the old helper printed raw.
    const detail = await DRIVERS[name](500, { error: 'some_internal_slug' }, PLAIN_ENV);
    assert.doesNotMatch(detail, /some_internal_slug/, detail);
  });
}

// --- 3. the registry ------------------------------------------------------------------

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(SRC_DIR, f));
}

/** Every exported endpoint builder in the package, found in source rather than listed. */
function declaredBuilders(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/export function (build[A-Za-z0-9_]*(?:Url|Link))\b/g)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

test('every endpoint this package can reach has a stated disposition', () => {
  // ⚠ THE ANTI-RECURRENCE GUARD. Adding a new worker route means adding a builder for
  // it, and that turns this red until the author says — in the registry, in writing —
  // what a person sees when it fails. A fix that relied on the next author remembering
  // would be a convention; this is not one.
  assert.deepEqual(
    declaredBuilders(),
    Object.keys(CLI_ENDPOINTS).sort(),
    'a build*Url/build*Link exists that CLI_ENDPOINTS does not classify (or vice versa)',
  );
});

test('the guard above is actually looking at source, not at an empty list', () => {
  // Measured, because a scan that silently finds nothing passes a set-equality test
  // against a registry it also failed to read. Both sides must be non-trivial.
  const builders = declaredBuilders();
  assert.ok(builders.length >= 10, `only found ${builders.length} builders`);
  assert.ok(builders.includes('buildGroundedAskUrl'));
  assert.ok(builders.includes('buildExchangeClaimUrl')); // proves it scans past urls.ts
});

test('a decision NOT to show somebody a failure is defended in a sentence', () => {
  // Scoped to the two dispositions that are a JUDGEMENT — "nobody sees this" and "this
  // one keeps its own copy". A link is not a fetch and needs no defence, so demanding
  // prose there would only teach the next author that this guard is noise.
  for (const [name, d] of Object.entries(CLI_ENDPOINTS) as Array<[string, EndpointDisposition]>) {
    if (d.renders !== 'never-shown' && d.renders !== 'own-slug-map') continue;
    assert.ok(d.why.length > 60, `${name}: "${d.why}" is not a reason`);
  }
});

test('every disposition that is not a renderer says something', () => {
  for (const [name, d] of Object.entries(CLI_ENDPOINTS) as Array<[string, EndpointDisposition]>) {
    if (d.renders === 'failure-body') {
      assert.ok(d.entryPoint.length > 0, name);
      continue;
    }
    assert.ok(d.why.trim().length > 0, name);
  }
});

test('endpoint construction is centralised, so nothing can dodge the registry', () => {
  // The registry keys off BUILDERS. A route added by inlining
  // `new URL('/new-thing', workerBaseUrl(env))` at a call site would have no builder and
  // would therefore never be classified — so the origin helpers are an allow-list.
  const ALLOWED = new Set(['urls.ts', 'claim.ts']);
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const base = file.slice(SRC_DIR.length + 1);
    if (ALLOWED.has(base)) continue;
    const src = readFileSync(file, 'utf8');
    // An ORIGIN alone is fine — `doctor` probes the bare host for connectivity. What is
    // forbidden is an origin joined to a PATH, which is an endpoint by another name.
    const ORIGIN = '(?:workerBaseUrl|functionsBaseUrl)\\s*\\(|DEFAULT_WORKER_URL|DEFAULT_FUNCTIONS_URL';
    // The CONSTANTS are in there as well as the functions: reaching past the helper to
    // `new URL('/x', DEFAULT_WORKER_URL)` builds the same endpoint and would have slipped
    // through a check that only knew about the helper.
    const inNewUrl = new RegExp(`new URL\\((?:[^()]|\\([^()]*\\))*(?:${ORIGIN})`);
    const inTemplate = new RegExp(`\\$\\{\\s*(?:${ORIGIN})`);
    if (inNewUrl.test(src) || inTemplate.test(src)) offenders.push(base);
  }
  assert.deepEqual(offenders, [], 'these files build an endpoint URL outside urls.ts/claim.ts');
});

test('no module keeps a private copy of the helper this file replaced', () => {
  // `message ?? String(error)` existed in three modules at once, which is why the defect
  // survived a fix on one of them. One renderer, or this goes red.
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const base = file.slice(SRC_DIR.length + 1);
    if (base === 'failureCopy.ts') continue;
    if (/function serverMessage\s*\(/.test(readFileSync(file, 'utf8'))) offenders.push(base);
  }
  assert.deepEqual(offenders, []);
});

// --- the Functions vocabulary ---------------------------------------------------------

test('a Functions slug maps to the ACTION it implies, not to itself', () => {
  const out = describeFailure({
    lead: "the decision log didn't sync",
    status: 403,
    payload: { error: 'not_a_member' },
    env: PLAIN_ENV,
    overrides: FUNCTIONS_SLUG_COPY,
  });
  assert.match(out, /not a member of the account that owns that repo/);
  assert.doesNotMatch(out, /not_a_member/);
});

test('the Functions table covers every slug those two endpoints emit', () => {
  // Enumerated from supabase/functions/read-decisions + ingest-decisions. `client_too_old`
  // is absent on purpose — it carries a server-authored `message` that says more than any
  // sentence here could, and the message branch renders it verbatim.
  for (const slug of [
    'repo_not_found',
    'not_a_member',
    'not_readable',
    'plan_limit',
    'invalid token',
    'token expired',
    'invalid session',
    'insufficient scope',
    'missing authorization',
  ]) {
    assert.ok(FUNCTIONS_SLUG_COPY[slug], `${slug} has no sentence`);
    assert.doesNotMatch(FUNCTIONS_SLUG_COPY[slug], new RegExp(slug), `${slug} maps to itself`);
  }
});

test('an expired credential says what to DO, not what the server called it', () => {
  for (const slug of ['token expired', 'invalid token', 'insufficient scope']) {
    assert.match(FUNCTIONS_SLUG_COPY[slug], /backthread login/);
  }
});

test('a Functions slug that is not on the table degrades, it does not leak', () => {
  const out = describeFailure({
    lead: 'x',
    status: 500,
    payload: { error: 'some_new_function_slug' },
    env: PLAIN_ENV,
    overrides: FUNCTIONS_SLUG_COPY,
  });
  assert.doesNotMatch(out, /some_new_function_slug/);
  assert.match(out, /HTTP 500/);
});

// --- "never shown" has to mean the string is never BUILT ----------------------------

/** The non-test modules that call a given builder. */
function callersOf(builder: string): string[] {
  const callers: string[] = [];
  for (const file of sourceFiles()) {
    const base = file.slice(SRC_DIR.length + 1);
    if (base === 'urls.ts' || base === 'failureCopy.ts') continue;
    if (new RegExp(`\\b${builder}\\s*\\(`).test(readFileSync(file, 'utf8'))) callers.push(base);
  }
  return callers;
}

test('a never-shown endpoint does not even READ the server diagnostic', () => {
  // ⚠ THE ESCAPE THIS CLOSES. `never-shown` is the one disposition the registry cannot
  // check by driving code, so it was a promise — and an outside read found the promise
  // false on THREE entries at once, each with a plausible sentence attached. Two were
  // printed outright; the third built the string and relied on its single caller
  // discarding it, which is a fact about the caller and not about the string.
  //
  // So the word is held to its strong reading: a module serving a `never-shown` endpoint
  // must not pull `error` or `message` off a response at all. Then there is no sentence to
  // leak, whoever prints what. It is a source-level property rather than a behavioural one,
  // which is the honest limit here — but it is checkable, and a promise is not.
  const READS_DIAGNOSTIC = /\b(?:rec|obj|payload|body|json|data|res)\.(?:error|message)\b/;
  const offenders: string[] = [];
  for (const [builder, d] of Object.entries(CLI_ENDPOINTS) as Array<[string, EndpointDisposition]>) {
    if (d.renders !== 'never-shown') continue;
    for (const caller of callersOf(builder)) {
      if (READS_DIAGNOSTIC.test(readFileSync(join(SRC_DIR, caller), 'utf8'))) {
        offenders.push(`${builder} -> ${caller}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a "never shown" endpoint is having its diagnostic read anyway');
});

test('the never-shown guard is looking at real callers, not at an empty list', () => {
  // A caller-finder that matches nothing passes the test above having checked nothing.
  const neverShown = (Object.entries(CLI_ENDPOINTS) as Array<[string, EndpointDisposition]>).filter(
    ([, d]) => d.renders === 'never-shown',
  );
  assert.ok(neverShown.length > 0, 'nothing is classified never-shown any more — delete the guard, do not leave it vacuous');
  for (const [builder] of neverShown) {
    assert.ok(callersOf(builder).length > 0, `${builder}: no caller found, so the guard checked nothing`);
  }
  // And prove the finder works on a builder we know has one.
  assert.ok(callersOf('buildGroundedAskUrl').includes('query.ts'));
});
