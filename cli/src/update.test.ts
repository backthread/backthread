// update.test.ts — the `backthread update` self-update command. Everything is injected
// (version, npm spawn, nudge reset) so no real npm, network, or global install is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runUpdate, detectInstallContext, type NpmRun, type UpdateDeps } from './update.js';

// A scripted npm: records calls, answers `view` / `install` from the given responses.
function fakeNpm(responses: { view?: NpmRun; install?: NpmRun } = {}) {
  const calls: string[][] = [];
  const impl = async (args: string[]): Promise<NpmRun> => {
    calls.push(args);
    if (args[0] === 'view') return responses.view ?? { ok: true, stdout: '9.9.9', stderr: '' };
    if (args[0] === 'install') return responses.install ?? { ok: true, stdout: '', stderr: '' };
    return { ok: false, stdout: '', stderr: 'unexpected npm call' };
  };
  return { calls, impl };
}

function nudgeSpy() {
  const calls: NodeJS.ProcessEnv[] = [];
  return { calls, impl: async (env: NodeJS.ProcessEnv) => void calls.push(env) };
}

// Global-context defaults (no plugin env, non-npx path). Override per test.
function globalDeps(over: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    env: {},
    scriptPath: '/usr/local/lib/node_modules/backthread/dist-bundle/backthread.js',
    currentVersion: () => '0.7.0',
    log: () => {},
    ...over,
  };
}

// --- context detection -------------------------------------------------------

test('detectInstallContext classifies plugin / npx / global', () => {
  assert.equal(detectInstallContext({ CLAUDE_PLUGIN_ROOT: '/p' }, '/anything'), 'plugin');
  assert.equal(detectInstallContext({}, '/home/u/.npm/_npx/abc123/node_modules/backthread/dist-bundle/backthread.js'), 'npx');
  assert.equal(detectInstallContext({}, 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\backthread\\backthread.js'), 'npx');
  assert.equal(detectInstallContext({}, '/usr/local/lib/node_modules/backthread/backthread.js'), 'global');
  assert.equal(detectInstallContext({}, undefined), 'global');
});

test('detectInstallContext: plugin wins over an npx-looking path', () => {
  assert.equal(detectInstallContext({ CLAUDE_PLUGIN_ROOT: '/p' }, '/x/_npx/y/backthread.js'), 'plugin');
});

test('a bare "_npx" substring that is not a path segment is NOT treated as npx', () => {
  // Guards the regex: only a real `_npx` path SEGMENT counts, not e.g. a repo named `my_npx`.
  assert.equal(detectInstallContext({}, '/home/u/dev/my_npx-tool/backthread.js'), 'global');
});

// --- npx context: explain, never spawn npm -----------------------------------

test('npx run explains (no npm spawn, no fake update)', async () => {
  const npm = fakeNpm();
  const nudge = nudgeSpy();
  const result = await runUpdate(globalDeps({
    scriptPath: '/home/u/.npm/_npx/deadbeef/node_modules/backthread/dist-bundle/backthread.js',
    runNpm: npm.impl,
    resetNudge: nudge.impl,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.context, 'npx');
  assert.equal(result.updated, false);
  assert.match(result.message, /npx/);
  assert.match(result.message, /npm i -g backthread/);
  assert.equal(npm.calls.length, 0, 'npx must not spawn npm');
  assert.equal(nudge.calls.length, 0);
});

// --- plugin context: point at /plugin update ---------------------------------

test('plugin run points at /plugin update (no npm spawn)', async () => {
  const npm = fakeNpm();
  const result = await runUpdate(globalDeps({
    env: { CLAUDE_PLUGIN_ROOT: '/home/u/.claude/plugins/backthread' },
    runNpm: npm.impl,
  }));
  assert.equal(result.context, 'plugin');
  assert.equal(result.updated, false);
  assert.match(result.message, /\/plugin update/);
  assert.equal(npm.calls.length, 0);
});

// --- global context: the real update paths -----------------------------------

test('global + behind → runs view then install, reports old → new, resets nudge', async () => {
  const npm = fakeNpm({ view: { ok: true, stdout: '0.8.0', stderr: '' }, install: { ok: true, stdout: '', stderr: '' } });
  const nudge = nudgeSpy();
  const result = await runUpdate(globalDeps({ runNpm: npm.impl, resetNudge: nudge.impl }));
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.match(result.message, /0\.7\.0 → 0\.8\.0/);
  assert.deepEqual(npm.calls[0], ['view', 'backthread', 'version']);
  assert.deepEqual(npm.calls[1], ['install', '-g', 'backthread@latest']);
  assert.equal(nudge.calls.length, 1, 'nudge quieted after a successful update');
});

test('global + already latest → no install, "already up to date", still resets nudge', async () => {
  const npm = fakeNpm({ view: { ok: true, stdout: '0.7.0', stderr: '' } });
  const nudge = nudgeSpy();
  const result = await runUpdate(globalDeps({ runNpm: npm.impl, resetNudge: nudge.impl }));
  assert.equal(result.ok, true);
  assert.equal(result.updated, false);
  assert.match(result.message, /already up to date/i);
  assert.equal(npm.calls.length, 1, 'only the view call — no install');
  assert.equal(nudge.calls.length, 1);
});

test('global + npm view fails (offline) → ok:false, current untouched, NO install attempted', async () => {
  const npm = fakeNpm({ view: { ok: false, stdout: '', stderr: 'network error ENOTFOUND registry.npmjs.org' } });
  const nudge = nudgeSpy();
  const result = await runUpdate(globalDeps({ runNpm: npm.impl, resetNudge: nudge.impl }));
  assert.equal(result.ok, false);
  assert.equal(result.updated, false);
  assert.match(result.message, /Couldn't check npm/);
  assert.match(result.message, /0\.7\.0.*untouched/);
  assert.equal(npm.calls.length, 1, 'never reaches install when the version check fails');
  assert.equal(nudge.calls.length, 0);
});

test('global + npm view returns garbage → ok:false (never installs an unknown target)', async () => {
  const npm = fakeNpm({ view: { ok: true, stdout: 'not-a-version', stderr: '' } });
  const result = await runUpdate(globalDeps({ runNpm: npm.impl }));
  assert.equal(result.ok, false);
  assert.equal(npm.calls.length, 1);
});

test('global + install fails → ok:false, current untouched, nudge NOT reset', async () => {
  const npm = fakeNpm({
    view: { ok: true, stdout: '0.8.0', stderr: '' },
    install: { ok: false, stdout: '', stderr: 'npm ERR! code EACCES\nnpm ERR! Missing write access to /usr/local/lib' },
  });
  const nudge = nudgeSpy();
  const result = await runUpdate(globalDeps({ runNpm: npm.impl, resetNudge: nudge.impl }));
  assert.equal(result.ok, false);
  assert.equal(result.updated, false);
  assert.match(result.message, /npm couldn't install/);
  assert.match(result.message, /EACCES/);
  assert.match(result.message, /0\.7\.0.*untouched/);
  assert.equal(nudge.calls.length, 0, 'no nudge reset on a failed install');
});
