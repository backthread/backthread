import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDir,
  extractCwdFromRaw,
  isTerminallyProcessed,
  runSweep,
  syntheticRemote,
  type SweepDeps,
  type SweepState,
} from './sweep.js';
import { runCapture, type CaptureDeps, type CaptureOutcome, type HookInput } from './capture.js';
import type { BackthreadConfig } from './config.js';

// ─── fixtures ────────────────────────────────────────────────────────────────
const HOME = '/home/jb';
const PROJ = `${HOME}/.claude/projects`;
const MAIN = '/Users/jb/www/clew';
const MAIN_SLUG = '-Users-jb-www-clew';
const NOW = '2026-06-24T12:00:00Z';
const TARGET = { owner: 'backthread', name: 'backthread-app' };
const TARGET_REMOTE = 'git@github.com:backthread/backthread-app.git';

/** A minimal CC transcript record carrying a top-level cwd. */
function transcript(cwd: string): string {
  return JSON.stringify({ type: 'user', cwd, message: { content: 'why a queue?' } });
}

interface FixtureOpts {
  dirs?: Record<string, string[]>; // absolute dir → entry names
  files?: Record<string, string>; // absolute file → content
  exists?: Set<string>; // paths that exist on disk
  remotes?: Record<string, string | null>; // cwd → git remote
  state?: SweepState; // initial durable ledger
  capture?: (input: HookInput, deps?: CaptureDeps) => Promise<CaptureOutcome>;
  config?: BackthreadConfig;
}

function fixture(opts: FixtureOpts = {}) {
  const dirs = opts.dirs ?? {
    [PROJ]: [MAIN_SLUG],
    [`${PROJ}/${MAIN_SLUG}`]: ['s1.jsonl', 's2.jsonl'],
  };
  const files = opts.files ?? {
    [`${PROJ}/${MAIN_SLUG}/s1.jsonl`]: transcript(MAIN),
    [`${PROJ}/${MAIN_SLUG}/s2.jsonl`]: transcript(MAIN),
  };
  const exists = opts.exists ?? new Set([MAIN]);
  const remotes = opts.remotes ?? { [MAIN]: TARGET_REMOTE };
  let state: SweepState = opts.state ?? { processed: [], lastSweptAt: {} };
  const captureCalls: { input: HookInput; deps?: CaptureDeps }[] = [];
  let written: SweepState | null = null;

  const deps: SweepDeps = {
    env: {} as NodeJS.ProcessEnv,
    log: () => {},
    homedirImpl: () => HOME,
    nowImpl: () => NOW,
    mainRootImpl: () => MAIN,
    readRemoteImpl: (cwd) => remotes[cwd] ?? null,
    readConfigImpl: async () => opts.config ?? { device_token: 'backthread_pat_x', account: 'a' },
    readDirImpl: async (d) => dirs[d] ?? [],
    readFileImpl: async (p) => files[p] ?? '',
    pathExistsImpl: async (p) => exists.has(p),
    readSweepStateImpl: async () => structuredClone(state),
    writeSweepStateImpl: async (s) => {
      written = s;
      state = s;
    },
    runCaptureImpl: opts.capture ?? (async () => ({ status: 'persisted', detail: 'ok', count: 2 })),
  };
  // wrap capture so EVERY call is recorded (the inner impl does not record itself).
  const inner = deps.runCaptureImpl!;
  deps.runCaptureImpl = async (input, d) => {
    captureCalls.push({ input, deps: d });
    return inner(input, d);
  };

  return { deps, captureCalls, get written() { return written; }, get state() { return state; } };
}

// ─── pure: syntheticRemote / isTerminallyProcessed ──────────────────────────

test('syntheticRemote yields an owner/name remote the parser round-trips', () => {
  assert.equal(syntheticRemote(TARGET), 'https://github.com/backthread/backthread-app.git');
});

test('isTerminallyProcessed: done states yes; transient/no-auth no', () => {
  const done: CaptureOutcome['status'][] = ['persisted', 'persisted-by-server', 'nothing-to-capture'];
  const notDone: CaptureOutcome['status'][] = ['no-auth', 'no-transcript', 'infer-failed', 'persist-failed', 'error'];
  for (const s of done) assert.equal(isTerminallyProcessed({ status: s, detail: '' }), true, s);
  for (const s of notDone) assert.equal(isTerminallyProcessed({ status: s, detail: '' }), false, s);
});

// ─── pure: extractCwdFromRaw ────────────────────────────────────────────────

test('extractCwdFromRaw: CC top-level cwd; skips summary lines', () => {
  const raw = [
    JSON.stringify({ leafUuid: 'x', sessionId: 's', type: 'summary' }), // no cwd
    JSON.stringify({ type: 'user', cwd: '/repo/x', message: { content: 'hi' } }),
  ].join('\n');
  assert.equal(extractCwdFromRaw(raw), '/repo/x');
});

test('extractCwdFromRaw: Codex session_meta.payload.cwd fallback', () => {
  const raw = JSON.stringify({ type: 'session_meta', payload: { cwd: '/codex/repo' } });
  assert.equal(extractCwdFromRaw(raw), '/codex/repo');
});

test('extractCwdFromRaw: none / all-corrupt → null', () => {
  assert.equal(extractCwdFromRaw(''), null);
  assert.equal(extractCwdFromRaw('{bad\n{also bad'), null);
  assert.equal(extractCwdFromRaw(JSON.stringify({ type: 'user', message: { content: 'no cwd' } })), null);
});

// ─── pure: classifyDir ──────────────────────────────────────────────────────

const base = { mainSlug: MAIN_SLUG, mainRoot: MAIN, target: TARGET } as const;

test('classifyDir: main dir, cwd exists + resolves to target → git include', () => {
  assert.deepEqual(
    classifyDir({ ...base, dirName: MAIN_SLUG, embeddedCwd: MAIN, cwdExists: true, resolved: TARGET }),
    { include: true, mode: 'git', cwd: MAIN },
  );
});

test('classifyDir: sibling whose cwd resolves to ANOTHER repo → excluded-other-repo', () => {
  assert.deepEqual(
    classifyDir({
      ...base,
      dirName: `${MAIN_SLUG}-lander`,
      embeddedCwd: '/Users/jb/www/clew-lander',
      cwdExists: true,
      resolved: { owner: 'backthread', name: 'backthread-lander' },
    }),
    { include: false, mode: 'excluded-other-repo', cwd: '/Users/jb/www/clew-lander' },
  );
});

test('classifyDir: DELETED sibling worktree (cwd gone, matches root-prefix) → heuristic include', () => {
  assert.deepEqual(
    classifyDir({
      ...base,
      dirName: `${MAIN_SLUG}-arp667`,
      embeddedCwd: '/Users/jb/www/clew-arp667',
      cwdExists: false,
      resolved: null,
    }),
    { include: true, mode: 'heuristic', cwd: '/Users/jb/www/clew-arp667' },
  );
});

test('classifyDir: DELETED nested worktree under the root → heuristic include', () => {
  assert.equal(
    classifyDir({
      ...base,
      dirName: `${MAIN_SLUG}--claude-worktrees-x`,
      embeddedCwd: '/Users/jb/www/clew/.claude/worktrees/x',
      cwdExists: false,
      resolved: null,
    }).mode,
    'heuristic',
  );
});

test('classifyDir: gone cwd that does NOT match the layout → unattributable (no guess)', () => {
  assert.deepEqual(
    classifyDir({
      ...base,
      dirName: `${MAIN_SLUG}-weird`,
      embeddedCwd: '/somewhere/else/entirely',
      cwdExists: false,
      resolved: null,
    }),
    { include: false, mode: 'unattributable', cwd: '/somewhere/else/entirely' },
  );
});

test('classifyDir: no embedded cwd → unattributable', () => {
  assert.deepEqual(
    classifyDir({ ...base, dirName: MAIN_SLUG, embeddedCwd: null, cwdExists: false, resolved: null }),
    { include: false, mode: 'unattributable', cwd: null },
  );
});

// ─── runSweep: gates ────────────────────────────────────────────────────────

test('runSweep: no git remote → no-repo, no capture', async () => {
  const f = fixture({ remotes: {} });
  const s = await runSweep({ cwd: MAIN }, f.deps);
  assert.equal(s.status, 'no-repo');
  assert.equal(f.captureCalls.length, 0);
});

test('runSweep: not logged in → no-auth, no enumeration', async () => {
  const f = fixture({ config: {} });
  const s = await runSweep({ cwd: MAIN }, f.deps);
  assert.equal(s.status, 'no-auth');
  assert.equal(s.repo, 'backthread/backthread-app');
  assert.equal(f.captureCalls.length, 0);
});

test('runSweep: freshness debounce skips a recently-swept repo (unless force)', async () => {
  const recent: SweepState = { processed: [], lastSweptAt: { 'backthread/backthread-app': '2026-06-24T11:59:30Z' } };
  const f = fixture({ state: recent });
  const debounced = await runSweep({ cwd: MAIN }, f.deps); // 30s < 15min
  assert.equal(debounced.status, 'debounced');
  assert.equal(f.captureCalls.length, 0);

  const f2 = fixture({ state: recent });
  const forced = await runSweep({ cwd: MAIN, force: true }, f2.deps);
  assert.equal(forced.status, 'swept');
  assert.equal(f2.captureCalls.length, 2);
});

test('runSweep: a stale lastSweptAt (older than the window) does NOT debounce', async () => {
  const stale: SweepState = { processed: [], lastSweptAt: { 'backthread/backthread-app': '2026-06-24T11:00:00Z' } };
  const f = fixture({ state: stale }); // 60min > 15min window
  const s = await runSweep({ cwd: MAIN }, f.deps);
  assert.equal(s.status, 'swept');
  assert.equal(f.captureCalls.length, 2);
});

// ─── runSweep: the happy path ───────────────────────────────────────────────

test('runSweep: sweeps the main dir, captures, tallies, and commits the ledger', async () => {
  const f = fixture();
  const s = await runSweep({ cwd: MAIN }, f.deps);
  assert.equal(s.status, 'swept');
  assert.equal(s.repo, 'backthread/backthread-app');
  assert.equal(s.dirsSwept, 1);
  assert.equal(s.found, 2);
  assert.equal(s.captured, 2);
  assert.equal(s.decisions, 4); // 2 + 2
  assert.equal(s.skipped, 0);
  assert.equal(s.attributions[0].mode, 'git');

  // Ledger committed: both sessions processed + lastSweptAt stamped.
  assert.deepEqual(f.written!.processed.sort(), ['s1', 's2']);
  assert.equal(f.written!.lastSweptAt['backthread/backthread-app'], NOW);
});

test('runSweep: each capture gets the embedded cwd + a remote PINNED to the target', async () => {
  const f = fixture();
  await runSweep({ cwd: MAIN }, f.deps);
  for (const { input, deps } of f.captureCalls) {
    assert.equal(input.cwd, MAIN); // embedded cwd, for path relativization
    assert.equal(input.hook_event_name, 'SessionEnd');
    assert.equal(deps?.readRemoteImpl?.(MAIN), 'https://github.com/backthread/backthread-app.git');
    assert.equal(typeof deps?.ensureAuthImpl, 'function'); // never pops a browser
  }
  assert.deepEqual(f.captureCalls.map((c) => c.input.session_id).sort(), ['s1', 's2']);
});

// ─── runSweep: skip-before-inference + idempotence ──────────────────────────

test('runSweep: sessions already in the ledger are skipped BEFORE inference', async () => {
  const f = fixture({ state: { processed: ['s1'], lastSweptAt: {} } });
  const s = await runSweep({ cwd: MAIN }, f.deps);
  assert.equal(s.found, 1); // only s2 processed
  assert.equal(s.skipped, 1); // s1 skipped
  assert.deepEqual(f.captureCalls.map((c) => c.input.session_id), ['s2']);
});

test('runSweep: knownCapturedSessionIds (server seed) skips before inference', async () => {
  const f = fixture();
  const s = await runSweep({ cwd: MAIN, knownCapturedSessionIds: ['s1', 's2'] }, f.deps);
  assert.equal(s.found, 0);
  assert.equal(s.skipped, 2);
  assert.equal(f.captureCalls.length, 0);
});

test('runSweep: IDEMPOTENT — a 2nd sweep over shared state adds 0 captures, 0 inference', async () => {
  const f = fixture(); // shared in-memory state persists across runs
  const first = await runSweep({ cwd: MAIN, force: true }, f.deps);
  assert.equal(first.found, 2);
  const callsAfterFirst = f.captureCalls.length;
  const second = await runSweep({ cwd: MAIN, force: true }, f.deps);
  assert.equal(second.found, 0);
  assert.equal(second.skipped, 2);
  assert.equal(f.captureCalls.length, callsAfterFirst); // no new inference
});

test('runSweep: only TERMINAL outcomes enter the ledger (transient retried next time)', async () => {
  const outcomes: Record<string, CaptureOutcome> = {
    s1: { status: 'persisted', detail: '', count: 1 },
    s2: { status: 'infer-failed', detail: 'boom' }, // transient → NOT ledgered
  };
  const f = fixture({ capture: async (input) => outcomes[input.session_id!] });
  await runSweep({ cwd: MAIN }, f.deps);
  assert.deepEqual(f.written!.processed, ['s1']); // s2 left for a retry
});

// ─── runSweep: worktree family + attribution ────────────────────────────────

test('runSweep: enumerates the worktree FAMILY, excludes a sibling other-repo dir', async () => {
  const dirs: Record<string, string[]> = {
    [PROJ]: [MAIN_SLUG, `${MAIN_SLUG}-arp1`, `${MAIN_SLUG}-lander`, 'unrelated-dir'],
    [`${PROJ}/${MAIN_SLUG}`]: ['m1.jsonl'],
    [`${PROJ}/${MAIN_SLUG}-arp1`]: ['w1.jsonl'],
    [`${PROJ}/${MAIN_SLUG}-lander`]: ['l1.jsonl'],
  };
  const WT = '/Users/jb/www/clew-arp1';
  const LANDER = '/Users/jb/www/clew-lander';
  const files: Record<string, string> = {
    [`${PROJ}/${MAIN_SLUG}/m1.jsonl`]: transcript(MAIN),
    [`${PROJ}/${MAIN_SLUG}-arp1/w1.jsonl`]: transcript(WT),
    [`${PROJ}/${MAIN_SLUG}-lander/l1.jsonl`]: transcript(LANDER),
  };
  const f = fixture({
    dirs,
    files,
    exists: new Set([MAIN, WT, LANDER]),
    remotes: { [MAIN]: TARGET_REMOTE, [WT]: TARGET_REMOTE, [LANDER]: 'git@github.com:backthread/backthread-lander.git' },
  });
  const s = await runSweep({ cwd: MAIN }, f.deps);

  assert.equal(s.dirsSwept, 2); // main + arp1 worktree; lander excluded
  assert.equal(s.found, 2);
  const byDir = Object.fromEntries(s.attributions.map((a) => [a.dir, a.mode]));
  assert.equal(byDir[MAIN_SLUG], 'git');
  assert.equal(byDir[`${MAIN_SLUG}-arp1`], 'git');
  assert.equal(byDir[`${MAIN_SLUG}-lander`], 'excluded-other-repo');
  // 'unrelated-dir' isn't in the family prefix → never a candidate (no attribution row).
  assert.ok(!s.attributions.some((a) => a.dir === 'unrelated-dir'));
  assert.deepEqual(f.captureCalls.map((c) => c.input.session_id).sort(), ['m1', 'w1']);
});

test('runSweep: DELETED-worktree dir (cwd gone) recovered by heuristic; pinned to target', async () => {
  const WT = '/Users/jb/www/clew-arp667'; // worktree removed → cwd not on disk
  const dirs: Record<string, string[]> = {
    [PROJ]: [`${MAIN_SLUG}-arp667`],
    [`${PROJ}/${MAIN_SLUG}-arp667`]: ['g1.jsonl'],
  };
  const files = { [`${PROJ}/${MAIN_SLUG}-arp667/g1.jsonl`]: transcript(WT) };
  const f = fixture({ dirs, files, exists: new Set([MAIN]) /* WT absent */ });
  const s = await runSweep({ cwd: MAIN }, f.deps);
  assert.equal(s.dirsSwept, 1);
  assert.equal(s.attributions[0].mode, 'heuristic');
  // capture pinned to target + cwd = the (gone) worktree path for path relativization
  assert.equal(f.captureCalls[0].input.cwd, WT);
  assert.equal(f.captureCalls[0].deps?.readRemoteImpl?.('anything'), 'https://github.com/backthread/backthread-app.git');
});

test('runSweep: gone-cwd dir that does not match the layout → unattributable, not swept', async () => {
  const dirs: Record<string, string[]> = {
    [PROJ]: [`${MAIN_SLUG}-mystery`],
    [`${PROJ}/${MAIN_SLUG}-mystery`]: ['x.jsonl'],
  };
  const files = { [`${PROJ}/${MAIN_SLUG}-mystery/x.jsonl`]: transcript('/var/tmp/elsewhere') };
  const f = fixture({ dirs, files, exists: new Set([MAIN]) });
  const s = await runSweep({ cwd: MAIN }, f.deps);
  assert.equal(s.dirsSwept, 0);
  assert.equal(s.attributions[0].mode, 'unattributable');
  assert.equal(f.captureCalls.length, 0);
});

// ─── runSweep: robustness (never throws) ────────────────────────────────────

test('runSweep: a readDir that throws degrades, never throws', async () => {
  const f = fixture();
  f.deps.readDirImpl = async () => {
    throw new Error('EACCES');
  };
  const s = await runSweep({ cwd: MAIN }, f.deps);
  assert.equal(s.status, 'swept'); // resolved repo, found nothing
  assert.equal(s.found, 0);
});

test('runSweep: a runCapture that throws on one transcript is swallowed; the rest run', async () => {
  const f = fixture({
    capture: async (input) => {
      if (input.session_id === 's1') throw new Error('boom');
      return { status: 'persisted', detail: '', count: 1 };
    },
  });
  const s = await runSweep({ cwd: MAIN }, f.deps);
  assert.equal(s.found, 2);
  assert.equal(s.captured, 1); // s2 only
  assert.deepEqual(f.written!.processed, ['s2']); // s1 threw → not ledgered → retried
});

// ─── integration: REAL runCapture through the sweep (redact fence holds) ─────

test('runSweep drives the REAL runCapture pipeline; the redact fence holds', async () => {
  const SID = 'real1';
  const TRANSCRIPT = [
    JSON.stringify({ type: 'user', cwd: MAIN, sessionId: SID, message: { content: 'why a queue?' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-18T09:00:00Z',
      message: { content: [{ type: 'text', text: 'Decouple ingestion.\n```js\nconst secret=1;\n```' }] },
    }),
  ].join('\n');
  const posted: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    posted.push(String(init?.body ?? ''));
    const body = String(url).includes('/infer-decisions')
      ? { decisions: [{ title: 'Use a queue' }], persisted: true }
      : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  const f = fixture({
    dirs: { [PROJ]: [MAIN_SLUG], [`${PROJ}/${MAIN_SLUG}`]: [`${SID}.jsonl`] },
    files: { [`${PROJ}/${MAIN_SLUG}/${SID}.jsonl`]: TRANSCRIPT },
    capture: runCapture, // the REAL pipeline
  });
  // the sweep reads the transcript for cwd-probe AND runCapture reads it again: thread
  // the transcript-reading seam into captureDeps too.
  f.deps.captureDeps = {
    env: {} as NodeJS.ProcessEnv,
    readConfigImpl: async () => ({ account: 'acc', device_token: 'backthread_pat_secret' }),
    readFileImpl: async () => TRANSCRIPT,
    ensureAuthImpl: () => {},
    fetchImpl,
    log: () => {},
  };
  const s = await runSweep({ cwd: MAIN }, f.deps);
  assert.equal(s.captured, 1);
  assert.equal(s.decisions, 1);
  const all = posted.join('\n');
  assert.ok(!all.includes('const secret=1'), 'source must not leave the machine');
  assert.match(all, /code redacted/);
});
