import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_REDACTION,
  HARVESTED_PATH_EXTENSIONS,
  parseJsonl,
  redactCodeFences,
  redactTranscript,
  sessionPaths,
  sessionTimestamp,
} from './redact.js';

// These golden cases mirror scripts/ingest/decisions/transcript.test.ts so the
// VENDORED fence cannot silently drift from the canonical one. If you change one,
// change both (until the shared-package follow-up collapses them into one).

test('parseJsonl parses one record per line and skips blank/corrupt lines', () => {
  const raw = ['{"type":"user","message":{"content":"hi"}}', '', 'not json', '{"type":"assistant"}'].join(
    '\n',
  );
  const out = parseJsonl(raw);
  assert.equal(out.length, 2);
});

test('redactCodeFences replaces fenced blocks with the sentinel', () => {
  const { text, count } = redactCodeFences('before\n```js\nconst x = 1;\n```\nafter');
  assert.equal(text, `before\n${CODE_REDACTION}\nafter`);
  assert.equal(count, 1);
});

test('redactCodeFences fail-closes on a dangling/unterminated fence', () => {
  const { text } = redactCodeFences('keep this\n```\nleaking secret code with no close');
  assert.equal(text, `keep this\n${CODE_REDACTION}`);
  assert.doesNotMatch(text, /leaking secret/);
});

test('redactCodeFences handles two adjacent fences independently', () => {
  const { count } = redactCodeFences('```a```\n```b```');
  assert.equal(count, 2);
});

test('redactTranscript keeps prose, drops tool_use/tool_result, and redacts fences', () => {
  const records = [
    { type: 'user', sessionId: 'sess-9', message: { content: 'why a queue?' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'To decouple ingestion.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } }, // dropped
        ],
      },
    },
    // tool_result user content — dropped wholesale.
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET STDOUT' }] } },
    // a system record — dropped.
    { type: 'file-history-snapshot', message: { content: 'noise' } },
    // assistant turn that is ALL code → redacts to the sentinel; the sentinel turn
    // is kept (non-empty), but it carries NO source (matches canonical transcript.ts).
    { type: 'assistant', message: { content: [{ type: 'text', text: '```\nconst secret = 1;\n```' }] } },
  ];

  const out = redactTranscript(records);
  assert.equal(out.sessionId, 'sess-9');
  assert.deepEqual(
    out.turns,
    [
      { role: 'user', text: 'why a queue?' },
      { role: 'assistant', text: 'To decouple ingestion.' },
      { role: 'assistant', text: '[code redacted]' },
    ],
  );
  // No leaked source / tool I/O anywhere.
  const blob = JSON.stringify(out.turns);
  assert.doesNotMatch(blob, /rm -rf/);
  assert.doesNotMatch(blob, /SECRET STDOUT/);
  assert.doesNotMatch(blob, /const secret/);
  assert.equal(out.stats.totalRecords, 5);
  assert.equal(out.stats.keptRecords, 3);
});

test('redactTranscript handles CURSOR records (role at the TOP level, not `type`) — ARP-507', () => {
  // Cursor puts the role at the top level (`role`) with Claude-style content blocks
  // under message.content. The old parser read role from `rec.type` ONLY, so every
  // Cursor turn got role=undefined and was dropped → "nothing to capture" on every
  // Cursor session. Lock the multi-field role resolution + the unchanged fence.
  const records = [
    { role: 'user', message: { content: [{ type: 'text', text: 'why hand-rolled over Intl?' }] } },
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hand-rolled: full control, no extra dep.' },
          { type: 'tool_use', name: 'Read', input: { path: '/repo/src/secret.ts' } }, // dropped
        ],
      },
    },
    // all-code assistant turn → redacts to the sentinel (kept, but carries no source).
    { role: 'assistant', message: { content: [{ type: 'text', text: '```\nconst apiKey = 2;\n```' }] } },
    // a non-conversational Cursor record (no role/type) → dropped.
    { message: { content: [{ type: 'text', text: 'noise' }] } },
  ];

  const out = redactTranscript(records);
  assert.deepEqual(out.turns, [
    { role: 'user', text: 'why hand-rolled over Intl?' },
    { role: 'assistant', text: 'Hand-rolled: full control, no extra dep.' },
    { role: 'assistant', text: '[code redacted]' },
  ]);
  // Security fence still holds on the Cursor shape: no tool input, no source.
  const blob = JSON.stringify(out.turns);
  assert.doesNotMatch(blob, /secret\.ts/);
  assert.doesNotMatch(blob, /const apiKey/);
  assert.equal(out.stats.totalRecords, 4);
  assert.equal(out.stats.keptRecords, 3);
});

test('sessionTimestamp returns the latest valid ISO stamp (Date.parse compare)', () => {
  const records = [
    { type: 'user', timestamp: '2026-06-01T10:00:00Z' },
    { type: 'assistant', timestamp: '2026-06-01T12:30:00+02:00' }, // = 10:30Z, latest
    { type: 'assistant', timestamp: 'not-a-date' },
    { type: 'assistant' },
  ];
  assert.equal(sessionTimestamp(records), '2026-06-01T12:30:00+02:00');
});

test('sessionTimestamp returns null when no record carries a timestamp', () => {
  assert.equal(sessionTimestamp([{ type: 'user' }, {}]), null);
});

test('sessionPaths harvests tool_use file_path, relativized + deduped + sorted under repoRoot', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/z.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/a.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/repo/src/z.ts' } }] } }, // dup
    { type: 'assistant', message: { content: [{ type: 'text', text: 'no path here' }] } },
  ];
  assert.deepEqual(sessionPaths(records, '/repo'), ['src/a.ts', 'src/z.ts']);
});

test('sessionPaths also harvests path / notebook_path / Bash cwd', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: '/repo/nb.ipynb' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { path: '/repo/dir/file.md' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { cwd: '/repo/sub' } }] } },
  ];
  assert.deepEqual(sessionPaths(records, '/repo'), ['dir/file.md', 'nb.ipynb', 'sub']);
});

test('sessionPaths drops paths foreign to the repoRoot (incl. sibling prefixes)', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/repo/keep.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/etc/passwd' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/repo-other/x.ts' } }] } },
  ];
  assert.deepEqual(sessionPaths(records, '/repo'), ['keep.ts']);
});

test('sessionPaths falls back to Codex session_meta.payload.cwd when repoRoot is omitted', () => {
  const records = [
    { type: 'session_meta', payload: { id: 'cx-1', cwd: '/Users/me/proj' } },
    // a Codex function_call whose args carry an in-repo file_path (JSON string)
    { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ file_path: '/Users/me/proj/src/changed.ts' }) } },
    // a foreign path → dropped against the session_meta root
    { type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ file_path: '/secret/path.ts' }) } },
  ];
  assert.deepEqual(sessionPaths(records), ['src/changed.ts']);
});

test('sessionPaths without a resolvable root skips absolute paths, keeps relative ones', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/abs/secret.ts' } }] } }, // skipped
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: './src/rel.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: 'pkg/mod.ts' } }] } },
  ];
  assert.deepEqual(sessionPaths(records), ['pkg/mod.ts', 'src/rel.ts']);
});

test('sessionPaths is robust to garbage records + unparseable Codex args (never throws)', () => {
  assert.deepEqual(sessionPaths([null, 42, 'str', {}, { message: {} }], '/repo'), []);
  assert.deepEqual(
    sessionPaths([{ type: 'response_item', payload: { type: 'function_call', arguments: '{not json' } }], '/repo'),
    [],
  );
});

test('sessionPaths drops ~, ../-escape, and Windows-absolute paths (keeps real relatives)', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '~/secret/key.pem' } }] } }, // home → drop
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '../../etc/passwd' } }] } }, // escape → drop
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: 'C:\\repo\\x.ts' } }] } }, // Win drive → drop
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '\\server\\share\\y.ts' } }] } }, // Win UNC → drop
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: 'src/x.ts' } }] } }, // genuine relative → keep
  ];
  assert.deepEqual(sessionPaths(records, '/repo'), ['src/x.ts']);
  assert.deepEqual(sessionPaths(records), ['src/x.ts']);
});

test('sessionPaths drops MID-path .. traversal that escapes the repo (defense-in-depth)', () => {
  // isForeignRelativePath only catches a LEADING ../, so these mid-path escapes
  // bypassed the guard pre-fix and were emitted verbatim. After normalization
  // they resolve above root → dropped. Never EMIT a path containing `..`.
  const records = [
    // relative with mid-path traversal escaping root → drop
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: 'a/../../etc/passwd' } }] } },
    // absolute that prefix-relativizes to ../etc/passwd against /repo → drop
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/repo/../etc/passwd' } }] } },
    // a deeper mid-path escape (net traversal pops above root) → drop
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: 'src/a/b/../../../../../../etc/shadow' } }] } },
    // a BACKSLASH mid-path escape — not a leading \ (so not caught as Win/UNC by
    // isForeignRelativePath), splits on either sep + resolves above root → drop
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: 'a\\..\\..\\etc\\passwd' } }] } },
    // an IN-repo redundant segment → normalized + kept (a/b/../c.ts → a/c.ts)
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: 'a/b/../c.ts' } }] } },
  ];
  // Only the in-repo redundant path survives, collapsed to its clean form.
  assert.deepEqual(sessionPaths(records, '/repo'), ['a/c.ts']);
  // Same drop behavior with no resolvable root at all.
  assert.deepEqual(sessionPaths(records), ['a/c.ts']);
  // And critically: no emitted path ever contains `..` (either separator).
  assert.ok(sessionPaths(records, '/repo').every((p) => !p.split(/[\\/]/).includes('..')));
});

test('sessionPaths harvests Codex shell command ARRAYS through the same fence', () => {
  // Codex passes the shell tool an argv array (["bash","-lc","…"]); we join it and
  // run the same token scan as a Claude Code Bash command string. This REVERSES the
  // old "a command is not a file path" rule — the file a shell call touches is named
  // only inside its command, and skipping it left ~half of all sessions unanchored.
  const records = [
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'sed -n 1,40p /repo/src/auth/rls.ts'] }),
      },
    },
  ];
  assert.deepEqual(sessionPaths(records, '/repo'), ['src/auth/rls.ts']);
});

// --- Bash-command path harvest ----------------------------------------------

/** A Claude Code assistant record carrying one Bash tool_use — the real shape. */
const bashRecord = (command: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command, description: 'run it' } }] },
});

test('sessionPaths harvests the repo paths a Bash command names', () => {
  const records = [bashRecord('git diff -- worker/src/ciPayload.ts scripts/ingest/classify/env-vars.ts')];
  assert.deepEqual(sessionPaths(records, '/repo'), [
    'scripts/ingest/classify/env-vars.ts',
    'worker/src/ciPayload.ts',
  ]);
});

test('sessionPaths matches the LONGEST extension: package.json is never package.js', () => {
  // JS alternation is first-match-wins, so an ext list ordered `js|json` would emit
  // `cli/package.js` — a file that does not exist. Longest-first + a path-ish
  // lookahead both have to hold for this to pass.
  const records = [bashRecord('cat cli/package.json && node scripts/x.mjs')];
  assert.deepEqual(sessionPaths(records, '/repo'), ['cli/package.json', 'scripts/x.mjs']);
  // The same guard from the other side: a doubled extension is not a truncated one.
  assert.deepEqual(sessionPaths([bashRecord('gzip dist/bundle.js.map')], '/repo'), []);
});

test('sessionPaths relativizes an ABSOLUTE path named inside a Bash command', () => {
  const records = [bashRecord("rg -n 'sessionPaths' /repo/packages/redact/src/index.ts")];
  assert.deepEqual(sessionPaths(records, '/repo'), ['packages/redact/src/index.ts']);
});

test('sessionPaths drops a Bash-named path OUTSIDE the repo root (never leaks a machine path)', () => {
  const records = [
    bashRecord('cat /etc/app/secrets.json /Users/me/other-repo/src/a.ts /repo-other/b.ts && cat /repo/keep.ts'),
  ];
  // Only the in-root file survives; nothing machine-absolute is ever emitted.
  assert.deepEqual(sessionPaths(records, '/repo'), ['keep.ts']);
  // With no resolvable root at all, every absolute is skipped outright.
  assert.deepEqual(sessionPaths(records), []);
});

test('sessionPaths drops a ../ escape and a ~ home path named inside a Bash command', () => {
  const records = [bashRecord('cat ../../etc/secrets.json ~/.config/creds.json src/keep.ts')];
  assert.deepEqual(sessionPaths(records, '/repo'), ['src/keep.ts']);
  // Belt and braces: nothing emitted ever contains a traversal segment.
  assert.ok(sessionPaths(records, '/repo').every((p) => !p.split('/').includes('..')));
});

test('sessionPaths drops glob/wildcard tokens in a Bash command (a glob is not a file)', () => {
  const records = [
    bashRecord('rm -rf dist/*.js && prettier "src/**/*.ts" && ls src/a[0].ts src/{a,b}.ts'),
  ];
  assert.deepEqual(sessionPaths(records, '/repo'), []);
});

test('sessionPaths does NOT harvest a URL out of a Bash command', () => {
  // The single nastiest false positive: a URL path segment looks exactly like a
  // repo path. The lookbehind rejects any token preceded by `/`, so a URL can only
  // offer its last segment — which has no `/` of its own and is therefore dropped.
  const records = [
    bashRecord('curl -sS https://example.com/x.json && curl https://api.example.com/v1/schema/user.json -o out.json'),
  ];
  assert.deepEqual(sessionPaths(records, '/repo'), []);
});

test('sessionPaths requires a directory separator (a bare filename is too ambiguous)', () => {
  // `index.ts` exists in every package — with no directory we can't attribute it,
  // so a single-segment token is dropped rather than guessed at.
  const records = [bashRecord('npx tsc index.ts && cat README.md'), bashRecord('cat src/index.ts')];
  assert.deepEqual(sessionPaths(records, '/repo'), ['src/index.ts']);
});

test('sessionPaths is extension-gated on Bash tokens, by the exported list', () => {
  assert.ok(HARVESTED_PATH_EXTENSIONS.includes('ts'));
  assert.ok(HARVESTED_PATH_EXTENSIONS.includes('json'));
  assert.ok(!HARVESTED_PATH_EXTENSIONS.includes('pem'));
  const records = [bashRecord('cat secrets/prod.pem secrets/id_rsa.key config/app.yaml')];
  assert.deepEqual(sessionPaths(records, '/repo'), ['config/app.yaml']);
});

test('sessionPaths harvests a Bash command from a REAL Claude Code transcript shape', () => {
  // The record shape a Claude Code .jsonl actually carries: an assistant record
  // whose message.content holds tool_use blocks, Bash among them, with the file
  // named only inside `input.command`. Interleaved with the prose + Read blocks a
  // real session mixes in. Hand-written — no captured transcript content.
  const records = [
    { type: 'user', sessionId: 'sess-42', message: { content: 'why did the digest send twice?' } },
    {
      type: 'assistant',
      timestamp: '2026-08-14T09:12:00Z',
      message: {
        content: [
          { type: 'thinking', thinking: 'Check the cron gate first.' },
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Bash',
            input: {
              command: "cd /repo && rg -n 'sendDigest' worker/src/digest/send.ts | head -20",
              description: 'Find the send entrypoint',
            },
          },
        ],
      },
    },
    // The paired tool_result the fence drops wholesale — never a path source.
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '42: export async function sendDigest() {' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-08-14T09:12:30Z',
      message: {
        content: [
          { type: 'text', text: 'The per-timezone gate runs twice on a DST boundary.' },
          { type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/repo/worker/src/cron.ts' } },
          {
            type: 'tool_use',
            id: 'toolu_03',
            name: 'Bash',
            input: {
              command: 'git add worker/src/digest/send.ts worker/src/cron.ts && git commit -m "fix: gate once per tz"',
              description: 'Commit the fix',
            },
          },
        ],
      },
    },
  ];

  assert.deepEqual(sessionPaths(records, '/repo'), [
    'worker/src/cron.ts',
    'worker/src/digest/send.ts',
  ]);
  // The fence still holds on the same records: no command, no tool output, no code.
  const blob = JSON.stringify(redactTranscript(records).turns);
  assert.doesNotMatch(blob, /rg -n/);
  assert.doesNotMatch(blob, /export async function sendDigest/);
});
