// plugin.test.ts — regression guards for the Claude Code plugin packaging (ARP-477).
//
// These pin the load-bearing invariants of the "single install" CC plugin so a future
// edit can't silently break a marketplace-installed plugin:
//   1. the SessionEnd hook + MCP server run the BUNDLED bin via ${CLAUDE_PLUGIN_ROOT}
//      (NOT `npx backthread`, the stale-resolution bug ARP-680 diagnosed),
//   2. the plugin `version` stays in lockstep with the npm package version,
//   3. the self-contained bundle is COMMITTED (CC runs no build step on install),
//   4. the repo-root marketplace.json points at the ./cli plugin.
//
// Pure file reads — no network, no live CC. Paths are resolved from this file's
// location so the test is cwd-independent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // cli/src
const cliRoot = join(here, '..'); // cli
const repoRoot = join(cliRoot, '..'); // backthread (repo root)

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const BUNDLE_REF = '${CLAUDE_PLUGIN_ROOT}/dist-bundle/backthread.js';

test('plugin.json registers the MCP server from the bundled bin via ${CLAUDE_PLUGIN_ROOT}', () => {
  const plugin = readJson(join(cliRoot, '.claude-plugin', 'plugin.json'));
  assert.equal(plugin.name, 'backthread');
  // The manifest must NOT reference hooks/hooks.json: CC auto-loads the standard
  // hooks/hooks.json, so an explicit `hooks` key double-registers it and the loader
  // rejects the whole block ("Duplicate hooks file detected") — which silently kills
  // the SessionEnd capture hook. The hook content itself is validated against
  // hooks/hooks.json by the dedicated test below.
  assert.ok(!('hooks' in plugin), 'manifest must omit `hooks` — CC auto-loads hooks/hooks.json; an explicit ref is a duplicate-load error');
  const server = plugin.mcpServers?.backthread;
  assert.ok(server, 'plugin.json declares the backthread MCP server inline');
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, [BUNDLE_REF, 'mcp']);
});

test('plugin.json version is in lockstep with the npm package version', () => {
  const plugin = readJson(join(cliRoot, '.claude-plugin', 'plugin.json'));
  const pkg = readJson(join(cliRoot, 'package.json'));
  assert.equal(
    plugin.version,
    pkg.version,
    `plugin.json version (${plugin.version}) must equal package.json version (${pkg.version}) — they ship as one artifact`,
  );
});

test('the SessionEnd hook runs the bundled bin, not npx, and detaches', () => {
  const hooks = readJson(join(cliRoot, 'hooks', 'hooks.json'));
  const cmd: string = hooks.hooks.SessionEnd[0].hooks[0].command;
  assert.ok(cmd.includes(BUNDLE_REF), 'hook invokes the bundled bin via ${CLAUDE_PLUGIN_ROOT}');
  assert.ok(!/\bnpx\b/.test(cmd), 'hook must NOT use npx (stale-resolution bug ARP-680)');
  assert.ok(cmd.includes('capture --from-hook'), 'hook routes through the shared --from-hook entrypoint');
  assert.ok(cmd.includes('--agent claude-code'), 'hook selects the claude-code payload shape');
  assert.ok(cmd.includes('--detach'), 'hook detaches so a slow capture is not SIGTERMd (ARP-682)');
});

test('the manifest registers SessionStart + SessionEnd only (Stop fires per-turn — intentionally absent)', () => {
  const hooks = readJson(join(cliRoot, 'hooks', 'hooks.json'));
  // ARP-763 added SessionStart (ambient routing); Stop stays out (would capture
  // every turn). Order doesn't matter to CC, so compare as a set.
  assert.deepEqual([...Object.keys(hooks.hooks)].sort(), ['SessionEnd', 'SessionStart']);
});

test('the SessionStart routing hook runs the bundled bin SYNCHRONOUSLY (ARP-763)', () => {
  const hooks = readJson(join(cliRoot, 'hooks', 'hooks.json'));
  const cmd: string = hooks.hooks.SessionStart[0].hooks[0].command;
  assert.ok(cmd.includes(BUNDLE_REF), 'hook invokes the bundled bin via ${CLAUDE_PLUGIN_ROOT}');
  assert.ok(!/\bnpx\b/.test(cmd), 'hook must NOT use npx (a sync session-start would block on the resolve)');
  assert.ok(cmd.includes('session-start'), 'hook routes through the session-start command');
  assert.ok(cmd.includes('--agent claude-code'), 'hook stamps the claude-code provider');
  assert.ok(!cmd.includes('--detach'), 'SessionStart must NOT detach — CC reads stdout for the additionalContext');
});

test('slash commands prefer the bundled bin (npx only as a fallback)', () => {
  for (const name of ['capture.md', 'start.md', 'how.md', 'blindspots.md']) {
    const md = readFileSync(join(cliRoot, 'commands', name), 'utf8');
    assert.ok(md.includes(BUNDLE_REF), `${name} references the bundled bin via \${CLAUDE_PLUGIN_ROOT}`);
    // npx is allowed ONLY as the else-branch fallback, never the sole invocation.
    assert.ok(md.includes('else npx backthread'), `${name} keeps an npx fallback`);
  }
});

test('/backthread:how invokes the `how` subcommand and disables model invocation', () => {
  const md = readFileSync(join(cliRoot, 'commands', 'how.md'), 'utf8');
  assert.match(md, /node "\$BT" how --cwd/, 'how.md runs the deterministic `how` subcommand');
  assert.match(md, /disable-model-invocation:\s*true/, 'how.md is user-typed (model routes via the query tool instead)');
});

test('/backthread:blindspots routes a blindspot-framed question through the `how` subcommand (ARP-1009)', () => {
  const md = readFileSync(join(cliRoot, 'commands', 'blindspots.md'), 'utf8');
  assert.match(md, /node "\$BT" how --cwd/, 'blindspots.md reuses the deterministic `how` subcommand');
  assert.match(md, /What am I missing about \$ARGUMENTS/, 'the area is framed as a blindspot question');
  assert.match(md, /blindspot pass/i, "Thariq's vocabulary rides in the framed question");
  assert.match(md, /disable-model-invocation:\s*true/, 'blindspots.md is user-typed');
});

test('the self-contained bundle is committed and is a node script', () => {
  const bundlePath = join(cliRoot, 'dist-bundle', 'backthread.js');
  assert.ok(existsSync(bundlePath), 'dist-bundle/backthread.js must be committed (no build step on install)');
  const firstLine = readFileSync(bundlePath, 'utf8').split('\n', 1)[0];
  assert.match(firstLine, /^#!.*node/, 'bundle starts with a node shebang');
});

test('repo-root marketplace.json lists the ./cli plugin', () => {
  const market = readJson(join(repoRoot, '.claude-plugin', 'marketplace.json'));
  assert.equal(market.name, 'backthread');
  assert.ok(market.owner?.name, 'marketplace declares an owner');
  assert.ok(Array.isArray(market.plugins) && market.plugins.length === 1);
  const entry = market.plugins[0];
  assert.equal(entry.name, 'backthread');
  assert.equal(entry.source, './cli', 'plugin source points at the cli subdirectory');
});
