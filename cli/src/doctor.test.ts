// doctor.test.ts — `backthread doctor`. Everything external is injected (config via a temp
// dir, hook files via readFileImpl, perms via statImpl, connectivity via fetchImpl, version
// via runNpm), so no real ~/.backthread, network, or npm is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, collectChecks, formatReport, type DoctorDeps, type Check } from './doctor.js';
import { writeConfig } from './config.js';
import type { NpmRun } from './npm.js';

async function tempCfgDir(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-doctor-'));
  return { ...process.env, BACKTHREAD_CONFIG_DIR: dir };
}

const okFetch: typeof fetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
const npmLatest = (v: string) => async (): Promise<NpmRun> => ({ ok: true, stdout: v, stderr: '' });

// A fully-healthy install: token + repo + CC hook wired + everything reachable + latest.
async function healthyDeps(over: Partial<DoctorDeps> = {}): Promise<DoctorDeps> {
  const env = await tempCfgDir();
  await writeConfig({ account: 'a', repo: 'owner/name', device_token: 'backthread_pat_x' }, env);
  return {
    env,
    home: '/home/u',
    cwd: '/home/u/project',
    fetchImpl: okFetch,
    runNpm: npmLatest('0.7.0'),
    // CC user-scope settings.json mentions backthread → hook wired.
    readFileImpl: async (p: string) => {
      if (p === '/home/u/.claude/settings.json') return '{"hooks":{"SessionEnd":[{"hooks":[{"command":"npx backthread@latest capture --from-hook --agent claude-code --detach"}]}]}}';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    statImpl: async () => ({ mode: 0o600 }),
    ...over,
  };
}

function find(checks: Check[], key: string): Check {
  const c = checks.find((x) => x.key === key);
  assert.ok(c, `check ${key} present`);
  return c!;
}

// --- healthy install → all green, exit 0 -------------------------------------

test('a healthy install: every check ✓/ℹ, exit 0', async () => {
  const { checks, exitCode } = await runDoctor(await healthyDeps({ statImpl: async (p: string) => ({ mode: p.endsWith('config.json') ? 0o600 : 0o700 }) }));
  assert.equal(exitCode, 0);
  assert.equal(find(checks, 'auth').status, 'ok');
  assert.equal(find(checks, 'perms').status, 'ok');
  assert.equal(find(checks, 'repo').status, 'ok');
  assert.equal(find(checks, 'hook').status, 'ok');
  assert.match(find(checks, 'hook').detail, /claude-code/);
  assert.equal(find(checks, 'connectivity').status, 'ok');
  assert.equal(find(checks, 'version').status, 'ok');
  assert.match(find(checks, 'version').detail, /latest/);
});

// --- deliberately-broken install → exit 1 (auth is the only critical) --------

test('not signed in → auth fails (critical), exit 1', async () => {
  const env = await tempCfgDir(); // no config written
  const { checks, exitCode } = await runDoctor({
    env,
    home: '/home/u',
    cwd: '/home/u/p',
    fetchImpl: okFetch,
    runNpm: npmLatest('0.7.0'),
    readFileImpl: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.equal(exitCode, 1, 'a missing token is the critical failure');
  const auth = find(checks, 'auth');
  assert.equal(auth.status, 'fail');
  assert.match(auth.detail, /backthread login/);
});

test('never prints the device token anywhere in the report', async () => {
  const env = await tempCfgDir();
  await writeConfig({ repo: 'o/n', device_token: 'backthread_pat_SUPERSECRET' }, env);
  const { text } = await runDoctor(await healthyDeps({ env }));
  assert.doesNotMatch(text, /SUPERSECRET/, 'the token value must never surface');
  assert.match(text, /device token present/);
});

test('loose config perms → warn with a chmod hint (not a hard fail)', async () => {
  const deps = await healthyDeps({ statImpl: async () => ({ mode: 0o644 }) }); // group/other readable
  const { checks, exitCode } = await runDoctor(deps);
  const perms = find(checks, 'perms');
  assert.equal(perms.status, 'warn');
  assert.match(perms.detail, /chmod 600/);
  assert.equal(exitCode, 0, 'loose perms is a warn, still logged in so exit stays 0');
});

test('no repo connected → warn (repo-less capture is still supported)', async () => {
  const env = await tempCfgDir();
  await writeConfig({ device_token: 'backthread_pat_x' }, env); // token but no repo
  const { checks } = await runDoctor(await healthyDeps({ env }));
  assert.equal(find(checks, 'repo').status, 'warn');
  assert.match(find(checks, 'repo').detail, /no repo connected/);
});

// --- capture-hook detection --------------------------------------------------

test('hook not detected anywhere → warn with install hint', async () => {
  const deps = await healthyDeps({
    readFileImpl: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.equal(find(await collectChecks(deps), 'hook').status, 'warn');
});

test('hook detected for a non-CC agent (codex) → ✓ names it', async () => {
  const deps = await healthyDeps({
    readFileImpl: async (p: string) => {
      if (p === '/home/u/.codex/hooks.json') return '{"hooks":{"Stop":[{"command":"npx -y backthread capture --from-hook --agent codex --detach"}]}}';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  });
  const hook = find(await collectChecks(deps), 'hook');
  assert.equal(hook.status, 'ok');
  assert.match(hook.detail, /codex/);
});

test('running as the Claude Code plugin → hook counted as wired', async () => {
  const env = await tempCfgDir();
  await writeConfig({ repo: 'o/n', device_token: 'backthread_pat_x' }, env);
  const deps = await healthyDeps({
    env: { ...env, CLAUDE_PLUGIN_ROOT: '/home/u/.claude/plugins/backthread' },
    readFileImpl: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  const hook = find(await collectChecks(deps), 'hook');
  assert.equal(hook.status, 'ok');
  assert.match(hook.detail, /plugin/);
});

test('ARP-680 trap: project-scoped CC hook but nothing user-global → warn', async () => {
  const deps = await healthyDeps({
    readFileImpl: async (p: string) => {
      if (p === '/home/u/project/.claude/settings.json') return '{"hooks":{"SessionEnd":[{"hooks":[{"command":"npx backthread@latest capture --from-hook --agent claude-code --detach"}]}]}}';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); // user-scope absent
    },
  });
  const hook = find(await collectChecks(deps), 'hook');
  assert.equal(hook.status, 'warn');
  assert.match(hook.detail, /PROJECT-scoped/);
  assert.match(hook.detail, /worktree/);
});

// --- connectivity + version --------------------------------------------------

test('one origin unreachable → connectivity warn names it', async () => {
  let call = 0;
  const flakyFetch: typeof fetch = (async () => {
    call += 1;
    if (call === 1) return new Response('', { status: 200 }); // worker ok
    throw new Error('ENOTFOUND'); // functions down
  }) as unknown as typeof fetch;
  const deps = await healthyDeps({ fetchImpl: flakyFetch });
  const conn = find(await collectChecks(deps), 'connectivity');
  assert.equal(conn.status, 'warn');
  assert.match(conn.detail, /functions/);
});

test('version: behind latest → ℹ with an update hint', async () => {
  const deps = await healthyDeps({ runNpm: npmLatest('9.9.9') });
  const ver = find(await collectChecks(deps), 'version');
  assert.equal(ver.status, 'info');
  assert.match(ver.detail, /update available \(9\.9\.9\)/);
  assert.match(ver.detail, /backthread update/);
});

test('version: offline npm view → ℹ "couldn\'t check", still shows local versions', async () => {
  const deps = await healthyDeps({ runNpm: async () => ({ ok: false, stdout: '', stderr: 'network error' }) });
  const ver = find(await collectChecks(deps), 'version');
  assert.equal(ver.status, 'info');
  assert.match(ver.detail, /couldn't check/);
  assert.match(ver.detail, /backthread \d+\.\d+\.\d+/);
});

// --- formatting --------------------------------------------------------------

test('formatReport aligns labels and picks the right summary', async () => {
  const green: Check[] = [
    { key: 'auth', label: 'Auth', status: 'ok', detail: 'signed in' },
    { key: 'version', label: 'Version', status: 'info', detail: 'x' },
  ];
  assert.match(formatReport(green), /All good/);
  const failed: Check[] = [{ key: 'auth', label: 'Auth', status: 'fail', critical: true, detail: 'no' }];
  assert.match(formatReport(failed), /1 issue to fix/);
  const warned: Check[] = [{ key: 'repo', label: 'Repo', status: 'warn', detail: 'x' }];
  assert.match(formatReport(warned), /Mostly good/);
});
