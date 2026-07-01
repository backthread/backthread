// upgradeNudge.test.ts — the once/day throttle for the server upgrade nudge.
// State lives in a temp dir via BACKTHREAD_CONFIG_DIR, so no real ~/.backthread is
// touched. The clock is injected so the 24h window is deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  maybeUpgradeNudge,
  resetUpgradeNudge,
  upgradeNudgeStatePath,
  UPGRADE_NUDGE_THROTTLE_MS,
} from './upgradeNudge.js';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-upgrade-nudge-'));
  return { BACKTHREAD_CONFIG_DIR: dir };
}

const MSG = 'A newer `backthread` is available — run `npm i -g backthread@latest`.';

test('returns null when there is no upgrade string (nothing to nudge)', async () => {
  const env = await tempEnv();
  assert.equal(await maybeUpgradeNudge(null, { env }), null);
  assert.equal(await maybeUpgradeNudge(undefined, { env }), null);
  assert.equal(await maybeUpgradeNudge('   ', { env }), null);
});

test('shows the nudge the FIRST time (and trims it)', async () => {
  const env = await tempEnv();
  const out = await maybeUpgradeNudge(`  ${MSG}  `, { env, now: () => 1000 });
  assert.equal(out, MSG);
});

test('SUPPRESSES a repeat within 24h (the throttle)', async () => {
  const env = await tempEnv();
  const t0 = 1_000_000;
  assert.equal(await maybeUpgradeNudge(MSG, { env, now: () => t0 }), MSG); // shown
  // 1ms before the window closes → still suppressed.
  assert.equal(
    await maybeUpgradeNudge(MSG, { env, now: () => t0 + UPGRADE_NUDGE_THROTTLE_MS - 1 }),
    null,
  );
});

test('shows AGAIN once the 24h window has passed', async () => {
  const env = await tempEnv();
  const t0 = 5_000_000;
  assert.equal(await maybeUpgradeNudge(MSG, { env, now: () => t0 }), MSG);
  assert.equal(
    await maybeUpgradeNudge(MSG, { env, now: () => t0 + UPGRADE_NUDGE_THROTTLE_MS }),
    MSG,
  );
});

test('suppression does NOT slide the window forward (records only on show)', async () => {
  const env = await tempEnv();
  const t0 = 9_000_000;
  await maybeUpgradeNudge(MSG, { env, now: () => t0 }); // shown at t0
  // A suppressed call at t0+1h must NOT reset the timer.
  await maybeUpgradeNudge(MSG, { env, now: () => t0 + 3_600_000 });
  // So at exactly t0 + 24h it shows again (window measured from t0, not the suppressed call).
  assert.equal(
    await maybeUpgradeNudge(MSG, { env, now: () => t0 + UPGRADE_NUDGE_THROTTLE_MS }),
    MSG,
  );
});

test('persists the timestamp to ~/.backthread/upgrade-nudge.json', async () => {
  const env = await tempEnv();
  await maybeUpgradeNudge(MSG, { env, now: () => 42 });
  const raw = await readFile(upgradeNudgeStatePath(env), 'utf8');
  assert.deepEqual(JSON.parse(raw), { lastUpgradeNudgeAt: 42 });
});

test('a corrupt state file degrades to showing once (never throws)', async () => {
  const env = await tempEnv();
  // Pre-seed garbage, then a nudge should still resolve (treated as "never nudged").
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(env.BACKTHREAD_CONFIG_DIR!, { recursive: true });
  await writeFile(upgradeNudgeStatePath(env), 'not json{{{');
  assert.equal(await maybeUpgradeNudge(MSG, { env, now: () => 1 }), MSG);
});

// --- resetUpgradeNudge (called by `backthread update`) ------------------------

test('resetUpgradeNudge records now → suppresses the next nudge for the full window', async () => {
  const env = await tempEnv();
  const t0 = 5_000_000;
  await resetUpgradeNudge({ env, now: () => t0 });
  // State should now say "last nudged at t0" (a quiet window), NOT be cleared.
  const raw = await readFile(upgradeNudgeStatePath(env), 'utf8');
  assert.deepEqual(JSON.parse(raw), { lastUpgradeNudgeAt: t0 });
  // A nudge inside the window is suppressed…
  assert.equal(await maybeUpgradeNudge(MSG, { env, now: () => t0 + 1000 }), null);
  // …and shows again only after 24h.
  assert.equal(await maybeUpgradeNudge(MSG, { env, now: () => t0 + UPGRADE_NUDGE_THROTTLE_MS }), MSG);
});

test('resetUpgradeNudge never throws on an unwritable state dir', async () => {
  // A bogus config dir (empty string forces the default path logic; point it at a file to
  // make writes fail) must not throw — reset is best-effort.
  await resetUpgradeNudge({ env: { BACKTHREAD_CONFIG_DIR: '/dev/null/nope' }, now: () => 1 });
});
