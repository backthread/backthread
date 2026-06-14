// @backthread/redact — the ONE redaction fence.
//
// This is the single, canonical implementation of the security-critical fence
// that strips source code + tool I/O out of an agent session transcript before
// anything leaves the machine. It used to exist TWICE — the server/dogfood copy
// in `scripts/ingest/decisions/transcript.ts` and the vendored cli copy in
// `cli/src/redact.ts` — held in parity only by golden tests that would
// eventually drift. Both now re-export from here, so the fence has exactly one
// implementation.
//
// THE RULE (load-bearing, non-negotiable):
//   DROP every tool-use / tool-result record entirely. Keep ONLY natural-
//   language user prompts and assistant text/thinking. In the kept text, REDACT
//   fenced code blocks (``` … ```) to a placeholder. No source code and no tool
//   I/O may leave this module — only derived rationale reaches the LLM.
//
// A spike measured ~92–98% of a transcript as droppable on exactly
// this basis. This is the same defense-in-depth posture as classify/sanitize.ts:
// redact at the boundary so a downstream extractor bug can't exfiltrate code.
//
// ZERO RUNTIME DEPENDENCIES — pure string transforms over already-parsed records
// so the cli bundle (`npx backthread`) stays light and the worker can inline it.
// The file I/O (reading the .jsonl off disk) lives in the consumers, not here.

/** Placeholder substituted for every fenced code block in kept prose. */
export const CODE_REDACTION = '[code redacted]';

/**
 * One natural-language turn that survived redaction. `text` is guaranteed to
 * carry no fenced code and no tool I/O — only prose + the redaction sentinel.
 */
export interface TranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** The redacted, natural-language-only transcript handed to the extractor. */
export interface RedactedTranscript {
  sessionId: string | null;
  turns: TranscriptTurn[];
  // Instrumentation — proves the drop rate (and feeds the spike's 92–98% claim).
  stats: {
    totalRecords: number;
    keptRecords: number;
    droppedRecords: number;
    codeBlocksRedacted: number;
  };
}

// A raw transcript record — the .jsonl line shape, loosely typed. We only reach
// into the few fields we keep; everything else is ignored (and thus dropped).
interface RawRecord {
  type?: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

// A single content block inside an assistant/user message's `content` array.
interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

/**
 * Replace every fenced code block (``` … ```, optionally with a language tag)
 * with the redaction sentinel. Inline `code` spans are left as-is: they're
 * short identifiers (a function name, a flag) that are rationale-bearing and
 * carry no meaningful source payload. Only fenced blocks — which is where real
 * code, diffs, and command output land — are scrubbed.
 *
 * Returns the redacted string AND a count of how many fences were removed (the
 * count is instrumentation, not load-bearing). The regex is greedy-per-fence
 * (non-greedy body) so adjacent fences don't merge into one redaction.
 */
export function redactCodeFences(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(/```[\s\S]*?```/g, () => {
    count += 1;
    return CODE_REDACTION;
  });
  // A dangling/unterminated fence (a ``` with no closing fence — e.g. the turn
  // was truncated) would otherwise leak everything after it. Redact from the
  // last unmatched ``` to end-of-string as a fail-closed backstop.
  const stray = out.lastIndexOf('```');
  if (stray !== -1) {
    return { text: out.slice(0, stray) + CODE_REDACTION, count: count + 1 };
  }
  return { text: out, count };
}

/**
 * Extract the natural-language text from one record, or null if the whole
 * record must be dropped. Drops:
 *   - any record whose type is not 'user' or 'assistant' (attachment, system,
 *     file-history-snapshot, mode, pr-link, …);
 *   - user records whose content is a tool_result array (no prose);
 *   - tool_use blocks within assistant content.
 * Keeps: user string prompts, and assistant `text` (+ `thinking`) blocks.
 */
function extractText(rec: RawRecord): { role: 'user' | 'assistant'; text: string } | null {
  if (rec.type !== 'user' && rec.type !== 'assistant') return null;
  const content = rec.message?.content;
  const role = rec.type;

  // A bare string is a real user prompt (the human typed it). Keep it.
  if (typeof content === 'string') {
    const t = content.trim();
    return t.length > 0 ? { role, text: t } : null;
  }

  if (!Array.isArray(content)) return null;

  // Block array: keep ONLY text/thinking blocks. tool_use and tool_result
  // blocks are dropped wholesale — that's where code + command I/O live.
  const parts: string[] = [];
  for (const raw of content as ContentBlock[]) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.type === 'text' && typeof raw.text === 'string') parts.push(raw.text);
    else if (raw.type === 'thinking' && typeof raw.thinking === 'string') parts.push(raw.thinking);
    // tool_use / tool_result / image / anything else → dropped.
  }
  const joined = parts.join('\n\n').trim();
  return joined.length > 0 ? { role, text: joined } : null;
}

/**
 * Parse + redact a list of already-deserialized transcript records into a
 * natural-language-only transcript. Pure: no file I/O, no parsing of bytes —
 * the caller hands us parsed records (one per .jsonl line) so this is trivially
 * testable and the fail-closed redaction is exercised without touching disk.
 */
export function redactTranscript(records: unknown[]): RedactedTranscript {
  const turns: TranscriptTurn[] = [];
  let sessionId: string | null = null;
  let kept = 0;
  let codeBlocksRedacted = 0;

  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as RawRecord;
    if (typeof rec.sessionId === 'string' && sessionId === null) sessionId = rec.sessionId;

    const extracted = extractText(rec);
    if (!extracted) continue;

    const { text: redacted, count } = redactCodeFences(extracted.text);
    codeBlocksRedacted += count;
    const trimmed = redacted.trim();
    if (trimmed.length === 0) continue; // a turn that was ALL code → nothing left
    turns.push({ role: extracted.role, text: trimmed });
    kept += 1;
  }

  return {
    sessionId,
    turns,
    stats: {
      totalRecords: records.length,
      keptRecords: kept,
      droppedRecords: records.length - kept,
      codeBlocksRedacted,
    },
  };
}

/**
 * Render the redacted transcript as a single plain-text blob for the LLM
 * prompt. Each turn is labelled with its role; no JSON, no tool scaffolding.
 */
export function renderTranscript(t: RedactedTranscript): string {
  return t.turns.map((turn) => `### ${turn.role.toUpperCase()}\n${turn.text}`).join('\n\n');
}

/** Parse a raw .jsonl string into records, skipping unparseable lines. */
export function parseJsonl(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A truncated/corrupt line is dropped — fail-closed, never half-parsed.
    }
  }
  return out;
}

/**
 * Pull the session's decision timestamp from its raw records: the LATEST
 * ISO-8601 top-level `timestamp` present (scanned BEFORE redaction drops the
 * records). Threaded out as `decidedAt` for the dedupe key + time slider.
 * Returns null when no record carries a parseable timestamp. The latest (not
 * first) is deliberate: a session's decisions are most accurately dated at the
 * point work settled, and a single per-session proxy keeps every decision from
 * one transcript on the same time-slider tick. Differing offset formats compare
 * chronologically (Date.parse), not lexically. Pure → unit-testable.
 *
 * This is the ONE implementation for both consumers: the cli capture hook
 * imports it via its `cli/src/redact.ts` shim, and the scripts/ingest backfill
 * re-exports it from `backfill.ts` (the historical home of the canonical copy,
 * which the claude-code adapter + tests still import from).
 */
export function sessionTimestamp(records: unknown[]): string | null {
  let latest = -Infinity;
  let latestIso: string | null = null;
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const ts = (raw as { timestamp?: unknown }).timestamp;
    if (typeof ts !== 'string') continue;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) continue;
    if (ms > latest) {
      latest = ms;
      latestIso = ts;
    }
  }
  return latestIso;
}

// --- File-path harvest ------------------------------------------------------

/** A leading `/` (or any run of them) — stripped when relativizing a path. */
function stripLeadingSlashes(p: string): string {
  let i = 0;
  while (i < p.length && p[i] === '/') i += 1;
  return p.slice(i);
}

/**
 * True iff `p` is an absolute POSIX path (starts with `/`). We deliberately do
 * NOT treat Windows drive paths or `~` as absolute: the agents we ingest stamp
 * POSIX cwds, and over-broadening would mis-classify a relative path as foreign.
 */
function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

/**
 * True iff a NON-POSIX-absolute string can't be confirmed repo-relative and so
 * must be DROPPED rather than kept verbatim. `isAbsolute` only matches POSIX `/`,
 * so without this guard a `~`-home, a `../`-escape, or a Windows-absolute path
 * would fall into the "already-relative" branch and be emitted unfiltered even
 * when a `repoRoot` was supplied. We treat as foreign (drop): a leading `~`
 * (home dir), a leading `../` or a bare `..` segment escaping the root, and the
 * two Windows-absolute forms — a drive letter (`X:\` / `X:/`) or a leading
 * backslash (`\server\share`, `\repo\x.ts`). Genuinely-relative POSIX paths
 * (`src/x.ts`, `./a/b.ts`) are NOT foreign. Pure string check, zero deps.
 */
function isForeignRelativePath(p: string): boolean {
  if (p.startsWith('~')) return true; // ~/secret/key.pem, ~root/x
  if (p.startsWith('\\')) return true; // \server\share, \repo\x.ts (Win/UNC absolute)
  if (/^[A-Za-z]:[\\/]/.test(p)) return true; // C:\repo\x.ts or C:/repo/x.ts (Win drive)
  // A `..` segment escaping the root, split on either separator so backslash
  // paths are caught too. Leading `./` runs are stripped first (canonical form).
  const stripped = p.replace(/^(?:\.[\\/])+/, '');
  return /^\.\.(?:[\\/]|$)/.test(stripped); // ../../etc/passwd, ..\x, bare ..
}

/**
 * Normalize an absolute path to repo-relative against `root`, or null when the
 * path is NOT under `root` (foreign to this repo → dropped). Pure string ops,
 * no `node:path`: the package is dependency-free + pure-string (load-bearing for
 * the esbuild-inlined CLI bundle). We compare on a `root` that's been trimmed of
 * trailing slashes and require either an exact match (the repo root itself) or a
 * `root/`-prefixed path so `/repo-other` is NOT treated as inside `/repo`.
 */
function relativizeUnder(abs: string, root: string): string | null {
  const trimmedRoot = root.replace(/\/+$/, '');
  if (trimmedRoot.length === 0) return null;
  if (abs === trimmedRoot) return ''; // the root itself → empty relative path
  const prefix = trimmedRoot + '/';
  if (!abs.startsWith(prefix)) return null;
  return stripLeadingSlashes(abs.slice(trimmedRoot.length));
}

/**
 * Collect candidate file-path strings out of one raw record's tool I/O —
 * BEFORE redaction drops those records. We treat all of this as DATA, never
 * instructions: we only read string fields at known shapes and never act on
 * their contents.
 *
 * Claude Code: `message.content[]` blocks with `type === 'tool_use'` →
 *   `input.file_path` (Edit/Write/Read), plus `input.path` /
 *   `input.notebook_path` (NotebookEdit and friends) and Bash `input.cwd`.
 * Codex: `payload.type === 'function_call'` may carry paths inside the
 *   JSON-string `payload.arguments` — we parse it defensively and pull the same
 *   path-named fields if present (shell `command` arrays are NOT path-harvested:
 *   a command string isn't a file path).
 */
function pathsFromRecord(rec: unknown): string[] {
  if (!rec || typeof rec !== 'object') return [];
  const out: string[] = [];
  const r = rec as {
    type?: unknown;
    message?: { content?: unknown };
    payload?: { type?: unknown; arguments?: unknown };
  };

  const pushFromInput = (input: unknown): void => {
    if (!input || typeof input !== 'object') return;
    const i = input as { file_path?: unknown; path?: unknown; notebook_path?: unknown; cwd?: unknown };
    for (const v of [i.file_path, i.path, i.notebook_path, i.cwd]) {
      if (typeof v === 'string' && v.trim().length > 0) out.push(v.trim());
    }
  };

  // Claude Code: tool_use blocks inside an assistant message's content array.
  const content = r.message?.content;
  if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as { type?: unknown; input?: unknown };
      if (block.type === 'tool_use') pushFromInput(block.input);
    }
  }

  // Codex: function_call args are a JSON STRING; parse defensively (a corrupt or
  // non-object args payload yields nothing — fail-closed, never throw).
  if (r.payload && typeof r.payload === 'object' && r.payload.type === 'function_call') {
    const args = r.payload.arguments;
    if (typeof args === 'string') {
      try {
        pushFromInput(JSON.parse(args));
      } catch {
        // Unparseable args → no paths from this record.
      }
    } else {
      pushFromInput(args);
    }
  }

  return out;
}

/** The in-transcript cwd Codex stamps into `session_meta.payload.cwd`, or null.
 *  Used as the repo-root fallback when the caller doesn't pass `repoRoot`. */
function codexSessionCwd(records: unknown[]): string | null {
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as { type?: unknown; payload?: { cwd?: unknown } };
    if (rec.type !== 'session_meta') continue;
    const cwd = rec.payload?.cwd;
    if (typeof cwd === 'string' && cwd.trim().length > 0) return cwd.trim();
  }
  return null;
}

/**
 * Harvest the repo-relative file paths an agent session touched, from its raw
 * (pre-redaction) records. The redaction fence DROPS the tool-use records these
 * paths live in, so this MUST run on the parsed records BEFORE `redactTranscript`
 * — same pre-redaction scan discipline as `sessionTimestamp`.
 *
 * `repoRoot` (optional): when given, each absolute path is normalized to
 * repo-relative by stripping the `repoRoot` prefix + leading slash. The caller
 * passes the WORKTREE root as `repoRoot`, so prefix-stripping handles worktrees
 * — we do NOT detect worktrees here. When `repoRoot` is omitted, we fall back to
 * an in-transcript root signal (Codex `session_meta.payload.cwd`); if no root can
 * be resolved, absolute paths are skipped (we NEVER emit machine-absolute paths)
 * and only already-relative paths are kept.
 *
 * Paths NOT under the resolved root are dropped (foreign to this repo). Already-
 * relative paths are kept as-is (deduped). Output is deduped + sorted for a
 * stable order. Pure → unit-testable; zero runtime deps (plain string ops).
 */
export function sessionPaths(records: unknown[], repoRoot?: string): string[] {
  const root = (repoRoot && repoRoot.trim().length > 0 ? repoRoot.trim() : codexSessionCwd(records)) ?? null;

  const seen = new Set<string>();
  for (const rec of records) {
    for (const p of pathsFromRecord(rec)) {
      if (isAbsolute(p)) {
        // Absolute path: needs a root to relativize against. No root → skip it
        // (never emit a machine-absolute path). Outside the root → foreign → drop.
        if (root === null) continue;
        const rel = relativizeUnder(p, root);
        if (rel === null || rel.length === 0) continue;
        seen.add(rel);
      } else if (!isForeignRelativePath(p)) {
        // Genuinely relative — keep as-is (a path the agent referenced relative
        // to the repo). Strip any leading `./` for a stable, canonical form.
        // Foreign forms (`~`-home, `../`-escape, Windows-absolute) are dropped
        // above: they can't be confirmed inside the repo, so we never emit them.
        const rel = p.replace(/^(?:\.\/)+/, '');
        if (rel.length > 0) seen.add(rel);
      }
    }
  }

  return Array.from(seen).sort();
}
