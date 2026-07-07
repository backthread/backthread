// ARP-763 — SessionStart ambient-routing hook tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTING_CONTEXT,
  buildSessionStartOutput,
  runSessionStart,
} from './sessionStart.js';
import type { BackthreadConfig } from './config.js';

test('buildSessionStartOutput: set up → injects the routing instruction', () => {
  const out = buildSessionStartOutput(true);
  assert.equal(out.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.equal(out.hookSpecificOutput?.additionalContext, ROUTING_CONTEXT);
  // ARP-854 — the instruction ROUTES BY QUESTION-TYPE: query for why/evolution/topology,
  // read the source for single-module mechanics, both for a whole-feature "how".
  assert.match(ROUTING_CONTEXT, /`query` MCP tool \(or `\/backthread:how`\)/);
  assert.match(ROUTING_CONTEXT, /For what a single function or file does right now, just read the source/);
  assert.match(ROUTING_CONTEXT, /whole-feature "how does X work", do both/);
  // ARP-1009 — the blindspot question type routes to `query` (Thariq's vocabulary
  // verbatim: "what am I missing" / "blindspot pass" / unknown unknowns).
  assert.match(ROUTING_CONTEXT, /blindspot pass/);
  assert.match(ROUTING_CONTEXT, /what am I missing/);
  assert.match(ROUTING_CONTEXT, /unknown unknowns/);
  assert.match(ROUTING_CONTEXT, /trade-offs, assumptions,\s*limitations, and rejected alternatives/);
  // the retired "call FIRST for any how/why" framing must be gone from every surface
  assert.doesNotMatch(ROUTING_CONTEXT, /call the backthread `query` tool FIRST/);
});

test('buildSessionStartOutput: not set up → no injection (empty object)', () => {
  assert.deepEqual(buildSessionStartOutput(false), {});
});

test('runSessionStart: device token present → injects + records the opportunity', async () => {
  let recorded = 0;
  const out = await runSessionStart({
    readConfig: async () => ({ device_token: 'backthread_pat_x' }) as BackthreadConfig,
    recordRoutingInjected: async () => { recorded += 1; },
  });
  assert.equal(out.hookSpecificOutput?.additionalContext, ROUTING_CONTEXT);
  assert.equal(recorded, 1); // the injection was counted
});

test('runSessionStart: no device token → no injection, does NOT record', async () => {
  let recorded = 0;
  const out = await runSessionStart({
    readConfig: async () => ({}) as BackthreadConfig,
    recordRoutingInjected: async () => { recorded += 1; },
  });
  assert.deepEqual(out, {});
  assert.equal(recorded, 0);
});

test('runSessionStart: a config read error degrades to no injection (never throws)', async () => {
  const out = await runSessionStart({
    readConfig: async () => { throw new Error('unreadable config'); },
    recordRoutingInjected: async () => {},
  });
  assert.deepEqual(out, {});
});

test('runSessionStart: a stats-record error never breaks the injection', async () => {
  const out = await runSessionStart({
    readConfig: async () => ({ device_token: 'backthread_pat_x' }) as BackthreadConfig,
    recordRoutingInjected: async () => { throw new Error('disk full'); },
  });
  // still injected — the record failure is swallowed
  assert.equal(out.hookSpecificOutput?.additionalContext, ROUTING_CONTEXT);
});
