import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_REDACTION,
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
    // an IN-repo redundant segment → normalized + kept (a/b/../c.ts → a/c.ts)
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: 'a/b/../c.ts' } }] } },
  ];
  // Only the in-repo redundant path survives, collapsed to its clean form.
  assert.deepEqual(sessionPaths(records, '/repo'), ['a/c.ts']);
  // Same drop behavior with no resolvable root at all.
  assert.deepEqual(sessionPaths(records), ['a/c.ts']);
  // And critically: no emitted path ever contains `..`.
  assert.ok(sessionPaths(records, '/repo').every((p) => !p.split('/').includes('..')));
});

test('sessionPaths does NOT harvest Codex shell command arrays (a command is not a file path)', () => {
  const records = [
    {
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['cat', '/repo/secret.ts'] }) },
    },
  ];
  assert.deepEqual(sessionPaths(records, '/repo'), []);
});
