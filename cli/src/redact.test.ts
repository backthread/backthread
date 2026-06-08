import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_REDACTION,
  parseJsonl,
  redactCodeFences,
  redactTranscript,
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
