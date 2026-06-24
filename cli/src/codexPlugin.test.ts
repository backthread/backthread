// codexPlugin.test.ts — regression guards for the Codex plugin (ARP-505).
//
// The plugin lives at repo-root extensions/codex/ (a distribution artifact, not part
// of the npm package). It bundles the backthread MCP server (.mcp.json) + a Stop
// capture hook (hooks/hooks.json), both invoking the published CLI via npx — the
// 8A.8 spike's shape for non-CC agents. These pin the load-bearing shapes; the exact
// Codex marketplace discovery + ack semantics are confirmed on a live install
// (spike-flavored — see the README). Pure file reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // cli/src
const repoRoot = join(here, '..', '..'); // backthread
const pluginDir = join(repoRoot, 'extensions', 'codex', 'plugins', 'backthread');

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('plugin.json points to the bundled .mcp.json + hooks', () => {
  const plugin = readJson(join(pluginDir, 'plugin.json'));
  assert.equal(plugin.name, 'backthread');
  assert.equal(plugin.mcpServers, './.mcp.json');
  assert.equal(plugin.hooks, './hooks/hooks.json');
});

test('plugin version is in lockstep with the npm package version', () => {
  const plugin = readJson(join(pluginDir, 'plugin.json'));
  const pkg = readJson(join(here, '..', 'package.json'));
  assert.equal(plugin.version, pkg.version, `plugin (${plugin.version}) must equal package (${pkg.version})`);
});

test('.mcp.json declares the backthread MCP server via npx (direct server map)', () => {
  const mcp = readJson(join(pluginDir, '.mcp.json'));
  const server = mcp.backthread;
  assert.ok(server, '.mcp.json has a backthread server (direct map)');
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', 'backthread', 'mcp']);
});

test('the Stop hook captures via --from-hook --agent codex, detached', () => {
  const hooks = readJson(join(pluginDir, 'hooks', 'hooks.json'));
  const entry = hooks.hooks.Stop[0].hooks[0];
  assert.equal(entry.type, 'command');
  const cmd: string = entry.command;
  assert.ok(cmd.includes('backthread capture --from-hook'), 'routes through the shared entrypoint');
  // --agent codex is load-bearing: it emits the JSON-on-stdout ack Codex requires.
  assert.ok(cmd.includes('--agent codex'), 'selects the codex payload shape + stdout ack');
  // --detach prints the ack + returns instantly so the per-turn Stop never adds latency.
  assert.ok(cmd.includes('--detach'), 'detaches so a turn is not blocked by capture');
});

test('marketplace.json lists the local backthread plugin', () => {
  const market = readJson(join(repoRoot, 'extensions', 'codex', 'marketplace.json'));
  assert.equal(market.name, 'backthread');
  assert.ok(Array.isArray(market.plugins) && market.plugins.length === 1);
  const entry = market.plugins[0];
  assert.equal(entry.name, 'backthread');
  assert.equal(entry.source?.path, './plugins/backthread');
});
