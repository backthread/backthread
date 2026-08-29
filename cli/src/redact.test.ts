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

// --- one repo, several checkouts (linked git worktrees) ----------------------
// A worktree is not another repo: same history, same file, same repo-relative path,
// different directory. Measuring against a single root threw all of that away — a
// real session recorded hundreds of decisions and ZERO paths because everything it
// edited lived in a worktree next door. The list of roots is how the caller says
// "all of these directories are this one repo".

test('sessionPaths relativizes paths in a SIBLING WORKTREE of the same repo', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/work/app/src/main.ts' } }] } },
    // the same session, editing the same repo checked out somewhere else
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/work/app-lane1/src/worker.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/work/app-lane2/docs/note.md' } }] } },
  ];
  // Single root — today's behaviour, and the bug: two of the three are discarded.
  assert.deepEqual(sessionPaths(records, '/work/app'), ['src/main.ts']);
  // The full root set: every worktree's file lands at its repo-relative path.
  assert.deepEqual(sessionPaths(records, ['/work/app', '/work/app-lane1', '/work/app-lane2']), [
    'docs/note.md',
    'src/main.ts',
    'src/worker.ts',
  ]);
});

test('sessionPaths collapses the SAME file seen through two worktrees to one path', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/app/src/main.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/app-lane1/src/main.ts' } }] } },
  ];
  assert.deepEqual(sessionPaths(records, ['/work/app', '/work/app-lane1']), ['src/main.ts']);
});

// THE NEGATIVE CONTROL. Widening from one root to many must widen it to THIS repo's
// worktrees and nothing else. If this test ever goes green while naming a foreign
// path in the output, the fix has become a leak.
test('sessionPaths still DROPS a path in a genuinely different repo, however many roots', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/app-lane1/keep.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/other-repo/src/secret.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/app-lane1-sibling/x.ts' } }] } }, // prefix look-alike
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/etc/passwd' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/app/../etc/shadow' } }] } }, // traversal out
  ];
  assert.deepEqual(sessionPaths(records, ['/work/app', '/work/app-lane1', '/work/app-lane2']), ['keep.ts']);
});

// The never-emit-a-machine-absolute-path invariant, asserted rather than eyeballed.
test('sessionPaths never emits a machine-absolute path or a root fragment, with many roots', () => {
  const roots = ['/Users/someone/work/app', '/Users/someone/work/app-lane1'];
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/Users/someone/work/app-lane1/src/a.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/Users/someone/work/app/src/b.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/Users/someone/.ssh/id_rsa' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '~/secrets.env' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: 'C:\\Users\\someone\\x.ts' } }] } },
  ];
  const out = sessionPaths(records, roots);
  assert.deepEqual(out, ['src/a.ts', 'src/b.ts']);
  for (const p of out) {
    assert.ok(!p.startsWith('/'), `emitted an absolute path: ${p}`);
    assert.ok(!p.includes('..'), `emitted a traversal: ${p}`);
    assert.ok(!p.includes('Users/someone'), `emitted a machine path fragment: ${p}`);
    for (const root of roots) assert.ok(!p.includes(root), `emitted a root fragment: ${p}`);
  }
});

test('sessionPaths measures a NESTED worktree against the deepest root, not its parent', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/app/wt/src/a.ts' } }] } },
  ];
  // Order in the argument must not decide it — the deepest containing root does.
  assert.deepEqual(sessionPaths(records, ['/work/app', '/work/app/wt']), ['src/a.ts']);
  assert.deepEqual(sessionPaths(records, ['/work/app/wt', '/work/app']), ['src/a.ts']);
});

test('sessionPaths tolerates blank / duplicate / trailing-slash roots', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/app-lane1/src/a.ts' } }] } },
  ];
  assert.deepEqual(sessionPaths(records, ['', '  ', '/work/app/', '/work/app', '/work/app-lane1//']), ['src/a.ts']);
});

test('sessionPaths with an EMPTY root list falls back to the transcript cwd, not to nothing', () => {
  const records = [
    { type: 'session_meta', payload: { id: 'cx-1', cwd: '/Users/me/proj' } },
    { type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ file_path: '/Users/me/proj/src/changed.ts' }) } },
  ];
  assert.deepEqual(sessionPaths(records, []), ['src/changed.ts']);
  assert.deepEqual(sessionPaths(records, ['', '   ']), ['src/changed.ts']);
});

// ...and when it falls back, the escape check has to be told about the root it fell back
// TO. A predicate handed the caller's empty list is measuring against no directories at
// all, so it can only ever answer "nothing left the repo" -- a second, weaker route into
// the output through the one door the caller cannot see. The claim is in the option's
// own documentation; this is what makes it true.
test('the escape check is given the roots the harvest actually used, not the caller list', () => {
  const records = [
    { type: 'session_meta', payload: { id: 'cx-1', cwd: '/Users/me/proj' } },
    { type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ file_path: '/Users/me/proj/vendor/secret.ts' }) } },
  ];
  const seen: string[][] = [];
  const out = sessionPaths(records, [], {
    escapesRepo: (rel, roots) => {
      seen.push([...roots]);
      return rel.startsWith('vendor/');
    },
  });
  // The predicate was handed the fallback root, not the empty list the caller passed.
  assert.deepEqual(seen, [['/Users/me/proj']]);
  // And its answer was obeyed, against a path relativized against that same root.
  assert.deepEqual(out, []);
});

// A root of `/` is not a root. It claims the whole filesystem as the repo, and the
// only honest reading is that the caller supplied nothing usable — so it is treated
// exactly like an omitted root and the transcript's own cwd decides. Stated as a test
// because it is the one input where a single-string caller's result changed: `/` used
// to be carried through and drop every absolute path, and a caller relying on that
// silence would now start receiving the transcript-relative ones.
test('sessionPaths treats a root of "/" as no root at all, not as the whole filesystem', () => {
  const records = [
    { type: 'session_meta', payload: { id: 'cx-1', cwd: '/Users/me/proj' } },
    { type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ file_path: '/Users/me/proj/src/a.ts' } ) } },
    { type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ file_path: '/etc/passwd' }) } },
  ];
  for (const root of ['/', '//', '/  ']) {
    const out = sessionPaths(records, root);
    assert.deepEqual(out, ['src/a.ts'], `root ${JSON.stringify(root)}`);
    // Whatever it does, it must never turn the filesystem root into a repo root and
    // start emitting everything absolute with the leading slash shaved off.
    assert.ok(!out.includes('etc/passwd'));
  }
  // Same for the list form.
  assert.deepEqual(sessionPaths(records, ['/']), ['src/a.ts']);
});

test('sessionPaths drops a path that IS a root, rather than re-measuring it upward', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { cwd: '/work/app/wt' } }] } },
  ];
  // `/work/app/wt` names a worktree directory, not a file in it. It was dropped when
  // there was one root and it stays dropped now — it must NOT surface as `wt`.
  assert.deepEqual(sessionPaths(records, ['/work/app', '/work/app/wt']), []);
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

// --- shell-command path harvest ----------------------------------------------
//
// Two things gate a path scraped out of a shell command, and the tests below are
// split along that line on purpose:
//   1. the STRING rules (extension, a directory separator, the token grammar) —
//      cheap, and enough to reject a glob or a doubled extension;
//   2. the `exists` PREDICATE — the only thing that can reject a token that is
//      perfectly well-formed and still not a file in this repo (`cd /etc && cat
//      app/secrets.json`, a scheme-less URL, a string literal inside a heredoc).
// Where a case is settled by (2), the test says so by asserting the predicate was
// actually consulted — otherwise it would pass just as well if the regex had
// silently rejected the token, and would stop guarding anything the day the regex
// changed.

/** A Claude Code assistant record carrying one Bash tool_use — the real shape. */
const bashRecord = (command: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command, description: 'run it' } }] },
});

/** An `exists` predicate backed by a fixed file list — no filesystem, still pure. */
const repoWith = (...files: string[]) => ({ exists: (p: string) => files.includes(p) });

/** Same, but records every path it was asked about, so a test can prove it ran. */
function spyRepo(...files: string[]) {
  const asked: string[] = [];
  return {
    asked,
    opts: {
      exists: (p: string) => {
        asked.push(p);
        return files.includes(p);
      },
    },
  };
}

test('sessionPaths emits NO shell-derived path when no exists predicate is given (fail closed)', () => {
  // A consumer that hasn't opted in must not receive unverified guesses. The
  // path-NAMED inputs are unaffected — they are an explicit act by the agent.
  const records = [
    bashRecord('cat src/real.ts'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/named.ts' } }] } },
  ];
  assert.deepEqual(sessionPaths(records, '/repo'), ['src/named.ts']);
  assert.deepEqual(sessionPaths(records, '/repo', {}), ['src/named.ts']);
  assert.deepEqual(sessionPaths(records, '/repo', repoWith('src/real.ts')), ['src/named.ts', 'src/real.ts']);
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
  assert.deepEqual(sessionPaths(records, '/repo', repoWith('src/auth/rls.ts')), ['src/auth/rls.ts']);
});

test('sessionPaths harvests the repo paths a Bash command names', () => {
  const records = [bashRecord('git diff -- worker/src/ciPayload.ts scripts/ingest/classify/env-vars.ts')];
  const opts = repoWith('worker/src/ciPayload.ts', 'scripts/ingest/classify/env-vars.ts');
  assert.deepEqual(sessionPaths(records, '/repo', opts), [
    'scripts/ingest/classify/env-vars.ts',
    'worker/src/ciPayload.ts',
  ]);
});

test('sessionPaths matches the LONGEST extension: package.json is never package.js', () => {
  // The trailing lookahead is what forces this, NOT the order of the extension list
  // (every shorter extension is shadowed by a longer one that continues with a word
  // character, so the short match is rejected and the engine backtracks). Both files
  // are claimed to exist, so nothing but the token grammar can decide the outcome.
  const records = [bashRecord('cat cli/package.json && node scripts/x.mjs')];
  const opts = repoWith('cli/package.json', 'cli/package.js', 'scripts/x.mjs');
  assert.deepEqual(sessionPaths(records, '/repo', opts), ['cli/package.json', 'scripts/x.mjs']);
  // The same guard from the other side: a doubled extension is not a truncated one.
  assert.deepEqual(sessionPaths([bashRecord('gzip dist/bundle.js.map')], '/repo', repoWith('dist/bundle.js')), []);
});

test('sessionPaths relativizes an ABSOLUTE path named inside a Bash command', () => {
  const records = [bashRecord("rg -n 'sessionPaths' /repo/packages/redact/src/index.ts")];
  assert.deepEqual(sessionPaths(records, '/repo', repoWith('packages/redact/src/index.ts')), [
    'packages/redact/src/index.ts',
  ]);
});

test('sessionPaths drops a Bash-named path OUTSIDE the repo root (never leaks a machine path)', () => {
  const records = [
    bashRecord('cat /etc/app/secrets.json /Users/me/other-repo/src/a.ts /repo-other/b.ts && cat /repo/keep.ts'),
  ];
  // Claim EVERY one of them exists: the root fence, not the predicate, must drop them.
  const spy = spyRepo('keep.ts', 'app/secrets.json', 'src/a.ts', 'b.ts');
  assert.deepEqual(sessionPaths(records, '/repo', spy.opts), ['keep.ts']);
  assert.deepEqual(spy.asked, ['keep.ts'], 'a foreign absolute must never even reach the predicate');
  // With no resolvable root at all, every absolute is skipped outright.
  assert.deepEqual(sessionPaths(records, undefined, spy.opts), []);
});

test('sessionPaths drops a ../ escape and a ~ home path named inside a Bash command', () => {
  const records = [bashRecord('cat ../../etc/secrets.json ~/.config/creds.json src/keep.ts')];
  const opts = repoWith('src/keep.ts', '../../etc/secrets.json', '.config/creds.json', 'etc/secrets.json');
  assert.deepEqual(sessionPaths(records, '/repo', opts), ['src/keep.ts']);
  // Belt and braces: nothing emitted ever contains a traversal segment.
  assert.ok(sessionPaths(records, '/repo', opts).every((p) => !p.split('/').includes('..')));
});

test('sessionPaths drops an scp-style host:/path argument', () => {
  // `:` is not in the segment class, so the token starts after it — as an ABSOLUTE
  // path, which the root fence then rejects for being outside the repo. Claim it
  // exists so only the fence can be what drops it.
  const records = [bashRecord('scp deploy@prod-host:/srv/secrets/creds.json .')];
  const spy = spyRepo('srv/secrets/creds.json');
  assert.deepEqual(sessionPaths(records, '/repo', spy.opts), []);
  assert.deepEqual(spy.asked, []);
});

test('sessionPaths drops glob/wildcard tokens in a Bash command (a glob is not a file)', () => {
  const records = [
    bashRecord('rm -rf dist/*.js && prettier "src/**/*.ts" && ls src/a[0].ts src/{a,b}.ts'),
  ];
  // Every one of these claims to exist; the token grammar has to be what rejects them.
  const spy = spyRepo('dist/*.js', 'src/**/*.ts', 'src/a[0].ts', 'src/{a,b}.ts', 'src/a.ts', 'src/b.ts');
  assert.deepEqual(sessionPaths(records, '/repo', spy.opts), []);
  assert.deepEqual(spy.asked, []);
});

test('sessionPaths does NOT harvest a URL out of a Bash command — with OR without a scheme', () => {
  // A `https://` URL is settled by the root fence: it matches at the second slash as
  // the absolute path `/example.com/x.json`, which is outside the repo. A SCHEME-LESS
  // one is not — `internal-api.acme.corp/v3/customers/export.json` is a perfectly
  // well-formed relative path and used to be emitted verbatim, exfiltrating an
  // internal hostname and API route. Only the existence check rejects it, so the
  // assertion below proves the predicate was the thing that ran.
  const withScheme = [bashRecord('curl -sS https://example.com/x.json -o out.json')];
  assert.deepEqual(sessionPaths(withScheme, '/repo', repoWith()), []);

  const schemeless = [
    bashRecord('curl internal-api.acme.corp/v3/customers/export.json && gh api repos/acme/private-repo/contents/infra/prod-secrets.yaml'),
  ];
  const spy = spyRepo('src/keep.ts');
  assert.deepEqual(sessionPaths(schemeless, '/repo', spy.opts), []);
  assert.deepEqual(spy.asked, [
    'internal-api.acme.corp/v3/customers/export.json',
    'repos/acme/private-repo/contents/infra/prod-secrets.yaml',
  ]);
});

test('sessionPaths drops a file reached after a `cd` OUT of the repo', () => {
  // THE privacy case. `cd /etc` then a bare relative filename produces a token the
  // string fence cannot fault — it looks exactly like an in-repo path. The `/etc`
  // and `~` in the same command are correctly dropped and then walked around by the
  // relative name that follows. Existence is the only thing that separates them.
  const records = [
    bashRecord('cd /etc && cat app/secrets.json'),
    bashRecord('cd /Users/jb/personal-notes && rg -n salary hr/comp-bands-2026.md'),
    bashRecord('cat src/keep.ts'),
  ];
  const spy = spyRepo('src/keep.ts');
  assert.deepEqual(sessionPaths(records, '/repo', spy.opts), ['src/keep.ts']);
  assert.deepEqual(spy.asked, ['app/secrets.json', 'hr/comp-bands-2026.md', 'src/keep.ts']);
});

test('sessionPaths drops path-shaped STRING LITERALS inside a heredoc', () => {
  // Writing a file with a heredoc puts program text in the command. A string literal
  // in that text is program CONTENT, not a file the session touched — and prose in a
  // heredoc'd Markdown doc is not one either. The file being WRITTEN is real; the
  // things it merely mentions are not.
  const records = [
    bashRecord(
      [
        "cat > src/loader.ts <<'EOF'",
        "const CUSTOMERS = 'data/customers/pii.json';",
        "import { parse } from './vendor/fastcsv/index.js';",
        'EOF',
      ].join('\n'),
    ),
    bashRecord(
      [
        "cat > docs/postmortem.md <<'EOF'",
        'The export at customers/acme-corp/pii-export-2026-08.json was world-readable.',
        'See also ops/runbooks/incident-2026-08.md for the timeline.',
        'EOF',
      ].join('\n'),
    ),
  ];
  const opts = repoWith('src/loader.ts', 'docs/postmortem.md');
  assert.deepEqual(sessionPaths(records, '/repo', opts), ['docs/postmortem.md', 'src/loader.ts']);
});

test('sessionPaths excludes .git/ and node_modules/ even though they exist on disk', () => {
  // They pass every other gate and are still never part of the system anyone learns.
  const records = [
    bashRecord('cat .git/hooks/pre-commit.sh node_modules/lodash/lodash.js vendor/node_modules/x/y.js src/keep.ts'),
  ];
  const opts = repoWith(
    '.git/hooks/pre-commit.sh',
    'node_modules/lodash/lodash.js',
    'vendor/node_modules/x/y.js',
    'src/keep.ts',
  );
  assert.deepEqual(sessionPaths(records, '/repo', opts), ['src/keep.ts']);
});

test('sessionPaths caps the LENGTH of a shell-derived path', () => {
  // A base64 blob presents as an enormous "path" (`+` and `/` are both base64 chars).
  // Both of these claim to exist, so only the cap can be what drops the long one.
  const ok = `src/${'a'.repeat(150)}.ts`;
  const tooLong = `src/${'a'.repeat(400)}.ts`;
  const records = [bashRecord(`cat ${ok} ${tooLong}`)];
  assert.deepEqual(sessionPaths(records, '/repo', repoWith(ok, tooLong)), [ok]);
});

test('sessionPaths caps the COUNT of shell-derived paths, in encounter order', () => {
  // Named so encounter order and alphabetical order DISAGREE: the `z` files are seen
  // first, the `a` files last. Truncating after the sort would keep the `a` files and
  // throw away everything actually read first — which is how alphabetically-early
  // junk crowds out real source paths. The cap must bite before the sort.
  const early = Array.from({ length: 400 }, (_, i) => `src/z${String(i).padStart(3, '0')}.ts`);
  const late = Array.from({ length: 5 }, (_, i) => `src/a${String(i).padStart(3, '0')}.ts`);
  const all = [...early, ...late];
  const records = [bashRecord(`cat ${all.join(' ')}`)];
  const out = sessionPaths(records, '/repo', repoWith(...all));

  assert.equal(out.length, 200, 'capped');
  assert.ok(out.every((p) => p.startsWith('src/z')), 'kept what was encountered first, not what sorts first');
  assert.equal(out[0], 'src/z000.ts');
  // The cap is on SHELL paths only — a path-named input still gets through beside it.
  const withNamed = [
    ...records,
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/aaa-named.ts' } }] } },
  ];
  assert.ok(sessionPaths(withNamed, '/repo', repoWith(...all)).includes('src/aaa-named.ts'));
});

test('sessionPaths requires a directory separator (a bare filename is too ambiguous)', () => {
  // `index.ts` exists in every package — with no directory we can't attribute it,
  // so a single-segment token is dropped rather than guessed at.
  const records = [bashRecord('npx tsc index.ts && cat README.md'), bashRecord('cat src/index.ts')];
  const spy = spyRepo('index.ts', 'README.md', 'src/index.ts');
  assert.deepEqual(sessionPaths(records, '/repo', spy.opts), ['src/index.ts']);
  assert.deepEqual(spy.asked, ['src/index.ts']);
});

test('sessionPaths is extension-gated on Bash tokens, by the exported list', () => {
  assert.ok(HARVESTED_PATH_EXTENSIONS.includes('ts'));
  assert.ok(HARVESTED_PATH_EXTENSIONS.includes('json'));
  assert.ok(!HARVESTED_PATH_EXTENSIONS.includes('pem'));
  const records = [bashRecord('cat secrets/prod.pem secrets/id_rsa.key config/app.yaml')];
  const spy = spyRepo('secrets/prod.pem', 'secrets/id_rsa.key', 'config/app.yaml');
  assert.deepEqual(sessionPaths(records, '/repo', spy.opts), ['config/app.yaml']);
  assert.deepEqual(spy.asked, ['config/app.yaml'], 'an un-listed extension never reaches the predicate');
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

  const opts = repoWith('worker/src/digest/send.ts', 'worker/src/cron.ts');
  assert.deepEqual(sessionPaths(records, '/repo', opts), [
    'worker/src/cron.ts',
    'worker/src/digest/send.ts',
  ]);
  // The fence still holds on the same records: no command, no tool output, no code.
  const blob = JSON.stringify(redactTranscript(records).turns);
  assert.doesNotMatch(blob, /rg -n/);
  assert.doesNotMatch(blob, /export async function sendDigest/);
});

// --- the filesystem's word on containment -----------------------------------
//
// Every rule inside sessionPaths is a string rule, and a string prefix does not
// survive a symlink: a checkout containing `vendor -> ../other-repo` puts another
// repository's files under a path that reads as in-repo by every test above. The
// module cannot see that — it is pure — so the caller answers, and these fix what
// the module does with the answer.

test('sessionPaths drops a path the caller says resolves OUTSIDE the repo', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/app/src/mine.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/app/vendor/src/secret.ts' } }] } },
  ];
  // Both are under the root by string prefix — that is the whole problem.
  assert.deepEqual(sessionPaths(records, '/work/app'), ['src/mine.ts', 'vendor/src/secret.ts']);
  assert.deepEqual(sessionPaths(records, '/work/app', { escapesRepo: (rel) => rel.startsWith('vendor/') }), [
    'src/mine.ts',
  ]);
});

test('the escape check also gets the last word on a SHELL-derived path', () => {
  const records = [
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', input: { command: 'cat vendor/src/secret.ts src/mine.ts' } }] },
    },
  ];
  const exists = () => true;
  assert.deepEqual(sessionPaths(records, '/work/app', { exists }), ['src/mine.ts', 'vendor/src/secret.ts']);
  assert.deepEqual(
    sessionPaths(records, '/work/app', { exists, escapesRepo: (rel) => rel.startsWith('vendor/') }),
    ['src/mine.ts'],
  );
});

// A path that resolves NOWHERE is not a path that resolves outside. The file a session
// DELETED is the common case, and it must keep the behaviour it has always had — the
// caller reports a contradiction, never an absence — so this pins that the module asks
// and then obeys the answer it gets, rather than treating the question as a filter.
test('a caller that reports no escape leaves every path exactly as it was', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/app/src/deleted.ts' } }] } },
  ];
  assert.deepEqual(sessionPaths(records, '/work/app', { escapesRepo: () => false }), ['src/deleted.ts']);
  assert.deepEqual(sessionPaths(records, '/work/app'), ['src/deleted.ts']);
});

// A dropped path must not spend the shell budget of a path that would have been kept.
test('an escaping shell path does not consume the shell-path budget', () => {
  const command = Array.from({ length: 260 }, (_, i) => `vendor/gen/f${i}.ts`).join(' ') + ' src/mine.ts';
  const records = [{ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command } }] } }];
  const out = sessionPaths(records, '/work/app', {
    exists: () => true,
    escapesRepo: (rel) => rel.startsWith('vendor/'),
  });
  assert.deepEqual(out, ['src/mine.ts']);
});

// A NUL cannot be part of a filename on any filesystem this runs on — the syscall layer
// stops reading at it — so a path carrying one names nothing, and it is metadata we
// would otherwise go on to store, join and render.
test('sessionPaths refuses a path carrying a NUL byte, whatever its origin', () => {
  const records = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/work/app/src/a\0lpha.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: 'src/b\0eta.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { path: 'src/ok.ts' } }] } },
  ];
  const out = sessionPaths(records, '/work/app');
  assert.deepEqual(out, ['src/ok.ts']);
  for (const p of out) assert.ok(!p.includes('\0'), p);
});
