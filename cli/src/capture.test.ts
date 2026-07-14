import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHookInput, runCapture, type CaptureDeps, type HookInput } from './capture.js';
import type { BackthreadConfig } from './config.js';

// --- helpers -----------------------------------------------------------------

const ENV: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;
const CONFIG: BackthreadConfig = { account: 'acc-1', device_token: 'backthread_pat_secret' };

// A transcript with prose + a fenced code block + a tool_use record. The hook must
// derive from the prose only; the code + tool I/O must never leave.
const TRANSCRIPT_JSONL = [
  JSON.stringify({ type: 'user', sessionId: 'sess-7', message: { content: 'why a queue?' } }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-03T09:00:00Z',
    message: {
      content: [
        { type: 'text', text: 'To decouple ingestion.\n```js\nconst secret = 1;\n```' },
        { type: 'tool_use', name: 'Bash', input: { command: 'cat ~/.ssh/id_rsa' } },
      ],
    },
  }),
].join('\n');

// A fetch stub that routes by URL substring and records every call.
function stubFetch(
  routes: { infer?: (body: unknown) => { status: number; body: unknown }; ingest?: (body: unknown) => { status: number; body: unknown } },
): { fetch: typeof fetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    let r: { status: number; body: unknown };
    if (url.includes('/infer-decisions')) r = (routes.infer ?? (() => ({ status: 200, body: {} })))(body);
    else if (url.includes('/ingest-decisions'))
      r = (routes.ingest ?? (() => ({ status: 200, body: {} })))(body);
    else r = { status: 404, body: { error: 'unexpected url' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function deps(over: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
    env: ENV,
    readConfigImpl: async () => CONFIG,
    readFileImpl: async () => TRANSCRIPT_JSONL,
    readRemoteImpl: () => 'git@github.com:acme/app.git',
    // ARP-696/1208 — deterministic git context (never shell out to real git in tests).
    readGitImpl: (_cwd, args) =>
      args.includes('--abbrev-ref')
        ? 'feat/test\n'
        : args[0] === 'rev-parse'
          ? 'sha-test\n'
          : args[0] === 'config' && args[1] === 'user.name'
            ? 'Test User\n'
            : args[0] === 'config' && args[1] === 'user.email'
              ? 'test@x.com\n'
              : null,
    ensureAuthImpl: () => {},
    // stub the trust gate + first-capture confirmation to NO-OPS by
    // default so these tests never touch the real ~/.backthread/first-run.json. The
    // dedicated tests below override them to assert the wiring.
    showTrustGateImpl: async () => false,
    firstCaptureConfirmImpl: async () => false,
    log: () => {},
    ...over,
  };
}

const HOOK: HookInput = {
  transcript_path: '/tmp/sess.jsonl',
  cwd: '/work/app',
  session_id: 'sess-hook',
  hook_event_name: 'SessionEnd',
};

// --- parseHookInput ----------------------------------------------------------

test('parseHookInput parses a valid object', () => {
  assert.deepEqual(parseHookInput('{"transcript_path":"/x"}'), { transcript_path: '/x' });
});

test('parseHookInput returns {} on garbage / arrays / non-objects', () => {
  assert.deepEqual(parseHookInput('not json'), {});
  assert.deepEqual(parseHookInput('[]'), {});
  assert.deepEqual(parseHookInput('42'), {});
});

// --- the happy paths ---------------------------------------------------------

test('server persists (persist requested + connected) → no double-POST to ingest', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: (body) => {
      // persist was requested because a repo resolved.
      assert.equal((body as { persist?: unknown }).persist, true);
      assert.deepEqual((body as { repo?: unknown }).repo, { owner: 'acme', name: 'app' });
      // The REDACTED transcript reached us — never the code or tool I/O.
      const sent = JSON.stringify(body);
      assert.doesNotMatch(sent, /const secret/);
      assert.doesNotMatch(sent, /id_rsa/);
      return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'Use a queue' }] } };
    },
  });

  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'persisted-by-server');
  assert.equal(out.count, 1);
  // Exactly ONE call — to /infer-decisions. No ingest re-POST (would double-write).
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/infer-decisions$/);
});

// --- file-path anchor (sessionPaths) -----------------------------------------

// A transcript whose tool_use records carry file_path/cwd — both ABSOLUTE under
// the hook's cwd (/work/app) and one already-relative. sessionPaths normalizes
// the absolutes against cwd → repo-relative, and keeps the relative as-is.
const TRANSCRIPT_WITH_PATHS = [
  JSON.stringify({ type: 'user', sessionId: 'sess-9', message: { content: 'why this auth design?' } }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-03T09:00:00Z',
    message: {
      content: [
        { type: 'text', text: 'Role-split RLS keeps the writer path narrow.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/work/app/src/auth/rls.ts' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/work/app/src/auth/session.ts' } },
        // a path OUTSIDE the repo root → dropped (foreign)
        { type: 'tool_use', name: 'Read', input: { file_path: '/etc/passwd' } },
        // an already-relative path → kept as-is
        { type: 'tool_use', name: 'Write', input: { file_path: 'src/auth/policy.ts' } },
      ],
    },
  }),
].join('\n');

test('harvests sessionPaths (cwd-relative) and includes filePaths in the /infer-decisions body', async () => {
  let sentBody: unknown = null;
  const { fetch: fetchImpl } = stubFetch({
    infer: (body) => {
      sentBody = body;
      return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'role-split RLS' }] } };
    },
  });

  const out = await runCapture(HOOK, deps({ fetchImpl, readFileImpl: async () => TRANSCRIPT_WITH_PATHS }));
  assert.equal(out.status, 'persisted-by-server');

  const filePaths = (sentBody as { filePaths?: unknown }).filePaths as string[];
  // Absolutes under /work/app are relativized; the relative one is kept; /etc/passwd
  // is foreign → dropped. Output is deduped + sorted by sessionPaths.
  assert.deepEqual(filePaths, ['src/auth/policy.ts', 'src/auth/rls.ts', 'src/auth/session.ts']);
});

test('code-less session (no tool_use paths) → persist leg omits filePaths (unanchored, still captured)', async () => {
  let inferBody: unknown = null;
  const { fetch: fetchImpl } = stubFetch({
    infer: (body) => {
      inferBody = body;
      return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'move to RLS role-split' }] } };
    },
  });

  // TRANSCRIPT_JSONL is a planning/discussion session: its only tool_use is a Bash
  // COMMAND (not a file path), so sessionPaths yields []. The decision is still kept
  // + persisted (the server marks it unanchored). The body must NOT carry filePaths.
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'persisted-by-server');
  assert.equal((inferBody as { persist?: unknown }).persist, true);
  assert.equal((inferBody as { filePaths?: unknown }).filePaths, undefined);
});

test('absent cwd → derive-only leg sends NO machine-absolute paths', async () => {
  let inferBody: unknown = null;
  const { fetch: fetchImpl } = stubFetch({
    // Derive-only: server returns decisions but did not persist.
    infer: (body) => {
      inferBody = body;
      return { status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'x' }] } };
    },
  });

  // No cwd on the hook → resolveRepo can't run → derive-only path (no persist leg).
  // sessionPaths still ran on the records but, without a root to relativize against,
  // it SKIPS every absolute path (never emits a machine-absolute path). Since
  // filePaths ride only the persist leg, the derive-only /infer-decisions body omits
  // them entirely — and the subsequent ingest path can't claim (no repo).
  const hookNoCwd: HookInput = { transcript_path: '/tmp/sess.jsonl', session_id: 'sess-9' };
  const out = await runCapture(
    hookNoCwd,
    deps({ fetchImpl, readFileImpl: async () => TRANSCRIPT_WITH_PATHS }),
  );
  // No repo → derived decisions have nothing to claim under → nothing-to-capture.
  assert.equal(out.status, 'nothing-to-capture');

  // The /infer-decisions body never carried filePaths (derive-only) — and crucially,
  // nothing absolute leaked anywhere in the request.
  assert.equal((inferBody as { filePaths?: unknown }).filePaths, undefined);
  // Guard the trust boundary generically, not just against this fixture's two
  // literals: forbid ANY machine-absolute path (a string value beginning with a
  // common root dir) regardless of which dirs the fixture happened to use.
  assert.doesNotMatch(JSON.stringify(inferBody), /(?:"|: ?")\/(?:Users|home|etc|var|work|root|tmp|opt|private)\//);
});

test('derive-only (server did not persist) → POST derived decisions to ingest-decisions', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: () => ({
      status: 200,
      // Server returns decisions but did NOT persist them (e.g. not a member yet).
      body: { ok: true, persisted: false, decisions: [{ title: 'Use a queue', provenance: 'inferred' }] },
    }),
    ingest: (body) => {
      // The derived decisions are wrapped with the repo slug + decidedAt for dedupe.
      assert.deepEqual((body as { repo?: unknown }).repo, { owner: 'acme', name: 'app' });
      const decisions = (body as { decisions?: Array<Record<string, unknown>> }).decisions ?? [];
      assert.equal(decisions[0].title, 'Use a queue');
      assert.equal(decisions[0].decidedAt, '2026-06-03T09:00:00Z');
      return { status: 200, body: { ok: true, count: 1, repoConnected: true } };
    },
  });

  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'persisted');
  assert.equal(out.count, 1);
  assert.equal(out.repoConnected, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/infer-decisions$/);
  assert.match(calls[1].url, /\/ingest-decisions$/);
  // sanity: ingest body never carries raw source
  assert.doesNotMatch(JSON.stringify(calls[1].body), /const secret/);
});

test('ARP-734 — a server upgrade nudge rides the SEPARATE outcome.upgrade field, NOT detail', async () => {
  // The detached-hook-silence invariant: runCapture carries the nudge as data, but
  // `detail` (what the hook logs to stderr / discards) must NOT contain it. Only the
  // interactive presenters (manual capture / MCP query) surface it, throttled.
  const NUDGE = 'A newer `backthread` is available — npm i -g backthread@latest';
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'Use a queue' }] } }),
    ingest: () => ({ status: 200, body: { ok: true, count: 1, repoConnected: true, upgrade: NUDGE } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'persisted');
  assert.equal(out.upgrade, NUDGE); // carried as a field
  assert.doesNotMatch(out.detail, /newer `backthread`/); // NOT in detail (hook stays silent)
});

test('ARP-734 — server-persist path propagates the infer upgrade onto the outcome', async () => {
  const NUDGE = 'please update backthread';
  const { fetch: fetchImpl } = stubFetch({
    // Server persisted (connected repo) AND returned a non-fatal upgrade nudge.
    infer: () => ({ status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }], upgrade: NUDGE } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'persisted-by-server');
  assert.equal(out.upgrade, NUDGE);
  assert.doesNotMatch(out.detail, /please update/);
});

test('ARP-734 — the no-git-remote (no-repo) path still carries the infer upgrade', async () => {
  const NUDGE = 'newer backthread available';
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'x' }], upgrade: NUDGE } }),
  });
  // No git remote → repo unresolved → the "nothing to claim" path, which must STILL
  // surface the nudge so an interactive manual capture in a non-git dir shows it.
  const out = await runCapture(HOOK, deps({ fetchImpl, readRemoteImpl: () => null }));
  assert.equal(out.status, 'nothing-to-capture');
  assert.equal(out.upgrade, NUDGE);
});

// --- ARP-696: the capture hook reports git context to BOTH persist paths -----

test('ARP-696 — git context rides the connected /infer-decisions persist body', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: true, count: 1, decisions: [{ title: 'a' }] } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'persisted-by-server');
  const inferBody = calls[0].body as Record<string, unknown>;
  assert.equal(inferBody.capturedBranch, 'feat/test');
  assert.equal(inferBody.capturedHeadSha, 'sha-test');
  assert.equal(inferBody.capturedGitUser, 'Test User <test@x.com>'); // ARP-1208
  // `at` is the session timestamp (decidedAt) harvested from the transcript.
  assert.equal(inferBody.capturedAt, '2026-06-03T09:00:00Z');
});

test('ARP-696 — git context rides the repo-less /ingest-decisions body too', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: () => ({
      status: 200,
      body: { ok: true, persisted: false, decisions: [{ title: 'Use a queue', provenance: 'inferred' }] },
    }),
    ingest: () => ({ status: 200, body: { ok: true, count: 1, repoConnected: false, claimedRepo: 'acme/app' } }),
  });
  await runCapture(HOOK, deps({ fetchImpl }));
  const ingestBody = calls[1].body as Record<string, unknown>;
  assert.equal(ingestBody.capturedBranch, 'feat/test');
  assert.equal(ingestBody.capturedHeadSha, 'sha-test');
  assert.equal(ingestBody.capturedGitUser, 'Test User <test@x.com>'); // ARP-1208
  assert.equal(ingestBody.capturedAt, '2026-06-03T09:00:00Z');
});

test('ARP-696 — a non-git cwd (runner returns null) sends NO captured fields', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: true, count: 1, decisions: [{ title: 'a' }] } }),
  });
  // readGitImpl returns null for both rev-parse calls → no branch, no sha.
  await runCapture(HOOK, deps({ fetchImpl, readGitImpl: () => null }));
  const inferBody = calls[0].body as Record<string, unknown>;
  assert.ok(!('capturedBranch' in inferBody));
  assert.ok(!('capturedHeadSha' in inferBody));
  // `at` still rides (it's the session timestamp), but with no branch/sha the server
  // keeps the decision merged (held ⟺ releasable).
});

test('repo-less landing → reports not-yet-connected from ingest response', async () => {
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'x' }] } }),
    ingest: () => ({ status: 200, body: { ok: true, count: 1, repoConnected: false, claimedRepo: 'acme/app' } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'persisted');
  assert.equal(out.repoConnected, false);
  assert.match(out.detail, /not yet connected/);
});

// — the headline path THROUGH the hook end-to-end:
// the git remote resolves a repo, so the hook asks the Worker to persist
// (persist:true + repo). The repo isn't connected to Backthread yet, so the Worker
// can't write it — but it MUST degrade to derive-only (ok:true, persisted:false,
// decisions present + persistSkipped) rather than error. The hook then self-persists
// via ingest-decisions, which routes the capture repo-less and holds it as pending.
// REGRESSION GUARD: if the Worker ever reverts to erroring on an unconnected/non-member
// persist, `result.ok` goes false → capture returns `infer-failed` and these decisions
// are LOST instead of landing as pending. This pins that they land.
test('git remote resolves but repo NOT connected → decisions land as pending (repo-less), not lost', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: (body) => {
      // The hook DID ask the server to persist (a repo resolved from the git remote)…
      assert.equal((body as { persist?: unknown }).persist, true);
      assert.deepEqual((body as { repo?: unknown }).repo, { owner: 'acme', name: 'app' });
      // …but the repo is unconnected, so the Worker degrades to derive-only and hands
      // the decisions back (the new contract) instead of a 4xx that drops them.
      return {
        status: 200,
        body: {
          ok: true,
          persisted: false,
          persistSkipped: 'repo_not_found',
          decisions: [{ title: 'Use a queue', provenance: 'inferred' }],
        },
      };
    },
    // ingest-decisions routes repo-less server-side: stored as pending under the
    // device account with a claimed_repo (repoConnected:false).
    ingest: (body) => {
      assert.deepEqual((body as { repo?: unknown }).repo, { owner: 'acme', name: 'app' });
      const decisions = (body as { decisions?: Array<Record<string, unknown>> }).decisions ?? [];
      assert.equal(decisions[0].title, 'Use a queue');
      return { status: 200, body: { ok: true, count: 1, repoConnected: false, claimedRepo: 'acme/app' } };
    },
  });

  const out = await runCapture(HOOK, deps({ fetchImpl }));
  // The decisions LANDED (as pending) — NOT 'infer-failed', NOT lost.
  assert.equal(out.status, 'persisted');
  assert.equal(out.count, 1);
  assert.equal(out.repoConnected, false);
  assert.match(out.detail, /not yet connected/);
  // Both legs ran: infer (which degraded) THEN the ingest self-persist.
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/infer-decisions$/);
  assert.match(calls[1].url, /\/ingest-decisions$/);
});

// --- the skip / no-op paths --------------------------------------------------

test('no transcript_path → no-transcript, no network', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({});
  const out = await runCapture({ cwd: '/x' }, deps({ fetchImpl }));
  assert.equal(out.status, 'no-transcript');
  assert.equal(calls.length, 0);
});

test('no device token → fires login in the background and SKIPS this capture', async () => {
  let loginFired = false;
  const { fetch: fetchImpl, calls } = stubFetch({});
  const out = await runCapture(
    HOOK,
    deps({
      fetchImpl,
      readConfigImpl: async () => ({}), // no token
      ensureAuthImpl: () => {
        loginFired = true;
      },
    }),
  );
  assert.equal(out.status, 'no-auth');
  assert.equal(loginFired, true);
  assert.equal(calls.length, 0); // never POSTed without a credential
});

test('unreadable transcript → no-transcript (swallowed), no network', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({});
  const out = await runCapture(
    HOOK,
    deps({
      fetchImpl,
      readFileImpl: async () => {
        throw new Error('ENOENT');
      },
    }),
  );
  assert.equal(out.status, 'no-transcript');
  assert.match(out.detail, /ENOENT/);
  assert.equal(calls.length, 0);
});

test('tool-only session (no prose) → nothing-to-capture, no network', async () => {
  // Every record is tool_use / tool_result → ALL dropped, zero turns survive. (An
  // all-FENCED prose turn instead redacts to a `[code redacted]` sentinel turn,
  // which is non-empty and proceeds to inference — matches canonical transcript.ts.)
  const toolOnly = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'stdout' }] } }),
  ].join('\n');
  const { fetch: fetchImpl, calls } = stubFetch({});
  const out = await runCapture(HOOK, deps({ fetchImpl, readFileImpl: async () => toolOnly }));
  assert.equal(out.status, 'nothing-to-capture');
  assert.equal(calls.length, 0);
});

test('derived decisions but no resolvable repo → nothing-to-capture (nothing to claim under)', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    // No repo → infer is derive-only (no persist leg); returns decisions.
    infer: (body) => {
      assert.equal((body as { persist?: unknown }).persist, undefined);
      return { status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'x' }] } };
    },
  });
  const out = await runCapture(
    HOOK,
    deps({ fetchImpl, readRemoteImpl: () => null }), // not a git repo
  );
  assert.equal(out.status, 'nothing-to-capture');
  assert.match(out.detail, /could not resolve a repo/);
  // Only the infer call happened; no ingest POST (nothing to claim under).
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/infer-decisions$/);
});

test('inference failure → infer-failed (swallowed)', async () => {
  const { fetch: fetchImpl } = stubFetch({ infer: () => ({ status: 401, body: { error: 'token revoked' } }) });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'infer-failed');
  assert.match(out.detail, /token revoked/);
});

test('ingest persist failure → persist-failed (swallowed)', async () => {
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'x' }] } }),
    ingest: () => ({ status: 500, body: { error: 'persist_failed' } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'persist-failed');
  assert.match(out.detail, /500/);
});

test('empty inference result → nothing-to-capture (no ingest POST)', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: false, decisions: [] } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'nothing-to-capture');
  assert.equal(out.count, 0);
  assert.equal(calls.length, 1); // infer only
});

// --- the load-bearing guarantee: NEVER throws --------------------------------

test('runCapture never throws even when a dep throws synchronously', async () => {
  const out = await runCapture(HOOK, {
    env: ENV,
    log: () => {},
    readConfigImpl: () => {
      throw new Error('boom');
    },
  });
  // readConfig is wrapped in .catch → treated as empty config → no-auth path.
  assert.equal(out.status, 'no-auth');
});

test('a thrown fetch is swallowed into a structured outcome (never rejects)', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  // infer surfaces ok:false → infer-failed; the promise resolves, never rejects.
  assert.equal(out.status, 'infer-failed');
});

test('the device token never appears in any outcome detail', async () => {
  const { fetch: fetchImpl } = stubFetch({ infer: () => ({ status: 401, body: { error: 'bad' } }) });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.doesNotMatch(out.detail, /backthread_pat_/);
});

// --- the throttled connect-nudge end-to-end through runCapture ----
//
// The server piggybacks `repoStatus` on the ingest-decisions response; the hook
// reads it and surfaces a ONE-PER-SESSION connect-nudge to the `log` (stderr) seam,
// throttled via a tiny ~/.backthread state file (isolated to a temp dir here). Capture
// itself ALWAYS succeeds first (repo-less landing) — the nudge is additive.

// runCapture deps wired for a repo-less (derive-only) capture that the server reports
// as `not_connected`. `cfgDir` isolates the throttle file; `log` captures stderr.
function repolessDeps(
  cfgDir: string,
  log: (m: string) => void,
  repoStatus: 'not_connected' | 'disconnected' | 'connected' | undefined,
  over: Partial<CaptureDeps> = {},
): CaptureDeps {
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'x' }] } }),
    ingest: () => ({
      status: 200,
      body: {
        ok: true,
        count: 1,
        repoConnected: repoStatus === 'connected',
        ...(repoStatus ? { repoStatus: repoStatus } : {}),
        ...(repoStatus !== 'connected' ? { claimedRepo: 'acme/app' } : {}),
      },
    }),
  });
  return deps({
    fetchImpl,
    log,
    env: { ...ENV, BACKTHREAD_CONFIG_DIR: cfgDir } as NodeJS.ProcessEnv,
    ...over,
  });
}

async function withCfgDir(fn: (cfgDir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'backthread-cap-'));
  try {
    await fn(join(dir, '.backthread'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('repoStatus:not_connected → connect-nudge on the FIRST capture of a session (stderr)', async () => {
  await withCfgDir(async (cfgDir) => {
    const lines: string[] = [];
    const out = await runCapture(
      { ...HOOK, session_id: 'nudge-sess-1' },
      repolessDeps(cfgDir, (m) => lines.push(m), 'not_connected'),
    );
    // Capture still succeeded (repo-less landing) — the nudge is additive, not a failure.
    assert.equal(out.status, 'persisted');
    assert.equal(out.repoConnected, false);
    // Exactly one nudge line, pointing at the connect destination.
    assert.equal(lines.filter((l) => /isn't connected/.test(l)).length, 1);
    assert.match(lines.find((l) => /isn't connected/.test(l))!, /\/acme\/app/);
  });
});

test('connect-nudge SUPPRESSED on a SECOND capture of the same session (once-per-session throttle)', async () => {
  await withCfgDir(async (cfgDir) => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    // The transcript fixture carries sessionId 'sess-7' (the transcript's id wins over
    // the hook's session_id), so two captures of THIS transcript throttle under the
    // same key — exactly the manual/MCP "many captures, one session" case. First shows,
    // second is suppressed. (The cross-session "new session re-shows" leg is covered
    // directly against maybeNudge in connectNudge.test.ts.)
    const mk = () => runCapture(HOOK, repolessDeps(cfgDir, log, 'not_connected'));
    await mk();
    await mk();
    assert.equal(
      lines.filter((l) => /isn't connected/.test(l)).length,
      1,
      'one nudge across two captures of the same session',
    );
  });
});

test('repoStatus:connected → NO connect-nudge', async () => {
  await withCfgDir(async (cfgDir) => {
    const lines: string[] = [];
    const out = await runCapture(
      { ...HOOK, session_id: 'nudge-connected' },
      repolessDeps(cfgDir, (m) => lines.push(m), 'connected'),
    );
    assert.equal(out.status, 'persisted');
    assert.equal(lines.filter((l) => /isn't connected/.test(l)).length, 0);
  });
});

test('a corrupt throttle file never breaks capture (still persisted, nudge still emitted)', async () => {
  await withCfgDir(async (cfgDir) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(cfgDir, { recursive: true });
    await writeFile(join(cfgDir, 'connect-nudge.json'), '}{garbage', 'utf8');
    const lines: string[] = [];
    const out = await runCapture(
      { ...HOOK, session_id: 'nudge-corrupt' },
      repolessDeps(cfgDir, (m) => lines.push(m), 'not_connected'),
    );
    // Capture is unharmed by the corrupt throttle file; the nudge still shows.
    assert.equal(out.status, 'persisted');
    assert.equal(lines.filter((l) => /isn't connected/.test(l)).length, 1);
  });
});

test('repoStatus:disconnected → reconnect-nudge (GitHub App removed copy)', async () => {
  await withCfgDir(async (cfgDir) => {
    const lines: string[] = [];
    const out = await runCapture(
      { ...HOOK, session_id: 'nudge-disc' },
      repolessDeps(cfgDir, (m) => lines.push(m), 'disconnected'),
    );
    assert.equal(out.status, 'persisted');
    assert.equal(lines.filter((l) => /disconnected/.test(l)).length, 1);
  });
});

// --- trust gate + first-capture confirmation wiring ----------
//
// We assert runCapture INVOKES the trust gate (before the transcript read) and the
// once-only first-capture confirmation (in BOTH persist legs) via the injected seams.
// The seam BEHAVIOUR is tested in firstRun.test.ts / firstCapture.test.ts; here we
// only prove the WIRING + arguments.

test('trust gate is invoked on every capture, before the transcript is read', async () => {
  let trustCalled = 0;
  let trustCalledBeforeRead = false;
  let readHappened = false;
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } }),
  });
  const out = await runCapture(
    HOOK,
    deps({
      fetchImpl,
      readFileImpl: async () => {
        readHappened = true;
        return TRANSCRIPT_JSONL;
      },
      showTrustGateImpl: async () => {
        trustCalled++;
        trustCalledBeforeRead = !readHappened; // the gate must run before the read
        return true;
      },
      firstCaptureConfirmImpl: async () => false,
    }),
  );
  assert.equal(out.status, 'persisted-by-server');
  assert.equal(trustCalled, 1, 'trust gate invoked exactly once');
  assert.equal(trustCalledBeforeRead, true, 'trust gate runs before the transcript read');
});

test('trust gate runs even when there is NO transcript (before the no-transcript bail)', async () => {
  let trustCalled = 0;
  const out = await runCapture(
    { cwd: '/work/app', session_id: 's' }, // no transcript_path
    deps({
      showTrustGateImpl: async () => {
        trustCalled++;
        return true;
      },
    }),
  );
  assert.equal(out.status, 'no-transcript');
  assert.equal(trustCalled, 1, 'trust copy is guaranteed even on the no-transcript path');
});

test('first-capture confirm fired with (count, connected, repo) on the server-persist leg', async () => {
  let seen: { count: number; connected: boolean; repo: unknown } | null = null;
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({
      status: 200,
      body: { ok: true, persisted: true, decisions: [{ title: 'a' }, { title: 'b' }] },
    }),
  });
  const out = await runCapture(
    HOOK,
    deps({
      fetchImpl,
      firstCaptureConfirmImpl: async (count, connected, repo) => {
        seen = { count, connected, repo };
        return true;
      },
    }),
  );
  assert.equal(out.status, 'persisted-by-server');
  assert.deepEqual(seen, { count: 2, connected: true, repo: { owner: 'acme', name: 'app' } });
});

test('first-capture confirm fired with the server-reported repoConnected on the ingest leg', async () => {
  let seen: { count: number; connected: boolean } | null = null;
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'x' }] } }),
    ingest: () => ({ status: 200, body: { ok: true, count: 1, repoConnected: true } }),
  });
  const out = await runCapture(
    HOOK,
    deps({
      fetchImpl,
      firstCaptureConfirmImpl: async (count, connected) => {
        seen = { count, connected };
        return true;
      },
    }),
  );
  assert.equal(out.status, 'persisted');
  assert.deepEqual(seen, { count: 1, connected: true });
});

test('a throwing first-capture confirm never breaks capture (swallowed, still persisted)', async () => {
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } }),
  });
  const out = await runCapture(
    HOOK,
    deps({
      fetchImpl,
      firstCaptureConfirmImpl: async () => {
        throw new Error('boom');
      },
    }),
  );
  assert.equal(out.status, 'persisted-by-server', 'capture is unharmed by a confirm failure');
});

// --- ARP-693: incremental capture (infer only turns after the watermark) -----

test('ARP-693 — default (no watermark) infers ALL turns and returns turnCount', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: true, count: 1, decisions: [{ title: 'a' }] } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'persisted-by-server');
  // TRANSCRIPT_JSONL → 2 redacted turns (1 user + 1 assistant).
  assert.equal(out.turnCount, 2);
  const turns = (calls[0].body as { transcript: { turns: unknown[] } }).transcript.turns;
  assert.equal(turns.length, 2);
});

test('ARP-693 — fromTurnIndex slices to only the new turns', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: true, count: 1, decisions: [{ title: 'a' }] } }),
  });
  // Watermark at 1 → infer only the 2nd turn (the assistant turn).
  const out = await runCapture(HOOK, deps({ fetchImpl, fromTurnIndex: 1 }));
  assert.equal(out.status, 'persisted-by-server');
  assert.equal(out.turnCount, 2, 'turnCount is the FULL count (the entrypoint advances the watermark to it)');
  const turns = (calls[0].body as { transcript: { turns: Array<{ role: string }> } }).transcript.turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].role, 'assistant');
});

test('ARP-693 — fromTurnIndex at/after the end → nothing-to-capture, no inference', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: true, decisions: [] } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl, fromTurnIndex: 2 }));
  assert.equal(out.status, 'nothing-to-capture');
  assert.equal(out.turnCount, 2);
  assert.equal(calls.length, 0, 'no new turns → the expensive inference leg never runs');
});
