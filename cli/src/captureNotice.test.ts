import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPTURE_NOTICE_MAX_AGE_MS,
  captureNoticePath,
  readCaptureNotice,
  recordCaptureNotice,
} from './captureNotice.js';

async function withDir(fn: (env: NodeJS.ProcessEnv, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-notice-'));
  try {
    await fn({ BACKTHREAD_CONFIG_DIR: join(dir, 'cfg') } as NodeJS.ProcessEnv, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a notice written by capture is the notice a later read gets back', async () => {
  await withDir(async (env) => {
    const now = new Date('2026-08-29T10:00:00.000Z');
    assert.equal(recordCaptureNotice('12 worktrees were left out of this capture.', env, now), true);
    assert.deepEqual(readCaptureNotice(env, now), {
      at: '2026-08-29T10:00:00.000Z',
      message: '12 worktrees were left out of this capture.',
    });
  });
});

test('the notice file is owner-only, like everything else holding local state', async () => {
  if (process.platform === 'win32') return;
  await withDir(async (env) => {
    recordCaptureNotice('something to say', env);
    const mode = (await stat(captureNoticePath(env))).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
  });
});

// It is the CURRENT state of a recurring condition, not a history of it: capture
// rewrites it every time the condition holds, and a file that grew instead would be a
// thing to maintain rather than a thing to read.
test('a second notice replaces the first rather than accumulating', async () => {
  await withDir(async (env) => {
    recordCaptureNotice('first', env, new Date('2026-08-01T00:00:00.000Z'));
    recordCaptureNotice('second', env, new Date('2026-08-02T00:00:00.000Z'));
    assert.equal(readCaptureNotice(env, new Date('2026-08-02T00:00:00.000Z'))?.message, 'second');
    const raw = await readFile(captureNoticePath(env), 'utf8');
    assert.doesNotMatch(raw, /first/);
  });
});

// Nothing clears the notice, and nothing can: no part of the product knows when the
// condition stopped. The window is what makes it self-clearing in one direction while
// staying indefinitely visible in the other — a live condition is re-recorded on the
// next capture, so only a condition that STOPPED ages out.
test('a notice older than the window is no longer reported', async () => {
  await withDir(async (env) => {
    const at = new Date('2026-08-01T00:00:00.000Z');
    recordCaptureNotice('stale news', env, at);
    const justInside = new Date(at.getTime() + CAPTURE_NOTICE_MAX_AGE_MS);
    const justOutside = new Date(at.getTime() + CAPTURE_NOTICE_MAX_AGE_MS + 1);
    assert.equal(readCaptureNotice(env, justInside)?.message, 'stale news');
    assert.equal(readCaptureNotice(env, justOutside), null);
  });
});

// A clock that moved is not a fresh notice, and it is not a reason to throw a real one
// away either.
test('a notice stamped in the future is still reported', async () => {
  await withDir(async (env) => {
    recordCaptureNotice('from ahead', env, new Date('2027-01-01T00:00:00.000Z'));
    assert.equal(readCaptureNotice(env, new Date('2026-08-29T00:00:00.000Z'))?.message, 'from ahead');
  });
});

// Silence, not an error line. This file is a diagnostic aid, and one that reports on
// its own storage is noise at the exact moment somebody is reading past it.
test('nothing recorded, unreadable, corrupt or shapeless all read as nothing to say', async () => {
  await withDir(async (env, dir) => {
    assert.equal(readCaptureNotice(env), null); // no file at all
    await mkdir(join(dir, 'cfg'), { recursive: true });
    const path = captureNoticePath(env);
    for (const bad of ['{ not json', 'null', '[]', '"a string"', '{"at":"2026-08-29T10:00:00Z"}', '{"message":"no when"}', '{"at":"never","message":"m"}', '{"at":"2026-08-29T10:00:00Z","message":"   "}']) {
      await writeFile(path, bad);
      assert.equal(readCaptureNotice(env, new Date('2026-08-29T11:00:00Z')), null, bad);
    }
  });
});

test('an empty message is not a notice', async () => {
  await withDir(async (env) => {
    assert.equal(recordCaptureNotice('   ', env), false);
    assert.equal(readCaptureNotice(env), null);
  });
});

// Load-bearing: every caller is inside an always-exit-0 hook. An unwritable home
// directory costs a diagnostic; it may never cost somebody their session.
test('an unwritable config dir loses the notice and nothing else', async () => {
  await withDir(async (_env, dir) => {
    // A FILE where the config directory should be — mkdir and write both fail on it.
    const asFile = join(dir, 'not-a-dir');
    await writeFile(asFile, 'x');
    const env = { BACKTHREAD_CONFIG_DIR: join(asFile, 'cfg') } as NodeJS.ProcessEnv;
    assert.equal(recordCaptureNotice('will not land', env), false);
    assert.equal(readCaptureNotice(env), null);
  });
});
