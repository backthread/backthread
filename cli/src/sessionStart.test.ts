// SessionStart hook tests — the two-tier grep-hook flip: refresh the cache
// (detached) + inject the DEPTH-TIER pointer (no longer "call query FIRST").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_START_CONTEXT,
  buildSessionStartOutput,
  runSessionStart,
} from './sessionStart.js';
import type { BackthreadConfig } from './config.js';

test('buildSessionStartOutput: set up → injects the depth-tier pointer', () => {
  const out = buildSessionStartOutput(true);
  assert.equal(out.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.equal(out.hookSpecificOutput?.additionalContext, SESSION_START_CONTEXT);
  // The grep-time local pre-read is now AUTOMATIC; the instruction says so...
  assert.match(SESSION_START_CONTEXT, /Grep or Glob, the relevant local structure \+ the recorded why are injected\s+automatically/);
  // ...and positions query/how as the hosted SYNTHESIS depth tier.
  assert.match(SESSION_START_CONTEXT, /`query` MCP tool \(or `\/backthread:how`\)/);
  assert.match(SESSION_START_CONTEXT, /reconciled SYNTHESIS/);
  assert.match(SESSION_START_CONTEXT, /For what a single function or file does right now, just read the source/);
  // The retired proactive "call query FIRST / per-question" nudge must be gone.
  assert.doesNotMatch(SESSION_START_CONTEXT, /call it FIRST/i);
  assert.doesNotMatch(SESSION_START_CONTEXT, /before grepping/i);
});

test('buildSessionStartOutput: not set up → no injection (empty object)', () => {
  assert.deepEqual(buildSessionStartOutput(false), {});
});

test('runSessionStart: set up → injects, spawns the cache refresh with the cwd, records', async () => {
  let recorded = 0;
  let refreshedCwd = '';
  const out = await runSessionStart(
    { cwd: '/repo' },
    {
      readConfig: async () => ({ device_token: 'backthread_pat_x' }) as BackthreadConfig,
      recordRoutingInjected: async () => { recorded += 1; },
      spawnCacheRefresh: (cwd) => { refreshedCwd = cwd; return true; },
    },
  );
  assert.equal(out.hookSpecificOutput?.additionalContext, SESSION_START_CONTEXT);
  assert.equal(refreshedCwd, '/repo', 'refreshed the session cwd');
  assert.equal(recorded, 1);
});

test('runSessionStart: no device token → no injection, no refresh, no record', async () => {
  let recorded = 0;
  let refreshed = false;
  const out = await runSessionStart(
    {},
    {
      readConfig: async () => ({}) as BackthreadConfig,
      recordRoutingInjected: async () => { recorded += 1; },
      spawnCacheRefresh: () => { refreshed = true; return true; },
    },
  );
  assert.deepEqual(out, {});
  assert.equal(recorded, 0);
  assert.equal(refreshed, false, 'never sync without auth');
});

test('runSessionStart: a config read error degrades to no injection (never throws)', async () => {
  const out = await runSessionStart(
    {},
    { readConfig: async () => { throw new Error('unreadable config'); }, spawnCacheRefresh: () => true },
  );
  assert.deepEqual(out, {});
});

test('runSessionStart: a refresh-spawn error never breaks the injection', async () => {
  const out = await runSessionStart(
    { cwd: '/repo' },
    {
      readConfig: async () => ({ device_token: 'backthread_pat_x' }) as BackthreadConfig,
      recordRoutingInjected: async () => {},
      spawnCacheRefresh: () => { throw new Error('spawn failed'); },
    },
  );
  assert.equal(out.hookSpecificOutput?.additionalContext, SESSION_START_CONTEXT);
});

test('runSessionStart: a stats-record error never breaks the injection', async () => {
  const out = await runSessionStart(
    { cwd: '/repo' },
    {
      readConfig: async () => ({ device_token: 'backthread_pat_x' }) as BackthreadConfig,
      recordRoutingInjected: async () => { throw new Error('disk full'); },
      spawnCacheRefresh: () => true,
    },
  );
  assert.equal(out.hookSpecificOutput?.additionalContext, SESSION_START_CONTEXT);
});
