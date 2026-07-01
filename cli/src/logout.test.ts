// logout.test.ts — the `backthread logout` runner. Points BACKTHREAD_CONFIG_DIR at a
// throwaway temp dir so no real ~/.backthread is touched (the config perms + drop-token
// behaviour are exercised on disk, not mocked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogout } from './logout.js';
import { writeConfig, readConfig, configPath } from './config.js';

async function freshConfigDir(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-logout-'));
  return { ...process.env, BACKTHREAD_CONFIG_DIR: dir };
}

test('logout drops the token but KEEPS account + repo', async () => {
  const env = await freshConfigDir();
  await writeConfig({ account: 'acct-1', repo: 'owner/name', device_token: 'backthread_pat_abc' }, env);

  const result = await runLogout(env);
  assert.equal(result.ok, true);
  assert.equal(result.cleared, true);
  assert.match(result.message, /Signed out/);
  assert.match(result.message, /owner\/name/, 'names the kept repo link');

  const after = await readConfig(env);
  assert.equal(after.device_token, undefined, 'the token is gone');
  assert.equal(after.account, 'acct-1', 'account preserved');
  assert.equal(after.repo, 'owner/name', 'repo preserved');
});

test('logout leaves a valid, still-parseable tokenless config on disk', async () => {
  const env = await freshConfigDir();
  await writeConfig({ repo: 'a/b', device_token: 'backthread_pat_z' }, env);

  await runLogout(env);

  const raw = await readFile(configPath(env), 'utf8');
  const parsed = JSON.parse(raw); // must still be valid JSON, not a corrupt half-write
  assert.equal(parsed.repo, 'a/b');
  assert.equal('device_token' in parsed, false, 'the token key is removed, not just blanked');
});

test('logout re-applies 0600 to the rewritten config', async () => {
  const env = await freshConfigDir();
  await writeConfig({ repo: 'a/b', device_token: 'backthread_pat_z' }, env);

  await runLogout(env);

  const mode = (await stat(configPath(env))).mode & 0o777;
  assert.equal(mode, 0o600, 'owner-only after rewrite');
});

test('logout is an idempotent no-op when already signed out', async () => {
  const env = await freshConfigDir();
  // No config written at all → nothing to clear.
  const result = await runLogout(env);
  assert.equal(result.ok, true);
  assert.equal(result.cleared, false);
  assert.match(result.message, /Already signed out/);
});

test('logout on a token-less-but-present config is still a clean no-op', async () => {
  const env = await freshConfigDir();
  await writeConfig({ repo: 'a/b' }, env); // repo connected, never logged in

  const result = await runLogout(env);
  assert.equal(result.cleared, false);
  const after = await readConfig(env);
  assert.equal(after.repo, 'a/b', 'the existing config is left intact');
});
