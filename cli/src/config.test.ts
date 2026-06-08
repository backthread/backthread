import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseConfig,
  serializeConfig,
  readConfig,
  writeConfig,
  updateConfig,
  configPath,
  CONFIG_MODE,
} from './config.js';

async function withTempEnv(fn: (env: NodeJS.ProcessEnv, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'backthread-cfg-'));
  const env = { ...process.env, BACKTHREAD_CONFIG_DIR: join(dir, '.backthread') } as NodeJS.ProcessEnv;
  try {
    await fn(env, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('parseConfig keeps known string fields, drops junk', () => {
  const cfg = parseConfig(
    JSON.stringify({ account: 'acc-1', repo: 'o/n', device_token: 'backthread_pat_x', extra: 1 }),
  );
  assert.deepEqual(cfg, { account: 'acc-1', repo: 'o/n', device_token: 'backthread_pat_x' });
});

test('parseConfig tolerates corrupt / non-object input', () => {
  assert.deepEqual(parseConfig('not json'), {});
  assert.deepEqual(parseConfig('[1,2,3]'), {});
  assert.deepEqual(parseConfig('null'), {});
  assert.deepEqual(parseConfig('{"account":""}'), {}); // empty string dropped
});

test('serializeConfig is stable-ordered with trailing newline', () => {
  const out = serializeConfig({ device_token: 't', account: 'a', repo: 'o/n' });
  assert.equal(out, '{\n  "account": "a",\n  "repo": "o/n",\n  "device_token": "t"\n}\n');
});

test('readConfig on a missing file returns empty config (not an error)', async () => {
  await withTempEnv(async (env) => {
    assert.deepEqual(await readConfig(env), {});
  });
});

test('writeConfig persists at chmod 0600', async () => {
  await withTempEnv(async (env) => {
    await writeConfig({ device_token: 'backthread_pat_secret', account: 'acc' }, env);
    const path = configPath(env);
    const st = await stat(path);
    // Compare the permission bits only.
    assert.equal(st.mode & 0o777, CONFIG_MODE, 'config.json must be 0600');
    const roundtrip = parseConfig(await readFile(path, 'utf8'));
    assert.deepEqual(roundtrip, { account: 'acc', device_token: 'backthread_pat_secret' });
  });
});

test('writeConfig re-tightens an existing world-readable file to 0600', async () => {
  await withTempEnv(async (env) => {
    // Pre-create a loose file at the config path.
    await writeConfig({ account: 'a' }, env);
    await chmod(configPath(env), 0o644);
    // Re-write — must clamp back to 0600 even though the file pre-existed.
    await writeConfig({ account: 'a', device_token: 'backthread_pat_t' }, env);
    const st = await stat(configPath(env));
    assert.equal(st.mode & 0o777, CONFIG_MODE);
  });
});

test('updateConfig merges without clobbering existing fields', async () => {
  await withTempEnv(async (env) => {
    await writeConfig({ repo: 'owner/name' }, env);
    // A login that only sets the token must keep the repo slug.
    const next = await updateConfig({ device_token: 'backthread_pat_new', account: 'acc' }, env);
    assert.deepEqual(next, { repo: 'owner/name', account: 'acc', device_token: 'backthread_pat_new' });
    assert.deepEqual(await readConfig(env), next);
  });
});

test('the on-disk config never contains the token in cleartext key positions other than device_token', async () => {
  // Guard: the serializer must not duplicate the token anywhere.
  await withTempEnv(async (env) => {
    await writeConfig({ device_token: 'backthread_pat_unique_marker' }, env);
    const raw = await readFile(configPath(env), 'utf8');
    const occurrences = raw.split('backthread_pat_unique_marker').length - 1;
    assert.equal(occurrences, 1, 'token must appear exactly once (device_token only)');
  });
});
