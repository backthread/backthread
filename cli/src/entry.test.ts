import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectEntry,
  isInsideClaudeCode,
  captureGuidance,
  PLUGIN_INSTALL,
  PLUGIN_MARKETPLACE,
} from './entry.js';

// --- detectEntry: claim ⇒ web, else terminal ---------------------------------

test('detectEntry: a claim code ⇒ web-initiated', () => {
  assert.equal(detectEntry({ claim: 'backthread_claim_abc' }), 'web');
});

test('detectEntry: no claim ⇒ terminal-first', () => {
  assert.equal(detectEntry({}), 'terminal');
  assert.equal(detectEntry(), 'terminal');
});

test('detectEntry: an empty/whitespace claim is not a web signal', () => {
  assert.equal(detectEntry({ claim: '' }), 'terminal');
  assert.equal(detectEntry({ claim: '   ' }), 'terminal');
});

// --- isInsideClaudeCode: CLAUDECODE=1 ----------------------------------------

test('isInsideClaudeCode: true only when CLAUDECODE === "1"', () => {
  assert.equal(isInsideClaudeCode({ CLAUDECODE: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(isInsideClaudeCode({} as NodeJS.ProcessEnv), false);
  assert.equal(isInsideClaudeCode({ CLAUDECODE: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(isInsideClaudeCode({ CLAUDECODE: 'true' } as NodeJS.ProcessEnv), false);
});

// --- captureGuidance: CC ⇒ plugin, else npx install --------------------------

test('captureGuidance inside Claude Code recommends the PLUGIN, never the npx hook', () => {
  const g = captureGuidance({ CLAUDECODE: '1' } as NodeJS.ProcessEnv);
  assert.match(g, new RegExp(`/plugin install ${PLUGIN_INSTALL.replace('@', '@')}`));
  assert.match(g, new RegExp(`/plugin marketplace add ${PLUGIN_MARKETPLACE}`));
  // The CC path must NOT push the stale npx settings.json hook (ARP-680).
  assert.doesNotMatch(g, /npx backthread install/);
  assert.doesNotMatch(g, /settings\.json/);
  // Vocabulary discipline.
  assert.doesNotMatch(g, /architectural memory/i);
});

test('captureGuidance outside Claude Code points at `npx backthread install` (+ --agent)', () => {
  const g = captureGuidance({} as NodeJS.ProcessEnv);
  assert.match(g, /npx backthread install/);
  assert.match(g, /--agent <codex\|cursor\|gemini>/);
  // The bare-terminal path must NOT tell the user to run plugin slash commands.
  assert.doesNotMatch(g, /\/plugin install/);
  assert.doesNotMatch(g, /architectural memory/i);
});
