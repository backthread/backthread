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
  isMachineCode,
  readServerMessage,
  CLI_ENDPOINTS,
  SLUG_COPY,
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
  assert.match(out, /It failed on our side, so retrying will not help\./);
  // The distinction is the whole contract: the two reasons must not read the same.
  assert.doesNotMatch(out, /try again in a moment/);
  // ⚠ AND IT MUST NOT STOP THERE. "Your one available action is useless" with no next step
  // leaves the reader with nothing to do, which is the state this whole change exists to
  // get them out of. The dead end names where to take it.
  assert.match(out, /run it again with --verbose/);
  assert.match(out, /github\.com\/backthread\/backthread\/issues/);
});

test('an operator at a dead end is told where to SEND the detail, not how to get it', () => {
  const out = describeFailure({
    lead: 'x',
    status: 502,
    payload: UNAVAILABLE,
    env: VERBOSE_ENV,
  });
  assert.match(out, /report the detail above at/);
  assert.doesNotMatch(out, /run it again with --verbose/);
});

test('a busy database is NOT sent to the issue tracker', () => {
  // The next step belongs on dead ends only. Telling somebody to file an issue about a
  // transient blip is how an issue tracker becomes noise.
  const out = describeFailure({ lead: 'x', status: 502, payload: OVERLOADED, env: PLAIN_ENV });
  assert.doesNotMatch(out, /issues/);
});

// --- prose in `error` is a sentence, not a slug ----------------------------------------

test('worker-AUTHORED prose in `error` is rendered, not hidden as an operator field', () => {
  // ⚠ THE REGRESSION THIS PINS. `error` carries BOTH kinds: `repo_gate_failed` is a slug,
  // `repo not found or not connected to Backthread` is a sentence somebody wrote for this
  // reader. Hiding the second made `how` / `learn` / `ask-me` read WORSE than before the
  // fix on their three most common non-transient failures.
  for (const prose of [
    'repo not found or not connected to Backthread',
    'not authorized to read this repo',
    'no repo given and none connected — pass repo:"owner/name"',
  ]) {
    const out = describeFailure({
      lead: "the answer didn't come back",
      status: 404,
      payload: { error: prose },
      env: PLAIN_ENV,
    });
    assert.match(out, new RegExp(prose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), out);
  }
});

test('a machine slug is still hidden, on the same field, in the same call', () => {
  const out = describeFailure({
    lead: 'x',
    status: 502,
    payload: { error: 'repo_gate_failed' },
    env: PLAIN_ENV,
  });
  assert.doesNotMatch(out, /repo_gate_failed/);
});

test('isMachineCode draws the line where the server draws it', () => {
  for (const yes of ['retrieval_failed', 'not_a_member', 'plan_limit', 'e', 'a1_b2']) {
    assert.equal(isMachineCode(yes), true, yes);
  }
  for (const no of [
    'repo not found or not connected to Backthread',
    'token expired',
    'Repo_Not_Found',
    'lesson: decision read failed (500): {"code":"57014"}',
    '_leading',
    '9leading',
  ]) {
    assert.equal(isMachineCode(no), false, no);
  }
});

test('prose in `error` is not repeated as a diagnostic under --verbose', () => {
  const out = describeFailure({
    lead: 'x',
    status: 404,
    payload: { error: 'repo not found or not connected to Backthread' },
    env: VERBOSE_ENV,
  });
  assert.match(out, /\[status=404\]/);
  assert.doesNotMatch(out, /error=repo not found/);
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
  assert.match(out, /^x\. The server rejected it \(HTTP 500\)\./);
  // A dead end all the same, so it names the next step too.
  assert.match(out, /--verbose/);
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
    assert.match(detail, /It failed on our side, so retrying will not help\./, detail);
    assert.match(detail, /github\.com\/backthread\/backthread\/issues/, detail);
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

/** The two modules allowed to turn an origin into an endpoint. */
const URL_MODULES = ['urls.ts', 'claim.ts'];

/**
 * The two origins a FETCH can go to. Deliberately excludes the app origin: that one is a
 * browser link and is printed all over the package, so banning it would be a vocabulary
 * rule rather than a safety one.
 */
const ORIGIN_TOKEN = /\b(?:workerBaseUrl|functionsBaseUrl|DEFAULT_WORKER_URL|DEFAULT_FUNCTIONS_URL)\b/;

/** The literal hosts, for the author who pastes a URL out of a curl command. */
const ORIGIN_HOST = /\b(?:workers\.dev|supabase\.co)\b/;

/** Any origin at all — what makes an exported function a URL builder, fetched or linked. */
const ANY_ORIGIN =
  /\b(?:workerBaseUrl|functionsBaseUrl|appBaseUrl|DEFAULT_WORKER_URL|DEFAULT_FUNCTIONS_URL|DEFAULT_APP_URL)\b|\b(?:workers\.dev|supabase\.co)\b/;

/** The origin declarations themselves are not builders — they are what builders reach for. */
const IS_ORIGIN_DECL = /^(?:workerBaseUrl|functionsBaseUrl|appBaseUrl|DEFAULT_\w+_URL)$/;

/**
 * Every exported endpoint builder in the package, found in source rather than listed.
 *
 * ⚠ IT USED TO MATCH `export function build…Url` AND NOTHING ELSE, and an outside read got
 * SEVEN new endpoints past it — `export const`, `export async function`, a name that did
 * not end in `Url`, and three ways of joining an origin to a path that the centralisation
 * check did not recognise. Every one of those is an ordinary TypeScript spelling, not a
 * contrivance.
 *
 * So the question asked is no longer "is it spelled like a builder?" but "does this
 * exported function BUILD AN ENDPOINT?" — which is answered by looking for an origin inside
 * its body. The naming convention is not enforced and does not need to be: the origins are
 * allow-listed to these two modules by the test below, so an endpoint has nowhere else to
 * be born.
 */
function declaredBuilders(): string[] {
  const found = new Set<string>();
  for (const base of URL_MODULES) {
    const src = readFileSync(join(SRC_DIR, base), 'utf8');
    // Split on top-level `export`s and keep the ones whose body reaches for an origin.
    const parts = src.split(/\nexport /);
    for (const part of parts.slice(1)) {
      const name = part.match(/^(?:async )?function ([A-Za-z0-9_]+)/)?.[1]
        ?? part.match(/^const ([A-Za-z0-9_]+)\s*[:=]/)?.[1];
      if (!name) continue;
      if (IS_ORIGIN_DECL.test(name)) continue;
      // A BUILDER constructs a URL and hands it back; it never uses one. That is what
      // separates `buildExchangeClaimUrl` from `exchangeClaim`, which sits beside it and
      // names an origin only to print "generate a fresh code at …". The discriminator is
      // behavioural rather than lexical on purpose — `export async function` and
      // `export const` both have to keep working, because both walked past the previous,
      // name-shaped version of this scan.
      if (/\b(?:doFetch|fetch)\s*\(/.test(part)) continue;
      if (ANY_ORIGIN.test(part)) found.add(name);
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
  // And that it is finding them by what they DO, not by what they are called: this one
  // ends in `Link`, not `Url`, and would be missed by a name-shaped scan.
  assert.ok(builders.includes('buildRepoDeepLink'));
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

/**
 * `doctor` probes the BARE origins for reachability and reports only up/down — it drains
 * the body and constructs no path. It is the one module outside urls.ts/claim.ts with a
 * reason to name an origin, and it is named here rather than pattern-matched so that a
 * second such module has to be argued for.
 */
const ORIGIN_ALLOWED = new Set([...URL_MODULES, 'doctor.ts']);

test('endpoint construction is centralised, so nothing can dodge the registry', () => {
  // ⚠ WIDENED FROM A PATTERN TO A BAN, after an outside read walked four spellings past the
  // pattern version: `base + '/path'`, a `const base = workerBaseUrl(env)` hop, a hardcoded
  // `https://….workers.dev/path`, and a builder that simply was not called `build…Url`.
  // Chasing the shapes was the mistake — every one of them starts by naming an origin, so
  // the origins themselves are the allow-list now. There is no "an origin, but joined to a
  // path in a way I recognise": outside these three modules, do not name one.
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const base = file.slice(SRC_DIR.length + 1);
    if (ORIGIN_ALLOWED.has(base)) continue;
    const src = readFileSync(file, 'utf8');
    if (ORIGIN_TOKEN.test(src)) offenders.push(`${base} (names an origin)`);
    if (ORIGIN_HOST.test(src)) offenders.push(`${base} (hardcodes an origin host)`);
  }
  assert.deepEqual(offenders, [], 'build the endpoint in urls.ts and register it instead');
});

test('urls.ts builds endpoints and never calls one', () => {
  // The builder scan tells a builder from a consumer by whether it fetches. That only
  // holds while the module of builders contains no fetch — otherwise one function could be
  // both, and would be skipped as a consumer while quietly being an unregistered endpoint.
  assert.doesNotMatch(readFileSync(join(SRC_DIR, 'urls.ts'), 'utf8'), /\bfetch\s*\(/);
});

test('the centralisation ban is not vacuous — the allow-listed modules really do trip it', () => {
  // If the tokens ever stop matching, the test above passes over every file in silence.
  for (const base of URL_MODULES) {
    assert.ok(ORIGIN_TOKEN.test(readFileSync(join(SRC_DIR, base), 'utf8')), base);
  }
  assert.ok(ORIGIN_HOST.test(readFileSync(join(SRC_DIR, 'urls.ts'), 'utf8')));
});

test('each driver drives its REGISTERED entry point, not a convenient stand-in', () => {
  // ⚠ Otherwise the conformance battery is satisfiable by a driver that calls
  // `describeFailure` itself: green, proving only that the renderer renders. The registry
  // names the function that must appear in the driver's own source.
  const selfSrc = readFileSync(join(SRC_DIR, 'failureCopy.test.ts'), 'utf8');
  const table = selfSrc.slice(selfSrc.indexOf('const DRIVERS'), selfSrc.indexOf('function failureBodyEndpoints'));
  assert.ok(table.length > 500, 'could not locate the driver table in this file');
  for (const [builder, d] of Object.entries(CLI_ENDPOINTS) as Array<[string, EndpointDisposition]>) {
    if (d.renders !== 'failure-body') continue;
    const start = table.indexOf(`${builder}:`);
    assert.ok(start >= 0, `${builder}: no driver`);
    const body = table.slice(start, start + 900);
    const fn = d.entryPoint.split(' ')[0];
    assert.ok(body.includes(fn), `${builder}: its driver never calls ${fn}`);
  }
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
    overrides: SLUG_COPY,
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
    assert.ok(SLUG_COPY[slug], `${slug} has no sentence`);
    assert.doesNotMatch(SLUG_COPY[slug], new RegExp(slug), `${slug} maps to itself`);
  }
});

test('an expired credential says what to DO, not what the server called it', () => {
  for (const slug of ['token expired', 'invalid token', 'insufficient scope']) {
    assert.match(SLUG_COPY[slug], /backthread login/);
  }
});

test('a Functions slug that is not on the table degrades, it does not leak', () => {
  const out = describeFailure({
    lead: 'x',
    status: 500,
    payload: { error: 'some_new_function_slug' },
    env: PLAIN_ENV,
    overrides: SLUG_COPY,
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

// --- the two remaining slug tables, held to the same rule -------------------------------

test('a scope skip reads as a sentence, and every enum value has one', async () => {
  const { SCOPE_REASON_COPY } = await import('./captureScope.js');
  for (const [reason, copy] of Object.entries(SCOPE_REASON_COPY)) {
    assert.ok(copy.length > 0, reason);
    // The underscore is what makes a value a machine code rather than a word: `connected`
    // is ordinary English and may legitimately appear in its own sentence, `not_a_member`
    // never can.
    if (reason.includes('_')) {
      assert.doesNotMatch(copy, new RegExp(reason), `${reason} maps to itself`);
    }
  }
  // The enum is closed, so the table must be exhaustive — a new value with no sentence
  // would render `undefined` to a person, which is worse than the slug it replaced.
  const src = readFileSync(join(SRC_DIR, 'captureScope.ts'), 'utf8');
  const decl = src.slice(src.indexOf('export type ScopeReason'), src.indexOf('export const SCOPE_REASON_COPY'));
  for (const m of decl.matchAll(/'([a-z_]+)'/g)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(SCOPE_REASON_COPY, m[1]),
      `ScopeReason '${m[1]}' has no sentence`,
    );
  }
});

test('the inflow override table is reachable on every route it claims to cover', async () => {
  // ⚠ `ask_expired` SURVIVED A MUTATION. Deleting it from the table changed nothing,
  // because the server only ever sends it as a bare 410 and the status check catches that
  // first — so the entry was unasserted defensive redundancy that a server-side status
  // change would have silently activated, wrong. Driven here as the non-410 it is defended
  // against being.
  const { answerAsk } = await import('./inflow.js');
  for (const [status, slug, expected] of [
    [400, 'ask_expired', /nothing is owed and nothing is missing/],
    [409, 'ask_material_moved', /changed since it was asked/],
  ] as Array<[number, string, RegExp]>) {
    const out = await answerAsk(
      { token: 'tok', answer: 'because' },
      {
        env: PLAIN_ENV,
        fetchImpl: stubFetch(status, { error: slug }),
        readConfigImpl,
        readRemoteImpl,
      },
    );
    assert.match(out.detail, expected, `${slug} @ ${status}: ${out.detail}`);
    assert.doesNotMatch(out.detail, new RegExp(slug), out.detail);
  }
});
