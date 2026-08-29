import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInsideRoot, parseHookInput, runCapture, type CaptureDeps, type HookInput } from './capture.js';
import type { BackthreadConfig } from './config.js';
import { runDoctor } from './doctor.js';

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
  routes: {
    infer?: (body: unknown) => { status: number; body: unknown };
    ingest?: (body: unknown) => { status: number; body: unknown };
    // ARP-1054 — the pre-send /capture-scope preflight. Defaults to a 'capture' verdict
    // so a test exercising the REAL checkCaptureScope (checkScopeImpl: undefined) sends.
    scope?: (body: unknown) => { status: number; body: unknown };
  },
): { fetch: typeof fetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    let r: { status: number; body: unknown };
    if (url.includes('/capture-scope'))
      r = (routes.scope ?? (() => ({ status: 200, body: { decision: 'capture', reason: 'connected' } })))(body);
    else if (url.includes('/infer-decisions')) r = (routes.infer ?? (() => ({ status: 200, body: {} })))(body);
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
    // Never shell out to real git for the repo-root set either: pin it to the hook's
    // own cwd, which is exactly what capture measured paths against before worktrees
    // were understood. The worktree tests below override this with a real root set.
    resolveRepoRootsImpl: (cwd) => [cwd],
    ensureAuthImpl: () => {},
    // ARP-1054 — default the pre-send scope check to a no-network PASS so the existing
    // flow tests aren't gated (and don't gain an extra /capture-scope call in their
    // `calls` assertions). The dedicated scope tests below override this.
    checkScopeImpl: async () => ({ send: true, reason: 'connected' }),
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

// A session whose only file evidence is inside Bash COMMAND strings — the shape that
// now dominates real transcripts. One command names a file that exists in the working
// tree, one names a file reached after `cd`-ing out of the repo. runCapture is what
// supplies the existence predicate (backed by fs.existsSync in production), so this is
// the test that the wiring is actually connected — sessionPaths alone would emit
// nothing here, and would emit BOTH paths if the predicate were passed but ignored.
const TRANSCRIPT_WITH_BASH = [
  JSON.stringify({ type: 'user', sessionId: 'sess-11', message: { content: 'why is the queue gated?' } }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-14T09:00:00Z',
    message: {
      content: [
        { type: 'text', text: 'The gate keeps a retry from double-sending.' },
        { type: 'tool_use', name: 'Bash', input: { command: "rg -n 'gate' src/queue/gate.ts" } },
        { type: 'tool_use', name: 'Bash', input: { command: 'cd /etc && cat app/secrets.json' } },
      ],
    },
  }),
].join('\n');

test('harvests file paths out of Bash commands, gated on the file existing in the repo', async () => {
  let sentBody: unknown = null;
  const asked: string[] = [];
  const { fetch: fetchImpl } = stubFetch({
    infer: (body) => {
      sentBody = body;
      return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'gate the queue' }] } };
    },
  });

  const out = await runCapture(
    HOOK,
    deps({
      fetchImpl,
      readFileImpl: async () => TRANSCRIPT_WITH_BASH,
      // Only the in-repo file exists. Asserted absolute, joined off the hook's cwd.
      fileExistsImpl: (abs: string) => {
        asked.push(abs);
        return abs === '/work/app/src/queue/gate.ts';
      },
    }),
  );
  assert.equal(out.status, 'persisted-by-server');

  const filePaths = (sentBody as { filePaths?: unknown }).filePaths as string[];
  assert.deepEqual(filePaths, ['src/queue/gate.ts']);
  // The `cd`-escape token really was produced and really was rejected by the check —
  // not silently missed by the scanner, which would make this test vacuous.
  assert.ok(asked.includes('/work/app/app/secrets.json'));
  // And nothing about the foreign file left the machine.
  assert.doesNotMatch(JSON.stringify(sentBody), /secrets\.json/);
});

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

// A session that did what sessions here actually do: the hook fired in /work/app while
// the edits landed in linked worktrees next door. Every one of those used to be thrown
// away as belonging to another repo, which is how a session could produce hundreds of
// decisions and an empty path list.
const TRANSCRIPT_ACROSS_WORKTREES = [
  JSON.stringify({ type: 'user', sessionId: 'sess-wt', message: { content: 'why hold the decision until merge?' } }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-29T09:00:00Z',
    message: {
      content: [
        { type: 'text', text: 'Holding until merge keeps unmerged reasoning out of the record.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/work/app/src/gate.ts' } },
        // the same repo, checked out in two sibling worktrees
        { type: 'tool_use', name: 'Edit', input: { file_path: '/work/app-lane1/src/merge/hold.ts' } },
        { type: 'tool_use', name: 'Write', input: { file_path: '/work/app-lane2/docs/merge-gate.md' } },
        // a DIFFERENT repo on the same machine → still foreign, still dropped
        { type: 'tool_use', name: 'Read', input: { file_path: '/work/other-repo/src/private.ts' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/etc/passwd' } },
      ],
    },
  }),
].join('\n');

test('harvests paths from SIBLING WORKTREES of the same repo, and still drops a foreign repo', async () => {
  let sentBody: unknown = null;
  const { fetch: fetchImpl } = stubFetch({
    infer: (body) => {
      sentBody = body;
      return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'hold until merge' }] } };
    },
  });

  const out = await runCapture(
    HOOK,
    deps({
      fetchImpl,
      readFileImpl: async () => TRANSCRIPT_ACROSS_WORKTREES,
      // What resolveRepoRoots reports on a machine running parallel worktrees.
      resolveRepoRootsImpl: () => ['/work/app', '/work/app-lane1', '/work/app-lane2'],
    }),
  );
  assert.equal(out.status, 'persisted-by-server');

  const filePaths = (sentBody as { filePaths?: unknown }).filePaths as string[];
  assert.deepEqual(filePaths, ['docs/merge-gate.md', 'src/gate.ts', 'src/merge/hold.ts']);
  // Nothing from the neighbouring repo, and no machine-absolute path, left the machine.
  const wire = JSON.stringify(sentBody);
  assert.doesNotMatch(wire, /other-repo/);
  assert.doesNotMatch(wire, /private\.ts/);
  assert.doesNotMatch(wire, /passwd/);
  for (const p of filePaths) assert.ok(!p.startsWith('/'), `emitted an absolute path: ${p}`);
});

test('the same session WITHOUT worktree awareness keeps only the hook cwd path (the regression)', async () => {
  let sentBody: unknown = null;
  const { fetch: fetchImpl } = stubFetch({
    infer: (body) => {
      sentBody = body;
      return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'hold until merge' }] } };
    },
  });

  await runCapture(
    HOOK,
    deps({
      fetchImpl,
      readFileImpl: async () => TRANSCRIPT_ACROSS_WORKTREES,
      resolveRepoRootsImpl: (cwd) => [cwd], // the old single-root behaviour
    }),
  );
  // Two of the three real edits are gone. This is the measured defect, pinned so the
  // test above cannot be read as passing for some other reason.
  assert.deepEqual((sentBody as { filePaths?: unknown }).filePaths, ['src/gate.ts']);
});

// The root set is the repo TOPLEVEL, not the directory the hook happened to fire in.
// A hook firing inside a monorepo package used to emit paths relative to that package,
// which the server cannot join against modules derived from a walk of the repo root.
// Pinned here because it is a silent change to the format of an existing field.
test('a hook firing in a SUBDIRECTORY emits repo-root-relative paths, not cwd-relative ones', async () => {
  let sentBody: unknown = null;
  const { fetch: fetchImpl } = stubFetch({
    infer: (body) => {
      sentBody = body;
      return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
    },
  });
  const transcript = [
    JSON.stringify({ type: 'user', sessionId: 'sess-sub', message: { content: 'why split the core package?' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-29T09:00:00Z',
      message: {
        content: [
          { type: 'text', text: 'Splitting core keeps the adapters off the hot path.' },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/work/app/packages/core/src/a.ts' } },
        ],
      },
    }),
  ].join('\n');

  await runCapture(
    { transcript_path: '/tmp/sess.jsonl', cwd: '/work/app/packages/core', session_id: 'sess-sub' },
    deps({
      fetchImpl,
      readFileImpl: async () => transcript,
      // What resolveRepoRoots reports from a subdirectory: the toplevel, not the cwd.
      resolveRepoRootsImpl: () => ['/work/app'],
    }),
  );
  assert.deepEqual((sentBody as { filePaths?: unknown }).filePaths, ['packages/core/src/a.ts']);
});

// Every worktree test above stubs `resolveRepoRootsImpl`, which means none of them can
// fail if the wiring from runCapture down to git is removed — the guard would sit one
// layer above the break. This one uses REAL git repos and the REAL resolver, so the
// only thing stubbed is the network and the transcript.
test('END TO END with real git: a sibling worktree edit reaches the wire, a foreign repo does not', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-e2e-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    };
    const app = join(tmp, 'app');
    const lane = join(tmp, 'app-lane');
    const foreign = join(tmp, 'other-repo');
    initRepo(app);
    initRepo(foreign);
    runGit(app, 'worktree', 'add', '-q', '-b', 'lane', lane);

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-e2e', message: { content: 'why hold until merge?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Holding until merge keeps unmerged reasoning out of the record.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: join(app, 'src/gate.ts') } },
            { type: 'tool_use', name: 'Edit', input: { file_path: join(lane, 'src/hold.ts') } },
            { type: 'tool_use', name: 'Read', input: { file_path: join(foreign, 'src/private.ts') } },
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'hold' }] } };
      },
    });

    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    // The point of this test: let REAL git decide, both for the root set and the context.
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-e2e' }, base);

    const filePaths = (sentBody as { filePaths?: unknown }).filePaths as string[];
    assert.deepEqual(filePaths, ['src/gate.ts', 'src/hold.ts']);
    const wire = JSON.stringify(sentBody);
    assert.doesNotMatch(wire, /other-repo/);
    assert.doesNotMatch(wire, /private\.ts/);
    for (const p of filePaths) assert.ok(!p.startsWith('/') && !p.includes('..'), p);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// THE SYMLINK LEAK, end to end with real git, real symlinks and real files on disk.
//
// A checkout can contain a link that leaves it — `vendor -> ../other-repo` is an
// ordinary thing to find in one — and containment used to be decided by string
// prefix, which walks straight through a link. So a file belonging to ANOTHER
// repository, opened through this repo's own directory, was relativized against this
// repo's root and sent as one of its paths. Nothing in the pure fence can see that;
// only the filesystem can, and this is the test that it is asked.
//
// The same session also edits a real file in a sibling WORKTREE and a real file in
// the checkout itself. Both must survive: a fix that closed the leak by tightening
// containment would take those with it and undo the reason the root set exists.
// THE LAUNDERING CASE. Roots are checkouts of ONE repo, so every tracked directory
// exists in all of them. Put the escaping link at a name the repo genuinely has — the
// ordinary `ln -s ../../other-repo packages/foo` trick, where `packages/foo` is a real
// directory in the sibling worktree — and a rule that keeps a path as soon as SOME root
// resolves it inside will let the sibling vouch for the escape. The sibling is telling
// the truth about its own directory; it simply is not being asked about the one the path
// came from. Only "does any root say this left?" survives the collision.
test('END TO END with real symlinks: a sibling worktree cannot vouch for an escaping link', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-launder-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    };
    const app = join(tmp, 'app');
    const lane = join(tmp, 'app-lane');
    const foreign = join(tmp, 'other-repo');
    initRepo(app);
    initRepo(foreign);
    runGit(app, 'worktree', 'add', '-q', '-b', 'lane', lane);

    // The foreign repo, reachable through a name this repo really uses.
    mkdirSync(join(foreign, 'vendorish'), { recursive: true });
    writeFileSync(join(foreign, 'vendorish/secret.ts'), 'export const secret = 1;\n');
    symlinkSync(foreign, join(app, 'vendor'), 'dir');
    // …and the SAME name, as a genuine directory, in the sibling worktree. This is the
    // root that would otherwise confirm the path.
    mkdirSync(join(lane, 'vendor/vendorish'), { recursive: true });
    // A real file of our own, so a green result cannot mean "the capture emitted
    // nothing at all".
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1;\n');

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-l', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Because the reasoning outlives the diff.' },
            { type: 'tool_use', name: 'Read', input: { file_path: join(app, 'vendor/vendorish/secret.ts') } },
            { type: 'tool_use', name: 'Edit', input: { file_path: join(app, 'src/mine.ts') } },
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-l' }, base);

    assert.deepEqual((sentBody as { filePaths?: unknown }).filePaths, ['src/mine.ts']);
    const wire = JSON.stringify(sentBody);
    assert.doesNotMatch(wire, /vendorish/);
    assert.doesNotMatch(wire, /secret/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// THE COST OF THAT INVERSION, AND HOW MUCH OF IT IS LEFT. "Any root saying outside is
// enough" is answering a question about a name, and a name is all a RELATIVE spelling
// gives you — so an honest file at a colliding name in a sibling checkout goes down with
// the escape. An ABSOLUTE spelling is not a name, it is a place: it can be followed on
// its own, no root gets to vouch for anything, and the honest file survives while the
// escape through the very same name is still refused. Both halves are pinned here
// because the pair is the whole trade-off, and either one alone reads as a bug.
test('END TO END with real symlinks: an absolute spelling recovers the honest file the name costs us', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-cost-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    };
    const app = join(tmp, 'app');
    const lane = join(tmp, 'app-lane');
    const foreign = join(tmp, 'other-repo');
    initRepo(app);
    initRepo(foreign);
    runGit(app, 'worktree', 'add', '-q', '-b', 'lane', lane);

    mkdirSync(join(foreign, 'src'), { recursive: true });
    writeFileSync(join(foreign, 'src/secret.ts'), 'export const secret = 1;\n');
    // The escaping link, at a name the repo genuinely has…
    mkdirSync(join(app, 'packages'), { recursive: true });
    symlinkSync(foreign, join(app, 'packages/foo'), 'dir');
    // …and the same name, as a real directory with a real file, in the sibling worktree.
    mkdirSync(join(lane, 'packages/foo/src'), { recursive: true });
    writeFileSync(join(lane, 'packages/foo/src/honest.ts'), 'export const honest = 1;\n');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1;\n');

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-c', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Because the reasoning outlives the diff.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: join(app, 'src/mine.ts') } },
            // The honest file, named as a place. Kept.
            { type: 'tool_use', name: 'Edit', input: { file_path: join(lane, 'packages/foo/src/honest.ts') } },
            // The same honest file, named only as a name. Dropped — this is the cost.
            { type: 'tool_use', name: 'Edit', input: { file_path: 'packages/foo/src/lost.ts' } },
            // And the escape through that name, in both spellings. Refused.
            { type: 'tool_use', name: 'Read', input: { file_path: join(app, 'packages/foo/src/secret.ts') } },
            { type: 'tool_use', name: 'Read', input: { file_path: 'packages/foo/src/secret.ts' } },
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-c' }, base);

    assert.deepEqual((sentBody as { filePaths?: unknown }).filePaths, [
      'packages/foo/src/honest.ts',
      'src/mine.ts',
    ]);
    assert.doesNotMatch(JSON.stringify(sentBody), /secret|lost\.ts/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// THE DANGLING CASE. Asking only about the immediate parent makes the fence depend on
// what happens to be on the far side of the link: `vendor/src/secret.ts` was refused
// because `vendor/src` resolved and landed outside, while `vendor/gone/secret.ts` was
// KEPT, because `vendor/gone` resolved nowhere and "nowhere" is an absence rather than a
// contradiction. Same link, same escape, opposite answer. Climbing to the deepest
// ancestor that does exist reaches `vendor` itself, which is the link, and settles both.
test('END TO END with real symlinks: a link into a missing directory is still a link out', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-dangle-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    };
    const app = join(tmp, 'app');
    const foreign = join(tmp, 'other-repo');
    initRepo(app);
    initRepo(foreign);
    symlinkSync(foreign, join(app, 'vendor'), 'dir');
    // `other-repo/gone/` deliberately does NOT exist.
    // A real file of our own, so the test cannot pass by emitting nothing at all.
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1;\n');

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-d', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Because the reasoning outlives the diff.' },
            { type: 'tool_use', name: 'Read', input: { file_path: join(app, 'vendor/gone/secret.ts') } },
            { type: 'tool_use', name: 'Edit', input: { file_path: join(app, 'src/mine.ts') } },
            // A file of OURS that no longer exists must still survive — the deleted-file
            // property, which the ancestor climb must not quietly take away.
            { type: 'tool_use', name: 'Edit', input: { file_path: join(app, 'src/deleted.ts') } },
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-d' }, base);

    assert.deepEqual((sentBody as { filePaths?: unknown }).filePaths, ['src/deleted.ts', 'src/mine.ts']);
    assert.doesNotMatch(JSON.stringify(sentBody), /vendor|secret/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// The containment comparison decides whether a path stayed in the repo, and it is wrong
// on Windows in a way nothing running on this machine can see: `realpathSync` and `join`
// answer in the platform's separator, so a root is `C:\repo` and a path below it is
// `C:\repo\src`. Compared against a hardcoded '/', every path with a directory component
// reads as an escape and the whole harvest silently empties. An end-to-end test here
// cannot tell `sep` from '/', so the separator is exercised directly.
test('isInsideRoot compares with the given separator, on both platform spellings', () => {
  // POSIX — what this machine runs.
  assert.equal(isInsideRoot('/repo/src/a.ts', ['/repo'], '/'), true);
  assert.equal(isInsideRoot('/repo', ['/repo'], '/'), true); // the root itself
  assert.equal(isInsideRoot('/repo-other/a.ts', ['/repo'], '/'), false); // prefix look-alike
  assert.equal(isInsideRoot('/elsewhere/a.ts', ['/repo'], '/'), false);

  // win32 — the case that cannot be reached from here, and the one that broke.
  assert.equal(isInsideRoot('C:\\repo\\src\\a.ts', ['C:\\repo'], '\\'), true);
  assert.equal(isInsideRoot('C:\\repo', ['C:\\repo'], '\\'), true);
  assert.equal(isInsideRoot('C:\\repo-other\\a.ts', ['C:\\repo'], '\\'), false);
  assert.equal(isInsideRoot('D:\\elsewhere\\a.ts', ['C:\\repo'], '\\'), false);

  // And the mutation this exists to catch: a win32 path judged with a POSIX separator
  // loses everything below the root while the root itself still matches — which is
  // exactly why the bug would look like "capture stopped finding files" and not like a
  // crash.
  assert.equal(isInsideRoot('C:\\repo\\src\\a.ts', ['C:\\repo'], '/'), false);

  // The default is the running platform's separator, not a literal.
  assert.equal(isInsideRoot(join('/repo', 'src'), ['/repo']), true);
});

test('END TO END with real symlinks: a link out of the checkout cannot carry another repo in', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-link-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    };
    const app = join(tmp, 'app');
    const lane = join(tmp, 'app-lane');
    const foreign = join(tmp, 'other-repo');
    initRepo(app);
    initRepo(foreign);
    runGit(app, 'worktree', 'add', '-q', '-b', 'lane', lane);

    // The foreign repo's file EXISTS — the leak needs a real file behind the link,
    // and so does the proof that it is gone.
    mkdirSync(join(foreign, 'src'), { recursive: true });
    writeFileSync(join(foreign, 'src/secret.ts'), 'export const secret = 1;\n');
    // The link that escapes: `<app>/vendor` IS `<other-repo>`.
    symlinkSync(foreign, join(app, 'vendor'), 'dir');
    // Two files that really are this repo's, in two of its checkouts.
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1;\n');
    // A symlinked FILE at a name this repo really has. `src/linked.ts` is in repoA's
    // own tree and git tracks it; where its contents happen to live is not something
    // the path gives away. It must survive — the leak is a path DESCENDING THROUGH a
    // link into somebody else's directory structure, not a leaf name of our own.
    symlinkSync(join(foreign, 'src/secret.ts'), join(app, 'src/linked.ts'), 'file');
    mkdirSync(join(lane, 'src'), { recursive: true });
    writeFileSync(join(lane, 'src/lane.ts'), 'export const lane = 1;\n');

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-link', message: { content: 'why hold until merge?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Holding until merge keeps unmerged reasoning out of the record.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: join(app, 'src/mine.ts') } },
            { type: 'tool_use', name: 'Edit', input: { file_path: join(lane, 'src/lane.ts') } },
            // Through the link, so it reads as in-repo by every string rule.
            { type: 'tool_use', name: 'Read', input: { file_path: join(app, 'vendor/src/secret.ts') } },
            // And again as a shell token, the other route into the output.
            { type: 'tool_use', name: 'Bash', input: { command: 'cat vendor/src/secret.ts' } },
            // A name this repo genuinely has, whose file happens to be a link out.
            { type: 'tool_use', name: 'Edit', input: { file_path: join(app, 'src/linked.ts') } },
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'hold' }] } };
      },
    });

    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    // Real git, real filesystem: the only stubs left are the network and the transcript.
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-link' }, base);

    const filePaths = (sentBody as { filePaths?: unknown }).filePaths as string[];
    // The checkout's own file, the sibling worktree's file, and this repo's own name
    // for a file that is a link out, all survive…
    assert.deepEqual(filePaths, ['src/lane.ts', 'src/linked.ts', 'src/mine.ts']);
    // …and nothing that belongs to the other repository went anywhere.
    const wire = JSON.stringify(sentBody);
    assert.doesNotMatch(wire, /other-repo/);
    assert.doesNotMatch(wire, /secret/);
    assert.doesNotMatch(wire, /vendor/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// THE SPELLING IS THE ATTACK. Every case above descends through a link in one straight
// line, and a fence that resolves the path it is about to EMIT catches all of them. None
// of these is spelled that way.
//
//   1. `..` CANCELLED ON THE STRING. `dlink/../src/secret.ts`, with `dlink` a link into
//      another repository, reduces arithmetically to `src/secret.ts` — a name this repo
//      genuinely has — while the kernel opens the other repo's file. Cancelling `..` is
//      only valid against a real directory; against a symlink it is simply wrong. Every
//      re-spelling of that trick is here: relative, `./`-prefixed, backslash-separated,
//      `.`-interleaved, double-slashed, and hidden one level down inside our own `src/`.
//   2. A SEGMENT THE FILESYSTEM WILL NOT RESOLVE. A dangling link, a `chmod 000` parent
//      and a symlink loop all make `realpath` fail, and a fence that CLIMBS past a
//      failure to the nearest ancestor that resolves lands back inside the repo and
//      keeps the path. `realpath` failing is not an absence — only `ENOENT` is — and
//      the difference is the whole rule.
//   3. A URI SCHEME. `file://…` is not POSIX-absolute, so it used to be treated as a
//      relative path and emitted as `file:/…` — a MACHINE-ABSOLUTE path, out of a module
//      that promises never to emit one.
//   4. A PERCENT-ESCAPED SEPARATOR, which is two different paths depending on who
//      decodes it, so the fence would measure one and the kernel would open the other.
//
// Each spelling targets a DISTINCT file so one leak can never be mistaken for another,
// and every path is built by concatenation — `join` normalizes `..` away, and
// normalization is the defect.
test('END TO END with real symlinks: no re-spelling of an escape reaches the wire', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-spell-'));
  const blocked = join(tmp, 'app/blocked');
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    };
    const app = join(tmp, 'app');
    const lane = join(tmp, 'app-lane');
    const foreign = join(tmp, 'other-repo');
    initRepo(app);
    initRepo(foreign);
    runGit(app, 'worktree', 'add', '-q', '-b', 'lane', lane);

    // The other repository's files. THEIRS is the marker that must never travel.
    mkdirSync(join(foreign, 'src'), { recursive: true });
    mkdirSync(join(foreign, 'deepdir/inner'), { recursive: true });
    for (const n of ['secret', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6'])
      writeFileSync(join(foreign, `src/${n}.ts`), 'export const v = 1; // THEIRS\n');
    writeFileSync(join(foreign, 'x7.ts'), 'export const v = 1; // THEIRS\n');
    writeFileSync(join(foreign, 'deepdir/inner/deep.ts'), 'export const deep = 1; // THEIRS\n');
    // A directory belonging to NEITHER repo, reachable by climbing out through a link.
    mkdirSync(join(tmp, 'plaindir/sub'), { recursive: true });
    writeFileSync(join(tmp, 'plaindir/sub/notes.ts'), 'export const notes = 1; // THEIRS\n');

    // Our own files, in two checkouts of one repo.
    mkdirSync(join(app, 'src'), { recursive: true });
    mkdirSync(join(app, 'packages'), { recursive: true });
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1;\n');
    mkdirSync(join(lane, 'src'), { recursive: true });
    writeFileSync(join(lane, 'src/lane.ts'), 'export const lane = 1;\n');

    symlinkSync(join(foreign, 'src'), join(app, 'dlink'), 'dir');
    symlinkSync(foreign, join(app, 'vendor'), 'dir');
    symlinkSync(foreign, join(app, 'packages/foo'), 'dir'); // at a name the repo has
    symlinkSync(join(foreign, 'missing'), join(app, 'ghost'), 'dir'); // DANGLING
    symlinkSync(join(foreign, 'src'), join(app, 'src/vlink'), 'dir'); // inside our own src/
    symlinkSync(join(foreign, 'src/secret.ts'), join(app, 'src/linked.ts'), 'file'); // our NAME
    symlinkSync(join(app, 'loopb'), join(app, 'loopa'), 'dir'); // ELOOP
    symlinkSync(join(app, 'loopa'), join(app, 'loopb'), 'dir');
    // Links that stay INSIDE the repo — one at the checkout root, one at a sibling
    // worktree. Nothing about them escapes; the `..` AFTER them is what leaves. They
    // are the case that separates "take the resolved parent" from "skip the `..`":
    // skipping it leaves the walk sitting inside the repo, and the path is kept.
    symlinkSync(app, join(app, 'selfroot'), 'dir');
    symlinkSync(lane, join(app, 'lanelink'), 'dir');
    // Links whose NAME BEGINS WITH WHITESPACE. A tool input is trimmed on the way in,
    // and the first segment is a head — trim it and the fence stops measuring the path
    // the kernel opens. NBSP as well as ASCII space: `trim()` strips every Unicode
    // whitespace character, so the escape is not spelled one way.
    symlinkSync(foreign, join(app, ' spacelink'), 'dir');
    symlinkSync(foreign, join(app, '\u00a0nbsplink'), 'dir');
    // A link whose NAME contains a backslash. On POSIX `\` is an ordinary filename
    // character, so this is ONE segment to the kernel and it lands in the other repo in
    // a single hop. A fence that reads `\` as a separator sees two segments that do not
    // exist, calls that empty ground inside the repo, and keeps the path.
    symlinkSync(foreign, join(app, 'x\\y'), 'dir');
    mkdirSync(blocked, { recursive: true });
    symlinkSync(foreign, join(blocked, 'vendor'), 'dir');

    const escapes = [
      app + '/dlink/../deepdir/inner/deep.ts', // would emit deepdir/inner/deep.ts
      app + '/dlink/../src/secret.ts', // would emit src/secret.ts
      app + '/vendor/../other-repo/src/x1.ts', // would emit other-repo/src/x1.ts
      app + '/vendor/../plaindir/sub/notes.ts', // would emit plaindir/sub/notes.ts
      app + '/packages/foo/../other-repo/src/x2.ts', // would emit packages/other-repo/…
      'file://' + app + '/vendor/src/x3.ts', // would emit a MACHINE-ABSOLUTE path
      'file:' + app + '/vendor/src/secret.ts', // …and so would the one-slash spelling
      app + '/blocked/vendor/src/x4.ts', // EACCES behind chmod 000
      app + '/ghost/src/x5.ts', // dangling link
      'loopa/src/secret.ts', // symlink loop
      'vendor%2Fsrc/x6.ts', // percent-escaped separator, relative
      app + '/vendor%2Fsrc/secret.ts', // …and absolute, which skips the relative branch
      app + '/src/vlink/../x7.ts', // masquerades as our own src/x7.ts
      'dlink/../src/secret.ts', // relative
      './dlink/../src/secret.ts', // ./-prefixed
      'dlink\\..\\src\\secret.ts', // backslash separators
      'dlink/.././src/secret.ts', // .-interleaved
      'dlink//../src/secret.ts', // double slash
      'vendor/src/secret.ts', // plain descent, relative
      'blocked/vendor/src/secret.ts',
      'ghost/src/secret.ts',
      app + '/selfroot/../other-repo/src/x5.ts', // `..` climbs out of an in-repo link
      'lanelink/../other-repo/src/x6.ts', // …and the same, via a sibling worktree
      'x\\y/src/secret.ts', // a link genuinely NAMED `x\y` — one segment to the kernel
      app + '/x\\y/src/secret.ts', // …and the absolute spelling of it
      'x\\y/src/../src/secret.ts', // …and with a `..` for good measure
      ' spacelink/src/secret.ts', // a NAME starting with a space, erased by trim()
      '\u00a0nbsplink/src/secret.ts', // …and with a non-breaking space
    ];
    // …and the properties that must survive it.
    const keep = [
      join(app, 'src/mine.ts'), // our own file
      join(lane, 'src/lane.ts'), // a sibling worktree's real file
      join(app, 'src/deleted.ts'), // a file we deleted
      join(app, 'src/linked.ts'), // our own NAME, whose file is a link out
    ];

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-s', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Because the reasoning outlives the diff.' },
            ...[...escapes, ...keep].map((p) => ({ type: 'tool_use', name: 'Read', input: { file_path: p } })),
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    chmodSync(blocked, 0o000); // the EACCES case, live for the duration of the harvest
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-s' }, base);
    chmodSync(blocked, 0o755);

    const filePaths = (sentBody as { filePaths?: unknown }).filePaths as string[];
    // Exactly the four that had to survive, and nothing else at all.
    assert.deepEqual(filePaths, ['src/deleted.ts', 'src/lane.ts', 'src/linked.ts', 'src/mine.ts']);
    // Not one machine-absolute path, from any of the 21 spellings.
    for (const p of filePaths) assert.ok(!p.startsWith('/') && !p.includes(tmp), p);
    const wire = JSON.stringify(sentBody);
    assert.doesNotMatch(
      wire,
      /other-repo|plaindir|deepdir|secret|vendor|ghost|loop|%2F|selfroot|lanelink|spacelink|nbsplink|x\/y|x\\\\y/i,
    );
    // The `cat`-level truth the backslash rows rest on: that spelling really does open
    // the other repository's file, in one hop, exactly as the kernel reads it.
    assert.match(readFileSync(app + '/x\\y/src/secret.ts', 'utf8'), /THEIRS/);
    // …and so does a name whose leading whitespace the input trim would have eaten.
    assert.match(readFileSync(app + '/ spacelink/src/secret.ts', 'utf8'), /THEIRS/);
    assert.match(readFileSync(app + '/\u00a0nbsplink/src/secret.ts', 'utf8'), /THEIRS/);
  } finally {
    try {
      chmodSync(blocked, 0o755);
    } catch {
      // the fixture may not have got that far
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

// THE FIFTH ESCAPE IN THIS FAMILY, AND THE SAME SHAPE AS THE OTHER FOUR: the fence
// measuring a different path from the one the kernel opens. Here the difference is not a
// spelling but a STARTING POINT — a relative token is resolved from the working directory
// of the tool call that produced it, and the previous release only knew the SESSION's cwd
// and the roots. A `cd` inside the scanned command, or a record whose own cwd is a
// subdirectory, moves the kernel and left the fence behind.
//
// Every escape below needs a NAME COLLISION to be interesting, and that is the point: the
// shell route is protected by `exists`, so a token only survives to be leaked when this
// repo genuinely has a file at the same relative name. `cat` proves each one really opens
// the other repository's copy.
test('a relative path is measured from the directory its own tool call ran in', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-cwd-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    };
    const app = join(tmp, 'app');
    const lane = join(tmp, 'app-lane');
    const foreign = join(tmp, 'other-repo');
    initRepo(app);
    initRepo(foreign);
    runGit(app, 'worktree', 'add', '-q', '-b', 'lane', lane);

    // THE COLLISION, AND WHY EACH ESCAPE GETS ITS OWN NAME. A leaked shell path always
    // wears one of OUR names — `exists` guarantees it — so a leak is a MISATTRIBUTION,
    // not a novel string, and an escape that reuses a name an honest record also
    // contributes is invisible in the output. Give every escape a distinct name that no
    // honest record touches, and each one becomes a row that appears on the wire when the
    // fence is wrong and is absent when it is right.
    mkdirSync(join(foreign, 'src'), { recursive: true });
    mkdirSync(join(app, 'src'), { recursive: true });
    const collisions = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'];
    for (const n of [...collisions, 'mine']) {
      writeFileSync(join(foreign, `src/${n}.ts`), 'export const v = 1; // THEIRS\n');
      writeFileSync(join(app, `src/${n}.ts`), `export const ${n} = 1; // OURS\n`);
    }
    mkdirSync(join(lane, 'src'), { recursive: true });
    writeFileSync(join(lane, 'src/lane.ts'), 'export const lane = 1;\n');
    // Somewhere inside the repo to `cd` to that is honest — the must-keep control.
    mkdirSync(join(app, 'honest'), { recursive: true });

    // Escaping links that are INVISIBLE FROM THE CHECKOUT ROOT. That is what made this
    // class survive: `<app>/sub` and `<app>/pkg` hold them, so measuring from `<app>`
    // finds nothing at `<app>/src` to object to and reads empty ground as safe.
    mkdirSync(join(app, 'sub'), { recursive: true });
    mkdirSync(join(app, 'pkg'), { recursive: true });
    symlinkSync(join(foreign, 'src'), join(app, 'sub/src'), 'dir');
    symlinkSync(join(foreign, 'src'), join(app, 'pkg/src'), 'dir');

    // `cat` FIRST: prove each spelling genuinely opens the other repository's file from
    // the directory its tool call ran in. Without this the test only checks a model.
    for (const n of collisions) {
      assert.match(readFileSync(join(app, `sub/src/${n}.ts`), 'utf8'), /THEIRS/);
      assert.match(readFileSync(join(app, `pkg/src/${n}.ts`), 'utf8'), /THEIRS/);
      assert.match(readFileSync(join(foreign, `src/${n}.ts`), 'utf8'), /THEIRS/);
      assert.match(readFileSync(join(app, `src/${n}.ts`), 'utf8'), /OURS/);
    }

    const rec = (cwd: string, input: Record<string, unknown>) =>
      JSON.stringify({
        type: 'assistant',
        cwd,
        timestamp: '2026-08-29T09:00:00Z',
        message: { content: [{ type: 'tool_use', name: 'Bash', input }] },
      });
    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-cwd', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: { content: [{ type: 'text', text: 'Because the reasoning outlives the diff.' }] },
      }),
      // 1. a `cd` inside the very command that is scanned
      rec(app, { command: 'cd sub && cat src/e1.ts' }),
      // 2. an ABSOLUTE `cd`, straight into the other repository
      rec(app, { command: `cd ${foreign} && cat src/e2.ts` }),
      // 3. chained relative `cd`s
      rec(app, { command: 'cd pkg && cd ../sub && cat src/e3.ts' }),
      // 4. the RECORD's own cwd is the subdirectory — no `cd` at all
      rec(join(app, 'pkg'), { command: 'cat src/e4.ts' }),
      // 5. a path-named tool INPUT, not a shell token, from that same subdirectory
      JSON.stringify({
        type: 'assistant',
        cwd: join(app, 'sub'),
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/e5.ts' } }] },
      }),
      // 6. the input's OWN cwd field, outranking the record stamp
      rec(app, { cwd: join(app, 'sub'), command: 'cat src/e6.ts' }),
      // 7. an unreadable `cd` target must fail CLOSED, not fall back to the safe base
      rec(app, { command: 'cd "$LANE" && cd sub && cat src/e7.ts' }),
      // 8. THE SAME SPELLING AS AN HONEST RECORD BELOW, from a directory where it is
      //    theirs. It comes FIRST deliberately: the answer is memoised, and a memo keyed
      //    on the spelling alone would let this record answer for the honest one and take
      //    `src/mine.ts` off the wire with it. One spelling, two directories, two answers.
      rec(join(app, 'sub'), { command: 'cat src/mine.ts' }),
      // …and the properties that must survive all of it.
      rec(app, { command: 'cat src/mine.ts' }), // OUR file, plainly
      rec(app, { command: 'cd honest && cat src/mine.ts' }), // a `cd` that stays inside
      rec(lane, { command: 'cat src/lane.ts' }), // a sibling WORKTREE's real file
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-cwd' }, base);

    const filePaths = (sentBody as { filePaths?: unknown }).filePaths as string[];
    // Seven escapes, seven names this repo genuinely has, and not one of them on the
    // wire. `src/mine.ts` IS here — the same spelling is ours from one directory and
    // theirs from another, which is why the answer cannot be cached on the spelling
    // alone — and it survives on the strength of the honest records only.
    //
    // `sub` is the bare directory named by record 6's `cwd` FIELD, which this module has
    // always harvested as a path candidate in its own right. It is in-repo and harmless,
    // and it is pinned rather than filtered so that the pre-existing behaviour is visible
    // here instead of being quietly absorbed into an expectation that looks tidier.
    assert.deepEqual(filePaths, ['src/lane.ts', 'src/mine.ts', 'sub']);
    for (const p of filePaths) assert.ok(!p.startsWith('/') && !p.includes(tmp), p);
    assert.doesNotMatch(JSON.stringify(sentBody), /other-repo|THEIRS/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// THE CONSTRUCTS THAT DEFEATED THE FIRST ATTEMPT AT THIS. Independent review found eleven
// spellings at once — `pushd`, `cd -P`, `cd --`, `{ cd x; }`, `\cd`, `env -C`, `then cd`,
// `time cd`, `bash -c 'cd x'`, `cd -`, and a Codex argv array whose join hid the `cd` behind
// a flag — every one of which produced a CONFIDENT base of the record's own cwd while the
// kernel was somewhere else. They are not eleven bugs; they are one: reading a shell command
// to find out where it moved is an open question, and the reader kept losing to a spelling.
//
// The rule now is the closed one. Anything that could change a directory is detected crudely
// and must be ACCOUNTED FOR by the reader; whatever is not, refuses the command. So these
// close as a class rather than one at a time, and a twelfth spelling refuses by default.
test('a command that could have moved and could not be read is refused, not guessed at', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-unread-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    };
    const app = join(tmp, 'app');
    const foreign = join(tmp, 'other-repo');
    initRepo(app);
    initRepo(foreign);
    mkdirSync(join(app, 'src'), { recursive: true });
    mkdirSync(join(foreign, 'src'), { recursive: true });
    mkdirSync(join(app, 'sub'), { recursive: true });
    mkdirSync(join(app, 'honest'), { recursive: true });
    symlinkSync(join(foreign, 'src'), join(app, 'sub/src'), 'dir');
    // A script that changes directory, and the `s3x` the mis-read targets really land in.
    writeFileSync(join(app, 'setup.sh'), `cd ${foreign}\n`);
    mkdirSync(join(app, 's3'), { recursive: true });
    mkdirSync(join(app, 's3x'), { recursive: true });
    symlinkSync(join(foreign, 'src'), join(app, 's3x/src'), 'dir');
    // `lib` escapes from the checkout root but is an ordinary directory one level down. So a
    // token read from `<app>` leaves the repo while the same token read from `<app>/sub` does
    // not — which is exactly the ambiguity a conditional `cd` leaves behind.
    mkdirSync(join(foreign, 'lib'), { recursive: true });
    mkdirSync(join(app, 'sub/lib'), { recursive: true });
    symlinkSync(join(foreign, 'lib'), join(app, 'lib'), 'dir');

    // One colliding name per spelling, so a leak is a row in the output rather than a
    // misattribution hidden behind an honest record contributing the same string.
    const ids = [
      'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13',
      'u14', 'u15', 'u16', 'u17', 'u18', 'u19', 'u20', 'u21', 'u22', 'u23', 'u24',
    ];
    for (const n of [...ids, 'keep', 'brace', 'codex', 'cond']) {
      writeFileSync(join(foreign, `src/${n}.ts`), 'export const v = 1; // THEIRS\n');
      writeFileSync(join(app, `src/${n}.ts`), `export const ${n} = 1; // OURS\n`);
    }
    writeFileSync(join(foreign, 'lib/cond.ts'), 'export const v = 1; // THEIRS\n');
    writeFileSync(join(app, 'sub/lib/cond.ts'), 'export const cond = 1; // OURS\n');
    // `cat` FIRST: each spelling really does open the other repository from where it ran.
    for (const n of ids) {
      // Every row lands in the other repository, by one of three routes: through `sub`,
      // through `s3x`, or through the script's `cd`. All three are the same file.
      assert.match(readFileSync(join(app, `sub/src/${n}.ts`), 'utf8'), /THEIRS/);
      assert.match(readFileSync(join(app, `s3x/src/${n}.ts`), 'utf8'), /THEIRS/);
      assert.match(readFileSync(join(foreign, `src/${n}.ts`), 'utf8'), /THEIRS/);
    }
    // …and the conditional row: from the root it is theirs, from `sub` it is ours.
    assert.match(readFileSync(join(app, 'lib/cond.ts'), 'utf8'), /THEIRS/);
    assert.match(readFileSync(join(app, 'sub/lib/cond.ts'), 'utf8'), /OURS/);

    const rec = (cwd: string, command: string) =>
      JSON.stringify({
        type: 'assistant',
        cwd,
        timestamp: '2026-08-29T09:00:00Z',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
      });
    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-u', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: { content: [{ type: 'text', text: 'Because the reasoning outlives the diff.' }] },
      }),
      rec(app, 'pushd sub && cat src/u1.ts'), // a stack this scan does not model
      rec(app, 'cd -P sub && cat src/u2.ts'), // an option, not a target
      rec(app, 'cd -- sub && cat src/u3.ts'),
      rec(app, 'cd - && cat src/u4.ts'), // returns somewhere that is nowhere in the text
      rec(app, '\\cd sub && cat src/u5.ts'), // the word escaped
      rec(app, 'env -C sub cat src/u6.ts'), // a different mechanism entirely
      rec(app, 'make -C sub && cat src/u7.ts'),
      rec(app, "bash -c 'cd sub && cat src/u8.ts'"), // an inner shell we do not read
      rec(app, 'cd "$SUB" && cat src/u9.ts'), // a variable we cannot expand
      rec(app, 'cd $(echo sub) && cat src/u10.ts'), // a substitution we must not run
      rec(app, 'popd && cat src/u11.ts'),
      rec(app, 'chdir sub && cat src/u12.ts'),
      // `cd` IS A WORD, NOT A SPELLING. The shell strips quoting before it looks up the
      // command name, so all four of these run the `cd` builtin while containing no literal
      // `cd` for a detector to find. Verified against real bash.
      rec(app, 'c\\d sub && cat src/u14.ts'),
      rec(app, 'c"d" sub && cat src/u15.ts'),
      rec(app, "c'd' sub && cat src/u16.ts"),
      rec(app, '\\c\\d sub && cat src/u17.ts'),
      // …and the same word built by EXPANSION rather than quoting. `c${EMPTY}d` contains no
      // `cd` in any spelling of the text, and runs one, because the shell assembles the
      // command word before it looks the word up. Nothing short of collapsing expansions the
      // way the shell does can see it.
      rec(app, 'c${EMPTY}d sub && cat src/u24.ts'),
      // A SCRIPT RUN IN THE CURRENT SHELL can `cd` anywhere, and the command that runs it
      // says nothing about where. Neither spelling of it is readable.
      rec(app, 'source ./setup.sh && cat src/u18.ts'),
      rec(app, '. ./setup.sh && cat src/u19.ts'),
      // A TARGET THAT IS NOT THE WHOLE WORD. `cd "s3"x` is `s3x` to the shell; a reader that
      // takes `"s3"` and stops composes a base that is not where the command went. The
      // residue after the match is the evidence, and there is no safe reading of it.
      rec(app, 'cd "s3"x && cat src/u20.ts'),
      rec(app, 'cd s3\\x && cat src/u21.ts'),
      rec(app, "cd s3'x' && cat src/u22.ts"),
      rec(app, 'cd sub>/dev/null && cat src/u23.ts'),
      // A CONDITIONAL `cd` is read, but only as a superset: we cannot tell whether the branch
      // ran, so every directory it could have been in has to agree.
      rec(app, 'if [ -d sub ]; then cd sub; fi && cat src/brace.ts'),
      // A Codex argv array whose script ESCAPES, proving the same route in both directions.
      JSON.stringify({
        type: 'response_item',
        cwd: app,
        payload: {
          type: 'function_call',
          arguments: JSON.stringify({ command: ['bash', '-lc', 'cd sub && cat src/u13.ts'] }),
        },
      }),
      // A Codex argv array. Joining it on a space hid the script's leading `cd` behind the
      // `-lc` flag, so the whole script read as though it had never moved.
      JSON.stringify({
        type: 'response_item',
        cwd: app,
        payload: {
          type: 'function_call',
          arguments: JSON.stringify({ command: ['bash', '-lc', 'cd honest && cat src/codex.ts'] }),
        },
      }),
      // …and the recall that the widened reader buys: a brace group and a `time` prefix are
      // READ, not refused, so a `cd` that stays inside the repo still yields its paths.
      rec(app, '{ cd honest; cat src/keep.ts; }'),
      rec(app, 'time cd honest && cat src/brace.ts'),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-u' }, base);

    const filePaths = ((sentBody as { filePaths?: unknown }).filePaths as string[]) ?? [];
    // Twelve unreadable spellings and a conditional one: none on the wire. `src/keep.ts` and
    // `src/brace.ts` survive ONLY on the strength of the two readable in-repo `cd`s — which
    // is what stops this test passing by simply refusing everything.
    assert.deepEqual(filePaths, ['src/brace.ts', 'src/codex.ts', 'src/keep.ts']);
    assert.doesNotMatch(JSON.stringify(sentBody), /other-repo|THEIRS/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// A `cd` TO A DIRECTORY THAT IS NOT THERE moves nothing — the shell reports an error and
// stays where it was — so a base that will not resolve must be SKIPPED, not treated as a
// place the token was measured from. Getting this backwards is not a corner case: measured
// across real transcripts, 98.4% of the paths a naive reading of this rule would have
// dropped were relative to a scratch worktree that had since been deleted. It is the same
// distinction the walk already makes between a contradiction and an absence, one level up.
test('a `cd` to a directory that does not exist does not move the base', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-deadcd-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const app = join(tmp, 'app');
    mkdirSync(app, { recursive: true });
    runGit(app, 'init', '-q', '-b', 'main');
    runGit(app, 'config', 'user.email', 'test@example.com');
    runGit(app, 'config', 'user.name', 'Test');
    writeFileSync(join(app, 'README.md'), '# fixture\n');
    runGit(app, 'add', '.');
    runGit(app, 'commit', '-qm', 'init');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1; // OURS\n');
    // A separate name per case, so that one of them being dropped is visible in the
    // output instead of being covered for by the other.
    writeFileSync(join(app, 'src/dead.ts'), 'export const dead = 1; // OURS\n');
    writeFileSync(join(app, 'src/outside.ts'), 'export const outside = 1; // OURS\n');
    // Two ways a base fails to resolve, and they are NOT the same condition. `gone` is a
    // clean absence — nothing is there. `deadlink` IS there and will not say where it
    // goes, which is the case the walk fails closed on everywhere else. Both must leave
    // the token measured from the directory the shell never left.
    assert.ok(!existsSync(join(app, 'gone')));
    symlinkSync(join(tmp, 'no-such-target'), join(app, 'deadlink'), 'dir');
    assert.ok(!existsSync(join(app, 'deadlink')));

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-dc', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: { content: [{ type: 'text', text: 'Because the reasoning outlives the diff.' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        cwd: app,
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd gone && cat src/mine.ts' } }] },
      }),
      JSON.stringify({
        type: 'assistant',
        cwd: app,
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd deadlink && cat src/dead.ts' } }] },
      }),
      // THE CASE THAT SEPARATES SKIPPING FROM WALKING THROUGH. `resolveWalk` continues past a
      // segment the filesystem says is absent, because for a PATH that is the deleted-file
      // case. For a BASE it invents a place: the phantom here lands OUTSIDE the repo, and
      // taking it as real would contradict and drop an honest path — the scratch worktree
      // deleted since capture, which is 98.4% of what a naive reading would have dropped.
      JSON.stringify({
        type: 'assistant',
        cwd: app,
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: `cd ${join(tmp, 'gone-scratch')} && cat src/outside.ts` } },
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-dc' }, base);

    const filePaths = ((sentBody as { filePaths?: unknown }).filePaths as string[]) ?? [];
    assert.deepEqual(filePaths, ['src/dead.ts', 'src/mine.ts', 'src/outside.ts']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// A CONDITIONAL `cd` IS A SUPERSET, NOT AN ANSWER. `if [ -d x ]; then cd x; fi` moves only
// when the test passed, and nothing in the transcript says whether it did. Reading it as an
// answer picks one of the two directories and is confidently wrong half the time.
//
// This only shows when the RECORD's own directory is not the session's — which is exactly the
// case this whole change is about. When they coincide, the session cwd is already among the
// bases and supplies the contradiction on its own, so a test built there passes either way
// and proves nothing.
test('a conditional `cd` is measured as every directory it could have been in', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-cond-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    };
    const app = join(tmp, 'app');
    const foreign = join(tmp, 'other-repo');
    initRepo(app);
    initRepo(foreign);

    // `zlib/cond.ts` exists at the checkout root (so `exists` is satisfied and the token is a
    // real candidate), exists honestly under `pkg/sub`, and is a LINK OUT under `pkg`. So the
    // spelling is ours from two of the three directories and theirs from the middle one.
    mkdirSync(join(foreign, 'lib'), { recursive: true });
    writeFileSync(join(foreign, 'lib/cond.ts'), 'export const v = 1; // THEIRS\n');
    mkdirSync(join(app, 'zlib'), { recursive: true });
    writeFileSync(join(app, 'zlib/cond.ts'), 'export const cond = 1; // OURS\n');
    mkdirSync(join(app, 'pkg/sub/zlib'), { recursive: true });
    writeFileSync(join(app, 'pkg/sub/zlib/cond.ts'), 'export const cond = 1; // OURS\n');
    symlinkSync(join(foreign, 'lib'), join(app, 'pkg/zlib'), 'dir');

    // `cat` proof of all three readings.
    assert.match(readFileSync(join(app, 'zlib/cond.ts'), 'utf8'), /OURS/);
    assert.match(readFileSync(join(app, 'pkg/sub/zlib/cond.ts'), 'utf8'), /OURS/);
    assert.match(readFileSync(join(app, 'pkg/zlib/cond.ts'), 'utf8'), /THEIRS/);

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-cn', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: { content: [{ type: 'text', text: 'Because the reasoning outlives the diff.' }] },
      }),
      // Stamped in `pkg`. If the branch ran the shell is in `pkg/sub` and the path is ours;
      // if it did not, the shell is in `pkg` and the same spelling is the other repository's.
      JSON.stringify({
        type: 'assistant',
        cwd: join(app, 'pkg'),
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'if [ -d sub ]; then cd sub; fi; cat zlib/cond.ts' },
            },
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-cn' }, base);

    const filePaths = ((sentBody as { filePaths?: unknown }).filePaths as string[]) ?? [];
    assert.deepEqual(filePaths, []);
    assert.doesNotMatch(JSON.stringify(sentBody), /other-repo|THEIRS/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// WHAT `moved` STILL DECIDES, and it is one thing only: what an UNRESOLVABLE base means.
// A `cd` to a directory that is not there FAILED, so the shell stayed and the token falls
// back to the ordinary bases. A record STAMPED with a directory that is not there is not a
// failed move — it is a statement we cannot check, and a path relative to it cannot be placed.
// Same base string, same spelling, opposite verdicts, which is also why the memo cannot key
// on the bases alone.
test('an unresolvable base means different things when a command moved and when it did not', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-moved-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const app = join(tmp, 'app');
    mkdirSync(app, { recursive: true });
    runGit(app, 'init', '-q', '-b', 'main');
    runGit(app, 'config', 'user.email', 'test@example.com');
    runGit(app, 'config', 'user.name', 'Test');
    writeFileSync(join(app, 'README.md'), '# fixture\n');
    runGit(app, 'add', '.');
    runGit(app, 'commit', '-qm', 'init');
    mkdirSync(join(app, 'src'), { recursive: true });
    // ONE spelling for both records, because that is what makes the memo collide. Two
    // different names would each get their own cache entry and the pairing would prove
    // nothing about the key.
    writeFileSync(join(app, 'src/same.ts'), 'export const a = 1; // OURS\n');
    // A second name that ONLY the unplaceable record mentions, so that its refusal is a row
    // missing from the output rather than something the paired record quietly covers for.
    writeFileSync(join(app, 'src/only.ts'), 'export const b = 1; // OURS\n');
    const gone = join(tmp, 'gone');
    assert.ok(!existsSync(gone));

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-m', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: { content: [{ type: 'text', text: 'Because the reasoning outlives the diff.' }] },
      }),
      // STAMPED with an absent directory: nothing failed, and nothing can be placed. It comes
      // FIRST deliberately — its verdict is the refusal, and a memo that forgot `moved` would
      // hand that refusal to the record below and take an honest path off the wire.
      JSON.stringify({
        type: 'assistant',
        cwd: gone,
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat src/same.ts' } }] },
      }),
      // The same unplaceable directory, naming something nothing else names. Our own root
      // would happily confirm `src/only.ts` — that is exactly the vouching that must not
      // happen for a record which said it was standing somewhere we cannot find.
      JSON.stringify({
        type: 'assistant',
        cwd: gone,
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat src/only.ts' } }] },
      }),
      // MOVED to that same absent directory: the `cd` failed, so the shell never left and the
      // path is ours. Same spelling, same base string, opposite verdict.
      JSON.stringify({
        type: 'assistant',
        cwd: app,
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `cd ${gone} && cat src/same.ts` } }] },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-m' }, base);

    const filePaths = ((sentBody as { filePaths?: unknown }).filePaths as string[]) ?? [];
    assert.deepEqual(filePaths, ['src/same.ts']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// A RECORD WORKING INSIDE ANOTHER REPOSITORY EMITS NOTHING RELATIVE — and this needs no
// exotic spelling at all, which is what makes it the sharpest case here. The record states
// plainly where it was standing; if that is not inside this repo, a relative spelling from it
// is not this repo's path, and letting our own root vouch for it publishes another project's
// file under this project's name.
//
// The tempting rule is the opposite one — ignore an out-of-repo directory, on the grounds
// that treating it as a contradiction empties the harvest. It does empty it, and that is the
// correct outcome: an emptied harvest is a session we could not place, a vouched-for one is a
// session we placed wrongly. ABSOLUTE spellings are unaffected, since they name one place on
// the machine and need no base at all.
test('a record working inside another repository contributes no relative path', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-outside-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const app = join(tmp, 'app');
    mkdirSync(app, { recursive: true });
    runGit(app, 'init', '-q', '-b', 'main');
    runGit(app, 'config', 'user.email', 'test@example.com');
    runGit(app, 'config', 'user.name', 'Test');
    writeFileSync(join(app, 'README.md'), '# fixture\n');
    runGit(app, 'add', '.');
    runGit(app, 'commit', '-qm', 'init');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1; // OURS\n');
    writeFileSync(join(app, 'src/keep.ts'), 'export const keep = 1; // OURS\n');
    // Another REPOSITORY, holding a file at a name this repo also has — the collision that
    // makes such a leak invisible in the output unless it is given its own row.
    const foreign = join(tmp, 'other-repo');
    mkdirSync(join(foreign, 'src'), { recursive: true });
    runGit(foreign, 'init', '-q', '-b', 'main');
    runGit(foreign, 'config', 'user.email', 'test@example.com');
    runGit(foreign, 'config', 'user.name', 'Test');
    writeFileSync(join(foreign, 'README.md'), '# fixture\n');
    runGit(foreign, 'add', '.');
    runGit(foreign, 'commit', '-qm', 'init');
    writeFileSync(join(foreign, 'src/mine.ts'), 'export const v = 1; // THEIRS\n');
    assert.match(readFileSync(join(foreign, 'src/mine.ts'), 'utf8'), /THEIRS/);
    assert.match(readFileSync(join(app, 'src/mine.ts'), 'utf8'), /OURS/);

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-o', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: { content: [{ type: 'text', text: 'Because the reasoning outlives the diff.' }] },
      }),
      // Stamped inside the OTHER repository and not moved by anything. Both routes — a
      // path-named tool input and a shell token — name that repository's file.
      JSON.stringify({
        type: 'assistant',
        cwd: foreign,
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/mine.ts' } }] },
      }),
      JSON.stringify({
        type: 'assistant',
        cwd: foreign,
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat src/mine.ts' } }] },
      }),
      // …while an ABSOLUTE spelling from that same record still resolves on its own, which is
      // what stops this test passing by simply refusing everything the record says.
      JSON.stringify({
        type: 'assistant',
        cwd: foreign,
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(app, 'src/keep.ts') } }] },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-o' }, base);

    const filePaths = ((sentBody as { filePaths?: unknown }).filePaths as string[]) ?? [];
    assert.deepEqual(filePaths, ['src/keep.ts']);
    assert.doesNotMatch(JSON.stringify(sentBody), /other-repo|THEIRS/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// The same fixture with the honest records REMOVED, so the escapes have nothing to hide
// behind. Above, `src/mine.ts` is on the wire either way and only its REASON changes;
// here its presence would be the leak itself. This is the test that can actually fail.
test('with no honest record, a colliding name from another repo reaches nothing', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-cwd2-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    };
    const app = join(tmp, 'app');
    const foreign = join(tmp, 'other-repo');
    initRepo(app);
    initRepo(foreign);
    mkdirSync(join(foreign, 'src'), { recursive: true });
    writeFileSync(join(foreign, 'src/mine.ts'), 'export const v = 1; // THEIRS\n');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1; // OURS\n');
    mkdirSync(join(app, 'sub'), { recursive: true });
    symlinkSync(join(foreign, 'src'), join(app, 'sub/src'), 'dir');
    assert.match(readFileSync(join(app, 'sub/src/mine.ts'), 'utf8'), /THEIRS/);

    const rec = (cwd: string, input: Record<string, unknown>) =>
      JSON.stringify({
        type: 'assistant',
        cwd,
        timestamp: '2026-08-29T09:00:00Z',
        message: { content: [{ type: 'tool_use', name: 'Bash', input }] },
      });
    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-c2', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: { content: [{ type: 'text', text: 'Because the reasoning outlives the diff.' }] },
      }),
      rec(app, { command: 'cd sub && cat src/mine.ts' }),
      rec(join(app, 'sub'), { command: 'cat src/mine.ts' }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-c2' }, base);

    const filePaths = ((sentBody as { filePaths?: unknown }).filePaths as string[]) ?? [];
    assert.deepEqual(filePaths, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// The rule that generalises past `..`: a segment the filesystem WILL NOT RESOLVE stops
// the walk. `realpath` returning nothing is several conditions wearing one face, and
// only ONE of them — a clean `ENOENT` — is an absence that is safe to walk past. The
// end-to-end test above covers a dangling link, an unreadable parent and a loop through
// the real filesystem; this pins the seam itself, because the difference between "there
// is nothing here" and "something is here and will not say where it goes" is invisible
// in the output of `realpath` alone and is what a mutant would quietly erase.
test('a segment that will not resolve fails closed unless the filesystem says it is absent', async () => {
  const run = async (isAbsent: (p: string) => boolean) => {
    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-a', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Because the reasoning outlives the diff.' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/work/app/opaque/secret.ts' } },
          ],
        },
      }),
    ].join('\n');
    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    await runCapture(
      { transcript_path: '/tmp/s.jsonl', cwd: '/work/app', session_id: 'sess-a' },
      deps({
        fetchImpl,
        readFileImpl: async () => transcript,
        resolveRepoRootsImpl: () => ['/work/app'],
        // Only the root itself resolves; `opaque` does not.
        realPathImpl: (p) => (p === '/work/app' ? '/work/app' : null),
        isAbsentImpl: isAbsent,
      }),
    );
    return ((sentBody as { filePaths?: string[] }).filePaths ?? []) as string[];
  };

  // "Nothing is here" — the deleted-directory case, which has always kept its path.
  assert.deepEqual(await run(() => true), ['opaque/secret.ts']);
  // "Something is here and will not say where it goes" — dangling link, EACCES, ELOOP.
  // The path is refused, and refusing it is the only safe reading.
  assert.deepEqual(await run(() => false), []);
});

// A RELATIVE SPELLING IS RESOLVED BY THE KERNEL FROM THE SESSION'S CWD, and measuring it
// only from the repo ROOTS is the same defect as every other one in this family: the fence
// reading a different path from the one that gets opened. When the session works in a
// SUBDIRECTORY -- the ordinary case in a monorepo package -- a symlink living there is
// invisible from the root: `<repo>/dlink` does not exist, which reads as empty ground
// inside the repo, so the path is kept, while the kernel opens another repository.
//
// The second half is worse, and is why `exists` cannot be the answer. With `pkg/src` linked
// out and the session in `<repo>/pkg`, `src/keep.ts` names the OTHER repo's file -- but this
// repo has its own `src/keep.ts`, so existence confirms it and it ships under our own name.
// Nothing downstream could ever tell.
test('END TO END with real symlinks: a link below the session cwd cannot hide from the fence', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-cwd-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    };
    const app = join(tmp, 'app');
    const foreign = join(tmp, 'other-repo');
    initRepo(app);
    initRepo(foreign);
    mkdirSync(join(foreign, 'src'), { recursive: true });
    writeFileSync(join(foreign, 'src/secret.ts'), 'export const secret = 1; // THEIRS\n');
    writeFileSync(join(foreign, 'src/keep.ts'), 'export const keep = 1; // THEIRS\n');

    // The session's working directory, with the escaping link inside it.
    mkdirSync(join(app, 'sub'), { recursive: true });
    symlinkSync(foreign, join(app, 'sub/dlink'), 'dir');
    // ...and the collision form, at a name this repo genuinely has.
    mkdirSync(join(app, 'pkg'), { recursive: true });
    symlinkSync(join(foreign, 'src'), join(app, 'pkg/src'), 'dir');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/keep.ts'), 'export const keep = 1; // OURS\n');
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1;\n');

    // The spellings really do open the other repository, from those working directories.
    assert.match(readFileSync(join(app, 'sub/dlink/src/secret.ts'), 'utf8'), /THEIRS/);
    assert.match(readFileSync(join(app, 'pkg/src/keep.ts'), 'utf8'), /THEIRS/);

    const capture = async (cwd: string, inputs: Record<string, string>[]) => {
      const transcript = [
        JSON.stringify({ type: 'user', sessionId: 'sess-w', message: { content: 'why?' } }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-29T09:00:00Z',
          message: {
            content: [
              { type: 'text', text: 'Because the reasoning outlives the diff.' },
              ...inputs.map((input) => ({ type: 'tool_use', name: 'Read', input })),
            ],
          },
        }),
      ].join('\n');
      let sentBody: unknown = null;
      const { fetch: fetchImpl } = stubFetch({
        infer: (body) => {
          sentBody = body;
          return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
        },
      });
      const base = deps({ fetchImpl, readFileImpl: async () => transcript });
      delete base.resolveRepoRootsImpl;
      delete base.readGitImpl;
      delete base.fileExistsImpl;
      await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd, session_id: 'sess-w' }, base);
      return (sentBody as { filePaths?: string[] }).filePaths as string[];
    };

    // Relative to a cwd one level down: invisible from the root, refused from the cwd.
    assert.deepEqual(
      await capture(join(app, 'sub'), [
        { file_path: 'dlink/src/secret.ts' },
        { file_path: join(app, 'src/mine.ts') },
      ]),
      ['src/mine.ts'],
    );
    // The collision form, through the shell route, where `exists` confirms our own file.
    assert.deepEqual(
      await capture(join(app, 'pkg'), [
        { command: 'cat src/keep.ts' },
        { file_path: join(app, 'src/mine.ts') },
      ]),
      ['src/mine.ts'],
    );
    // ...and a genuinely repo-relative path from that same subdirectory still survives.
    assert.deepEqual(await capture(join(app, 'sub'), [{ file_path: 'src/mine.ts' }]), ['src/mine.ts']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// THE MEMO KEY IS THE WHOLE RAW SPELLING, AND IT HAS TO BE. The obvious cheaper key is
// the parent directory -- that is what the previous release used, and paths do cluster
// into a few directories -- but two spellings that share a parent do NOT share an answer.
// `walkableSegments` strips `.` segments BEFORE popping the leaf, so `sub/dlink/.` walks
// to `sub` while `sub/dlink/secret.ts` walks to `sub/dlink`: one lands inside the repo,
// the other steps through a link into somebody else's. Under a parent key whichever
// arrives first decides both, so the order of two tool calls in a transcript decides
// whether another repository's file ships. Ordered here with the SAFE spelling first,
// because that is the order that leaks.
test('the containment memo is keyed on the whole spelling, not on the parent directory', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-memo-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const app = join(tmp, 'app');
    const foreign = join(tmp, 'other-repo');
    for (const dir of [app, foreign]) {
      mkdirSync(dir, { recursive: true });
      runGit(dir, 'init', '-q', '-b', 'main');
      runGit(dir, 'config', 'user.email', 'test@example.com');
      runGit(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      runGit(dir, 'add', '.');
      runGit(dir, 'commit', '-qm', 'init');
    }
    writeFileSync(join(foreign, 'topsecret.ts'), 'export const secret = 1; // THEIRS\n');
    mkdirSync(join(app, 'sub'), { recursive: true });
    symlinkSync(foreign, join(app, 'sub/dlink'), 'dir');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1;\n');

    // The spelling really does open the other repository.
    assert.match(readFileSync(join(app, 'sub/dlink/topsecret.ts'), 'utf8'), /THEIRS/);

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-m', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Because the reasoning outlives the diff.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: join(app, 'src/mine.ts') } },
            // Shares a parent with the next one, and walks one segment less far.
            { type: 'tool_use', name: 'Read', input: { cwd: app + '/sub/dlink/.' } },
            // …the one that steps through the link.
            { type: 'tool_use', name: 'Read', input: { file_path: app + '/sub/dlink/topsecret.ts' } },
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-m' }, base);

    const filePaths = (sentBody as { filePaths?: string[] }).filePaths as string[];
    // `sub/dlink` is a name in our own tree and may be reported; the file BEHIND it is
    // another repository's and must not be, whatever order the two arrived in.
    assert.ok(!filePaths.includes('sub/dlink/topsecret.ts'), JSON.stringify(filePaths));
    assert.doesNotMatch(JSON.stringify(sentBody), /topsecret/);
    assert.ok(filePaths.includes('src/mine.ts'), 'the control must survive');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// A ROOT THAT NO LONGER RESOLVES CANNOT CONFIRM ANYTHING, and the tempting way to
// handle one is to keep its logical spelling in the set "just in case". That fails open:
// the resolved paths a candidate walks to are physical, and a logical spelling kept
// beside them is a string that no physical path can match — except by prefix, at which
// point a directory that has been deleted, renamed or unmounted starts vouching for
// paths that resolved somewhere else entirely. The code says so in a comment; this is
// what makes the comment fail when it stops being true.
test('a root that does not resolve is dropped from the set rather than kept as a string', async () => {
  const transcript = [
    JSON.stringify({ type: 'user', sessionId: 'sess-r', message: { content: 'why?' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-29T09:00:00Z',
      message: {
        content: [
          { type: 'text', text: 'Because the reasoning outlives the diff.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/gone/src/secret.ts' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/real/src/mine.ts' } },
        ],
      },
    }),
  ].join('\n');
  let sentBody: unknown = null;
  const { fetch: fetchImpl } = stubFetch({
    infer: (body) => {
      sentBody = body;
      return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
    },
  });
  await runCapture(
    { transcript_path: '/tmp/s.jsonl', cwd: '/real', session_id: 'sess-r' },
    deps({
      fetchImpl,
      readFileImpl: async () => transcript,
      // Two checkouts of one repo. One is still there; the other has been deleted,
      // renamed or unmounted since git listed it.
      resolveRepoRootsImpl: () => ['/gone', '/real'],
      realPathImpl: (p) => (p.startsWith('/gone') ? null : p),
      // Everything under the dead root reads as an ordinary absence, so the ONLY thing
      // that can decide this path is what the resolved-root set does with `/gone`. Keep
      // its logical spelling in that set and `/gone/src` prefix-matches it, the path
      // reads as inside the repo, and another directory's contents ship under our name.
      isAbsentImpl: () => true,
    }),
  );
  // The live root's own file survives, so a green here cannot mean "nothing was sent".
  assert.deepEqual((sentBody as { filePaths?: string[] }).filePaths, ['src/mine.ts']);
});

// A TRAILING `..` IS NOT A LEAF, and popping it walks one segment DEEPER than the
// spelling names. `sub/rootlink/..`, with `sub/rootlink` a link pointing at the checkout
// root, names the directory the repo SITS IN — outside it. Pop the `..` and the walk
// stops at the root instead, reads as inside, and the path ships under a name of ours
// (`sub`) while naming somewhere else. Nothing else in the suite reaches this branch:
// every other spelling ends in a plain filename.
test('a trailing .. is walked, not popped, so a link to the root cannot re-enter it', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-trail-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const app = join(tmp, 'app');
    mkdirSync(join(app, 'sub'), { recursive: true });
    runGit(app, 'init', '-q', '-b', 'main');
    runGit(app, 'config', 'user.email', 'test@example.com');
    runGit(app, 'config', 'user.name', 'Test');
    writeFileSync(join(app, 'README.md'), '# fixture\n');
    runGit(app, 'add', '.');
    runGit(app, 'commit', '-qm', 'init');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1;\n');
    symlinkSync(app, join(app, 'sub/rootlink'), 'dir'); // a link back to the checkout root

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-t', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Because the reasoning outlives the diff.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: join(app, 'src/mine.ts') } },
            { type: 'tool_use', name: 'Read', input: { cwd: app + '/sub/rootlink/..' } },
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: app, session_id: 'sess-t' }, base);

    // Only our own file. `sub` must NOT appear: that spelling names the parent of the repo.
    assert.deepEqual((sentBody as { filePaths?: unknown }).filePaths, ['src/mine.ts']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// A ROOT THAT CANNOT BE RESOLVED SAYS NOTHING — it must not be able to say "no escape"
// on behalf of the roots that CAN answer. The relative route asks every root in turn and
// stops at the first contradiction; a root that fails to resolve has to be stepped over,
// not treated as a verdict, or the first dead root in the list acquits every path behind
// it. Reached with an injected root set, because the real resolver verifies every root it
// returns — which is what keeps this a defensive branch rather than a live hole.
test('an unresolvable root is stepped over, not treated as a verdict of "no escape"', async () => {
  const transcript = [
    JSON.stringify({ type: 'user', sessionId: 'sess-d', message: { content: 'why?' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-29T09:00:00Z',
      message: {
        content: [
          { type: 'text', text: 'Because the reasoning outlives the diff.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'vendor/src/secret.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/mine.ts' } },
        ],
      },
    }),
  ].join('\n');
  let sentBody: unknown = null;
  const { fetch: fetchImpl } = stubFetch({
    infer: (body) => {
      sentBody = body;
      return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
    },
  });
  await runCapture(
    { transcript_path: '/tmp/s.jsonl', cwd: '/real', session_id: 'sess-d' },
    deps({
      fetchImpl,
      readFileImpl: async () => transcript,
      // The dead root is FIRST, so a mutant that returns "no escape" on it never reaches
      // the live root that would have contradicted.
      resolveRepoRootsImpl: () => ['/gone', '/real'],
      realPathImpl: (p) =>
        p.startsWith('/gone') ? null : p === '/real/vendor' ? '/elsewhere' : p,
      isAbsentImpl: () => true,
      fileExistsImpl: () => true,
    }),
  );
  // `/real` says `vendor` comes out at `/elsewhere`. That contradiction has to survive
  // the dead root sitting in front of it.
  assert.deepEqual((sentBody as { filePaths?: string[] }).filePaths, ['src/mine.ts']);
});

// The walk costs a syscall per segment, so its depth is capped — and the cap DROPS the
// path rather than waving it through, because a limit that fails open is a documented
// way in. Pinned because "too deep" is exactly the branch a reader assumes is harmless.
test('a path deeper than the walk cap is refused, not waved through', async () => {
  const shallow = 'a/'.repeat(200) + 'ok.ts'; // 201 segments — walked
  const deep = 'a/'.repeat(300) + 'no.ts'; // 301 segments — refused
  const transcript = [
    JSON.stringify({ type: 'user', sessionId: 'sess-c', message: { content: 'why?' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-29T09:00:00Z',
      message: {
        content: [
          { type: 'text', text: 'Because the reasoning outlives the diff.' },
          { type: 'tool_use', name: 'Read', input: { file_path: shallow } },
          { type: 'tool_use', name: 'Read', input: { file_path: deep } },
        ],
      },
    }),
  ].join('\n');
  let sentBody: unknown = null;
  const { fetch: fetchImpl } = stubFetch({
    infer: (body) => {
      sentBody = body;
      return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
    },
  });
  await runCapture(
    { transcript_path: '/tmp/s.jsonl', cwd: '/work/app', session_id: 'sess-c' },
    deps({
      fetchImpl,
      readFileImpl: async () => transcript,
      resolveRepoRootsImpl: () => ['/work/app'],
      // Every segment resolves to itself and stays inside — so ONLY the cap can
      // separate these two paths.
      realPathImpl: (p) => p,
      isAbsentImpl: () => false,
    }),
  );
  assert.deepEqual((sentBody as { filePaths?: string[] }).filePaths, [shallow]);
});

// A CHECKOUT REACHED THROUGH A SYMLINKED PARENT still works — the property the
// previous release bought, now that containment asks the filesystem instead of
// comparing strings. Git answers with physical paths; the agent reports the ones the
// person actually typed. The root set carries both spellings for exactly that reason,
// and the escape check has to compare a RESOLVED path against RESOLVED roots or the
// logical spelling matches nothing and every path is judged to have left the repo.
test('END TO END with real git: a repo reached through a symlinked parent keeps its paths', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-parent-'));
  try {
    const runGit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const real = join(tmp, 'real');
    const app = join(real, 'app');
    mkdirSync(app, { recursive: true });
    runGit(app, 'init', '-q', '-b', 'main');
    runGit(app, 'config', 'user.email', 'test@example.com');
    runGit(app, 'config', 'user.name', 'Test');
    writeFileSync(join(app, 'README.md'), '# fixture\n');
    runGit(app, 'add', '.');
    runGit(app, 'commit', '-qm', 'init');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/mine.ts'), 'export const mine = 1;\n');
    // The link is ABOVE the checkout — `<tmp>/link/app` is `<tmp>/real/app`.
    symlinkSync(real, join(tmp, 'link'), 'dir');
    const viaLink = join(tmp, 'link', 'app');

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-p', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Because the reasoning outlives the diff.' },
            // Reported under the spelling the session used, not the one git answers with.
            { type: 'tool_use', name: 'Edit', input: { file_path: join(viaLink, 'src/mine.ts') } },
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    delete base.resolveRepoRootsImpl;
    delete base.readGitImpl;
    delete base.fileExistsImpl;
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: viaLink, session_id: 'sess-p' }, base);

    assert.deepEqual((sentBody as { filePaths?: unknown }).filePaths, ['src/mine.ts']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// The same property where there is NO git at all. Capture works in a directory that is
// not a repo, and then the root set is just the session's cwd — the LOGICAL spelling,
// with no physical counterpart alongside it. Comparing a resolved path against that
// string matches nothing, so every path would be read as having left a repo that does
// not exist. This is the case that makes resolving the roots load-bearing rather than
// belt-and-braces, and it is reachable on any machine whose temp dir is a symlink.
test('a non-git directory reached through a symlink still keeps its paths', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bt-cap-nogit-'));
  try {
    const real = join(tmp, 'real');
    const proj = join(real, 'proj');
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src/a.ts'), 'export const a = 1;\n');
    symlinkSync(real, join(tmp, 'link'), 'dir');
    const viaLink = join(tmp, 'link', 'proj');

    const transcript = [
      JSON.stringify({ type: 'user', sessionId: 'sess-n', message: { content: 'why?' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-29T09:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Because the reasoning outlives the diff.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: join(viaLink, 'src/a.ts') } },
          ],
        },
      }),
    ].join('\n');

    let sentBody: unknown = null;
    const { fetch: fetchImpl } = stubFetch({
      infer: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
      },
    });
    const base = deps({ fetchImpl, readFileImpl: async () => transcript });
    // Real root resolution, real filesystem — but there is no git here, so the root set
    // is `[resolve(cwd)]` and carries the symlinked spelling only.
    delete base.resolveRepoRootsImpl;
    delete base.fileExistsImpl;
    base.readGitImpl = () => null; // no git anywhere on this path
    await runCapture({ transcript_path: join(tmp, 's.jsonl'), cwd: viaLink, session_id: 'sess-n' }, base);

    assert.deepEqual((sentBody as { filePaths?: unknown }).filePaths, ['src/a.ts']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- what capture has to say, and whether anyone can hear it -----------------
//
// The shipped SessionEnd/Stop hook re-spawns its worker with `stdio: 'ignore'`, so a
// line capture writes to stderr is not a quiet channel — it is no channel. These pin
// the OTHER end: that the warning root resolution produces travels all the way to the
// surface a person actually reads, without either test knowing how it got there.

test('a warning from root resolution reaches BOTH channels, not only the dead one', async () => {
  const logged: string[] = [];
  const recorded: string[] = [];
  const { fetch: fetchImpl } = stubFetch({});
  await runCapture(
    HOOK,
    deps({
      fetchImpl,
      log: (m) => logged.push(m),
      recordNoticeImpl: (m) => recorded.push(m),
      resolveRepoRootsImpl: (cwd, _run, warn) => {
        warn?.('backthread: 6 worktrees were left out of this capture.');
        return [cwd];
      },
    }),
  );
  // stderr, for `backthread capture` run by hand with a terminal attached…
  assert.ok(
    logged.includes('backthread: 6 worktrees were left out of this capture.'),
    `not on stderr: ${JSON.stringify(logged)}`,
  );
  // …and the file, which is the only one of the two the shipped hook can use.
  assert.deepEqual(recorded, ['backthread: 6 worktrees were left out of this capture.']);
});

// END TO END across the two modules, with a real config directory on disk and no
// knowledge on either side of how the other works. A guard that stopped at "capture
// called the recorder" would sit one layer above the break: the question is whether
// the sentence reaches the report somebody reads.
test('END TO END: what a detached capture leaves behind is what `backthread doctor` shows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bt-notice-e2e-'));
  try {
    const env = { BACKTHREAD_CONFIG_DIR: join(dir, 'cfg') } as NodeJS.ProcessEnv;
    const message =
      'backthread: this repo has 70 linked worktrees and only the first 64 were checked, so ' +
      'file paths in the other 6 were left out of this capture.';
    const { fetch: fetchImpl } = stubFetch({});
    const base = deps({
      fetchImpl,
      env,
      // The detached worker's stdio is discarded; model that by throwing the log away.
      log: () => {},
      resolveRepoRootsImpl: (cwd, _run, warn) => {
        warn?.(message);
        return [cwd];
      },
    });
    // The real recorder — this is the wiring under test.
    delete base.recordNoticeImpl;
    await runCapture(HOOK, base);

    const report = await runDoctor({ env, home: dir, cwd: dir, fetchImpl, runNpm: async () => ({ ok: false, stdout: '', stderr: '' }) });
    assert.match(report.text, /this repo has 70 linked worktrees/);
    assert.match(report.text, /other 6 were left out/);
    // A partial capture is not a broken install: it must never drive the exit code.
    assert.equal(report.exitCode, 1); // (the fail is the absent auth config, not this)
    const capture = report.checks.find((c) => c.key === 'capture');
    assert.equal(capture?.status, 'warn');
    assert.notEqual(capture?.critical, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the existence gate for a SHELL path accepts a file that lives in a sibling worktree', async () => {
  let sentBody: unknown = null;
  const { fetch: fetchImpl } = stubFetch({
    infer: (body) => {
      sentBody = body;
      return { status: 200, body: { ok: true, persisted: true, decisions: [{ title: 'x' }] } };
    },
  });
  const transcript = [
    JSON.stringify({ type: 'user', sessionId: 'sess-wt2', message: { content: 'why the retry cap?' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-29T09:00:00Z',
      message: {
        content: [
          { type: 'text', text: 'A cap stops a poisoned job retrying forever.' },
          { type: 'tool_use', name: 'Bash', input: { command: "sed -n '1,40p' src/queue/retry.ts" } },
        ],
      },
    }),
  ].join('\n');

  // The file exists ONLY in the sibling worktree — never under the hook's own cwd.
  const asked: string[] = [];
  await runCapture(
    HOOK,
    deps({
      fetchImpl,
      readFileImpl: async () => transcript,
      resolveRepoRootsImpl: () => ['/work/app', '/work/app-lane1'],
      fileExistsImpl: (p) => {
        asked.push(p);
        return p === '/work/app-lane1/src/queue/retry.ts';
      },
    }),
  );
  // The predicate really was consulted for BOTH roots — otherwise a green here would
  // only mean the shell path skipped the gate entirely.
  assert.ok(asked.includes('/work/app/src/queue/retry.ts'));
  assert.ok(asked.includes('/work/app-lane1/src/queue/retry.ts'));
  assert.deepEqual((sentBody as { filePaths?: unknown }).filePaths, ['src/queue/retry.ts']);
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
  // command (`cat ~/.ssh/id_rsa`). Shell commands ARE path-harvested now, but this one
  // names nothing harvestable — `.ssh/id_rsa` carries no source/doc extension, and a
  // `~` home path is foreign to the repo either way — so sessionPaths still yields [].
  // The decision is still kept + persisted (the server marks it unanchored), and the
  // body must NOT carry filePaths.
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
  const { fetch: fetchImpl } = stubFetch({ infer: () => ({ status: 401, body: { error: 'token_revoked' } }) });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'infer-failed');
  // The detail a person reads is a sentence about what did not happen — never the
  // internal slug, which is an operator field behind `--verbose`.
  assert.match(out.detail, /this session wasn't written up/);
  assert.doesNotMatch(out.detail, /token_revoked/);
});

test('ingest persist failure → persist-failed (swallowed)', async () => {
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'x' }] } }),
    ingest: () => ({ status: 500, body: { error: 'persist_failed' } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.equal(out.status, 'persist-failed');
  // `capture --manual` PRINTS this detail, so it is product copy: the reader learns their
  // decisions were not saved, and does not read `persist_failed`.
  assert.match(out.detail, /the write didn't complete on our side/);
  assert.doesNotMatch(out.detail, /persist_failed/);
});

test('a raw upstream diagnostic never reaches the reader as product copy', async () => {
  // ⚠ MEASURED LEAK. ingest-decisions pairs the slug with `rpcErr.message`, so before this
  // slug was mapped a person read: "the decisions weren't saved — duplicate key value
  // violates unique constraint \"decisions_pkey\"". The `failureBody` allow-list that
  // normally makes this impossible does not run on this route.
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'x' }] } }),
    ingest: () => ({
      status: 500,
      body: {
        error: 'persist_failed',
        message: 'duplicate key value violates unique constraint "decisions_pkey"',
      },
    }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.doesNotMatch(out.detail, /duplicate key|constraint|decisions_pkey/);
  assert.match(out.detail, /the write didn't complete on our side/);
});

test('a plan-limit rejection tells the reader what to do about it', async () => {
  const { fetch: fetchImpl } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'x' }] } }),
    ingest: () => ({ status: 402, body: { error: 'plan_limit' } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl }));
  assert.match(out.detail, /used its capture allowance for now/);
  assert.doesNotMatch(out.detail, /plan_limit/);
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

// --- ARP-1054: pre-send capture-scope skip ----------------------------------

test('a scope skip is reported as a sentence, not as the enum value', async () => {
  // ⚠ A MUTANT SURVIVED HERE. A table of sentences with nothing driving the call site is a
  // table, not a behaviour: reverting `capture.ts` to `capture skipped (not_a_member)` was
  // invisible to the whole suite. This drives the real runCapture.
  const out = await runCapture(
    HOOK,
    deps({ checkScopeImpl: async () => ({ send: false, reason: 'not_a_member' }) }),
  );
  assert.equal(out.status, 'skipped-out-of-scope');
  assert.match(out.detail, /you're not a member of the account that owns this repo/);
  assert.doesNotMatch(out.detail, /not_a_member/);
});

test('scope skip (capture_paused) → skipped-out-of-scope; transcript never read, nothing sent, no nudge', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({});
  let readTranscript = false;
  const logs: string[] = [];
  const out = await runCapture(
    HOOK,
    deps({
      fetchImpl,
      checkScopeImpl: async () => ({ send: false, reason: 'capture_paused' }),
      readFileImpl: async () => {
        readTranscript = true;
        return TRANSCRIPT_JSONL;
      },
      log: (m) => logs.push(m),
    }),
  );
  assert.equal(out.status, 'skipped-out-of-scope');
  assert.equal(out.count, 0);
  assert.equal(readTranscript, false, 'a paused repo must not even read the transcript off disk');
  assert.equal(calls.length, 0, 'nothing sent to infer/ingest');
  assert.equal(logs.length, 0, 'a paused repo is silent — no connect nudge');
});

test('scope skip (not_connected) → skipped-out-of-scope + the once-per-session connect nudge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bt-scope-'));
  try {
    const { fetch: fetchImpl, calls } = stubFetch({});
    const logs: string[] = [];
    const out = await runCapture(
      HOOK,
      deps({
        env: { BACKTHREAD_CONFIG_DIR: dir } as NodeJS.ProcessEnv,
        fetchImpl,
        checkScopeImpl: async () => ({ send: false, reason: 'not_connected' }),
        log: (m) => logs.push(m),
      }),
    );
    assert.equal(out.status, 'skipped-out-of-scope');
    assert.equal(calls.length, 0, 'nothing sent');
    assert.equal(logs.length, 1, 'an unconnected repo gets the connect nudge');
    assert.match(logs[0], /isn't connected to Backthread/);
    assert.match(logs[0], /acme\/app/);
    assert.doesNotMatch(logs[0], /held as pending/, 'pre-send copy: nothing was captured/held');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scope send → the normal capture flow proceeds unchanged', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: true, count: 1, decisions: [{ title: 'x' }] } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl, checkScopeImpl: async () => ({ send: true, reason: 'connected' }) }));
  assert.equal(out.status, 'persisted-by-server');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/infer-decisions$/);
});

test('REAL wiring: runCapture POSTs /capture-scope first and skips on a skip verdict (no transcript send)', async () => {
  // checkScopeImpl:undefined → exercise the real checkCaptureScope against the stub.
  const { fetch: fetchImpl, calls } = stubFetch({
    scope: () => ({ status: 200, body: { ok: true, decision: 'skip', reason: 'capture_paused' } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl, checkScopeImpl: undefined }));
  assert.equal(out.status, 'skipped-out-of-scope');
  // Exactly ONE network call — the preflight — and it carries the slug only, no transcript.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/capture-scope$/);
  assert.deepEqual(calls[0].body, { repo: { owner: 'acme', name: 'app' } });
});

test('REAL wiring: a fail-open preflight (server 5xx) still sends the capture', async () => {
  const { fetch: fetchImpl, calls } = stubFetch({
    scope: () => ({ status: 502, body: { error: 'scope_lookup_failed' } }),
    infer: () => ({ status: 200, body: { ok: true, persisted: true, count: 1, decisions: [{ title: 'x' }] } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl, checkScopeImpl: undefined }));
  assert.equal(out.status, 'persisted-by-server', 'a 5xx preflight fails open → capture proceeds');
  // preflight + infer.
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/capture-scope$/);
  assert.match(calls[1].url, /\/infer-decisions$/);
});

test('scope: a no-git-remote cwd (null repo) skips the preflight entirely (no /capture-scope call)', async () => {
  // No resolvable repo → the (1b) scope block is skipped; the flow falls through to the
  // existing "derived but can't claim a repo" path. checkScopeImpl:undefined so the REAL
  // check would fire if repo were non-null — proving it's the null-repo guard, not the seam.
  const { fetch: fetchImpl, calls } = stubFetch({
    infer: () => ({ status: 200, body: { ok: true, persisted: false, decisions: [{ title: 'x' }] } }),
  });
  const out = await runCapture(HOOK, deps({ fetchImpl, checkScopeImpl: undefined, readRemoteImpl: () => null }));
  assert.equal(out.status, 'nothing-to-capture'); // derived but no repo to claim under
  assert.equal(calls.some((c) => c.url.includes('/capture-scope')), false, 'no preflight without a repo');
});

test('REAL wiring: not_connected → skipped-out-of-scope + the connect nudge (no transcript send)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bt-scope-nc-'));
  try {
    const { fetch: fetchImpl, calls } = stubFetch({
      scope: () => ({ status: 200, body: { ok: true, decision: 'skip', reason: 'not_connected' } }),
    });
    const logs: string[] = [];
    const out = await runCapture(
      HOOK,
      deps({
        env: { BACKTHREAD_CONFIG_DIR: dir } as NodeJS.ProcessEnv,
        fetchImpl,
        checkScopeImpl: undefined, // exercise the real checkCaptureScope → not_connected
        log: (m) => logs.push(m),
      }),
    );
    assert.equal(out.status, 'skipped-out-of-scope');
    // Exactly ONE network call — the preflight. No infer/ingest.
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/capture-scope$/);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /isn't connected to Backthread/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
