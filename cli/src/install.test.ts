import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOOK_COMMAND,
  TRUST_COPY,
  mergeSessionEndHook,
  registerHook,
  runInstall,
  type InstallDeps,
  type InstallOptions,
} from './install.js';
import type { BackthreadConfig } from './config.js';
import type { BackfillSummary } from './backfill.js';

// Everything mocked: NO real network / browser / disk / capture. ensureAuth is
// always injected so the real browser/login path is NEVER reached.

const ENV = {} as NodeJS.ProcessEnv;
const CWD = '/work/app';
const AUTHED: BackthreadConfig = { account: 'acc-1', device_token: 'backthread_pat_x' };

function emptyBackfill(): BackfillSummary {
  return { found: 0, captured: 0, decisions: 0, results: [], text: 'none' };
}

function deps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    ensureAuthImpl: async () => AUTHED,
    readConfigImpl: async () => AUTHED,
    readFileImpl: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    writeFileImpl: async () => {},
    mkdirImpl: async () => {},
    runBackfillImpl: async () => emptyBackfill(),
    ...over,
  };
}

function opts(over: Partial<InstallOptions> = {}): InstallOptions {
  return { cwd: CWD, env: ENV, log: () => {}, ...over };
}

// --- TRUST_COPY --------------------------------------------------------------

test('TRUST_COPY restates never-store-source + links /security', () => {
  assert.match(TRUST_COPY, /never leave your machine/i);
  assert.match(TRUST_COPY, /redact/i);
  assert.match(TRUST_COPY, /derived decisions/i);
  assert.match(TRUST_COPY, /app\.backthread\.dev\/security/);
});

// --- mergeSessionEndHook (pure) ----------------------------------------------

test('mergeSessionEndHook adds the SessionEnd hook to empty settings', () => {
  const out = mergeSessionEndHook({});
  assert.ok(out);
  const se = (out!.hooks as any).SessionEnd;
  assert.equal(se.length, 1);
  assert.equal(se[0].hooks[0].command, HOOK_COMMAND);
  assert.equal(se[0].hooks[0].type, 'command');
});

test('mergeSessionEndHook preserves other settings + other hook events', () => {
  const existing = {
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
    },
  };
  const out = mergeSessionEndHook(existing)!;
  assert.equal(out.model, 'opus'); // untouched
  assert.deepEqual((out.hooks as any).PreToolUse, existing.hooks.PreToolUse); // untouched
  assert.equal((out.hooks as any).SessionEnd[0].hooks[0].command, HOOK_COMMAND);
  // Never mutated the input.
  assert.equal((existing.hooks as any).SessionEnd, undefined);
});

test('mergeSessionEndHook is idempotent: returns null when our hook is already present', () => {
  const existing = {
    hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] },
  };
  assert.equal(mergeSessionEndHook(existing), null);
});

test('mergeSessionEndHook appends alongside a different SessionEnd hook', () => {
  const existing = {
    hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] },
  };
  const out = mergeSessionEndHook(existing)!;
  const se = (out.hooks as any).SessionEnd;
  assert.equal(se.length, 2);
  assert.equal(se[0].hooks[0].command, 'other-tool'); // kept
  assert.equal(se[1].hooks[0].command, HOOK_COMMAND); // added
});

// --- registerHook (I/O seams) -----------------------------------------------

test('registerHook writes merged settings to <cwd>/.claude/settings.json', async () => {
  let written: { path: string; data: string } | null = null;
  let mkdirDir: string | null = null;
  const res = await registerHook(CWD, {
    readFileImpl: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    mkdirImpl: async (d) => void (mkdirDir = d),
    writeFileImpl: async (p, d) => void (written = { path: p, data: d }),
  });
  assert.equal(res.wrote, true);
  assert.equal(res.path, '/work/app/.claude/settings.json');
  assert.equal(mkdirDir, '/work/app/.claude');
  // Assert on the parsed JSON's command field directly (not a substring of the
  // serialized blob) so the assertion can't match the command appearing elsewhere.
  const parsed = JSON.parse(written!.data);
  assert.equal(parsed.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
  assert.equal(parsed.hooks.SessionEnd[0].hooks[0].type, 'command');
});

test('registerHook is a no-op (no write) when already present', async () => {
  let wrote = false;
  const res = await registerHook(CWD, {
    readFileImpl: async () =>
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }),
    writeFileImpl: async () => void (wrote = true),
    mkdirImpl: async () => {},
  });
  assert.equal(res.wrote, false);
  assert.equal(wrote, false);
});

test('registerHook merges into an existing valid settings.json (preserves keys)', async () => {
  let data = '';
  await registerHook(CWD, {
    readFileImpl: async () => JSON.stringify({ permissions: { allow: ['Bash'] } }),
    writeFileImpl: async (_p, d) => void (data = d),
    mkdirImpl: async () => {},
  });
  const parsed = JSON.parse(data);
  assert.deepEqual(parsed.permissions, { allow: ['Bash'] });
  assert.equal(parsed.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
});

test('registerHook REFUSES to overwrite a corrupt (unparseable) settings.json', async () => {
  let wrote = false;
  await assert.rejects(
    registerHook(CWD, {
      readFileImpl: async () => '{ this is : not json,', // present but broken
      writeFileImpl: async () => void (wrote = true),
      mkdirImpl: async () => {},
    }),
    /not valid JSON|refusing to overwrite/i,
  );
  assert.equal(wrote, false); // the user's broken-but-recoverable file is left intact
});

test('registerHook REFUSES to overwrite a non-object settings.json (e.g. an array)', async () => {
  let wrote = false;
  await assert.rejects(
    registerHook(CWD, {
      readFileImpl: async () => '[]',
      writeFileImpl: async () => void (wrote = true),
      mkdirImpl: async () => {},
    }),
    /not a JSON object|refusing to overwrite/i,
  );
  assert.equal(wrote, false);
});

test('registerHook surfaces a real read error (non-ENOENT) instead of clobbering', async () => {
  let wrote = false;
  await assert.rejects(
    registerHook(CWD, {
      readFileImpl: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      writeFileImpl: async () => void (wrote = true),
      mkdirImpl: async () => {},
    }),
    /EACCES/,
  );
  assert.equal(wrote, false);
});

// --- runInstall: the full flow ----------------------------------------------

test('runInstall: happy path → auth + hook + backfill, exit 0', async () => {
  let backfillCwd: string | undefined;
  const res = await runInstall(
    opts(),
    deps({
      runBackfillImpl: async (input) => {
        backfillCwd = input.cwd;
        return { found: 3, captured: 2, decisions: 5, results: [], text: 'seeded' };
      },
    }),
  );
  assert.equal(res.exitCode, 0);
  assert.equal(res.authed, true);
  assert.equal(res.hookRegistered, true);
  assert.equal(res.backfill!.decisions, 5);
  assert.equal(backfillCwd, CWD); // backfill scoped to the install cwd
});

test('runInstall prints the trust copy before doing anything', async () => {
  const logs: string[] = [];
  await runInstall(opts({ log: (m) => logs.push(m) }), deps());
  const joined = logs.join('\n').toLowerCase();
  assert.match(joined, /never leave your machine/i);
  // Trust copy comes before the backfill step marker.
  const trustIdx = joined.indexOf('never leave your machine');
  const backfillIdx = joined.indexOf('[3/3]');
  assert.ok(trustIdx >= 0 && trustIdx < backfillIdx);
});

test('runInstall: ensureAuth never reaching the real browser (injected) + never throws', async () => {
  let ensureCalls = 0;
  const res = await runInstall(
    opts(),
    deps({
      ensureAuthImpl: async () => ((ensureCalls += 1), AUTHED),
    }),
  );
  assert.equal(ensureCalls, 1);
  assert.equal(res.authed, true);
});

test('runInstall: auth failure → exit 1, backfill skipped, but does not throw', async () => {
  let backfillCalls = 0;
  const res = await runInstall(
    opts(),
    deps({
      ensureAuthImpl: async () => {
        throw new Error('login declined');
      },
      runBackfillImpl: async () => ((backfillCalls += 1), emptyBackfill()),
    }),
  );
  assert.equal(res.exitCode, 1);
  assert.equal(res.authed, false);
  assert.equal(backfillCalls, 0); // no token → backfill skipped
});

test('runInstall --skip-auth + already authed → exit 0, runs backfill', async () => {
  let backfillCalls = 0;
  const res = await runInstall(
    opts({ skipAuth: true }),
    deps({
      readConfigImpl: async () => AUTHED,
      ensureAuthImpl: async () => {
        throw new Error('should not be called');
      },
      runBackfillImpl: async () => ((backfillCalls += 1), emptyBackfill()),
    }),
  );
  assert.equal(res.exitCode, 0);
  assert.equal(backfillCalls, 1);
});

test('runInstall --skip-hook → does not write settings.json (plugin path)', async () => {
  let wrote = false;
  const res = await runInstall(
    opts({ skipHook: true }),
    deps({ writeFileImpl: async () => void (wrote = true) }),
  );
  assert.equal(res.hookRegistered, false);
  assert.equal(wrote, false);
});

test('runInstall --skip-backfill → does not run backfill', async () => {
  let backfillCalls = 0;
  const res = await runInstall(
    opts({ skipBackfill: true }),
    deps({ runBackfillImpl: async () => ((backfillCalls += 1), emptyBackfill()) }),
  );
  assert.equal(backfillCalls, 0);
  assert.equal(res.backfill, null);
  assert.equal(res.exitCode, 0);
});

test('runInstall: a backfill that throws is swallowed (install still succeeds)', async () => {
  const res = await runInstall(
    opts(),
    deps({
      runBackfillImpl: async () => {
        throw new Error('backfill boom');
      },
    }),
  );
  assert.equal(res.exitCode, 0); // best-effort — backfill never fails install
  assert.equal(res.authed, true);
});

test('runInstall: a hook-write failure is reported but does not fail install', async () => {
  const res = await runInstall(
    opts(),
    deps({
      writeFileImpl: async () => {
        throw new Error('EROFS');
      },
    }),
  );
  // auth ok + backfill ok → exit 0 even though the hook write failed.
  assert.equal(res.exitCode, 0);
  assert.equal(res.hookRegistered, false);
});

test('runInstall: a corrupt settings.json is reported (no clobber) but install still succeeds', async () => {
  let wrote = false;
  const res = await runInstall(
    opts(),
    deps({
      readFileImpl: async () => '{ broken json', // present but unparseable
      writeFileImpl: async () => void (wrote = true),
    }),
  );
  assert.equal(wrote, false); // the corrupt file was NOT overwritten
  assert.equal(res.hookRegistered, false);
  assert.equal(res.exitCode, 0); // auth + backfill ok → install does not fail on this
});
