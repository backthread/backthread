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
  assert.match(out, /set BACKTHREAD_VERBOSE=1 \(or pass --verbose\)/);
  assert.match(out, /github\.com\/backthread\/backthread\/issues/);
});

test('an operator at a dead end is told where to SEND the detail, not how to get it', () => {
  const out = describeFailure({
    lead: 'x',
    status: 502,
    payload: UNAVAILABLE,
    env: VERBOSE_ENV,
  });
  assert.match(out, /report the detail at the end of this line at/);
  assert.doesNotMatch(out, /set BACKTHREAD_VERBOSE=1/);
  // ⚠ IT USED TO SAY "the detail above", WHICH WAS FALSE: the operator suffix is appended
  // to the END of this same line. The sentence has to be true about its own layout.
  assert.doesNotMatch(out, /detail above/);
  assert.ok(out.indexOf('[status=502') > out.indexOf('report the detail'));
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

/**
 * Every stubbed request in this file is counted, so a driver cannot merely CLAIM to have
 * driven a route. Module-scoped rather than threaded through the driver signature because
 * a driver may make several hops (capture infers before it persists) and the question is
 * only ever "did anything reach the wire".
 */
let stubbedRequests = 0;

function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () => {
    stubbedRequests += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
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
            stubbedRequests += 1; // counted like every other stub — see `stubbedRequests`
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

/**
 * Every non-test source file, RECURSIVELY.
 *
 * ⚠ IT USED TO BE A FLAT `readdirSync`, so everything under `cli/src/bin/` — and any
 * subdirectory a future author creates — was invisible to every guard in this file. An
 * outside read put a complete unregistered endpoint in a new `cli/src/net/` and the whole
 * suite stayed green. A guard that cannot see half the package is not a guard.
 */
function sourceFiles(dir: string = SRC_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** A file's path relative to src/ — `bin/backthread.ts`, not just the basename. */
function rel(file: string): string {
  return file.slice(SRC_DIR.length + 1);
}

/**
 * The modules allowed to name an origin. `urls.ts` and `claim.ts` build endpoints from
 * them; `doctor.ts` probes the bare hosts for reachability and constructs no path.
 *
 * ⚠ ALL THREE ARE SCANNED FOR BUILDERS, not just the first two. An outside read put a
 * complete unregistered endpoint in `doctor.ts` and it went green: the module was on the
 * origin allow-list, so it could name an origin, and it was outside the builder scan, so
 * nothing looked for what it did with one. Permission to name an origin is not permission
 * to skip the registry.
 */
const ORIGIN_MODULES = ['urls.ts', 'doctor.ts'];

/**
 * Where an endpoint can be BORN. Exactly one module, and it is forbidden to fetch.
 *
 * ⚠ IT WAS THREE, AND TWO ORDINARY SPELLINGS WALKED THROUGH THE GAP. The scan called a
 * declaration a builder only if an origin appeared inside its own brace-matched extent, so
 * routing the origin through a one-line private helper in the same file
 * (`function originFor(env) { return workerBaseUrl(env); }`) left the extent clean and the
 * endpoint unregistered. And because a declaration containing `fetch(` was classified a
 * consumer and skipped, a single function in `claim.ts` or `doctor.ts` that BOTH built a
 * URL and requested it was invisible to every guard here — which is the codebase's own
 * house style, just with the URL built inline.
 *
 * Both are gone because the discriminators are. `buildExchangeClaimUrl` moved here, so this
 * is the only URL module; every export in it that is not an origin helper must be in the
 * registry, with no test of what its body says or what its signature returns.
 *
 * ⚠ WHAT THIS IS AND IS NOT. Earlier drafts of this comment ended "there is nothing left to
 * spell differently", and an outside read falsified that sentence four rounds running — most
 * recently with `export default`. The claim was the defect, not just the spelling. What is
 * true: the ORDINARY ways to add an endpoint are red at three independent points — an
 * unregistered builder, a module that makes requests without being declared one, and a URL
 * that was invented or edited. It is a source-level trace, not a type system: a determined
 * author can still dodge it, and a reviewer should still read a diff that adds a request.
 * What it stops is FORGETTING, which is what actually happened here — the defect this whole
 * change exists for sat on five routes at once because nothing ever asked.
 */
const URL_MODULES = ['urls.ts'];

/**
 * The two origins a FETCH can go to. Deliberately excludes the app origin: that one is a
 * browser link and is printed all over the package, so banning it would be a vocabulary
 * rule rather than a safety one.
 */
const ORIGIN_TOKEN =
  /\b(?:workerBaseUrl|functionsBaseUrl|DEFAULT_WORKER_URL|DEFAULT_FUNCTIONS_URL|BACKTHREAD_WORKER_URL|BACKTHREAD_FUNCTIONS_URL)\b/;

/** The literal hosts, for the author who pastes a URL out of a curl command. */
const ORIGIN_HOST = /\b(?:workers\.dev|supabase\.co)\b/;


/**
 * The origin declarations themselves are not builders — they are what builders reach for.
 *
 * ⚠ AN EXPLICIT LIST, NOT A NAME SHAPE. It was `/^(?:…|DEFAULT_\w+_URL)$/`, which is a
 * name-shaped exemption — the precise mistake every other version of this scan made. An
 * outside read named a builder `DEFAULT_LESSON_NEXT_URL` and walked straight out of the
 * registry. Six names, written down.
 */
const ORIGIN_DECLS = new Set([
  'appBaseUrl',
  'workerBaseUrl',
  'functionsBaseUrl',
  'DEFAULT_APP_URL',
  'DEFAULT_WORKER_URL',
  'DEFAULT_FUNCTIONS_URL',
]);

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
    const src = codeOnly(readFileSync(join(SRC_DIR, base), 'utf8'));
    for (const m of src.matchAll(
      // `const` was the only binding form matched, so `export let buildLessonNextUrl = …`
      // walked out of the registry — and later `export default function …` did the same.
      // Every binding keyword, `default`, and `class` for good measure.
      /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z0-9_]+)|(?:const|let|var|class)\s+([A-Za-z0-9_]+)\s*[:={(]?)/g,
    )) {
      const name = m[1] ?? m[2];
      if (ORIGIN_DECLS.has(name)) continue;
      found.add(name);
    }
    // ⚠ AND THE LIST FORM. `function f() {…}` followed by `export { f };` is an ordinary
    // TypeScript spelling and was invisible — a builder declared privately and exported at
    // the bottom of the file never reached the registry.
    for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}\s*(?:from\s*''\s*)?;/g)) {
      for (const raw of m[1].split(',')) {
        const name = (raw.split(/\bas\b/).pop() ?? '').trim();
        if (!name || ORIGIN_DECLS.has(name)) continue;
        if (/^type\b/.test(raw.trim())) continue;
        found.add(name);
      }
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

test('endpoint construction is centralised, so the ordinary ways are red', () => {
  // ⚠ WIDENED FROM A PATTERN TO A BAN, after an outside read walked four spellings past the
  // pattern version: `base + '/path'`, a `const base = workerBaseUrl(env)` hop, a hardcoded
  // `https://….workers.dev/path`, and a builder that simply was not called `build…Url`.
  // Chasing the shapes was the mistake — every one of them starts by naming an origin, so
  // the origins themselves are the allow-list now. There is no "an origin, but joined to a
  // path in a way I recognise": outside these three modules, do not name one.
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const base = rel(file);
    if (ORIGIN_ALLOWED.has(base)) continue;
    // Comments stripped first. A module documenting its env-override seam ("Env override
    // seam (BACKTHREAD_WORKER_URL)") is describing the behaviour, not reaching for it, and
    // a ban that cannot tell those apart teaches the next author that it is noise.
    const src = stripComments(readFileSync(file, 'utf8'));
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

/**
 * The modules allowed to put a request on the wire. Every one of them appears in the
 * registry as the caller of a classified endpoint.
 *
 * ⚠ THE BAN ON ORIGINS WAS NOT ENOUGH, AND THIS IS WHY. An outside read added a new module
 * that derived its endpoint from an existing builder —
 * `buildLessonStartUrl(env).replace('/lesson/start', '/lesson/next')` — then fetched it and
 * printed `String(rec.error)`. It names no origin, so the origin ban never fired; it is not
 * a URL module, so the builder scan never looked at it. A complete unregistered endpoint,
 * rendering a raw slug, entirely green. The same read got a second one past by inventing a
 * host on a domain the host pattern did not list.
 *
 * Both start by CALLING FETCH, which is the property — a request leaving this package —
 * rather than any of the shapes a URL can be spelled in. So the fetchers are named. Adding
 * a module to this list is a deliberate act, and the thing to do next is register what it
 * calls.
 */
const NETWORK_MODULES = new Set([
  'capture.ts',
  'captureScope.ts',
  'claim.ts',
  'cliAuthPoll.ts',
  'doctor.ts',
  'infer.ts',
  'inflow.ts',
  'lesson.ts',
  'localDecisions.ts',
  'onboardingState.ts',
  'query.ts',
]);

/**
 * ⚠ THE IDENTIFIER, NOT A CALL SHAPE — and `\bfetch\b` alone was not enough, because it does
 * not match `fetchImpl`, so a module taking the sender as an injected dep never tripped the
 * allow-list at all. Named forms rather than a bare prefix, so `fetchOnboardingState` — a
 * function that happens to start with the word — is not mistaken for one. The first version matched `doFetch(` / `fetch(`, and
 * an outside read walked past it with `const send = deps.fetchImpl ?? globalThis.fetch;`
 * followed by `await send(url, …)` — an ordinary alias. Chasing call spellings is the same
 * mistake this file already made twice with URL spellings. A module that cannot NAME fetch
 * cannot call it, however it spells the call, so the token itself is the allow-list.
 */
const TOUCHES_FETCH = /\bfetch\s*\(|\bfetchImpl\b|\bfetch\b/i;

test('only declared modules put a request on the wire', () => {
  const offenders = sourceFiles()
    .filter((f) => !NETWORK_MODULES.has(rel(f)))
    .filter((f) => TOUCHES_FETCH.test(codeOnly(readFileSync(f, 'utf8'))))
    .map(rel);
  assert.deepEqual(
    offenders,
    [],
    'a new module makes network calls — add it above, and register the endpoint it calls in CLI_ENDPOINTS',
  );
});

test('a not-a-fetch-target really is never fetched', () => {
  // ⚠ THE LAST UNCHECKED CATEGORY. `not-a-fetch-target` was exempt from even the prose bar,
  // so an outside read registered a real worker endpoint as one ("just a link we print"),
  // fetched it from `query.ts` and printed the raw slug — entirely green. A link is a claim
  // about behaviour like any other, so it is asked as one: the builder's name must not
  // appear inside a request in any module that makes them.
  const links = (Object.entries(CLI_ENDPOINTS) as Array<[string, EndpointDisposition]>)
    .filter(([, d]) => d.renders === 'not-a-fetch-target')
    .map(([n]) => n);
  assert.ok(links.length > 0, 'nothing is a link any more — delete the category, do not leave it vacuous');
  const offenders: string[] = [];
  for (const base of NETWORK_MODULES) {
    const src = codeOnly(readFileSync(join(SRC_DIR, base), 'utf8'));
    for (const link of links) {
      // The builder appearing anywhere inside a request expression, in any of the spellings
      // a request is written in.
      if (new RegExp(`(?:fetch|send|doFetch)\\w*\\s*\\(\\s*[^)]{0,120}\\b${link}\\s*\\(`).test(src)) {
        offenders.push(`${base} fetches ${link}`);
      }
      // …and via a local binding: `const u = buildXUrl(env); … fetch(u`.
      const bound = src.match(new RegExp(`const\\s+(\\w+)\\s*=\\s*${link}\\s*\\(`))?.[1];
      if (bound && new RegExp(`(?:fetch|send|doFetch)\\w*\\s*\\(\\s*${bound}\\b`).test(src)) {
        offenders.push(`${base} fetches ${link} via ${bound}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'an endpoint is registered as a link and is being requested');
});

/**
 * Every identifier in a file that holds a URL — bound from a registered builder, or from an
 * origin helper. Following the binding is what makes this a trace rather than a pattern: an
 * outside read defeated the adjacent-only version with one hop,
 * `const base = buildLessonStartUrl(env); const url = base.replace(…)`, which is the most
 * ordinary line in this codebase's own house style.
 */
function urlBindings(src: string, registered: string[]): string[] {
  const bound = new Set<string>();
  // ⚠ IMPORTS ARE BINDINGS TOO. Only `const|let|var` was followed, so
  // `import { buildLessonStartUrl as lessonStart }` produced a holder under a name nothing
  // recognised — one rename and the trace stopped at the door.
  for (const m of src.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)) {
    for (const spec of m[1].split(',')) {
      const parts = spec.split(/\bas\b/).map((x) => x.trim());
      if (parts.length !== 2) continue;
      const [orig, alias] = parts;
      if (registered.includes(orig) || ORIGIN_DECLS.has(orig)) bound.add(alias);
    }
  }
  const sources = [...registered, ...ORIGIN_DECLS].join('|');
  let changed = true;
  while (changed) {
    changed = false;
    const from = [...bound, ...registered, ...ORIGIN_DECLS].join('|');
    const add = (name: string): void => {
      if (!bound.has(name)) {
        bound.add(name);
        changed = true;
      }
    };
    for (const m of src.matchAll(
      new RegExp(`(?:const|let|var)\\s+([A-Za-z0-9_]+)\\s*(?::[^=;]+)?=\\s*[^;\\n]*\\b(?:${from})\\b`, 'g'),
    )) {
      add(m[1]);
    }
    // ⚠ A FUNCTION THAT RETURNS ONE IS A HOLDER TOO. `function origin() { return
    // buildLessonStartUrl(env); }` then `origin().replace(…)` put a whole call frame between
    // the builder and the edit — and a rule that follows values has to follow them through
    // the plainest indirection there is.
    for (const m of src.matchAll(
      new RegExp(`function\\s+([A-Za-z0-9_]+)\\s*\\([^)]*\\)[^{]*\\{([^{}]*)\\}`, 'g'),
    )) {
      if (new RegExp(`\\b(?:${from})\\b`).test(m[2])) add(m[1]);
    }
    void sources;
  }
  return [...bound];
}

/**
 * Files that may hold a literal address because it is a LINK, not an endpoint — nothing
 * fetches it, it is printed for a person or handed to git. Named one by one so a new one is
 * a decision somebody makes rather than a side effect of where they happened to type it.
 */
const LINK_EXEMPT = new Set([
  'failureCopy.ts', // the issue tracker a dead end points a reader at
  'sweep.ts', // the GitHub clone URL for a repo being swept
]);

const EDIT_VERBS =
  '(?:\\.\\s*(?:replace|replaceAll|concat|slice|substring|substr|split|padStart|padEnd|trim)\\b|\\s*\\+)';

/**
 * The URL-trace rule, as ONE implementation.
 *
 * ⚠ IT WAS TWO — the real check and a "not vacuous" copy of it — and they drifted, so the
 * fixture list went on passing against a version of the rule the package no longer used.
 * A guard and its own proof cannot be separate transcriptions of the same idea.
 *
 * `canFetch` is what separates a module that can make a request from one that merely writes
 * a link down: constructing a URL and inventing an address are only bans where a request
 * can follow.
 */
function urlTraceOffences(src: string, registered: string[], canFetch: boolean): string[] {
  const out: string[] = [];
  const held = [...registered, ...urlBindings(src, registered)].join('|');

  // 1. Editing a URL — anywhere in the same STATEMENT as a value that holds one, not merely
  //    adjacent to its name. ⚠ Adjacency was the last thing standing and it fell to a bare
  //    pair of parentheses: `(builder(env)).replace(…)`, `String(b).replace(…)`,
  //    `ENDPOINTS.start(env).replace(…)`, `(b ?? '').replace(…)`. One property access or one
  //    wrapper call broke it every time.
  for (const stmt of src.split(/[;\n]/)) {
    if (!new RegExp(`\\b(?:${held})\\b`).test(stmt)) continue;
    if (new RegExp(EDIT_VERBS).test(stmt)) {
      out.push('edits a URL');
      break;
    }
  }
  // 2. Interpolating one in front of a PATH. The rule used to require a literal `/` right
  //    after the closing brace and was defeated by `` `${base}${'/lesson/next'}` ``; both
  //    continuations are covered. It stays scoped to a path because printing a link inside a
  //    sentence is what half these modules do, and banning that would be a vocabulary rule.
  if (new RegExp(`\\$\\{[^}]*\\b(?:${held})\\b[^}]*\\}\\s*(?:/|\\$\\{)`).test(src)) {
    out.push('interpolates a URL in front of a path');
  }
  if (!canFetch) return out;
  // 3. Constructing one at all, in a module that can request it.
  if (/new\s+(?:globalThis\.|window\.)?URL\s*\(/.test(src)) out.push('constructs a URL');
  // 4. Reaching for ANY origin, the app origin included, in front of a path. The app origin
  //    is off the fetch-side ban elsewhere because it is a link people print — but
  //    `app.backthread.dev` really does serve `/api/*`, so inside a fetcher it is an endpoint.
  if (/\b(?:appBaseUrl\s*\(|DEFAULT_APP_URL|BACKTHREAD_APP_URL)[^;\n]*\//.test(src)) {
    out.push('builds a path on the app origin');
  }
  return out;
}

test('a fetched URL traces to a registered builder — nothing invented, nothing edited', () => {
  // ⚠ THE PROPERTY, NOT A LIST OF SHAPES — and it took five rounds of being told that. Every
  // previous version banned a syntax: a method name, adjacency to the call, one spelling of
  // an origin, a `const` binding but not an import. Each was walked past by ordinary
  // TypeScript. `/lesson/next` is a REAL worker route emitting the contract, so each of
  // those was the ticket's own defect one line away.
  //
  // What holds instead: in a module that can make requests, a URL may not be CONSTRUCTED,
  // INVENTED or EDITED — where "edited" follows the value through its bindings, its imports
  // and its statement, rather than looking only at the call site.
  const registered = Object.keys(CLI_ENDPOINTS);
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const base = rel(file);
    if (URL_MODULES.includes(base)) continue; // where URLs are legitimately written down
    const src = codeWithStrings(readFileSync(file, 'utf8'));
    // Inventing one, ANYWHERE. ⚠ This was scoped to modules that can fetch, and an outside
    // read parked `export const COVERAGE_ENDPOINT = 'https://…'` in `version.ts` and
    // imported it into one. Where a URL is WRITTEN and where it is REQUESTED need not be the
    // same file, so the ban follows the writing; the exceptions are named, which is the
    // point — a hardcoded address has to be argued for.
    if (!LINK_EXEMPT.has(base) && /['"`]https?:\/\//.test(src)) {
      offenders.push(`${base} hardcodes a URL`);
    }
    for (const o of urlTraceOffences(src, registered, NETWORK_MODULES.has(base))) {
      offenders.push(`${base} ${o}`);
    }
  }
  assert.deepEqual(offenders, [], 'build it in urls.ts and register it instead');
});

test('the URL-trace rule is not vacuous — it catches every shape that got past it', () => {
  // Every spelling measured green against some earlier version of this rule, as fixtures,
  // run through the SAME function the check above uses. If one stops matching, the rule has
  // quietly become the pattern-matcher it replaced.
  const registered = ['buildLessonStartUrl', 'buildGroundedAskUrl'];
  const catches = (src: string): boolean =>
    urlTraceOffences(src, registered, true).length > 0 || /['"`]https?:\/\//.test(src);
  for (const shape of [
    "new URL('/lesson/next', buildLessonStartUrl(env)).toString()",
    "buildLessonStartUrl(env).replaceAll('/lesson/start', '/lesson/next')",
    "const base = buildLessonStartUrl(env);\nconst url = base.replace('/a', '/b');",
    "const u = new URL(buildLessonStartUrl(env)); u.pathname = '/lesson/next';",
    'fetch(`${appBaseUrl(env)}/api/coverage`)',
    "fetch('https://api.backthread.dev/coverage')",
    'const origin = workerBaseUrl(env);\nfetch(`${origin}/lesson/next`);',
    "buildGroundedAskUrl(env) + '/next'",
    // …and the round that said "one property access, one wrapper call, one pair of
    // parentheses, or one renamed import breaks the adjacency". Each of these was measured
    // green against the version before this one.
    "String(buildLessonStartUrl(env)).replace('/a', '/b')",
    "(buildLessonStartUrl(env)).replace('/a', '/b')",
    "(buildLessonStartUrl(env) ?? '').replace('/a', '/b')",
    "const ENDPOINTS = { start: buildLessonStartUrl };\nENDPOINTS.start(env).replace('/a', '/b');",
    "const base = buildLessonStartUrl(env);\nconst url = `${base}${'/lesson/next'}`;",
    'new globalThis.URL(buildLessonStartUrl(env))',
    "function origin() { return buildLessonStartUrl(env); }\nconst u = origin().replace('/a', '/b');",
  ]) {
    assert.ok(catches(shape), `not caught: ${shape}`);
  }
  // …and it does NOT fire on the honest form, or this is a ban on the codebase.
  assert.equal(catches('const res = await doFetch(buildGroundedAskUrl(env), init);'), false);
});

test('every declared network module really does fetch', () => {
  // Otherwise the list rots into permission nobody needs, and a stale entry is a hole
  // somebody can move a new endpoint into without touching this file.
  const idle: string[] = [];
  for (const base of NETWORK_MODULES) {
    if (!TOUCHES_FETCH.test(codeOnly(readFileSync(join(SRC_DIR, base), 'utf8')))) idle.push(base);
  }
  assert.deepEqual(idle, [], 'these are on the network allow-list but make no network call');
});

test('the centralisation ban is not vacuous — the allow-listed modules really do trip it', () => {
  // If the tokens ever stop matching, the test above passes over every file in silence.
  for (const base of ORIGIN_MODULES) {
    assert.ok(ORIGIN_TOKEN.test(readFileSync(join(SRC_DIR, base), 'utf8')), base);
  }
  assert.ok(ORIGIN_HOST.test(readFileSync(join(SRC_DIR, 'urls.ts'), 'utf8')));
});

test('doctor probes origins and builds no path, which is why it may name one', () => {
  // ⚠ THE OTHER HALF OF NARROWING URL_MODULES TO ONE. `doctor.ts` keeps permission to name
  // an origin because it checks the bare hosts for reachability — so it must not be able to
  // turn one into an endpoint. It has no builder scan over it any more; this is what stands
  // in its place, and it is a stronger statement than the scan was.
  // ⚠ ON codeWithStrings, NOT codeOnly. `codeOnly` replaces every template literal with an
  // empty pair of backticks, so `` `${workerBaseUrl(env)}/lesson/next` `` VANISHED before
  // this guard looked at it — an outside read fetched exactly that from here, green.
  const src = codeWithStrings(readFileSync(join(SRC_DIR, 'doctor.ts'), 'utf8'));
  assert.doesNotMatch(src, /new URL\(/, 'doctor.ts constructs a URL — build it in urls.ts and register it');
  assert.doesNotMatch(
    src,
    /(?:workerBaseUrl|functionsBaseUrl)\s*\([^)]*\)\s*(?:\+|\.concat)/,
    'doctor.ts joins a path to an origin',
  );
  assert.doesNotMatch(
    src,
    /\$\{\s*(?:workerBaseUrl|functionsBaseUrl)\s*\([^)]*\)\s*\}\s*\//,
    'doctor.ts interpolates an origin in front of a path',
  );
});

test('each driver actually reaches the network', async () => {
  // ⚠ THE NAME CHECK BELOW IS TEXT, AND TEXT IS ARGUABLE. It was first defeated by putting
  // the entry point's name in a trailing comment, and then — after comments were stripped —
  // by putting the real call behind `if (Number.isNaN(status))` and returning
  // `describeFailure(...)` directly. Both times the battery went green while proving only
  // that the renderer renders. A driver that never made a request cannot have driven a
  // route, whatever its source says, so the fetch it is handed counts its own calls.
  for (const name of failureBodyEndpoints()) {
    stubbedRequests = 0;
    await DRIVERS[name](502, OVERLOADED, PLAIN_ENV);
    assert.ok(stubbedRequests > 0, `${name}: its driver never made a request`);
  }
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
    // Comments stripped and a CALL required: a driver that faked it by calling the
    // renderer directly, with the real function's name in a trailing comment, passed the
    // earlier `includes()` form — so the guard's strength depended on comment placement.
    const body = table
      .slice(start, start + 900)
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const fn = d.entryPoint.split(' ')[0];
    assert.match(body, new RegExp(`\\b${fn}\\s*\\(`), `${builder}: its driver never calls ${fn}`);
  }
});

test('no module keeps a private copy of the logic this file replaced', () => {
  // ⚠ IT USED TO LOOK FOR `function serverMessage(` AND NOTHING ELSE, which saw two of the
  // seven modules that had this. The other five never named it — they inlined the same
  // nested ternary at the call site, which is the form a future author is most likely to
  // reach for, because it is the form six of the seven actually used. The SHAPE is what is
  // banned, not the name.
  const NAMED = /function serverMessage\s*\(/;
  const INLINED = /typeof\s+\w+\.message\s*===\s*'string'[\s\S]{0,200}?String\(\s*\w+\.error\s*\)/;
  const ALSO_INLINED = /\.message\s*(?:&&|\?)[\s\S]{0,160}?'error'\s+in\s+\w+/;
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const base = rel(file);
    if (base === 'failureCopy.ts') continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    if (NAMED.test(src) || INLINED.test(src) || ALSO_INLINED.test(src)) offenders.push(base);
  }
  assert.deepEqual(offenders, [], 'this module reimplements `message ?? String(error)`');
});

test('the private-copy ban can see the shape it bans', () => {
  // Measured against the real thing rather than trusted: this is the exact text that stood
  // in seven modules before this change, so if the pattern stops matching it, the ban above
  // has quietly become a no-op.
  const WAS = `
    const serverErr =
      typeof obj.message === 'string' && obj.message.length > 0
        ? obj.message
        : 'error' in obj
          ? String(obj.error)
          : \`HTTP \${res.status}\`;
  `;
  const INLINED = /typeof\s+\w+\.message\s*===\s*'string'[\s\S]{0,200}?String\(\s*\w+\.error\s*\)/;
  assert.ok(INLINED.test(WAS), 'the ban no longer recognises the code it exists to ban');
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

/**
 * Source with comments removed — a mention in prose is not a use.
 *
 * ⚠ A SCANNER, NOT A REGEX PAIR. A line-comment regex eats from the `//` in
 * `'https://app.backthread.dev'`, so every guard built on it was silently reading truncated
 * source — including the one that bans hardcoded URLs, which could not see a URL. A
 * comment and a string can only be told apart by walking the file.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Comments AND string literals removed — CODE only.
 *
 * A token inside quotes is data. `renders: 'not-a-fetch-target'` and a log line reading
 * `'state fetch failed (swallowed)'` both contain the word and neither can send a request;
 * flagging them would teach the next author that the ban is noise, which is how a guard
 * gets deleted.
 */
function codeOnly(src: string): string {
  return stripComments(src)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Comments removed, string literals KEPT — for rules that are about what a string says. */
function codeWithStrings(src: string): string {
  return stripComments(src);
}

/** The non-test modules that call a given builder. */
function callersOf(builder: string): string[] {
  const callers: string[] = [];
  for (const file of sourceFiles()) {
    const base = rel(file);
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
  // ⚠ ANY identifier, and bracket notation too. Pinning it to a list of variable names in
  // dot notation meant `rec['error']` — or one variable renamed — walked straight past.
  // Dot, bracket AND destructuring. `const { error: slug } = rec` reads the diagnostic as
  // surely as `rec.error` does, and walked past the first two forms.
  const READS_DIAGNOSTIC =
    /\.\s*(?:error|message)\b|\[\s*['"](?:error|message)['"]\s*\]|\{[^{}]*\b(?:error|message)\s*:/;
  const offenders: string[] = [];
  for (const [builder, d] of Object.entries(CLI_ENDPOINTS) as Array<[string, EndpointDisposition]>) {
    if (d.renders !== 'never-shown') continue;
    for (const caller of callersOf(builder)) {
      // Comments stripped: the guard once fired on a doc comment quoting `String(rec.error)`,
      // which is a mention, not a read.
      if (READS_DIAGNOSTIC.test(stripComments(readFileSync(join(SRC_DIR, caller), 'utf8')))) {
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
  // ⚠ AND THE TWO CLIENT-SIDE SENTINELS, which are not in the enum and were therefore not
  // checked. `'other'` is reachable — `interpretScopeResponse` maps any skip reason it does
  // not recognise to it, which is exactly what a NEW server value looks like — and deleting
  // it rendered `capture skipped — undefined.` with the whole suite green. TypeScript did
  // catch it, but a type kill is not a test kill and this table is about what a person
  // reads.
  for (const sentinel of ['unknown', 'other'] as const) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(SCOPE_REASON_COPY, sentinel),
      `the '${sentinel}' sentinel has no sentence`,
    );
    assert.ok(SCOPE_REASON_COPY[sentinel].length > 0);
  }
});

test('an unrecognised server skip reason still reads as a sentence', async () => {
  // The `'other'` sentinel, driven rather than asserted about: this is what today's client
  // does when tomorrow's server adds a scope reason.
  const { interpretScopeResponse } = await import('./captureScope.js');
  const verdict = interpretScopeResponse(true, 200, {
    decision: 'skip',
    reason: 'some_future_reason',
  });
  assert.equal(verdict.send, false);
  assert.equal(verdict.reason, 'other');
  const { SCOPE_REASON_COPY: TBL } = await import('./captureScope.js');
  assert.ok(TBL[verdict.reason].length > 0);
  assert.doesNotMatch(TBL[verdict.reason], /some_future_reason|undefined/);
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

// --- the other unchecked category ------------------------------------------------------

/** Drive an `own-slug-map` endpoint with a slug nothing maps, and read what comes out. */
const OWN_MAP_DRIVERS: Readonly<Record<string, (slug: string) => Promise<string>>> = {
  buildExchangeClaimUrl: async (slug) => {
    const { exchangeClaim } = await import('./claim.js');
    const out = await exchangeClaim('backthread_claim_abcdefghijklmnop', {
      env: PLAIN_ENV,
      fetchImpl: stubFetch(403, { error: slug }),
    });
    return out.message;
  },
  buildCliAuthPollUrl: async (slug) => {
    const { pollForToken } = await import('./cliAuthPoll.js');
    const { generateEphemeralKeypair } = await import('./cliAuthCrypto.js');
    // Clock and sleep are injected so the poll loop finishes rather than waiting out its
    // five-minute budget in a unit test.
    let t = 0;
    const out = await pollForToken('sess', generateEphemeralKeypair(), {
      env: PLAIN_ENV,
      fetchImpl: stubFetch(403, { error: slug }),
      timeoutMs: 10,
      intervalMs: 1,
      sleep: async () => {},
      now: () => (t += 4),
    });
    return JSON.stringify(out);
  },
};

test('every own-slug-map endpoint has a driver here', () => {
  const declared = Object.entries(CLI_ENDPOINTS)
    .filter(([, d]) => d.renders === 'own-slug-map')
    .map(([n]) => n)
    .sort();
  assert.deepEqual(Object.keys(OWN_MAP_DRIVERS).sort(), declared);
});

for (const name of Object.keys(OWN_MAP_DRIVERS).sort()) {
  test(`${name}: keeping its own map does not mean echoing an unmapped slug`, async () => {
    // ⚠ THE LAST UNCHECKED CATEGORY. `own-slug-map` demanded a sentence of justification
    // and verified nothing — exactly the hole that shipped two false `never-shown` claims
    // before it was closed for that category. "It maps its own slugs" is a claim about
    // behaviour, so it is asked as one: hand it a slug its map has never heard of and
    // watch whether the slug comes back out.
    const out = await OWN_MAP_DRIVERS[name]('some_slug_this_map_never_heard_of');
    assert.doesNotMatch(out, /some_slug_this_map_never_heard_of/, out);
  });
}

// --- the lead reaches the reader --------------------------------------------------------

test('the caller-written lead survives every branch, not just the fallback', () => {
  // ⚠ THREE MUTANTS SURVIVED HERE. Deleting `${lead}` from the reason branch and from the
  // authored-prose branch changed nothing, because only the step-4 fallback pinned it —
  // and the per-route lead is the entire mechanism behind different commands naming
  // different things while agreeing on the verdict.
  const LEAD = 'the zzz did not zzz';
  for (const payload of [
    OVERLOADED,
    UNAVAILABLE,
    { error: 'repo not found or not connected to Backthread' },
    { error: 'client_too_old', message: 'please update backthread' },
    {},
  ] as Array<Record<string, unknown>>) {
    const out = describeFailure({ lead: LEAD, status: 502, payload, env: PLAIN_ENV });
    assert.ok(out.startsWith(LEAD), `lead lost: ${out}`);
  }
});

/**
 * The lead each route writes. ⚠ NAMED, NOT COUNTED. The earlier version asserted that at
 * least 6 of 9 were distinct, so three routes could quietly collapse onto another's lead
 * while the test's own comment claimed "a lead deleted anywhere collapses this set". Four
 * such mutants survived. `answerLesson` and `answerAsk` share one deliberately — somebody
 * who just answered a question does not care which surface carried it.
 */
const EXPECTED_LEADS: Readonly<Record<string, string>> = {
  buildGroundedAskUrl: "the answer didn't come back",
  buildLessonStartUrl: "the lesson didn't start",
  buildLessonAnswerUrl: "your answer wasn't recorded",
  buildInflowAskUrl: 'no question came back',
  buildInflowAnswerUrl: "your answer wasn't recorded",
  buildInferDecisionsUrl: "this session wasn't written up",
  buildReadDecisionsUrl: "the decision log didn't sync",
  buildIngestDecisionsUrl: "the decisions weren't saved",
  buildOnboardingStateUrl: "your setup status didn't load",
};

test('each route names its own thing, by name', async () => {
  assert.deepEqual(Object.keys(EXPECTED_LEADS).sort(), failureBodyEndpoints());
  for (const name of failureBodyEndpoints()) {
    const detail = await DRIVERS[name](502, UNAVAILABLE, PLAIN_ENV);
    assert.ok(
      detail.startsWith(EXPECTED_LEADS[name]),
      `${name}: expected to open with "${EXPECTED_LEADS[name]}", got "${detail}"`,
    );
  }
});

// --- a refusal is not a bug report ------------------------------------------------------

test("a 4xx carrying reason:'unavailable' is still not a bug report", () => {
  // ⚠ THE GATE THE CODE COMMENT DEFENDS, UNASSERTED UNTIL A MUTANT SURVIVED DROPPING IT.
  // No server sends this combination today, which is exactly why the claim "a 4xx never
  // does" was true by accident rather than by construction.
  const out = describeFailure({
    lead: 'x',
    status: 403,
    payload: { error: 'zzz_unmapped', reason: 'unavailable' },
    env: PLAIN_ENV,
  });
  assert.match(out, /retrying will not help/);
  assert.doesNotMatch(out, /issues/, out);
});

test('a 5xx carrying the same reason IS', () => {
  const out = describeFailure({
    lead: 'x',
    status: 502,
    payload: { error: 'zzz_unmapped', reason: 'unavailable' },
    env: PLAIN_ENV,
  });
  assert.match(out, /github\.com\/backthread\/backthread\/issues/);
});

test('a 4xx refusal is NOT sent to the issue tracker', () => {
  // ⚠ THE FIRST DRAFT APPENDED THE BUG-REPORT TAIL UNCONDITIONALLY, so a lesson rate limit,
  // an authorization refusal and a repo you cannot write to all ended "report what that
  // prints at github.com/…/issues". Telling somebody to file a bug about a working
  // permission check is worse than telling them nothing, because it is confidently wrong.
  for (const status of [400, 401, 403, 404, 409, 410, 429]) {
    const out = describeFailure({ lead: 'x', status, payload: { error: 'zzz_unmapped' }, env: PLAIN_ENV });
    assert.doesNotMatch(out, /issues/, `HTTP ${status}: ${out}`);
  }
});

test('a 5xx with no contract IS worth reporting', () => {
  for (const status of [500, 502, 503]) {
    const out = describeFailure({ lead: 'x', status, payload: { error: 'zzz_unmapped' }, env: PLAIN_ENV });
    assert.match(out, /github\.com\/backthread\/backthread\/issues/, `HTTP ${status}`);
  }
});

test('a route-specific override BEATS the global table for the same slug', () => {
  // ⚠ UNASSERTED UNTIL A MUTANT SURVIVED SWAPPING THE SPREAD ORDER. No key collides today,
  // so the documented direction — local meaning wins over global — was a comment. It is the
  // direction that matters the day a slug means something different on one route, which is
  // the only reason the argument exists.
  const out = describeFailure({
    lead: 'x',
    status: 403,
    payload: { error: 'not_a_member' },
    env: PLAIN_ENV,
    overrides: { not_a_member: 'this one route says something else entirely.' },
  });
  assert.match(out, /this one route says something else entirely\./);
  assert.doesNotMatch(out, /ask one of its owners/);
});

test('an inherited property is not a sentence', () => {
  // ⚠ MEASURED USER-VISIBLE GARBAGE. The lookup was a bare index into an object literal, so
  // `{"error":"toString"}` from the server made the whole line
  // `function toString() { [native code] }` — no lead, no verdict, no status, no next step.
  for (const key of [
    'toString',
    'constructor',
    '__proto__',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'toLocaleString',
    'propertyIsEnumerable',
  ]) {
    const out = describeFailure({ lead: 'zzlead', status: 500, payload: { error: key }, env: PLAIN_ENV });
    assert.ok(out.startsWith('zzlead'), `${key}: ${out}`);
    assert.doesNotMatch(out, /native code|\[object /, `${key}: ${out}`);
  }
  // …and the same on the overrides side, which is also a caller-supplied object.
  const viaOverride = describeFailure({
    lead: 'zzlead',
    status: 500,
    payload: { error: 'toString' },
    env: PLAIN_ENV,
    overrides: {},
  });
  assert.ok(viaOverride.startsWith('zzlead'), viaOverride);
});

test('every sentence in the table is reachable through the renderer', () => {
  // ⚠ SEVEN ENTRIES WERE DELETABLE WITH THE SUITE GREEN. The list-based test below asserts
  // the KEY exists, which is a restatement of the table rather than a check on it. This
  // drives each one through `describeFailure` and reads the output, so an entry that stops
  // being used stops passing.
  for (const [slug, copy] of Object.entries(SLUG_COPY)) {
    const out = describeFailure({ lead: 'zzlead', status: 500, payload: { error: slug }, env: PLAIN_ENV });
    assert.equal(out, copy, `${slug} did not render its own sentence`);
    assert.doesNotMatch(out, new RegExp(slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${slug} maps to itself`);
  }
});

/**
 * The complete set of `error` values a route THIS PACKAGE CALLS can send, transcribed from
 * the servers' source.
 *
 * ⚠ SET-EQUAL, NOT "EACH KEY EXISTS". The earlier version iterated the table and asserted
 * things about what it found, which is a restatement rather than a check: seven entries
 * were deletable with the suite green, because deleting one simply meant it was not
 * iterated. The list has to come from OUTSIDE the table, and outside is all this package
 * can reach for — it cannot import the server. So it is written down, and it is CLOSED in
 * both directions: dropping a sentence fails, and adding one without saying which server
 * line sends it fails too.
 *
 * Absent on purpose: `client_too_old` (ships a server-authored `message` with the exact
 * upgrade instruction, which the message branch renders verbatim), `ask_expired` (a bare
 * 410 the inflow path catches by status, plus a route-local override), `lesson_in_progress`
 * on the 409 (the lesson path renders the server's own sentence there) — and every slug
 * belonging to /ci/snapshot or the git-decisions routes, which this package never calls.
 */
const REACHABLE_SLUGS = [
  // worker resolveRepoGate + read/ingest-decisions authz
  'repo_not_found',
  'not_a_member',
  'not_readable',
  'repo_not_writable',
  // deliberate refusals
  'plan_limit',
  'lesson_retry_too_soon',
  'lesson_in_progress',
  'ask_not_yours',
  'ask_malformed',
  'ask_bad_signature',
  'ask_material_moved',
  // our bug, said as ours
  'invalid_body',
  'invalid_payload',
  'invalid_field',
  'method not allowed',
  // a slug paired with a raw upstream string — mapped so the string never renders
  'persist_failed',
  'inference_failed',
  // deviceAuth (worker) and every Function share this vocabulary
  'invalid token',
  'token expired',
  'invalid session',
  'insufficient scope',
  'missing authorization',
].sort();

test('the table covers exactly the vocabulary the reachable routes send', () => {
  assert.deepEqual(
    Object.keys(SLUG_COPY).sort(),
    REACHABLE_SLUGS,
    'a slug the servers send has no sentence, or a sentence exists for a slug nothing sends',
  );
});

/**
 * The sentence itself, per slug. ⚠ SPELLED OUT, NOT DESCRIBED. Fifteen of these were pinned
 * only by "longer than twenty characters, doesn't name itself, isn't the fallback" — so
 * rewriting one to say something wrong stayed green, and two mutants that reverted the
 * previous commit's headline fix (telling a reader to contact owners of a repo that by
 * definition has none) were invisible. Copy is the product here; it gets asserted like one.
 */
const EXPECTED_COPY: Readonly<Record<string, string>> = {
  repo_not_found: "that repo isn't connected to Backthread yet — run `backthread` to connect it.",
  not_a_member:
    "you're not a member of the account that owns that repo — ask one of its owners to invite you.",
  not_readable:
    "that repo has no owning Backthread account, so there is nothing to read — run `backthread` to connect it.",
  repo_not_writable:
    "that repo has no owning Backthread account, so nothing can be saved against it — run `backthread` to connect it.",
  plan_limit:
    'this account has used its capture allowance for now — open Billing in the web app to raise it.',
  lesson_retry_too_soon:
    'the last few attempts for this repo found nothing worth asking about, so no more are being built for now — try again later.',
  lesson_in_progress: 'a lesson is already being prepared for this repo — try again in a moment.',
  ask_not_yours: 'that question belongs to somebody else, so it cannot be answered here.',
  ask_malformed: 'that answer token is not one this client recognises — ask for a fresh question.',
  ask_material_moved:
    'the recorded material behind that question changed since it was asked, so it is not answerable any more. Nothing was recorded against you.',
  ask_bad_signature:
    'that answer token could not be verified, so nothing was recorded — ask for a fresh question.',
  invalid_body: 'nothing is wrong with what you did — it failed on our side.',
  invalid_payload: 'nothing is wrong with what you did — it failed on our side.',
  invalid_field: 'nothing is wrong with what you did — it failed on our side.',
  'method not allowed': 'nothing is wrong with what you did — it failed on our side.',
  persist_failed: "the write didn't complete on our side. Nothing was saved; try again.",
  inference_failed: "the write-up didn't complete on our side. Nothing was saved; try again.",
  'invalid token': 'this device is no longer authorized — run `backthread login` again.',
  'token expired': 'this device is no longer authorized — run `backthread login` again.',
  'invalid session': 'this device is no longer authorized — run `backthread login` again.',
  'insufficient scope': 'this device is no longer authorized — run `backthread login` again.',
  'missing authorization': 'this device is no longer authorized — run `backthread login` again.',
};

test('every slug renders the exact sentence it is meant to', () => {
  assert.deepEqual(Object.keys(EXPECTED_COPY).sort(), REACHABLE_SLUGS);
  for (const [slug, want] of Object.entries(EXPECTED_COPY)) {
    const out = describeFailure({ lead: 'zzlead', status: 500, payload: { error: slug }, env: PLAIN_ENV });
    assert.equal(out, want, `${slug} does not say what it is meant to say`);
  }
});

test('the four sentences that were once wrong about their own condition stay right', () => {
  // Each of these described a condition the producer does not have. Named individually so
  // a revert is a named failure rather than a diff nobody reads.
  assert.doesNotMatch(EXPECTED_COPY.not_readable, /ask one of its owners/);
  assert.doesNotMatch(EXPECTED_COPY.repo_not_writable, /ask one of its owners/);
  assert.doesNotMatch(EXPECTED_COPY.plan_limit, /decision limit/);
  assert.doesNotMatch(EXPECTED_COPY.lesson_retry_too_soon, /was built very recently/);
  assert.doesNotMatch(EXPECTED_COPY.ask_bad_signature, /issued to this device/);
  // …and "our bug" must not invite the reader to look for their own mistake.
  assert.match(EXPECTED_COPY.invalid_body, /nothing is wrong with what you did/);
});

test('every one of those names what to do, and none names itself', () => {
  for (const slug of REACHABLE_SLUGS) {
    const out = describeFailure({ lead: 'zzlead', status: 500, payload: { error: slug }, env: PLAIN_ENV });
    assert.ok(out.length > 20, `${slug}: ${out}`);
    assert.doesNotMatch(
      out,
      new RegExp(slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${slug} maps to itself`,
    );
    // A mapped slug replaces the whole sentence, so the generic fallback must not show.
    assert.doesNotMatch(out, /The server rejected it/, `${slug} fell through to the fallback`);
  }
});

// --- a 5xx `error` string is a diagnostic, not copy ---------------------------------------

test('a raw upstream string in `error` on a 5xx never reaches the reader', () => {
  // ⚠ THREE EDGE FUNCTIONS DO `json({ error: message }, 500)` WITH THE CAUGHT UPSTREAM
  // STRING. Measured before the status gate: `backthread sync: read-failed — the decision
  // log didn't sync — could not serialize access due to concurrent update`. Nobody writes
  // reader-facing copy for a 500, so on a 5xx the field is treated as the diagnostic it is.
  for (const raw of [
    'could not serialize access due to concurrent update',
    'permission denied for schema private',
    'canceling statement due to statement timeout',
  ]) {
    const out = describeFailure({ lead: 'zzlead', status: 500, payload: { error: raw }, env: PLAIN_ENV });
    assert.doesNotMatch(out, /serialize|permission denied|canceling statement/, out);
    assert.match(out, /^zzlead\. The server rejected it \(HTTP 500\)\./);
    assert.match(out, /issues/, 'a 5xx dead end still names where to take it');
  }
});

test('the operator still gets that string, because nobody else will', () => {
  const out = describeFailure({
    lead: 'zzlead',
    status: 500,
    payload: { error: 'permission denied for schema private' },
    env: VERBOSE_ENV,
  });
  assert.match(out, /error=permission denied for schema private/);
});

test('the SAME string on a 4xx is worker-authored copy and still renders', () => {
  // The gate must not swallow the sentences the previous round restored: a 4xx `error`
  // string is the server answering the caller's own request.
  const out = describeFailure({
    lead: 'zzlead',
    status: 404,
    payload: { error: 'repo not found or not connected to Backthread' },
    env: PLAIN_ENV,
  });
  assert.match(out, /repo not found or not connected to Backthread/);
});

test('--verbose means something on the two paths that answer before the renderer', async () => {
  // The 409 "already being prepared" and the bare-410 expired-ask are both RIGHT to write
  // their own sentence — but the switch stopped meaning anything on exactly the two paths
  // somebody is most likely to re-run.
  const { startLesson } = await import('./lesson.js');
  const started = await startLesson(
    { repo: 'acme/widgets' },
    {
      env: VERBOSE_ENV,
      fetchImpl: stubFetch(409, { error: 'lesson_in_progress' }),
      readConfigImpl,
      readRemoteImpl,
    },
  );
  assert.match(started.detail, /\[status=409 error=lesson_in_progress\]/, started.detail);

  const { answerAsk } = await import('./inflow.js');
  const answered = await answerAsk(
    { token: 'tok', answer: 'x' },
    { env: VERBOSE_ENV, fetchImpl: stubFetch(410, {}), readConfigImpl, readRemoteImpl },
  );
  assert.match(answered.detail, /nothing is owed/);
  assert.match(answered.detail, /\[status=410\]/, answered.detail);
});

test('a server-authored `message` beats prose in `error` when a 4xx carries both', () => {
  // ⚠ THE ORDER OF THE TWO READERS WAS UNASSERTED — swapping them survived the suite,
  // because no producer this package reaches sends both today. `message` is the field a
  // server uses when it means to be read; `error` holding prose is the older habit. If one
  // ever arrives with both, the deliberate one wins.
  const out = describeFailure({
    lead: 'zzlead',
    status: 400,
    payload: { error: 'no repo given and none connected', message: 'pass repo:"owner/name"' },
    env: PLAIN_ENV,
  });
  assert.match(out, /pass repo:"owner\/name"/);
  assert.doesNotMatch(out, /no repo given and none connected/);
});

test('urls.ts is the only place an endpoint can be born', () => {
  // The claim the registry doc makes about itself, asked directly. Both halves matter: one
  // module, and that module cannot make a request — so "built here" and "used there" can
  // never be the same declaration, which is how a build-and-fetch function slipped past.
  assert.deepEqual(URL_MODULES, ['urls.ts']);
  assert.doesNotMatch(codeOnly(readFileSync(join(SRC_DIR, 'urls.ts'), 'utf8')), /\bfetch\b/i);
  // …and every export of it is classified, origin helpers aside.
  assert.ok(declaredBuilders().length >= 12, `only ${declaredBuilders().length} exports classified`);
});

test('a 5xx `message` is withheld from the reader and handed to the operator', () => {
  const payload = {
    error: 'persist_failed',
    message: 'duplicate key value violates unique constraint "decisions_pkey"',
  };
  const plain = describeFailure({ lead: 'zzlead', status: 500, payload, env: PLAIN_ENV });
  assert.doesNotMatch(plain, /duplicate key|decisions_pkey/, plain);
  const loud = describeFailure({ lead: 'zzlead', status: 500, payload, env: VERBOSE_ENV });
  assert.match(loud, /message=duplicate key value violates unique constraint/, loud);
});

test('a 4xx `message` is the reader\'s, so it is not repeated as a diagnostic', () => {
  const out = describeFailure({
    lead: 'zzlead',
    status: 426,
    payload: { error: 'client_too_old', message: 'please update backthread' },
    env: VERBOSE_ENV,
  });
  assert.match(out, /please update backthread/);
  assert.doesNotMatch(out, /message=/, out);
});

// --- the last unpinned copy table, and two invariants that rested on habit --------------

/** Every scope-skip sentence, spelled out — the same rigor `SLUG_COPY` gets. */
const EXPECTED_SCOPE_COPY: Readonly<Record<string, string>> = {
  connected: 'this repo is connected',
  not_connected: "this repo isn't connected to Backthread yet, so nothing was read or sent",
  repo_not_writable: 'this repo has no owning Backthread account, so nothing was read or sent',
  not_a_member:
    "you're not a member of the account that owns this repo, so nothing was read or sent",
  capture_paused: 'capture is paused for this repo, so nothing was read or sent',
  unknown: 'the scope check could not be reached, so nothing was read or sent',
  other: 'this repo is out of capture scope, so nothing was read or sent',
};

test('every scope-skip sentence is the sentence it is meant to be', async () => {
  // ⚠ FOUR MUTANTS SURVIVED HERE. The guard checked non-empty and not-self-mapping, so
  // replacing three of these with each other's copy — on a table `capture --manual` prints —
  // was green. `SLUG_COPY` is asserted sentence by sentence; this is the same product.
  const { SCOPE_REASON_COPY } = await import('./captureScope.js');
  assert.deepEqual(Object.keys(SCOPE_REASON_COPY).sort(), Object.keys(EXPECTED_SCOPE_COPY).sort());
  for (const [reason, want] of Object.entries(EXPECTED_SCOPE_COPY)) {
    assert.equal(
      (SCOPE_REASON_COPY as Record<string, string>)[reason],
      want,
      `${reason} does not say what it is meant to say`,
    );
  }
});

test('a server-authored sentence is joined as an appositive, not as a new sentence', () => {
  // The dash is argued for in failureCopy.ts — somebody else's words, no guaranteed capital
  // — and nothing pinned it, so swapping it for a full stop was invisible.
  const out = describeFailure({
    lead: 'zzlead',
    status: 426,
    payload: { error: 'client_too_old', message: 'please update backthread' },
    env: PLAIN_ENV,
  });
  assert.equal(out, 'zzlead — please update backthread');
});

test('a wire verdict of `unavailable` outranks the GLOBAL table, but not a route-local one', () => {
  // Two global sentences end "try again"; saying that over a server which has just said
  // retrying will not help is the CLI overruling the wire about the one thing it knows
  // better. A route-local override still wins — it exists because that route knows more.
  const global = describeFailure({
    lead: 'zzlead',
    status: 503,
    payload: { error: 'persist_failed', reason: 'unavailable' },
    env: PLAIN_ENV,
  });
  assert.match(global, /retrying will not help/);
  assert.doesNotMatch(global, /try again/);

  const local = describeFailure({
    lead: 'zzlead',
    status: 503,
    payload: { error: 'ask_expired', reason: 'unavailable' },
    env: PLAIN_ENV,
    overrides: { ask_expired: 'that ask has expired.' },
  });
  assert.match(local, /^that ask has expired\./);
});

test('a 5xx `message` never renders, whatever slug it arrives with', () => {
  // ⚠ THE INVARIANT USED TO REST ON `SLUG_COPY` STAYING EXHAUSTIVE. `readAuthoredError` was
  // status-gated and `message` was not, so one new 5xx slug on any Function re-opened the
  // raw-database-text path. Measured through `login --claim` before the gate.
  const out = describeFailure({
    lead: 'zzlead',
    status: 500,
    payload: { error: 'a_slug_nothing_maps', message: 'duplicate key value violates unique constraint "lessons_pkey"' },
    env: PLAIN_ENV,
  });
  assert.doesNotMatch(out, /duplicate key|lessons_pkey/, out);
  assert.match(out, /The server rejected it \(HTTP 500\)/);
  assert.match(describeFailure({
    lead: 'zzlead',
    status: 500,
    payload: { error: 'a_slug_nothing_maps', message: 'duplicate key' },
    env: VERBOSE_ENV,
  }), /message=duplicate key/);
});

test('a single word is not a sentence somebody wrote for you', () => {
  const out = describeFailure({ lead: 'zzlead', status: 400, payload: { error: 'hasOwnProperty' }, env: PLAIN_ENV });
  assert.doesNotMatch(out, /hasOwnProperty/, out);
  assert.match(out, /HTTP 400/);
});

test('the verdict follows the lead as a SENTENCE, not as another dashed clause', () => {
  // ⚠ A SURVIVING MUTANT, on a join the module argues for explicitly: the presenter above
  // this already prefixes `query: read-failed — `, so a third dash turns the line into a log
  // entry. Swapping the full stop for a dash was invisible.
  const out = describeFailure({ lead: 'zzlead', status: 502, payload: OVERLOADED, env: PLAIN_ENV });
  assert.equal(out, 'zzlead. The database was busy — try again in a moment.');
});
