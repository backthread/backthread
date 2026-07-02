import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  queryDecisions,
  resolveQueryRepo,
  countCitationsAfterCheckout,
  stalenessNote,
  type GitExitRunner,
  type QueryCitation,
  type QueryDeps,
} from './query.js';
import type { BackthreadConfig } from './config.js';

// GUARDRAIL: every test injects a config WITH a device_token + a mocked fetch +
// (where relevant) a git-remote reader, so NOTHING here hits real auth, network, or
// a browser. There is no ensureAuth/login seam in the query path at all — query is
// an explicit user action that simply reports "run `backthread login`" when unauthed.

const ENV: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;
const CONFIG: BackthreadConfig = { account: 'acc-1', repo: 'acme/app', device_token: 'backthread_pat_secret' };

// A fetch stub that asserts it only ever hits /grounded-ask and records the call.
function stubFetch(resp: { status: number; body: unknown }): {
  fetch: typeof fetch;
  calls: Array<{ url: string; body: any; auth: string | undefined; version: string | undefined }>;
} {
  const calls: Array<{ url: string; body: any; auth: string | undefined; version: string | undefined }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, body, auth: headers.Authorization, version: headers['x-backthread-version'] });
    if (!url.includes('/grounded-ask')) {
      throw new Error(`unexpected url: ${url}`);
    }
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => resp.body,
    } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function deps(over: Partial<QueryDeps> = {}): QueryDeps {
  return {
    env: ENV,
    readConfigImpl: async () => CONFIG,
    readRemoteImpl: () => 'git@github.com:acme/app.git',
    ...over,
  };
}

const OK_BODY = {
  ok: true,
  repo: { owner: 'acme', name: 'app' },
  question: 'how does checkout work?',
  answer: 'Checkout uses a queue to decouple ingestion [1].\n\nSources:\n  [1] Use a queue\n\nOpen the "How it works" diagram: https://app.backthread.dev/acme/app',
  coverage: 'partial',
  citations: [
    { n: 1, decisionId: 'd1', title: 'Use a queue', url: 'https://app.backthread.dev/acme/app', moduleIds: ['m1'], decidedAt: '2026-06-01T00:00:00Z' },
  ],
  inferredSpans: [],
  retrieved: 12,
  deepLink: 'https://app.backthread.dev/acme/app',
};

// --- resolveQueryRepo (pure precedence) --------------------------------------

test('resolveQueryRepo: explicit string slug wins over config + cwd', () => {
  const r = resolveQueryRepo({ repo: 'foo/bar', cwd: '/x' }, CONFIG, () => 'git@github.com:zzz/yyy.git');
  assert.deepEqual(r, { owner: 'foo', name: 'bar' });
});

test('resolveQueryRepo: explicit {owner,name} wins', () => {
  const r = resolveQueryRepo({ repo: { owner: 'o', name: 'n' } }, CONFIG);
  assert.deepEqual(r, { owner: 'o', name: 'n' });
});

test('resolveQueryRepo: falls back to config.repo', () => {
  const r = resolveQueryRepo({ cwd: '/x' }, CONFIG, () => null);
  assert.deepEqual(r, { owner: 'acme', name: 'app' });
});

test('resolveQueryRepo: falls back to cwd git remote when no config repo', () => {
  const r = resolveQueryRepo({ cwd: '/x' }, { device_token: 't' }, () => 'git@github.com:zzz/yyy.git');
  assert.deepEqual(r, { owner: 'zzz', name: 'yyy' });
});

test('resolveQueryRepo: malformed slug ignored, falls through', () => {
  const r = resolveQueryRepo({ repo: 'no-slash' }, CONFIG, () => null);
  assert.deepEqual(r, { owner: 'acme', name: 'app' }); // config.repo
});

test('resolveQueryRepo: returns null when nothing resolves', () => {
  const r = resolveQueryRepo({ cwd: '/x' }, { device_token: 't' }, () => null);
  assert.equal(r, null);
});

// --- queryDecisions (thin relay to /grounded-ask) ----------------------------

test('queryDecisions: happy path relays question + repo, returns the synthesized answer verbatim', async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: OK_BODY });
  const out = await queryDecisions({ question: 'how does checkout work?', repo: 'acme/app' }, deps({ fetchImpl: fetch }));

  assert.equal(out.status, 'ok');
  assert.deepEqual(out.repo, { owner: 'acme', name: 'app' });
  assert.equal(out.answer, OK_BODY.answer); // rendered verbatim
  assert.equal(out.coverage, 'partial');
  assert.equal(out.citations?.length, 1);
  assert.equal(out.citations?.[0].title, 'Use a queue');
  assert.equal(out.deepLink, 'https://app.backthread.dev/acme/app');

  // exactly one call, to grounded-ask, bearer the device token, {question, repo} in body.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/grounded-ask$/);
  assert.equal(calls[0].auth, 'Bearer backthread_pat_secret');
  assert.deepEqual(calls[0].body, { question: 'how does checkout work?', repo: 'acme/app' });
  // The cli stamps its version so the server can run the compat guard.
  assert.match(calls[0].version ?? '', /^\d+\.\d+\.\d+/);
});

test('queryDecisions: missing question defaults to a general question (server requires one)', async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: OK_BODY });
  const out = await queryDecisions({ repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'ok');
  assert.equal(calls[0].body.question, 'How does this project work?');
  assert.equal(calls[0].body.repo, 'acme/app');
});

test('queryDecisions: carries a non-fatal server upgrade nudge in the SEPARATE upgrade field (ARP-734)', async () => {
  const { fetch } = stubFetch({
    status: 200,
    body: { ...OK_BODY, upgrade: 'A newer `backthread` is available — run `npm i -g backthread@latest`.' },
  });
  const out = await queryDecisions({ question: 'q', repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'ok');
  assert.match(out.upgrade ?? '', /newer `backthread` is available/);
  assert.doesNotMatch(out.detail, /newer `backthread` is available/);
});

test('queryDecisions: a 426 too-old soft-block prefers the friendly message', async () => {
  const { fetch } = stubFetch({
    status: 426,
    body: { error: 'client_too_old', message: 'Your `backthread` is too old — run `npm i -g backthread@latest`.' },
  });
  const out = await queryDecisions({ question: 'q', repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'read-failed');
  assert.match(out.detail, /too old/);
  assert.match(out.detail, /npm i -g backthread@latest/);
});

test('queryDecisions: no device token → no-auth, NO fetch, NO login triggered', async () => {
  let fetched = false;
  const out = await queryDecisions(
    { question: 'q', repo: 'acme/app' },
    deps({
      readConfigImpl: async () => ({ account: 'a' }), // no device_token
      fetchImpl: (async () => {
        fetched = true;
        throw new Error('must not fetch');
      }) as typeof fetch,
    }),
  );
  assert.equal(out.status, 'no-auth');
  assert.equal(fetched, false);
  assert.match(out.detail, /backthread login/);
});

test('queryDecisions: no resolvable repo → no-repo, NO fetch', async () => {
  let fetched = false;
  const out = await queryDecisions(
    { question: 'q' }, // no repo arg, no cwd
    deps({
      readConfigImpl: async () => ({ device_token: 't' }), // no config.repo
      readRemoteImpl: () => null,
      fetchImpl: (async () => {
        fetched = true;
        throw new Error('must not fetch');
      }) as typeof fetch,
    }),
  );
  assert.equal(out.status, 'no-repo');
  assert.equal(fetched, false);
});

test('queryDecisions: server rejection surfaces read-failed with detail + deep-link', async () => {
  const { fetch } = stubFetch({ status: 403, body: { error: 'not authorized to read this repo' } });
  const out = await queryDecisions({ question: 'q', repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'read-failed');
  assert.match(out.detail, /403/);
  assert.match(out.detail, /not authorized/);
  // deep-link is still returned (repo was resolvable) so the agent can offer it.
  assert.equal(out.deepLink, 'https://app.backthread.dev/acme/app');
});

test('queryDecisions: network throw surfaces read-failed (never throws)', async () => {
  const out = await queryDecisions(
    { question: 'q', repo: 'acme/app' },
    deps({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    }),
  );
  assert.equal(out.status, 'read-failed');
  assert.match(out.detail, /ECONNREFUSED/);
});

test('queryDecisions: a timeout (AbortError) surfaces a clean read-failed', async () => {
  const out = await queryDecisions(
    { question: 'q', repo: 'acme/app' },
    deps({
      fetchImpl: (async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }) as typeof fetch,
    }),
  );
  assert.equal(out.status, 'read-failed');
  assert.match(out.detail, /timed out/);
});

// --- ARP-839: one automatic retry on timeout / network error / 5xx ------------

/** A fetch stub that fails the first N attempts, then succeeds. */
function flakyFetch(failures: Array<'abort' | 'network' | 500>, okBody: unknown): {
  fetch: typeof fetch;
  calls: () => number;
} {
  let n = 0;
  const fetchImpl = (async () => {
    const mode = failures[n];
    n += 1;
    if (mode === 'abort') {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (mode === 'network') throw new Error('ECONNRESET');
    if (mode === 500) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response;
    return { ok: true, status: 200, json: async () => okBody } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls: () => n };
}

test('queryDecisions: a 5xx first attempt retries once and succeeds (ARP-839)', async () => {
  const { fetch, calls } = flakyFetch([500], OK_BODY);
  const out = await queryDecisions({ question: 'q', repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'ok');
  assert.equal(calls(), 2, 'exactly one retry');
});

test('queryDecisions: a timed-out first attempt retries once and succeeds (ARP-839)', async () => {
  const { fetch, calls } = flakyFetch(['abort'], OK_BODY);
  const out = await queryDecisions({ question: 'q', repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'ok');
  assert.equal(calls(), 2);
});

test('queryDecisions: two failing attempts surface read-failed with the attempt count', async () => {
  const { fetch, calls } = flakyFetch(['network', 'network'], OK_BODY);
  const out = await queryDecisions({ question: 'q', repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'read-failed');
  assert.match(out.detail, /after 2 attempts/);
  assert.equal(calls(), 2, 'never more than one retry');
});

test('queryDecisions: 4xx rejections do NOT retry (auth/bad-repo are not transient)', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    return { ok: false, status: 403, json: async () => ({ error: 'not authorized' }) } as Response;
  }) as typeof fetch;
  const out = await queryDecisions({ question: 'q', repo: 'acme/app' }, deps({ fetchImpl }));
  assert.equal(out.status, 'read-failed');
  assert.match(out.detail, /403/);
  assert.equal(n, 1, '4xx must not be retried');
});

test('queryDecisions: 200 with no answer degrades to read-failed (never an empty result)', async () => {
  const { fetch } = stubFetch({ status: 200, body: { ok: true, answer: '' } });
  const out = await queryDecisions({ question: 'q', repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'read-failed');
  assert.match(out.detail, /no answer/);
});

test('queryDecisions: token never appears in the outcome', async () => {
  const { fetch } = stubFetch({ status: 500, body: { error: 'boom' } });
  const out = await queryDecisions({ question: 'q', repo: 'acme/app' }, deps({ fetchImpl: fetch }));
  assert.equal(out.status, 'read-failed');
  assert.ok(!JSON.stringify(out).includes('backthread_pat_secret'), 'device token leaked into outcome');
});

test('queryDecisions: BACKTHREAD_APP_URL override flows into the fallback deep-link', async () => {
  // server omits deepLink → cli falls back to the locally-built one (app-url override)
  const { fetch } = stubFetch({ status: 200, body: { ...OK_BODY, deepLink: undefined } });
  const out = await queryDecisions(
    { question: 'q', repo: 'acme/app' },
    deps({ fetchImpl: fetch, env: { BACKTHREAD_APP_URL: 'http://localhost:5173' } as NodeJS.ProcessEnv }),
  );
  assert.equal(out.deepLink, 'http://localhost:5173/acme/app');
});


// --- ARP-840: cited-decision staleness note -------------------------------------

const SHA_A = 'a'.repeat(40); // contained in the checkout
const SHA_B = 'b'.repeat(40); // exists locally but not an ancestor (fetched, unmerged)
const SHA_C = 'c'.repeat(40); // absent from the object store (landed after)

function cite(n: number, anchorSha: string | null): QueryCitation {
  return { n, decisionId: `d${n}`, title: `T${n}`, url: '', moduleIds: [], decidedAt: null, anchorSha };
}

/** A git stub over a tiny world: which shas exist, which are ancestors of HEAD. */
function gitWorld(world: { exists: string[]; ancestors: string[]; broken?: boolean }): GitExitRunner {
  return (args) => {
    if (world.broken) return 128; // not a repo / git exploded
    if (args[0] === 'rev-parse') {
      const sha = String(args[3]).replace(/\^\{commit\}$/, '');
      return world.exists.includes(sha) ? 0 : 1;
    }
    if (args[0] === 'merge-base') {
      return world.ancestors.includes(String(args[2])) ? 0 : 1;
    }
    return 128;
  };
}

test('countCitationsAfterCheckout: counts CITATIONS whose anchor is missing or unmerged', () => {
  const run = gitWorld({ exists: [SHA_A, SHA_B], ancestors: [SHA_A] });
  const citations = [cite(1, SHA_A), cite(2, SHA_B), cite(3, SHA_C), cite(4, SHA_C), cite(5, null)];
  // B (not ancestor) + two C citations (absent) = 3; A contained + null-anchor never count.
  assert.equal(countCitationsAfterCheckout(citations, '/tmp', run), 3);
});

test('countCitationsAfterCheckout: all anchors contained → 0 (silent)', () => {
  const run = gitWorld({ exists: [SHA_A], ancestors: [SHA_A] });
  assert.equal(countCitationsAfterCheckout([cite(1, SHA_A), cite(2, SHA_A)], '/tmp', run), 0);
});

test('countCitationsAfterCheckout: no anchors at all → 0 without ever invoking git', () => {
  const run: GitExitRunner = () => {
    throw new Error('git must not run');
  };
  assert.equal(countCitationsAfterCheckout([cite(1, null), cite(2, 'not-a-sha!')], '/tmp', run), 0);
});

test('countCitationsAfterCheckout: any git error (non-repo cwd) → 0, note stays silent', () => {
  const run = gitWorld({ exists: [], ancestors: [], broken: true });
  assert.equal(countCitationsAfterCheckout([cite(1, SHA_C)], '/tmp', run), 0);
});

test('queryDecisions: appends the staleness note when a cited anchor landed after the checkout', async () => {
  const body = {
    ...OK_BODY,
    citations: [
      { n: 1, decisionId: 'd1', title: 'A', url: '', moduleIds: [], decidedAt: null, anchorSha: SHA_A },
      { n: 2, decisionId: 'd2', title: 'B', url: '', moduleIds: [], decidedAt: null, anchorSha: SHA_C },
    ],
  };
  const { fetch } = stubFetch({ status: 200, body });
  const out = await queryDecisions(
    { question: 'q', repo: 'acme/app', cwd: '/tmp' },
    deps({ fetchImpl: fetch, runGitImpl: gitWorld({ exists: [SHA_A], ancestors: [SHA_A] }) }),
  );
  assert.equal(out.status, 'ok');
  assert.ok(out.answer!.endsWith(stalenessNote(1)), `note appended once: ${out.answer!.slice(-140)}`);
  // the note references the checkout, never breaks the verbatim prose above it
  assert.ok(out.answer!.startsWith(String(OK_BODY.answer)));
});

test('queryDecisions: in-sync checkout → verbatim answer, no note', async () => {
  const body = {
    ...OK_BODY,
    citations: [{ n: 1, decisionId: 'd1', title: 'A', url: '', moduleIds: [], decidedAt: null, anchorSha: SHA_A }],
  };
  const { fetch } = stubFetch({ status: 200, body });
  const out = await queryDecisions(
    { question: 'q', repo: 'acme/app', cwd: '/tmp' },
    deps({ fetchImpl: fetch, runGitImpl: gitWorld({ exists: [SHA_A], ancestors: [SHA_A] }) }),
  );
  assert.equal(out.status, 'ok');
  assert.equal(out.answer, OK_BODY.answer, 'verbatim relay unchanged');
});

test('queryDecisions: non-git cwd (runner errors) → verbatim answer, no note', async () => {
  const body = {
    ...OK_BODY,
    citations: [{ n: 1, decisionId: 'd1', title: 'A', url: '', moduleIds: [], decidedAt: null, anchorSha: SHA_C }],
  };
  const { fetch } = stubFetch({ status: 200, body });
  const out = await queryDecisions(
    { question: 'q', repo: 'acme/app', cwd: '/tmp' },
    deps({ fetchImpl: fetch, runGitImpl: gitWorld({ exists: [], ancestors: [], broken: true }) }),
  );
  assert.equal(out.status, 'ok');
  assert.equal(out.answer, OK_BODY.answer);
});
