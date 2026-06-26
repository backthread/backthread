// geminiExtension.test.ts — regression guards for the Gemini CLI extension (ARP-504).
//
// The extension lives at repo-root extensions/gemini/ (a distribution artifact, not
// part of the npm package). It bundles the backthread MCP server + a SessionEnd
// capture hook, both invoking the published CLI via npx (spike ARP-481's recommended
// shape for non-CC agents — no bundled-binary pattern, so no 1.1MB duplication).
// These pin the load-bearing shapes so a future edit can't silently break the
// one-command install. Pure file reads; paths resolved from this file's location.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // cli/src
const repoRoot = join(here, '..', '..'); // backthread (repo root)
const extDir = join(repoRoot, 'extensions', 'gemini');

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('gemini-extension.json declares the backthread MCP server via npx', () => {
  const manifest = readJson(join(extDir, 'gemini-extension.json'));
  assert.equal(manifest.name, 'backthread');
  assert.equal(manifest.contextFileName, 'GEMINI.md');
  const server = manifest.mcpServers?.backthread;
  assert.ok(server, 'manifest declares the backthread MCP server');
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', 'backthread', 'mcp']);
});

test('the extension version is in lockstep with the npm package version', () => {
  const manifest = readJson(join(extDir, 'gemini-extension.json'));
  const pkg = readJson(join(here, '..', 'package.json'));
  assert.equal(
    manifest.version,
    pkg.version,
    `gemini-extension.json version (${manifest.version}) must equal package.json version (${pkg.version})`,
  );
});

test('the SessionEnd hook captures via the shared --from-hook entrypoint, detached', () => {
  const hooks = readJson(join(extDir, 'hooks', 'hooks.json'));
  const entry = hooks.hooks.SessionEnd[0].hooks[0];
  assert.equal(entry.type, 'command');
  const cmd: string = entry.command;
  assert.ok(cmd.includes('backthread@latest capture --from-hook'), 'routes through the shared --from-hook entrypoint, self-updating (ARP-739)');
  assert.ok(cmd.includes('--agent gemini-cli'), 'selects the gemini-cli payload shape');
  // Gemini SessionEnd is best-effort (CLI does not await the hook) → must detach.
  assert.ok(cmd.includes('--detach'), 'detaches so the capture survives the CLI exiting');
});

test('the extension ships a GEMINI.md context file', () => {
  assert.ok(existsSync(join(extDir, 'GEMINI.md')), 'GEMINI.md context file is present');
});
