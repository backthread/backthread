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

test('the manifest registers PreToolUse + SessionStart + SessionEnd + Stop', () => {
  const hooks = readJson(join(cliRoot, 'hooks', 'hooks.json'));
  // PreToolUse (grep-time local context); SessionStart (ambient routing); SessionEnd
  // (session-end backstop); Stop (per-turn capture — the incremental capture watermark
  // makes each fire cheap). Order doesn't matter to CC, so compare as a set.
  // PostToolUse (the in-flow dead-time ask) joined them: it fires AFTER a tool the
  // person waited on, which is the one moment they have nothing to do — and, being a
  // Post hook on a non-editing tool, it is structurally incapable of standing between
  // somebody and a file they are about to change.
  assert.deepEqual(
    [...Object.keys(hooks.hooks)].sort(),
    ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop'],
  );
});

test('the PostToolUse dead-time hook waits on long tools only, runs the bundled bin, never detaches', () => {
  const hooks = readJson(join(cliRoot, 'hooks', 'hooks.json'));
  assert.equal(hooks.hooks.PostToolUse.length, 1, 'exactly one PostToolUse registration');
  const entry = hooks.hooks.PostToolUse[0];
  assert.equal(entry.matcher, 'Bash|Task|WebFetch|WebSearch');
  const cmd: string = entry.hooks[0].command;
  assert.ok(cmd.includes(BUNDLE_REF), 'hook invokes the bundled bin via ${CLAUDE_PLUGIN_ROOT}');
  assert.ok(!/\bnpx\b/.test(cmd), 'hook must NOT use npx (a sync hook would block on the resolve)');
  assert.ok(cmd.includes('inflow-context'), 'hook routes through the inflow-context command');
  assert.ok(cmd.includes('--agent claude-code'), 'hook stamps the claude-code provider');
  assert.ok(!cmd.includes('--detach'), 'PostToolUse must NOT detach — CC reads stdout for the additionalContext');
});

test('the PreToolUse grep hook runs the bundled bin SYNCHRONOUSLY, matches Grep|Glob, never detaches', () => {
  const hooks = readJson(join(cliRoot, 'hooks', 'hooks.json'));
  const entry = hooks.hooks.PreToolUse.find((e: any) => e.matcher === 'Grep|Glob');
  assert.ok(entry, 'the grep-context PreToolUse entry is registered');
  const cmd: string = entry.hooks[0].command;
  assert.ok(cmd.includes(BUNDLE_REF), 'hook invokes the bundled bin via ${CLAUDE_PLUGIN_ROOT}');
  assert.ok(!/\bnpx\b/.test(cmd), 'hook must NOT use npx (a sync grep hook would block every grep on the resolve)');
  assert.ok(cmd.includes('grep-context'), 'hook routes through the grep-context command');
  assert.ok(cmd.includes('--agent claude-code'), 'hook stamps the claude-code provider');
  assert.ok(!cmd.includes('--detach'), 'PreToolUse must NOT detach — CC reads stdout for the additionalContext');
});

test('GUARD: nothing fires before an edit — the pre-edit trigger was removed and must not return', () => {
  // INVERTED on 2026-08-19. This test used to PIN the existence of a PreToolUse hook
  // on `Edit|MultiEdit|Write` — the pre-edit coverage line shipped in 0.17.0. It was
  // removed because it fires at exactly the moment we ruled we would not interrupt
  // anyone, four companies named the interruption as the objection, and ~28 preflight
  // calls produced no observed action. The shipped version was mild — never blocked,
  // short timeout, once per session, silent on everything but a clean `uncovered` —
  // and was rejected anyway: "it never blocks" answers the letter of the ruling and
  // leaves its intent untouched. A test that merely DELETED this case would let the
  // hook come back unnoticed, so the assertion is inverted rather than dropped.
  //
  // The hosted POST /coverage-preflight route deliberately stays live: installed
  // plugin versions keep calling it and fail toward silence.
  const hooks = readJson(join(cliRoot, 'hooks', 'hooks.json'));

  // 1. No hook of ANY event may match a tool that edits the codebase. Every event, not
  //    just PreToolUse, because the property is "we do not put ourselves around
  //    somebody's edit", and a matcher naming an editing tool breaks it wherever it is
  //    registered (inflowHook.ts re-checks the same closed allowlist for its own hook).
  //
  //    ⚠️ THE MATCHER IS EXECUTED, NOT INSPECTED, and two rounds of review are why. The first
  //    version tested the matcher TEXT for `\bEdit\b`, so `.*` walked past it. The second
  //    added a "is it made only of metacharacters" check, and review walked past THAT with
  //    `Bash|.*`, `[A-Za-z]+` and `Edi[t]` — every one of which fires on `Edit` at runtime
  //    while naming no editing tool. A matcher is a regex, so the only reading that cannot be
  //    out-spelled is to RUN it against the tool names and ask whether it matches. An
  //    unparseable matcher counts as firing: we cannot tell what the host would do with it,
  //    and "I could not tell" must not share a verdict with "it is safe".
  //
  //    ⚠️ AND THE EVENT LIST IS CLOSED THE OTHER WAY ROUND. Naming the tool-scoped events
  //    positively means an event nobody listed skips the check entirely — the guard fails
  //    OPEN on a name it has not seen. So the events that are NOT scoped to a tool are the
  //    enumerated ones (they carry no matcher because they cannot fire around an edit), and
  //    everything else is treated as tool-scoped and must survive the match.
  const NOT_TOOL_SCOPED = [
    'SessionStart',
    'SessionEnd',
    'Stop',
    'SubagentStop',
    'Notification',
    'PreCompact',
    'UserPromptSubmit',
  ];
  const EDITING_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
  /** Would this matcher fire on this tool? An unreadable matcher is assumed to fire. */
  const firesOn = (matcher: string | undefined, tool: string): boolean => {
    if (typeof matcher !== 'string' || matcher.length === 0) return true; // no matcher = every tool
    try {
      return new RegExp(matcher).test(tool);
    } catch {
      return true;
    }
  };
  for (const [event, entries] of Object.entries(hooks.hooks) as [string, any[]][]) {
    if (NOT_TOOL_SCOPED.includes(event)) {
      for (const entry of entries) {
        assert.ok(
          entry.matcher === undefined,
          `${event} is not scoped to a tool but carries a matcher (${entry.matcher}) — say which it is`,
        );
      }
      continue;
    }
    for (const entry of entries) {
      for (const tool of EDITING_TOOLS) {
        assert.ok(
          !firesOn(entry.matcher, tool),
          `${event} registers a hook whose matcher (${entry.matcher}) fires on the editing tool ${tool}`,
        );
      }
    }
  }

  // 2. And the entrypoint it routed to is gone, so a re-registration under some other
  //    matcher cannot reach it either.
  const allCommands = (Object.values(hooks.hooks) as any[][])
    .flat()
    .flatMap((entry: any) => (entry.hooks as any[]).map((h: any) => h.command as string));
  for (const cmd of allCommands) {
    assert.ok(
      !cmd.includes('edit-context'),
      `a hook still routes to the retired edit-context command: ${cmd}`,
    );
  }

  // 3. The Grep|Glob entry on the same array is a DIFFERENT hook and must survive the
  //    removal — it injects context at search time, not at edit time.
  const pre = hooks.hooks.PreToolUse as any[];
  assert.deepEqual(
    pre.map((e) => e.matcher),
    ['Grep|Glob'],
    'PreToolUse carries exactly the grep-context entry — nothing added, nothing lost',
  );
});

test('the Stop hook runs the bundled bin, detaches, and matches the SessionEnd capture command', () => {
  const hooks = readJson(join(cliRoot, 'hooks', 'hooks.json'));
  const stopCmd: string = hooks.hooks.Stop[0].hooks[0].command;
  assert.ok(stopCmd.includes(BUNDLE_REF), 'Stop hook invokes the bundled bin via ${CLAUDE_PLUGIN_ROOT}');
  assert.ok(!/\bnpx\b/.test(stopCmd), 'Stop hook must NOT use npx (the stale-resolution bug)');
  assert.ok(stopCmd.includes('capture --from-hook'), 'Stop hook routes through the shared --from-hook entrypoint');
  assert.ok(stopCmd.includes('--agent claude-code'), 'Stop hook selects the claude-code payload shape');
  assert.ok(stopCmd.includes('--detach'), 'Stop hook detaches so a slow per-turn capture is not SIGTERMd');
  // Per-turn Stop + once-per-session SessionEnd use the SAME command: the shared entrypoint
  // + the per-session_id watermark make repeated fires incremental + de-duplicated.
  assert.equal(stopCmd, hooks.hooks.SessionEnd[0].hooks[0].command, 'Stop + SessionEnd run the identical capture command');
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
  for (const name of ['capture.md', 'start.md', 'how.md', 'blindspots.md', 'learn.md', 'ask-me.md']) {
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

test('/backthread:learn runs the `learn` subcommand and lets the agent run the conversation', () => {
  const md = readFileSync(join(cliRoot, 'commands', 'learn.md'), 'utf8');
  assert.match(md, /node "\$BT" learn --cwd/, 'learn.md runs the deterministic `learn` subcommand');
  assert.match(md, /disable-model-invocation:\s*true/, 'learn.md is user-typed');
  // The product rules have to survive into the instructions the agent follows.
  assert.match(md, /I disagree/, 'the no-cost replies are offered');
  assert.match(md, /Bad question/, 'the no-cost replies are offered');
  assert.match(md, /caught up/i, 'a quiet day is handled as a real completion');
  assert.match(md, /stop and wait/i, 'the agent waits for the person instead of answering itself');
  assert.doesNotMatch(md, /architectural memory/i);
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
