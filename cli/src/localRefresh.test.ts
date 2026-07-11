// localRefresh.test.ts — the detached cache-refresh spawner: it forks `sync` +
// `graph` children, unref'd + stdio-ignored, and never throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnCacheRefresh } from './localRefresh.js';

function fakeChild() {
  return { unref() {}, on() {} };
}

test('spawns detached `sync` and `graph` for the cwd, unref\'d + stdio ignored', () => {
  const calls: { args: string[]; opts: any }[] = [];
  const ok = spawnCacheRefresh('/repo', {
    execPath: '/usr/bin/node',
    scriptPath: '/bin/backthread.js',
    spawnImpl: ((_exe: string, args: string[], opts: any) => {
      calls.push({ args, opts });
      return fakeChild() as any;
    }) as any,
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['/bin/backthread.js', 'sync', '--cwd', '/repo']);
  assert.deepEqual(calls[1].args, ['/bin/backthread.js', 'graph', '--cwd', '/repo']);
  for (const c of calls) {
    assert.equal(c.opts.detached, true);
    assert.equal(c.opts.stdio, 'ignore');
  }
});

test('returns false (no-op) when the bin path is unknown', () => {
  const ok = spawnCacheRefresh('/repo', { scriptPath: '', spawnImpl: (() => fakeChild()) as any });
  assert.equal(ok, false);
});

test('never throws when spawn fails; launches whatever it can', () => {
  let n = 0;
  const ok = spawnCacheRefresh('/repo', {
    execPath: '/usr/bin/node',
    scriptPath: '/bin/backthread.js',
    spawnImpl: (() => {
      n += 1;
      if (n === 1) throw new Error('EAGAIN'); // sync fails
      return fakeChild(); // graph succeeds
    }) as any,
  });
  assert.equal(ok, true, 'graph still launched even though sync threw');
});
