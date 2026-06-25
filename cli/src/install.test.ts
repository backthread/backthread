import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOOK_COMMAND,
  TRUST_COPY,
  mergeSessionEndHook,
  registerHook,
  runInstall,
  stripSessionEndHook,
  unregisterProjectHook,
  type InstallDeps,
  type InstallOptions,
} from './install.js';
import type { BackthreadConfig } from './config.js';
import type { BackfillSummary } from './backfill.js';

// Everything mocked: NO real network / browser / disk / capture. ensureAuth is
// always injected so the real browser/login path is NEVER reached.

const ENV = {} as NodeJS.ProcessEnv;
const CWD = '/work/app';
const HOME = '/home/dev';
const AUTHED: BackthreadConfig = { account: 'acc-1', device_token: 'backthread_pat_x' };

function emptyBackfill(): BackfillSummary {
  return { found: 0, captured: 0, decisions: 0, results: [], text: 'none' };
}

function deps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    home: HOME,
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

test('mergeSessionEndHook MIGRATES a retired (bare) command in place — never duplicates', () => {
  // This is the upgrade path: a pre-ARP-682 install has the bare inline command. Re-running
  // install must rewrite it to the completion-safe HOOK_COMMAND, not append a second hook
  // (two hooks → double capture).
  assert.notEqual(HOOK_COMMAND, 'npx backthread capture'); // guard: the test must be meaningful
  const existing = {
    hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'npx backthread capture' }] }] },
  };
  const out = mergeSessionEndHook(existing)!;
  const se = (out.hooks as any).SessionEnd;
  assert.equal(se.length, 1); // upgraded in place, NOT appended
  assert.equal(se[0].hooks[0].command, HOOK_COMMAND);
  // Input never mutated.
  assert.equal((existing.hooks as any).SessionEnd[0].hooks[0].command, 'npx backthread capture');
});

test('mergeSessionEndHook keeps a foreign hook while migrating the retired command', () => {
  const existing = {
    hooks: {
      SessionEnd: [
        { hooks: [{ type: 'command', command: 'other-tool' }] },
        { hooks: [{ type: 'command', command: 'npx backthread capture' }] },
      ],
    },
  };
  const out = mergeSessionEndHook(existing)!;
  const se = (out.hooks as any).SessionEnd;
  assert.equal(se.length, 2); // no new group appended
  assert.equal(se[0].hooks[0].command, 'other-tool'); // foreign kept
  assert.equal(se[1].hooks[0].command, HOOK_COMMAND); // migrated in place
});

// --- registerHook (I/O seams) -----------------------------------------------

test('registerHook writes merged settings to the USER-GLOBAL ~/.claude/settings.json', async () => {
  let written: { path: string; data: string } | null = null;
  let mkdirDir: string | null = null;
  const res = await registerHook({ home: HOME,
    readFileImpl: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    mkdirImpl: async (d) => void (mkdirDir = d),
    writeFileImpl: async (p, d) => void (written = { path: p, data: d }),
  });
  assert.equal(res.wrote, true);
  // USER scope (ARP-680), NOT the project /work/app/.claude — survives worktrees.
  assert.equal(res.path, '/home/dev/.claude/settings.json');
  assert.equal(mkdirDir, '/home/dev/.claude');
  // Assert on the parsed JSON's command field directly (not a substring of the
  // serialized blob) so the assertion can't match the command appearing elsewhere.
  const parsed = JSON.parse(written!.data);
  assert.equal(parsed.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
  assert.equal(parsed.hooks.SessionEnd[0].hooks[0].type, 'command');
});

test('registerHook is a no-op (no write) when already present', async () => {
  let wrote = false;
  const res = await registerHook({ home: HOME,
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
  await registerHook({ home: HOME,
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
    registerHook({ home: HOME,
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
    registerHook({ home: HOME,
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
    registerHook({ home: HOME,
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

// --- stripSessionEndHook (pure) — the project→user migration (ARP-689) -------

test('stripSessionEndHook returns null when nothing of ours is present', () => {
  assert.equal(stripSessionEndHook({}), null);
  assert.equal(stripSessionEndHook({ hooks: {} }), null);
  assert.equal(stripSessionEndHook({ hooks: { SessionEnd: [] } }), null);
  assert.equal(
    stripSessionEndHook({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] } }),
    null,
  );
});

test('stripSessionEndHook removes our hook + prunes the emptied SessionEnd/hooks', () => {
  const existing = { model: 'opus', hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } };
  const out = stripSessionEndHook(existing)!;
  assert.ok(out);
  assert.equal(out.model, 'opus'); // other keys preserved
  assert.equal(out.hooks, undefined); // emptied hooks object pruned
  // Input never mutated.
  assert.equal((existing.hooks as any).SessionEnd.length, 1);
});

test('stripSessionEndHook strips the RETIRED bare command too (npx backthread capture)', () => {
  const existing = { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'npx backthread capture' }] }] } };
  const out = stripSessionEndHook(existing)!;
  assert.equal(out.hooks, undefined);
});

test('stripSessionEndHook keeps foreign hooks + other events while removing ours', () => {
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }],
      SessionEnd: [
        { hooks: [{ type: 'command', command: 'other-tool' }] },
        { hooks: [{ type: 'command', command: HOOK_COMMAND }] },
      ],
    },
  };
  const out = stripSessionEndHook(existing)!;
  const se = (out.hooks as any).SessionEnd;
  assert.equal(se.length, 1); // ours dropped, foreign group kept
  assert.equal(se[0].hooks[0].command, 'other-tool');
  assert.deepEqual((out.hooks as any).PreToolUse, existing.hooks.PreToolUse); // other event untouched
});

test('stripSessionEndHook removes ours from a MIXED group, keeping the foreign hook in it', () => {
  const existing = {
    hooks: {
      SessionEnd: [
        { hooks: [
          { type: 'command', command: 'other-tool' },
          { type: 'command', command: HOOK_COMMAND },
        ] },
      ],
    },
  };
  const out = stripSessionEndHook(existing)!;
  const se = (out.hooks as any).SessionEnd;
  assert.equal(se.length, 1);
  assert.equal(se[0].hooks.length, 1); // only the foreign hook remains in the group
  assert.equal(se[0].hooks[0].command, 'other-tool');
});

// --- unregisterProjectHook (I/O seams) ---------------------------------------

test('unregisterProjectHook: missing project file → no-op (no write)', async () => {
  let wrote = false;
  const res = await unregisterProjectHook('/work/app', {
    readFileImpl: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    writeFileImpl: async () => void (wrote = true),
  });
  assert.equal(res.stripped, false);
  assert.equal(res.path, '/work/app/.claude/settings.json'); // PROJECT scope, not user
  assert.equal(wrote, false);
});

test('unregisterProjectHook: strips our hook from the project settings.json, preserving foreign keys', async () => {
  let data = '';
  const res = await unregisterProjectHook('/work/app', {
    readFileImpl: async () =>
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] },
      }),
    writeFileImpl: async (_p, d) => void (data = d),
  });
  assert.equal(res.stripped, true);
  const parsed = JSON.parse(data);
  assert.deepEqual(parsed.permissions, { allow: ['Bash'] }); // foreign key preserved
  assert.equal(parsed.hooks, undefined); // our hook removed + pruned
});

test('unregisterProjectHook: no write when nothing of ours is present (idempotent re-run)', async () => {
  let wrote = false;
  const res = await unregisterProjectHook('/work/app', {
    readFileImpl: async () =>
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] } }),
    writeFileImpl: async () => void (wrote = true),
  });
  assert.equal(res.stripped, false);
  assert.equal(wrote, false);
});

test('unregisterProjectHook: REFUSES to modify a corrupt project settings.json (no clobber)', async () => {
  let wrote = false;
  await assert.rejects(
    unregisterProjectHook('/work/app', {
      readFileImpl: async () => '{ broken json',
      writeFileImpl: async () => void (wrote = true),
    }),
    /not valid JSON|refusing to modify/i,
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

test('runInstall: migrates a stale PROJECT-scope hook to user scope (ARP-689)', async () => {
  const userPath = '/home/dev/.claude/settings.json';
  const projPath = '/work/app/.claude/settings.json';
  const writes: Record<string, string> = {};
  const res = await runInstall(
    opts(),
    deps({
      readFileImpl: async (p) => {
        // Project file carries the OLD bare command; the user-global file doesn't exist yet.
        if (p === projPath)
          return JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'npx backthread capture' }] }] } });
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      writeFileImpl: async (p, d) => void (writes[p] = d),
    }),
  );
  assert.equal(res.projectHookMigrated, true);
  // The user-global hook is registered…
  assert.equal(JSON.parse(writes[userPath]).hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
  // …and the stale project hook is stripped (so CC no longer double-fires).
  assert.equal(JSON.parse(writes[projPath]).hooks, undefined);
});

test('runInstall: no project file → no migration (projectHookMigrated false)', async () => {
  const res = await runInstall(opts(), deps());
  assert.equal(res.projectHookMigrated, false);
});

test('runInstall: a corrupt USER settings.json does NOT strip the working project hook (gated on hookRegistered)', async () => {
  const userPath = '/home/dev/.claude/settings.json';
  const projPath = '/work/app/.claude/settings.json';
  const writes: Record<string, string> = {};
  const res = await runInstall(
    opts(),
    deps({
      readFileImpl: async (p) => {
        if (p === userPath) return '{ broken json'; // user-global registration will throw
        if (p === projPath)
          return JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'npx backthread capture' }] }] } });
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      writeFileImpl: async (p, d) => void (writes[p] = d),
    }),
  );
  assert.equal(res.hookRegistered, false); // user-global registration failed (corrupt)
  assert.equal(res.projectHookMigrated, false); // …so we did NOT strip the still-working project hook
  assert.equal(writes[projPath], undefined); // project file untouched → repo keeps capturing
  assert.equal(res.exitCode, 0);
});

test('runInstall: a corrupt PROJECT settings.json is reported (no clobber) but install still succeeds', async () => {
  const userPath = '/home/dev/.claude/settings.json';
  const projPath = '/work/app/.claude/settings.json';
  const writes: Record<string, string> = {};
  const res = await runInstall(
    opts(),
    deps({
      readFileImpl: async (p) => {
        if (p === projPath) return '{ broken json'; // present but unparseable
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      writeFileImpl: async (p, d) => void (writes[p] = d),
    }),
  );
  assert.equal(res.exitCode, 0); // migration failure never fails the install
  assert.equal(res.projectHookMigrated, false);
  assert.equal(writes[projPath], undefined); // the corrupt project file was NOT overwritten
  // The user-global hook still got registered (migration is independent of it).
  assert.equal(JSON.parse(writes[userPath]).hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
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

// --- runInstall --agent (per-agent writer path) ------------------------------

test('runInstall --agent gemini → per-agent writer, NO CC settings.json / backfill', async () => {
  let agentArg: string | undefined;
  let backfillCalls = 0;
  let ccWrote = false;
  const res = await runInstall(
    opts({ agent: 'gemini' }),
    deps({
      runInstallAgentImpl: async (a) => {
        agentArg = a;
        return { agent: a, writes: [{ path: '/home/dev/.gemini/settings.json', wrote: true }], versionWarning: null, deeplink: null };
      },
      runBackfillImpl: async () => ((backfillCalls += 1), emptyBackfill()),
      // The CC settings.json writer must NEVER be reached on the --agent path.
      writeFileImpl: async () => void (ccWrote = true),
    }),
  );
  assert.equal(agentArg, 'gemini');
  assert.equal(res.agentResult!.agent, 'gemini');
  assert.equal(res.backfill, null);
  assert.equal(backfillCalls, 0);
  assert.equal(ccWrote, false);
  assert.equal(res.exitCode, 0);
});

test('runInstall --agent: writes the config even when auth fails (armed), exit 1', async () => {
  let agentCalls = 0;
  const res = await runInstall(
    opts({ agent: 'cursor' }),
    deps({
      ensureAuthImpl: async () => {
        throw new Error('login declined');
      },
      runInstallAgentImpl: async (a) => {
        agentCalls += 1;
        return { agent: a, writes: [{ path: '/home/dev/.cursor/mcp.json', wrote: true }], versionWarning: null, deeplink: 'cursor://x' };
      },
    }),
  );
  assert.equal(agentCalls, 1); // config still written (armed for the next `backthread login`)
  assert.equal(res.authed, false);
  assert.equal(res.exitCode, 1);
  assert.equal(res.agentResult!.deeplink, 'cursor://x');
});

test('runInstall --agent: a writer throw (corrupt config) is reported, install does not crash', async () => {
  const res = await runInstall(
    opts({ agent: 'codex' }),
    deps({
      runInstallAgentImpl: async () => {
        throw new Error('config.toml is not valid');
      },
    }),
  );
  assert.equal(res.exitCode, 0); // auth ok → install succeeds; the write problem is reported
  assert.equal(res.agentResult, null);
});
