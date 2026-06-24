import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAgent,
  normalizeHookInput,
  wasSessionCaptured,
  markSessionCaptured,
  spawnDetached,
  runFromHook,
  captureStatePath,
  type Agent,
  type FromHookDeps,
} from './fromHook.js';
import type { CaptureOutcome, HookInput } from './capture.js';

// Isolate the idempotence state file under a temp BACKTHREAD_CONFIG_DIR so no real
// ~/.backthread is touched (mirrors connectNudge.test.ts / config.test.ts).
async function withTempEnv(fn: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'backthread-fromhook-'));
  const env = { ...process.env, BACKTHREAD_CONFIG_DIR: join(dir, '.backthread') } as NodeJS.ProcessEnv;
  // Strip the env fallback so tests drive the payload via rawPayload only.
  delete env.BACKTHREAD_HOOK_INPUT;
  try {
    await fn(env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A capture stub that records the HookInput it received and returns a fixed outcome.
function captureStub(outcome: CaptureOutcome) {
  const calls: HookInput[] = [];
  const impl = async (input: HookInput): Promise<CaptureOutcome> => {
    calls.push(input);
    return outcome;
  };
  return { impl, calls };
}

const OK_OUTCOME: CaptureOutcome = { status: 'persisted', detail: 'captured 1 decision(s).', count: 1 };

// =====================================================================================
// parseAgent
// =====================================================================================

test('parseAgent maps known agents, normalizes case, aliases gemini → gemini-cli', () => {
  assert.equal(parseAgent('codex'), 'codex');
  assert.equal(parseAgent('Cursor'), 'cursor');
  assert.equal(parseAgent('gemini-cli'), 'gemini-cli');
  assert.equal(parseAgent('gemini'), 'gemini-cli'); // the spike's bare alias
  assert.equal(parseAgent('claude-code'), 'claude-code');
});

test('parseAgent defaults to "unknown" for absent / unrecognized values', () => {
  assert.equal(parseAgent(undefined), 'unknown');
  assert.equal(parseAgent(''), 'unknown');
  assert.equal(parseAgent('windsurf'), 'unknown');
});

// =====================================================================================
// normalizeHookInput — per-agent payload shapes (verified in the spike)
// =====================================================================================

test('CC SessionEnd payload → canonical HookInput (unchanged field names)', () => {
  const payload = {
    session_id: 'cc-sess-1',
    transcript_path: '/Users/x/.claude/projects/-work/cc-sess-1.jsonl',
    cwd: '/work/app',
    hook_event_name: 'SessionEnd',
  };
  assert.deepEqual(normalizeHookInput(payload, 'claude-code'), {
    transcript_path: '/Users/x/.claude/projects/-work/cc-sess-1.jsonl',
    cwd: '/work/app',
    session_id: 'cc-sess-1',
    hook_event_name: 'SessionEnd',
  });
});

test('Codex Stop payload → HookInput (canonical names; extra fields ignored)', () => {
  // Codex Stop: {session_id, transcript_path, cwd, hook_event_name, model,
  //              permission_mode, turn_id, stop_hook_active, last_assistant_message}
  const payload = {
    session_id: 'codex-sess-1',
    transcript_path: '/Users/x/.codex/sessions/2026/06/04/rollout-123-abc.jsonl',
    cwd: '/work/svc',
    hook_event_name: 'Stop',
    turn_id: 't-7',
    stop_hook_active: true,
    last_assistant_message: 'done',
  };
  assert.deepEqual(normalizeHookInput(payload, 'codex'), {
    transcript_path: '/Users/x/.codex/sessions/2026/06/04/rollout-123-abc.jsonl',
    cwd: '/work/svc',
    session_id: 'codex-sess-1',
    hook_event_name: 'Stop',
  });
});

test('Gemini SessionEnd payload → HookInput (canonical names; reason ignored)', () => {
  const payload = {
    session_id: 'gem-sess-1',
    transcript_path: '/Users/x/.gemini/tmp/abc/chats/session-1.jsonl',
    cwd: '/work/gem',
    hook_event_name: 'SessionEnd',
    reason: 'exit',
    timestamp: '2026-06-04T10:00:00Z',
  };
  assert.deepEqual(normalizeHookInput(payload, 'gemini-cli'), {
    transcript_path: '/Users/x/.gemini/tmp/abc/chats/session-1.jsonl',
    cwd: '/work/gem',
    session_id: 'gem-sess-1',
    hook_event_name: 'SessionEnd',
  });
});

test('Cursor stop payload → HookInput via aliases (conversation_id → session, workspace_roots[0] → cwd)', () => {
  // Cursor stop: {conversation_id, generation_id, model, hook_event_name, cursor_version,
  //               workspace_roots[], user_email, transcript_path, status, loop_count}
  const payload = {
    conversation_id: 'cur-conv-1',
    generation_id: 'gen-99', // PER-TURN — must NOT become the session id
    model: 'claude',
    hook_event_name: 'stop',
    cursor_version: '1.7.0',
    workspace_roots: ['/work/cursor-app', '/work/other'],
    user_email: 'x@example.com',
    transcript_path: '/Users/x/.cursor/.../agent-transcripts/t.jsonl',
    status: 'completed',
    loop_count: 3,
  };
  assert.deepEqual(normalizeHookInput(payload, 'cursor'), {
    transcript_path: '/Users/x/.cursor/.../agent-transcripts/t.jsonl',
    cwd: '/work/cursor-app', // first workspace root
    session_id: 'cur-conv-1', // conversation_id, NOT generation_id
    hook_event_name: 'stop',
  });
});

test('Cursor sessionEnd with NULLABLE transcript_path → degrades (no transcript_path key)', () => {
  // transcript_path is documented nullable ("null if disabled"). We must NOT
  // invent a path — leave it absent so runCapture returns `no-transcript` (the live
  // hook no-ops; the dir-walk adapter remains the backfill fallback).
  const payload = {
    conversation_id: 'cur-conv-2',
    hook_event_name: 'sessionEnd',
    workspace_roots: ['/work/cursor-app'],
    transcript_path: null,
  };
  const out = normalizeHookInput(payload, 'cursor');
  assert.equal(out.transcript_path, undefined);
  assert.equal(out.session_id, 'cur-conv-2');
  assert.equal(out.cwd, '/work/cursor-app');
});

test('normalizeHookInput tolerates garbage / empty / missing fields → empty HookInput', () => {
  assert.deepEqual(normalizeHookInput({}, 'unknown'), {});
  assert.deepEqual(normalizeHookInput({ transcript_path: '   ' }, 'unknown'), {}); // whitespace → absent
  assert.deepEqual(normalizeHookInput({ session_id: 42 } as unknown as HookInput, 'unknown'), {}); // wrong type
  // workspace_roots present but no string entries → no cwd.
  assert.deepEqual(normalizeHookInput({ workspace_roots: [null, 7] } as unknown as HookInput, 'cursor'), {});
});

test('unknown agent reads canonical fields AND conversation_id fallback', () => {
  // An agent we do not specifically know still resolves canonical fields; we also try
  // conversation_id as a generic fallback so an unexpected Cursor-like payload works.
  assert.deepEqual(
    normalizeHookInput({ conversation_id: 'c-1', transcript_path: '/t.jsonl' }, 'unknown'),
    { transcript_path: '/t.jsonl', session_id: 'c-1' },
  );
});

// =====================================================================================
// Idempotence state — the bounded ring (mirrors connectNudge)
// =====================================================================================

test('wasSessionCaptured false before, true after markSessionCaptured; file is 0600', async () => {
  await withTempEnv(async (env) => {
    assert.equal(await wasSessionCaptured('s-1', env), false);
    await markSessionCaptured('s-1', env);
    assert.equal(await wasSessionCaptured('s-1', env), true);
    // A different session is independent.
    assert.equal(await wasSessionCaptured('s-2', env), false);
    // The state file is owner-only.
    const s = await stat(captureStatePath(env));
    assert.equal(s.mode & 0o777, 0o600);
    assert.match(await readFile(captureStatePath(env), 'utf8'), /s-1/);
  });
});

test('markSessionCaptured is a no-op for a null/empty/whitespace session id', async () => {
  await withTempEnv(async (env) => {
    await markSessionCaptured(null, env);
    await markSessionCaptured('', env);
    await markSessionCaptured('   ', env);
    // No file written (nothing to key on); and an unknown id is never "captured".
    await assert.rejects(stat(captureStatePath(env)));
    assert.equal(await wasSessionCaptured(null, env), false);
  });
});

test('a CORRUPT state file is harmless — fail-open (treated as not-captured)', async () => {
  await withTempEnv(async (env) => {
    await mkdir(env.BACKTHREAD_CONFIG_DIR as string, { recursive: true });
    await writeFile(captureStatePath(env), 'not-json{{{', 'utf8');
    // Fail open: a corrupt file → we'd rather re-capture than silently drop.
    assert.equal(await wasSessionCaptured('s-1', env), false);
    // And marking still works (rewrites valid state).
    await markSessionCaptured('s-1', env);
    assert.equal(await wasSessionCaptured('s-1', env), true);
  });
});

test('the ring is bounded — old session ids fall off the front', async () => {
  await withTempEnv(async (env) => {
    // Push more than MAX_REMEMBERED (200) ids; the earliest must be evicted.
    for (let i = 0; i < 250; i++) await markSessionCaptured(`s-${i}`, env);
    assert.equal(await wasSessionCaptured('s-0', env), false); // evicted
    assert.equal(await wasSessionCaptured('s-249', env), true); // most recent kept
    const state = JSON.parse(await readFile(captureStatePath(env), 'utf8'));
    assert.equal(state.captured.length, 200);
  });
});

// =====================================================================================
// spawnDetached — the fire-and-forget seam (Gemini)
// =====================================================================================

test('spawnDetached re-execs the bin detached, passing the payload via env, with --no-detach', () => {
  const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
  const fakeChild = { unref() {}, on() {} } as unknown as ReturnType<typeof import('node:child_process').spawn>;
  const spawnImpl = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return fakeChild;
  }) as unknown as typeof import('node:child_process').spawn;

  const launched = spawnDetached('{"session_id":"d-1"}', 'gemini-cli', {
    spawnImpl,
    execPath: '/usr/bin/node',
    scriptPath: '/bin/backthread.js',
    env: { PATH: '/x' } as NodeJS.ProcessEnv,
  });

  assert.equal(launched, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/usr/bin/node');
  // The child re-runs capture --from-hook with --no-detach (so it can't recurse) + --agent.
  assert.deepEqual(calls[0].args, [
    '/bin/backthread.js',
    'capture',
    '--from-hook',
    '--no-detach',
    '--agent',
    'gemini-cli',
  ]);
  // Detached + stdio ignored; payload handed off via BACKTHREAD_HOOK_INPUT.
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  const childEnv = calls[0].opts.env as NodeJS.ProcessEnv;
  assert.equal(childEnv.BACKTHREAD_HOOK_INPUT, '{"session_id":"d-1"}');
  assert.equal(childEnv.PATH, '/x'); // base env preserved
});

test('spawnDetached returns false (never throws) on a spawn error or missing script path', () => {
  // A throwing spawner → false, not a throw.
  const throwingSpawn = (() => {
    throw new Error('EAGAIN');
  }) as unknown as typeof import('node:child_process').spawn;
  assert.equal(spawnDetached('{}', 'gemini-cli', { spawnImpl: throwingSpawn, scriptPath: '/x' }), false);
  // No script path to re-exec → false (empty string is falsy; the guard fires before
  // ever calling spawn — we inject a spawnImpl that would fail the test if reached).
  const spawnNotReached = (() => {
    throw new Error('spawn must not be called when scriptPath is empty');
  }) as unknown as typeof import('node:child_process').spawn;
  assert.equal(spawnDetached('{}', 'gemini-cli', { spawnImpl: spawnNotReached, scriptPath: '' }), false);
});

// =====================================================================================
// runFromHook — the orchestrator
// =====================================================================================

test('runFromHook runs the shared fence with the normalized input and ALWAYS exits 0', async () => {
  await withTempEnv(async (env) => {
    const cap = captureStub(OK_OUTCOME);
    const result = await runFromHook({
      env,
      agent: 'codex',
      rawPayload: JSON.stringify({ session_id: 'r-1', transcript_path: '/t.jsonl', cwd: '/w' }),
      runCaptureImpl: cap.impl,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, 'captured');
    assert.equal(result.outcome?.status, 'persisted');
    assert.equal(cap.calls.length, 1);
    assert.deepEqual(cap.calls[0], { transcript_path: '/t.jsonl', cwd: '/w', session_id: 'r-1' });
  });
});

test('runFromHook is IDEMPOTENT per session id — a second turn-fire skips the pipeline', async () => {
  await withTempEnv(async (env) => {
    const cap = captureStub(OK_OUTCOME);
    const payload = JSON.stringify({ session_id: 'dup-1', transcript_path: '/t.jsonl', cwd: '/w' });
    const first = await runFromHook({ env, agent: 'codex', rawPayload: payload, runCaptureImpl: cap.impl });
    const second = await runFromHook({ env, agent: 'codex', rawPayload: payload, runCaptureImpl: cap.impl });
    assert.equal(first.status, 'captured');
    assert.equal(second.status, 'duplicate-session');
    assert.equal(cap.calls.length, 1, 'one session = one capture across turn-fires');
    assert.equal(second.exitCode, 0);
  });
});

test('a TRANSIENT failure is NOT marked captured → a retry can run', async () => {
  await withTempEnv(async (env) => {
    const fail = captureStub({ status: 'persist-failed', detail: 'HTTP 500' });
    const ok = captureStub(OK_OUTCOME);
    const payload = JSON.stringify({ session_id: 'retry-1', transcript_path: '/t.jsonl', cwd: '/w' });
    const first = await runFromHook({ env, agent: 'codex', rawPayload: payload, runCaptureImpl: fail.impl });
    assert.equal(first.status, 'captured');
    assert.equal(first.outcome?.status, 'persist-failed');
    // Not marked → the retry actually runs the pipeline again.
    const second = await runFromHook({ env, agent: 'codex', rawPayload: payload, runCaptureImpl: ok.impl });
    assert.equal(second.status, 'captured');
    assert.equal(second.outcome?.status, 'persisted');
    assert.equal(ok.calls.length, 1);
  });
});

test('a STABLE non-capture outcome (nothing-to-capture) IS marked → not retried', async () => {
  await withTempEnv(async (env) => {
    const nothing = captureStub({ status: 'nothing-to-capture', detail: 'no prose', count: 0 });
    const payload = JSON.stringify({ session_id: 'noop-1', transcript_path: '/t.jsonl', cwd: '/w' });
    await runFromHook({ env, agent: 'codex', rawPayload: payload, runCaptureImpl: nothing.impl });
    const second = await runFromHook({ env, agent: 'codex', rawPayload: payload, runCaptureImpl: nothing.impl });
    assert.equal(second.status, 'duplicate-session');
    assert.equal(nothing.calls.length, 1);
  });
});

test('empty / garbage payload → no-input, no pipeline, exit 0', async () => {
  await withTempEnv(async (env) => {
    const cap = captureStub(OK_OUTCOME);
    for (const raw of ['', '{}', 'not json', '[]']) {
      const r = await runFromHook({ env, agent: 'unknown', rawPayload: raw, runCaptureImpl: cap.impl });
      assert.equal(r.status, 'no-input', `raw=${JSON.stringify(raw)}`);
      assert.equal(r.exitCode, 0);
    }
    assert.equal(cap.calls.length, 0);
  });
});

test('runFromHook falls back to BACKTHREAD_HOOK_INPUT when no rawPayload is passed (detached child path)', async () => {
  await withTempEnv(async (env) => {
    const cap = captureStub(OK_OUTCOME);
    const envWithPayload = {
      ...env,
      BACKTHREAD_HOOK_INPUT: JSON.stringify({ session_id: 'env-1', transcript_path: '/t.jsonl', cwd: '/w' }),
    } as NodeJS.ProcessEnv;
    const r = await runFromHook({ env: envWithPayload, agent: 'gemini-cli', runCaptureImpl: cap.impl });
    assert.equal(r.status, 'captured');
    assert.equal(cap.calls[0].session_id, 'env-1');
  });
});

// --- detached mode --------------------------------------------------------------

test('detach mode re-spawns a detached worker and DOES NOT run the pipeline inline', async () => {
  await withTempEnv(async (env) => {
    const cap = captureStub(OK_OUTCOME);
    let spawnedWith: { raw: string; agent: Agent } | null = null;
    const r = await runFromHook({
      env,
      agent: 'gemini-cli',
      detach: true,
      rawPayload: JSON.stringify({ session_id: 'g-1', transcript_path: '/t.jsonl', cwd: '/w' }),
      runCaptureImpl: cap.impl,
      spawnDetachedImpl: (raw, agent) => {
        spawnedWith = { raw, agent };
        return true;
      },
    });
    assert.equal(r.status, 'detached');
    assert.equal(r.exitCode, 0);
    assert.equal(cap.calls.length, 0, 'detach must NOT capture inline — the worker does it');
    assert.equal(spawnedWith!.agent, 'gemini-cli');
    assert.match(spawnedWith!.raw, /g-1/);
  });
});

// ARP-682: CC's SessionEnd hook now routes through this same detach seam
// (`capture --from-hook --agent claude-code --detach`) so a slow (≥30s) inference can't
// be SIGTERM'd by CC's hook timeout or reaped on session exit. The hook process must
// re-spawn the worker and return immediately — never run the pipeline inline.
test('claude-code SessionEnd in detach mode re-spawns the worker and returns immediately (never inline)', async () => {
  await withTempEnv(async (env) => {
    const cap = captureStub(OK_OUTCOME);
    let spawnedWith: { raw: string; agent: Agent } | null = null;
    const r = await runFromHook({
      env,
      agent: 'claude-code',
      detach: true,
      rawPayload: JSON.stringify({
        session_id: 'cc-1',
        transcript_path: '/t.jsonl',
        cwd: '/w',
        hook_event_name: 'SessionEnd',
      }),
      runCaptureImpl: cap.impl,
      spawnDetachedImpl: (raw, agent) => {
        spawnedWith = { raw, agent };
        return true;
      },
    });
    assert.equal(r.status, 'detached');
    assert.equal(r.exitCode, 0);
    assert.equal(cap.calls.length, 0, 'the slow capture must run in the detached worker, not inline');
    assert.equal(spawnedWith!.agent, 'claude-code');
    assert.match(spawnedWith!.raw, /cc-1/);
  });
});

test('a failed detached spawn still exits 0 (never disrupts the host agent)', async () => {
  await withTempEnv(async (env) => {
    const r = await runFromHook({
      env,
      agent: 'gemini-cli',
      detach: true,
      rawPayload: '{"session_id":"g-2"}',
      spawnDetachedImpl: () => false, // spawn failed
    });
    assert.equal(r.status, 'detached');
    assert.equal(r.exitCode, 0);
  });
});

// --- JSON-stdout (Codex only) ---------------------------------------------------

test('Codex gets a minimal source-free JSON ack on stdout; other agents get none', async () => {
  await withTempEnv(async (env) => {
    const cap = captureStub(OK_OUTCOME);
    const payload = JSON.stringify({ session_id: 'c-stdout', transcript_path: '/t.jsonl', cwd: '/w' });

    const codex = await runFromHook({ env, agent: 'codex', rawPayload: payload, runCaptureImpl: cap.impl });
    assert.ok(codex.stdout, 'codex gets a stdout ack');
    assert.equal(codex.stdout!.continue, true); // don't-block-the-turn signal
    assert.deepEqual(codex.stdout!.backthread, { status: 'captured', capture: 'persisted' });
    // No source / token in the ack.
    assert.doesNotMatch(JSON.stringify(codex.stdout), /backthread_pat_|transcript|\/t\.jsonl/);

    // A different session id so idempotence doesn't short-circuit the second run.
    const payload2 = JSON.stringify({ session_id: 'g-stdout', transcript_path: '/t.jsonl', cwd: '/w' });
    const gemini = await runFromHook({ env, agent: 'gemini-cli', rawPayload: payload2, runCaptureImpl: cap.impl });
    assert.equal(gemini.stdout, null, 'non-Codex agents get no stdout (keeps the channel clean)');
  });
});

// --- never-throws backstop ------------------------------------------------------

test('runFromHook NEVER throws even when runCapture throws — degrades to exit 0', async () => {
  await withTempEnv(async (env) => {
    const r = await runFromHook({
      env,
      agent: 'codex',
      rawPayload: JSON.stringify({ session_id: 'boom-1', transcript_path: '/t.jsonl', cwd: '/w' }),
      runCaptureImpl: async () => {
        throw new Error('boom');
      },
    });
    // The throw is caught; we still exit 0 (the host agent is never disrupted).
    assert.equal(r.exitCode, 0);
    assert.equal(r.status, 'error', 'a swallowed entrypoint throw reports the dedicated error status');
    assert.equal(r.outcome?.status, 'error');
    assert.match(r.outcome!.detail, /swallowed/);
  });
});

test('runFromHook FAILS OPEN when the idempotence check throws (degrades to not-captured, pipeline RUNS)', async () => {
  await withTempEnv(async (env) => {
    const cap = captureStub(OK_OUTCOME);
    const r = await runFromHook({
      env,
      agent: 'codex',
      rawPayload: JSON.stringify({ session_id: 'x', transcript_path: '/t.jsonl', cwd: '/w' }),
      runCaptureImpl: cap.impl,
      wasCapturedImpl: async () => {
        throw new Error('state read blew up');
      },
    });
    // Fail-open: a broken check degrades to "not captured" → the capture PROCEEDS
    // (not silently aborted). Exit 0, status 'captured', and the pipeline actually ran.
    assert.equal(r.exitCode, 0);
    assert.equal(r.status, 'captured');
    assert.equal(cap.calls.length, 1, 'a throwing idempotence check must NOT abort the capture');
  });
});

// --- exhaustive exit-0 sweep ----------------------------------------------------

test('every entry path returns exitCode 0', async () => {
  await withTempEnv(async (env) => {
    const base: FromHookDeps = { env, runCaptureImpl: captureStub(OK_OUTCOME).impl };
    const results = await Promise.all([
      runFromHook({ ...base, agent: 'codex', rawPayload: '{"session_id":"a","transcript_path":"/t","cwd":"/w"}' }),
      runFromHook({ ...base, agent: 'cursor', rawPayload: '{}' }), // no-input
      runFromHook({ ...base, agent: 'gemini-cli', detach: true, rawPayload: '{}', spawnDetachedImpl: () => true }),
      runFromHook({ ...base, agent: 'unknown', rawPayload: 'garbage' }),
    ]);
    for (const r of results) assert.equal(r.exitCode, 0);
  });
});
