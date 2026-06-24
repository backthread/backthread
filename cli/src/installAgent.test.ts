// installAgent.test.ts — the per-agent (codex/cursor/gemini) install writers (ARP-503).
//
// All disk is mocked (a tiny in-memory fs) — no real ~/.codex / ~/.cursor / ~/.gemini
// is touched. Each writer is exercised for: the correct USER-GLOBAL path, the right
// MCP + hook shape, idempotence (re-run = no write), preserving foreign content, the
// corrupt-config refusal, and the version gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runInstallAgent,
  parseInstallAgent,
  hookCommand,
  cursorDeeplink,
  type AgentInstallDeps,
} from './installAgent.js';

const HOME = '/home/dev';

function fakeFs(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial };
  const deps: AgentInstallDeps = {
    readFileImpl: async (p: string) => {
      if (p in files) return files[p];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    writeFileImpl: async (p: string, d: string) => void (files[p] = d),
    mkdirImpl: async () => {},
  };
  return { files, deps };
}

const noProbe = async () => null;

// --- parse + helpers ---------------------------------------------------------

test('parseInstallAgent maps aliases + rejects unknown', () => {
  assert.equal(parseInstallAgent('codex'), 'codex');
  assert.equal(parseInstallAgent('cursor'), 'cursor');
  assert.equal(parseInstallAgent('gemini'), 'gemini');
  assert.equal(parseInstallAgent('gemini-cli'), 'gemini');
  assert.equal(parseInstallAgent('claude-code'), 'claude-code');
  assert.equal(parseInstallAgent('cc'), 'claude-code');
  assert.equal(parseInstallAgent('vim'), null);
  assert.equal(parseInstallAgent(undefined), null);
});

test('hookCommand routes through the shared --from-hook entrypoint, detached', () => {
  assert.equal(hookCommand('codex'), 'npx -y backthread capture --from-hook --agent codex --detach');
  assert.equal(hookCommand('gemini-cli'), 'npx -y backthread capture --from-hook --agent gemini-cli --detach');
});

test('cursorDeeplink encodes the MCP server config', () => {
  const link = cursorDeeplink();
  assert.match(link, /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=backthread&config=/);
  const b64 = link.split('config=')[1];
  const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  assert.equal(decoded.command, 'npx');
  assert.deepEqual(decoded.args, ['-y', 'backthread', 'mcp']);
});

// --- Gemini ------------------------------------------------------------------

test('gemini: writes mcpServers + SessionEnd hook to ~/.gemini/settings.json, then idempotent', async () => {
  const path = '/home/dev/.gemini/settings.json';
  const fs1 = fakeFs();
  const r1 = await runInstallAgent('gemini', { home: HOME, ...fs1.deps, probeVersionImpl: noProbe });
  assert.equal(r1.writes[0].path, path);
  assert.equal(r1.writes[0].wrote, true);
  const s = JSON.parse(fs1.files[path]);
  assert.equal(s.mcpServers.backthread.command, 'npx');
  assert.deepEqual(s.mcpServers.backthread.args, ['-y', 'backthread', 'mcp']);
  assert.match(s.hooks.SessionEnd[0].hooks[0].command, /--from-hook --agent gemini-cli --detach/);

  const fs2 = fakeFs({ [path]: fs1.files[path] });
  const r2 = await runInstallAgent('gemini', { home: HOME, ...fs2.deps, probeVersionImpl: noProbe });
  assert.equal(r2.writes[0].wrote, false); // re-run is a no-op
});

test('gemini: preserves the user’s existing settings + foreign hooks', async () => {
  const path = '/home/dev/.gemini/settings.json';
  const fs1 = fakeFs({
    [path]: JSON.stringify({
      theme: 'dark',
      mcpServers: { other: { command: 'x' } },
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'their-tool' }] }] },
    }),
  });
  await runInstallAgent('gemini', { home: HOME, ...fs1.deps, probeVersionImpl: noProbe });
  const s = JSON.parse(fs1.files[path]);
  assert.equal(s.theme, 'dark'); // untouched
  assert.equal(s.mcpServers.other.command, 'x'); // other server kept
  assert.equal(s.mcpServers.backthread.command, 'npx'); // ours added
  assert.equal(s.hooks.SessionEnd.length, 2); // foreign hook kept, ours appended
  assert.equal(s.hooks.SessionEnd[0].hooks[0].command, 'their-tool');
});

// --- Codex -------------------------------------------------------------------

test('codex: appends [mcp_servers.backthread] to config.toml + writes the Stop hook; idempotent', async () => {
  const toml = '/home/dev/.codex/config.toml';
  const hooks = '/home/dev/.codex/hooks.json';
  const fs1 = fakeFs();
  await runInstallAgent('codex', { home: HOME, ...fs1.deps, probeVersionImpl: noProbe });
  assert.match(fs1.files[toml], /\[mcp_servers\.backthread\]/);
  assert.match(fs1.files[toml], /command = "npx"/);
  assert.match(fs1.files[toml], /args = \["-y", "backthread", "mcp"\]/);
  const hj = JSON.parse(fs1.files[hooks]);
  assert.match(hj.hooks.Stop[0].hooks[0].command, /--from-hook --agent codex --detach/);
  assert.equal(hj.hooks.Stop[0].hooks[0].timeout, 60);

  const fs2 = fakeFs({ [toml]: fs1.files[toml], [hooks]: fs1.files[hooks] });
  const r2 = await runInstallAgent('codex', { home: HOME, ...fs2.deps, probeVersionImpl: noProbe });
  assert.ok(r2.writes.every((w) => !w.wrote)); // both no-op on re-run
});

test('codex: preserves existing config.toml content when appending the MCP table', async () => {
  const toml = '/home/dev/.codex/config.toml';
  const fs1 = fakeFs({ [toml]: 'model = "o3"\n\n[some.other]\nkey = 1\n' });
  await runInstallAgent('codex', { home: HOME, ...fs1.deps, probeVersionImpl: noProbe });
  assert.match(fs1.files[toml], /model = "o3"/); // root key kept
  assert.match(fs1.files[toml], /\[some\.other\]/); // foreign table kept
  assert.match(fs1.files[toml], /\[mcp_servers\.backthread\]/); // ours appended at the end
  // Our table is appended LAST (a trailing table is TOML-append-safe).
  assert.ok(fs1.files[toml].indexOf('[some.other]') < fs1.files[toml].indexOf('[mcp_servers.backthread]'));
});

// --- Cursor ------------------------------------------------------------------

test('cursor: writes mcp.json + hooks.json (stop, version 1) + returns a deeplink', async () => {
  const fs1 = fakeFs();
  const r = await runInstallAgent('cursor', { home: HOME, ...fs1.deps, probeVersionImpl: noProbe });
  const mcp = JSON.parse(fs1.files['/home/dev/.cursor/mcp.json']);
  assert.equal(mcp.mcpServers.backthread.command, 'npx');
  const hj = JSON.parse(fs1.files['/home/dev/.cursor/hooks.json']);
  assert.equal(hj.version, 1);
  assert.match(hj.hooks.stop[0].command, /--from-hook --agent cursor --detach/);
  assert.match(r.deeplink ?? '', /^cursor:\/\//);
});

test('cursor: preserves an existing hooks.json version (no downgrade)', async () => {
  const path = '/home/dev/.cursor/hooks.json';
  const fs1 = fakeFs({ [path]: JSON.stringify({ version: 2, hooks: { stop: [{ command: hookCommand('cursor') }] } }) });
  const r = await runInstallAgent('cursor', { home: HOME, ...fs1.deps, probeVersionImpl: noProbe });
  const hookWrite = r.writes.find((w) => w.path.endsWith('hooks.json'))!;
  assert.equal(hookWrite.wrote, false); // our hook + a version already present → no-op
  assert.equal(JSON.parse(fs1.files[path]).version, 2); // version untouched (not downgraded to 1)
});

test('cursor: idempotent re-run writes nothing', async () => {
  const fs1 = fakeFs();
  await runInstallAgent('cursor', { home: HOME, ...fs1.deps, probeVersionImpl: noProbe });
  const fs2 = fakeFs({ ...fs1.files });
  const r2 = await runInstallAgent('cursor', { home: HOME, ...fs2.deps, probeVersionImpl: noProbe });
  assert.ok(r2.writes.every((w) => !w.wrote));
});

// --- corrupt config + version gate -------------------------------------------

test('a corrupt existing config THROWS (never clobbered)', async () => {
  const fs1 = fakeFs({ '/home/dev/.gemini/settings.json': '{ not json' });
  await assert.rejects(
    runInstallAgent('gemini', { home: HOME, ...fs1.deps, probeVersionImpl: noProbe }),
    /not valid JSON|refusing/i,
  );
});

test('version gate: warns on a too-old agent, silent on new / undetectable', async () => {
  const old = await runInstallAgent('gemini', { home: HOME, ...fakeFs().deps, probeVersionImpl: async () => '0.10.0' });
  assert.match(old.versionWarning ?? '', /0\.26\.0\+/);

  const ok = await runInstallAgent('gemini', { home: HOME, ...fakeFs().deps, probeVersionImpl: async () => 'gemini 1.2.0' });
  assert.equal(ok.versionWarning, null);

  const none = await runInstallAgent('gemini', { home: HOME, ...fakeFs().deps, probeVersionImpl: noProbe });
  assert.equal(none.versionWarning, null);
});
