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
  // Cursor records the role at the TOP level (`role`), unlike Claude Code's `type`.
  role?: string;
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
 *   - any record whose ROLE is not 'user' or 'assistant' (attachment, system,
 *     file-history-snapshot, mode, pr-link, …);
 *   - user records whose content is a tool_result array (no prose);
 *   - tool_use blocks within assistant content.
 * Keeps: user string prompts, and assistant `text` (+ `thinking`) blocks.
 *
 * The role lives at a different field per agent: `type` (Claude Code), the
 * top-level `role` (Cursor), or `message.role`. We resolve from any of them — for
 * Claude Code, where role === type, the behaviour is unchanged.
 */
function extractText(rec: RawRecord): { role: 'user' | 'assistant'; text: string } | null {
  const role = rec.type ?? rec.role ?? rec.message?.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const content = rec.message?.content;

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
 * A URI scheme at the head of a token — `file://…`, `https://…`, `data:…` — and also
 * the Windows drive spelling `C:\`, which is the same shape with a one-letter scheme.
 *
 * NONE of these is a path this module can measure, and one of them was leaving.
 * `file:///…/other-repo/src/secret.ts` is not POSIX-absolute (it does not start with
 * `/`), so it fell into the "already-relative" branch, survived `..`-resolution as
 * `file:/…/other-repo/src/secret.ts`, and was EMITTED — a machine-absolute path naming
 * another repository, out of a module whose stated contract is that it never emits a
 * machine-absolute path at all. Decoding the URL and measuring the result would be
 * guessing at an authority, a drive and an encoding we were not given; refusing the
 * shape is the only answer that is true for every scheme. Matched only BEFORE the first
 * separator, so an ordinary path with a colon deeper in (`src/a:b.ts`) is untouched.
 */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Percent-escapes that decode to something structural — `/`, `\`, `.` or NUL. A token
 * carrying one is TWO different paths depending on who decodes it, and this module is
 * not the layer that decides: `vendor%2Fsrc/secret.ts` is one segment here and two to
 * anything that unescapes it, so the fence would be measuring a different path from the
 * one that eventually gets opened. Refuse the ambiguity rather than pick a reading of it.
 */
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c|2e|00)/i;

/**
 * Any C0 control character, NUL included.
 *
 * NUL is the one that cannot be a path at all: the syscall layer stops reading at it, so
 * a string carrying one names nothing on any filesystem this runs on. The rest — a
 * newline, a tab, an escape — are technically legal in a POSIX filename and are still
 * refused, because what arrives here is a transcript-supplied string that goes on to be
 * stored, joined, logged and rendered as a path. A "path" containing a newline is a
 * thing that renders as two, and nothing downstream is expecting that. It can only come
 * from a malformed or hostile tool-input field; the shell token class has never been
 * able to carry one.
 *
 * ONE HONEST QUALIFICATION: a path-named tool input is `trim()`ed before it gets here, so
 * a control character that JavaScript considers whitespace (tab, LF, VT, FF, CR) and that
 * sits at either END of the string is removed rather than refused, and the trimmed path is
 * kept. That is the right outcome — what is emitted carries no control character either
 * way — but it means "refused" is exactly true only of an INTERIOR one, plus NUL and the
 * non-whitespace controls (ESC, DEL) in any position. NUL is refused everywhere because
 * `trim()` does not consider it whitespace.
 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * True iff a NON-POSIX-absolute string can't be confirmed repo-relative and so
 * must be DROPPED rather than kept verbatim. `isAbsolute` only matches POSIX `/`,
 * so without this guard a `~`-home, a `../`-escape, a URI scheme or a Windows-absolute
 * path would fall into the "already-relative" branch and be emitted unfiltered even
 * when a `repoRoot` was supplied. We treat as foreign (drop): a leading `~`
 * (home dir), a leading `../` or a bare `..` segment escaping the root, a URI scheme
 * (`file://…` — which also subsumes the Windows drive letter `X:`, see `URI_SCHEME`).
 * Genuinely-relative POSIX paths (`src/x.ts`, `./a/b.ts`) are NOT foreign. Pure string
 * check, zero deps.
 *
 * A backslash and a percent-escaped separator are NOT checked here even though they read
 * like they belong: they are true of ABSOLUTE spellings too, and an absolute path never
 * reaches this function. Both live in the `sessionPaths` loop instead.
 *
 */
function isForeignRelativePath(p: string): boolean {
  if (p.startsWith('~')) return true; // ~/secret/key.pem, ~root/x
  if (URI_SCHEME.test(p)) return true; // file://…, https://…, and C:\repo\x.ts / C:/repo/x.ts
  // A `..` segment escaping the root. `/` is the ONLY separator this module knows —
  // see the backslash refusal in `sessionPaths`, which is what makes that true, and
  // which exists because having two answers to "what is a separator" is how a symlink
  // named `x\y` walked out of the repo. Leading `./` runs are stripped first.
  const stripped = p.replace(/^(?:\.\/)+/, '');
  return /^\.\.(?:\/|$)/.test(stripped); // ../../etc/passwd, bare ..
}

/**
 * Resolve `.` / `..` segments in a repo-RELATIVE POSIX path, returning the
 * normalized in-repo path, or null when the path ESCAPES the repo root (a `..`
 * pops above root, i.e. net traversal goes above the root). Defense-in-depth for
 * the trust boundary: `isForeignRelativePath` / `relativizeUnder` only catch a
 * LEADING `../`, so mid-path traversal (`a/../../etc/passwd`, or a
 * `/repo/../etc/passwd` that prefix-relativizes to `../etc/passwd`) would slip
 * through and be emitted verbatim. We never EMIT a path containing `..`: any
 * unresolved/escaping traversal → null (drop). An in-repo redundant segment
 * (`a/b/../c.ts`) collapses to a clean path (`a/c.ts`) and is kept.
 *
 * `/` IS THE ONLY SEPARATOR. This used to split on `\` as well, so that a Windows
 * spelling could be reduced like a POSIX one, and that second answer to "what is a
 * separator" was a live escape: on POSIX `\` is an ordinary filename character, so a
 * symlink named `x\y` pointing at another repository was read here as two segments that
 * do not exist, while the kernel opened it in one hop. A path carrying `\` is refused
 * outright in `sessionPaths` now — the ambiguity is not resolvable by this module, and
 * one answer everywhere beats two. Pure string ops, zero deps (no `node:path`) —
 * load-bearing for the bundle.
 */
function normalizeRepoRelative(rel: string): string | null {
  const out: string[] = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue; // collapse empty + same-dir segments
    if (seg === '..') {
      if (out.length === 0) return null; // pops above root → escapes → drop
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
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
 * The repo roots an absolute path may be measured against. A single string is the
 * historical contract and still works; a LIST is what lets one repo be present on
 * disk at several paths at once — a checkout plus its linked worktrees. They are
 * the same repo, so `<checkout>/src/a.ts` and `<worktree>/src/a.ts` must BOTH
 * relativize to `src/a.ts` rather than the second being discarded as foreign.
 *
 * Membership is decided by the CALLER, never here: this package is pure and cannot
 * ask git or the filesystem anything. Whatever roots arrive are taken to belong to
 * one repo; a path under none of them is still foreign and is still dropped, which
 * is what keeps a genuinely different repo out however many roots are supplied.
 */
export type SessionRoots = string | readonly string[];

/**
 * Clean, dedupe and ORDER the roots for matching. Longest first, because roots can
 * nest: with a worktree parked inside its own checkout (`/repo` and `/repo/wt`) a
 * file at `/repo/wt/src/a.ts` is under both, and only the deeper root yields the
 * path the repo knows the file by (`src/a.ts`, not `wt/src/a.ts`). Trailing slashes
 * are trimmed here so the ordering is decided on the same strings `relativizeUnder`
 * will go on to compare.
 */
function normalizeRoots(roots: readonly string[]): string[] {
  const cleaned: string[] = [];
  for (const r of roots) {
    if (typeof r !== 'string') continue;
    const trimmed = r.trim().replace(/\/+$/, '');
    if (trimmed.length === 0) continue;
    if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
  }
  return cleaned.sort((a, b) => b.length - a.length);
}

/**
 * Relativize `abs` against the first (deepest) root that contains it, then resolve
 * whatever `..` the string-prefix strip left behind. Null when the path is under NO
 * root — foreign, dropped.
 *
 * A path that IS a root names a directory, not a file, and resolves to nothing. We
 * stop there rather than re-measuring it against a shallower root: that preserves
 * the single-root behaviour exactly (the root itself was always dropped) instead of
 * quietly turning a session's cwd into a harvested directory name.
 */
function relativizeUnderAny(abs: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const rel = relativizeUnder(abs, root);
    if (rel === null) continue;
    if (rel.length === 0) return null; // the root itself → not a file
    return normalizeRepoRelative(rel);
  }
  return null;
}

/**
 * File extensions a token scraped out of a SHELL COMMAND must end in to count as
 * a file path. Exported so the accepted set is reviewable in one place (and so a
 * consumer can assert against it) rather than buried in a regex literal.
 *
 * This gate applies ONLY to the shell-command scan. Path-named tool inputs
 * (`file_path`, `path`, `notebook_path`, `cwd`) are already unambiguous and stay
 * ungated — a `cwd` is a directory and has no extension at all.
 */
export const HARVESTED_PATH_EXTENSIONS: readonly string[] = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'css', 'scss', 'html', 'json', 'sql', 'md', 'yml', 'yaml', 'sh', 'toml',
  'py', 'rb', 'ex', 'exs', 'php', 'kt', 'dart', 'swift', 'java', 'go',
];

// ALTERNATION ORDER IS NOT A GUARD — the trailing lookahead is. JS alternation is
// first-match-wins, so it is tempting to sort longest-first and call that the thing
// stopping `package.json` from matching as `package.js`. It isn't: `SHELL_PATH_TOKEN`
// ends in `(?![\w.@~+/\\-])`, and every shorter extension in this list is followed by
// a word character in the pair that shadows it (`js` inside `json`, `ts` inside `tsx`,
// `ex` inside `exs`), so the lookahead rejects the short match and the engine
// backtracks to the long one on its own. A longest-first sort here is measurably dead
// code — reversing this list produces byte-identical output — so it is deliberately
// absent rather than present-and-untested. If you ever weaken the lookahead, the
// shadowing pairs above are what breaks.
const EXT_ALTERNATION = HARVESTED_PATH_EXTENSIONS.join('|');

/**
 * Longest plausible repo-relative path, in characters. A shell command can carry a
 * heredoc, a base64 blob, or a generated one-liner; `+` and `/` both being legal in
 * base64 means a blob can present as an enormous "path". Fuzzing produced a single
 * 16,892-character token. No file anyone learns a system from is anywhere near this.
 */
const MAX_SHELL_PATH_CHARS = 200;

/**
 * Most distinct shell-derived paths one session may contribute. Fuzzing produced a
 * single command yielding 20,000. The cap is applied in ENCOUNTER order, before the
 * final sort, deliberately: the output is sorted, so truncating after sorting would
 * systematically keep alphabetically-early junk (`.git/…`, `AAAA+bbb/…`) and throw
 * away the real source files this harvest exists to capture.
 */
const MAX_SHELL_PATHS = 200;

/**
 * Directories that exist on disk, pass every other gate, and are still never part of
 * the system anyone is learning. Applied to shell-derived paths only — a path-named
 * tool input is an explicit act by the agent and keeps its existing behaviour.
 */
const SHELL_EXCLUDED_DIRS = new Set(['.git', 'node_modules']);

/** Options for `sessionPaths`. */
export interface SessionPathsOptions {
  /**
   * Does `repoRelativePath` name a file that actually exists in this repo?
   *
   * REQUIRED for any shell-derived path to be emitted at all. A token scraped out
   * of a command string can be a file outside the repo reached after a `cd`, a
   * hostname in a scheme-less URL, a REST route, a string literal inside a heredoc,
   * or prose in a heredoc'd document. Every one of those is well-formed enough that
   * no string rule can reject it, and every one of them is, by construction, not a
   * file in the repo — so existence is the only check that separates them from the
   * real thing. Omit this and NO shell-derived path is emitted (fail closed); path-
   * named tool inputs are unaffected either way.
   *
   * Injected rather than performed here because this package is pure and dependency-
   * free by design (the CLI bundle inlines it). The caller already holds the repo
   * root and a filesystem; it should memoise, since one session asks thousands of
   * times.
   *
   * KNOWN TRADE: a file the session DELETED no longer exists, so its path is lost.
   * Accepted — a decision anchored to a path that resolves to nothing teaches
   * nobody anything, and the alternative is trusting every unverifiable token.
   */
  exists?: (repoRelativePath: string) => boolean;

  /**
   * Does `candidate`, FOLLOWED ON DISK IN THE SPELLING IT ARRIVED IN, land outside
   * every root of this repo? Return true and the path is dropped.
   *
   * WHY THIS EXISTS. Containment above is decided by string prefix, and a string
   * prefix does not survive a symlink. With `repoA/vendor` linked at `repoB`, the
   * path `<repoA>/vendor/src/secret.ts` is under the root `<repoA>` by every rule
   * this module can apply, so it relativizes to `vendor/src/secret.ts` and is
   * emitted — as one of THIS repo's paths, while the file it names belongs to
   * another repository. That is a cross-repo leak of exactly the thing the roots
   * were introduced to get right, and no amount of string reasoning closes it: only
   * the filesystem knows where a link goes. Same seam as `exists` and for the same
   * reason — this package is pure and dependency-free (load-bearing for the
   * esbuild-inlined bundle), so the caller, which already holds a filesystem and the
   * roots, answers and this module obeys.
   *
   * IT RECEIVES THE ORIGINAL SPELLING, AND THAT IS THE WHOLE POINT. The first version
   * of this predicate was handed the NORMALIZED path, and could not close the leak it
   * was written for: `normalizeRepoRelative` cancels `..` arithmetically, and
   * cancelling `..` against a SYMLINKED segment gives the wrong answer, because the
   * link does not go where its name says. `dlink/../src/a.ts`, with `dlink` a link to
   * another repository, reduces on paper to `src/a.ts` — indistinguishable from a file
   * of our own — while the kernel opens the other repo's `src/a.ts`. By the time a
   * post-normalization predicate is called the evidence has already been destroyed
   * upstream, inside this function, and no predicate at that position can recover it.
   * So the candidate crosses this boundary UNCHANGED, `..` and all, and the caller
   * resolves it against the filesystem BEFORE anything reduces it. A half-resolved path
   * crossing this boundary is the defect, not a convenience.
   *
   * Applies to EVERY origin, not just shell tokens. A `file_path` tool input reached
   * through a link escapes just as completely as a scraped one, and the leak was
   * measured on the tool-input route.
   *
   * IT REPORTS A CONTRADICTION, NOT AN ABSENCE. "The filesystem says this path leaves
   * the repo" is a drop; "the filesystem cannot say" is not. A path that resolves
   * nowhere under any root — the file the session DELETED, most often — must return
   * false and be kept, because the alternative is to silently impose `exists` on
   * path-named tool inputs, which have never required it, and lose the paths of every
   * removed file. The predicate that decides EXISTENCE is `exists`; this one decides
   * DESTINATION.
   *
   * ONE ROOT DISAGREEING IS ENOUGH TO DROP IT, and that is not the same as asking
   * whether SOME root can vouch for it. Roots are checkouts of one repo, so every
   * tracked directory exists in all of them — which means a sibling worktree will
   * happily confirm a name whose spelling in THIS checkout is a link to somebody
   * else's repo. Answering "is it inside anywhere?" lets that confirmation launder
   * the escape; answering "does anything say it left?" does not.
   *
   * IT IS GIVEN THE ROOTS THE HARVEST ACTUALLY USED, not the ones the caller passed
   * in. When the caller supplies none, this module falls back to a root it found in
   * the transcript — and a predicate closed over the caller's empty list would then
   * be measuring against directories that had nothing to do with the paths being
   * relativized, and could only ever answer "no escape". Handing the effective roots
   * to the predicate is what keeps the promise that there is no second, weaker route
   * into the output.
   *
   * Omit it and containment stays string-only — the long-standing behaviour. The
   * shipped CLI always supplies it. Should memoise: one session asks thousands of
   * times.
   */
  escapesRepo?: (candidate: PathCandidate, roots: readonly string[]) => boolean;
}

/**
 * A harvested path in the spelling it was harvested in, before any normalization —
 * what `escapesRepo` is asked about.
 *
 * `raw` is verbatim: absolute or relative, `.` and `..` intact, no `./` stripped and no
 * leading whitespace trimmed. `/` is its only separator — a spelling carrying `\` is
 * refused before it gets here, so this is never two spellings of one path. That is deliberate and load-bearing (see `escapesRepo`): every
 * reduction this module could apply first is a reduction that can be wrong in the
 * presence of a symlink, so none of them is applied before the filesystem has spoken.
 *
 * `absolute` says which question the caller is answering, because they are different
 * questions and only the caller can tell them apart from the string. An ABSOLUTE raw
 * names exactly one place on this machine and can be resolved on its own. A RELATIVE
 * raw carries no evidence of what it is relative to, so it can only be measured
 * against the roots — every one of them, since any single root that says the path left
 * the repo is a contradiction, while a root that confirms it is merely one opinion.
 */
export interface PathCandidate {
  /** The path exactly as harvested — never reduced, never relativized. */
  raw: string;
  /** True iff `raw` is POSIX-absolute (starts with `/`). */
  absolute: boolean;
  /**
   * The working directories THE TOOL CALL ITSELF NAMED, which is the context the fence
   * previously had to guess at and kept guessing wrong.
   *
   * A relative spelling means nothing without the directory it is relative to, and the
   * kernel uses the working directory of the tool call that produced it — not the
   * session's, and not the repo root. Those differ constantly: measured over 73,406 real
   * shell commands, **71.9% contain a `cd`**, and 86.8% of the commands carrying a
   * relative path token do. Every escape in this family is the same shape — the fence
   * measuring a DIFFERENT PATH from the one that gets opened — and this is the last
   * remaining source of that difference, so the originating directory now travels WITH
   * the candidate rather than being inferred after the fact.
   *
   * Each entry is a composed directory SPELLING: POSIX-absolute when the tool call stated
   * an absolute one, otherwise relative to whatever the caller measures relative paths
   * against. They are spellings, not resolved paths, for exactly the reason `raw` is:
   * this package is pure and cannot ask the filesystem anything, and a reduction applied
   * before the filesystem has spoken is a reduction that a symlink can make wrong.
   *
   * ANY ONE OF THEM CONTRADICTING IS ENOUGH TO DROP THE PATH — the same rule the caller
   * already applies to roots, and for the same reason. Usually there is exactly one entry
   * (the tool call's directory, moved by whatever `cd`s precede the token). More than one
   * means the command could not be read positionally — a `cd "$VAR"`, a subshell — and
   * the list is then a conservative superset rather than an answer.
   *
   * Empty means the tool call named no directory at all, and the caller's existing bases
   * are all there is. That is the pre-existing behaviour, unchanged.
   */
  bases: readonly string[];
}

/**
 * Path-shaped tokens inside a shell command string. Deliberately a TOKEN SCAN,
 * not a shell parse — we never interpret the command, we only pick substrings
 * that look like files. Only the matched substrings are ever emitted; the
 * command string itself never leaves this module, so a heredoc full of source
 * can contribute a path but never a line of code.
 *
 * Shape: `[/]seg/seg[/seg…].ext`
 *  - **Must contain at least one `/`** — the `(?:/…)+` group is not optional. A
 *    bare `index.ts` names a file we can't attribute (every package has one), so
 *    ambiguous single-segment tokens are dropped rather than guessed at.
 *  - The segment class `[\w.@~+-]` excludes every shell metacharacter, so
 *    quoting, `$( )`, `=`, `:`, `,`, `;`, `|`, `&`, redirects and parens all act
 *    as natural token boundaries — no stripping pass needed. It also excludes the
 *    glob metacharacters `* ? [ { `, so `src/*.ts` and `src/a[0].ts` simply do not
 *    match (a glob is not a file).
 *  - The lookahead rejects a token followed by a path-ish character. THIS is what
 *    keeps `package.json` from harvesting as `package.js`, and `bundle.js.map`
 *    from harvesting as `bundle.js` — not the order of the extension list.
 *  - The lookbehind rejects a token whose preceding character is itself path-ish.
 *    It stops a mid-path false start (`…/vendor/x.json` re-matching at `x`). It is
 *    NOT what keeps URLs out, despite how it reads: measured, deleting it leaves
 *    every URL case still passing, because `https://example.com/x.json` matches at
 *    the second slash as the ABSOLUTE path `/example.com/x.json` and is then
 *    dropped for being outside the repo root. Say what actually holds a line.
 *
 * A REGEX CANNOT DECIDE THIS, which is the load-bearing point. `cd /etc && cat
 * app/secrets.json` names a file outside the repo using a token indistinguishable
 * from a real relative path; a scheme-less `curl internal-api.example/v3/x.json`
 * is a hostname; a heredoc writing a `.ts` file contains string literals shaped
 * exactly like paths. All three were produced by fuzzing and all three used to be
 * emitted. So the scan is only a CANDIDATE generator: everything it yields runs
 * through the SAME absolute/relative fence as every other harvested path
 * (`isAbsolute` → `relativizeUnder` → `normalizeRepoRelative`, or
 * `isForeignRelativePath`) AND THEN through the caller's `exists` predicate, which
 * is the actual authority on whether a token names a file in this repo. There is
 * no second, weaker route into the output.
 */
const SHELL_PATH_TOKEN = new RegExp(
  `(?<![\\w.@~$+/\\\\-])/?[\\w.@~+-]+(?:/[\\w.@~+-]+)+\\.(?:${EXT_ALTERNATION})(?![\\w.@~+/\\\\-])`,
  'g',
);

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
 *   path-named fields if present.
 *
 * SHELL COMMANDS ARE SCANNED TOO (`input.command`). Measured on real Claude Code
 * transcripts, shell calls now outnumber Read/Edit/Write by more than an order of
 * magnitude — an agent greps, seds and `git diff`s far more than it opens files
 * through a path-named tool — so reading only the path-named fields left roughly
 * half of all sessions with an EMPTY path list and their decisions unanchored.
 * The file a shell call touches is named inside the command string, so we scan it
 * with `SHELL_PATH_TOKEN` above. We match on the FIELD, not on the tool's name,
 * so an agent that calls its shell tool something other than `Bash` is covered
 * too; Codex passes the same field as an argv array, which we join first.
 */
/**
 * One candidate path plus WHERE it came from. The origin decides which gates apply:
 * a path-named tool input is an unambiguous, explicit act by the agent and keeps its
 * long-standing behaviour, while a token scraped out of a command string is a guess
 * and has to earn its place (see `sessionPaths`).
 */
interface CandidatePath {
  raw: string;
  fromShell: boolean;
  bases: readonly string[];
}

/**
 * A `cd` that actually moves the shell, with its target captured.
 *
 * Anchored to a COMMAND POSITION — start of string, or after `;`, `&&`, `||`, `|`, `(`
 * or a newline — so the word `cd` inside a heredoc, a filename, a flag value or a comment
 * is not mistaken for one. `cd -` is excluded: it returns to the PREVIOUS directory, which
 * is a history this scan does not keep, so it is treated as unreadable rather than guessed
 * at (see `UNREADABLE_CD_TARGET`).
 *
 * This is NOT a shell parse and must never become one. It reads exactly one construct,
 * and everything it cannot read makes the harvest MORE conservative rather than less —
 * which is the only direction a partial reading of an attacker-shaped string may fail in.
 */
const SHELL_CD = /(?:^|[;&|(\n]|&&|\|\|)\s*cd\s+(?!-\s|-$)(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))/g;

/**
 * A `cd` target this scan must not pretend to understand: a variable or command
 * substitution (`$HOME`, `` `pwd` ``), a `~` the shell expands from an environment we do
 * not have, or a glob. Guessing at any of them would produce a base that is confidently
 * wrong, and a wrong base is the entire defect class this change exists to close — so an
 * unreadable target instead makes the command fail CLOSED (every readable target becomes
 * a base, and any one of them contradicting drops the path).
 */
const UNREADABLE_CD_TARGET = /[$`~*?[\]{}]/;

/**
 * Compose a `cd` target onto the directory in effect. Absolute targets REPLACE it, which
 * is what `cd /elsewhere` does; relative targets descend from it, which is what `cd sub`
 * does. Pure string composition — `.` and `..` are left in the spelling for the caller to
 * resolve against the filesystem, never cancelled here, because cancelling `..` against a
 * symlink is the original defect in this family wearing a different costume.
 */
function composeBase(current: string | null, target: string): string {
  if (target.startsWith('/')) return target;
  if (current === null || current.length === 0) return target;
  return `${current.replace(/\/+$/, '')}/${target}`;
}

/**
 * The working directory in effect at each offset in a command string, plus whether that
 * reading is EXACT.
 *
 * Positional, because a command is a sequence: in `cat a/x.ts && cd sub && cat b/y.ts`
 * the two tokens are relative to different directories, and measuring both against the
 * union would drop the first one for a move that had not happened yet. Measured, the
 * positional reading also drops fewer legitimate paths than the union (72.1% vs 73.7% of
 * an at-risk set that is itself dominated by a measurement artifact).
 *
 * `exact: false` means some `cd` in this command could not be read, so no offset in it has
 * a trustworthy answer and the caller must be handed every readable base at once.
 */
function shellCdBases(text: string, cwd: string | null): { at: number; base: string }[] & { exact?: boolean } {
  const events: { at: number; base: string }[] = [];
  let exact = true;
  let chain: string | null = cwd;
  for (const m of text.matchAll(SHELL_CD)) {
    const target = m[1] ?? m[2] ?? m[3] ?? '';
    if (target.length === 0 || UNREADABLE_CD_TARGET.test(target)) {
      exact = false;
      continue;
    }
    chain = composeBase(chain, target);
    events.push({ at: (m.index ?? 0) + m[0].length, base: chain });
  }
  const out = events as { at: number; base: string }[] & { exact?: boolean };
  out.exact = exact;
  return out;
}

function pathsFromRecord(rec: unknown, sessionCwd: string | null): CandidatePath[] {
  if (!rec || typeof rec !== 'object') return [];
  const out: CandidatePath[] = [];
  const r = rec as {
    type?: unknown;
    cwd?: unknown;
    message?: { content?: unknown };
    payload?: { type?: unknown; arguments?: unknown };
  };
  // THE RECORD'S OWN WORKING DIRECTORY. Claude Code stamps `cwd` on every record, and it
  // is the directory that tool call ran in — the exact context the fence has been
  // inferring. Measured: present on 73,281 of 73,281 shell tool-use records, while the
  // `input.cwd` field this was expected to arrive in appears on 0 of 110,141 tool inputs.
  // The per-record stamp is the real signal; the input field is kept below because Codex
  // and other agents may still use it, and because it costs nothing.
  const recordCwd =
    typeof r.cwd === 'string' && r.cwd.trim().length > 0 ? r.cwd.trim() : sessionCwd;

  // A shell command: one string (Claude Code `Bash`) or an argv array (Codex
  // `shell`: ["bash","-lc","…"]). Join an array on a space — the scan is
  // whitespace-boundary-tolerant, so an argv entry is just another token.
  const pushFromCommand = (command: unknown, cwd: string | null): void => {
    const text =
      typeof command === 'string'
        ? command
        : Array.isArray(command)
          ? command.filter((c): c is string => typeof c === 'string').join(' ')
          : null;
    if (text === null || text.length === 0) return;
    const cds = shellCdBases(text, cwd);
    const exact = cds.exact !== false;
    // Every readable base at once, for the case where the command could not be read
    // positionally. Kept outside the token loop: it does not vary by offset.
    const conservative = cds.length > 0 || cwd !== null ? [...(cwd !== null ? [cwd] : []), ...cds.map((e) => e.base)] : [];
    for (const m of text.matchAll(SHELL_PATH_TOKEN)) {
      let bases: readonly string[];
      if (!exact) {
        // FAIL CLOSED. A `cd` we could not read means no offset in this command has a
        // trustworthy answer, so the token is measured against every directory it could
        // plausibly have been relative to and a single contradiction drops it. Measured
        // cost: 851 of 73,406 commands, and it is the honest answer for all of them.
        bases = conservative;
      } else {
        // The directory in effect AT THIS OFFSET — the last `cd` that precedes the token,
        // or the tool call's own directory when none does.
        let base: string | null = cwd;
        for (const e of cds) {
          if (e.at > (m.index ?? 0)) break;
          base = e.base;
        }
        bases = base === null ? [] : [base];
      }
      out.push({ raw: m[0], fromShell: true, bases });
    }
  };

  const pushFromInput = (input: unknown): void => {
    if (!input || typeof input !== 'object') return;
    const i = input as {
      file_path?: unknown;
      path?: unknown;
      notebook_path?: unknown;
      cwd?: unknown;
      command?: unknown;
    };
    // The directory THIS tool call ran in. An explicit `cwd` on the input wins over the
    // record's stamp, because it is the more specific statement of the same fact.
    const blockCwd =
      typeof i.cwd === 'string' && i.cwd.trim().length > 0 ? i.cwd.trim() : recordCwd;
    const inputBases = blockCwd === null ? [] : [blockCwd];
    for (const v of [i.file_path, i.path, i.notebook_path, i.cwd]) {
      // TRIM THE TAIL ONLY. This used to push `v.trim()`, and trimming the HEAD is an
      // escape: `trim()` erases leading whitespace, the FIRST SEGMENT is a head, and a
      // symlink can be named ` vendor`. The agent reports ` vendor/src/secret.ts`, the
      // fence measures `vendor/src/secret.ts`, finds no `vendor` in the repo, reads that
      // as empty ground inside it, and keeps the path — while the kernel opens the other
      // repository in one hop. Same defect as `..` cancelled on the string and as `\`
      // read as a separator: the fence measuring a DIFFERENT PATH from the one opened.
      //
      // The tail is safe and is still trimmed, because the walk never follows the last
      // segment, so nothing the tail does can change where the path resolves — and a
      // trailing newline is common enough in a tool-input field that refusing it would
      // cost real paths. A LEADING control character is not trimmed here and is refused
      // outright by `CONTROL_CHARACTER` below.
      if (typeof v === 'string' && v.trim().length > 0)
        out.push({ raw: v.trimEnd(), fromShell: false, bases: inputBases });
    }
    pushFromCommand(i.command, blockCwd);
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
 * `repoRoot` (optional): the root, or ROOTS, an absolute path is normalized against
 * by stripping the root prefix + leading slash. One string is the original contract.
 * A LIST is what makes this worktree-aware: a repo checked out at several paths at
 * once (a checkout plus its linked worktrees) is ONE repo, and a file edited in any
 * of them must relativize to the same repo-relative path instead of being discarded
 * as foreign. Passing a single root that happens to be a worktree only ever covered
 * the worktree the session started in — every sibling worktree it touched was lost,
 * which on a machine where parallel worktrees are the normal workflow silently
 * emptied the path list for whole sessions.
 *
 * We still do NOT detect worktrees here: this package is pure and dependency-free
 * (load-bearing for the esbuild-inlined bundle), so it cannot ask git which paths
 * are the same repo. The caller resolves that and hands the answer down.
 *
 * When `repoRoot` is omitted we fall back to an in-transcript root signal (Codex
 * `session_meta.payload.cwd`); if no root can be resolved, absolute paths are
 * skipped (we NEVER emit machine-absolute paths) and only already-relative paths
 * are kept.
 *
 * Paths under NONE of the resolved roots are dropped (foreign to this repo).
 * Already-relative paths are kept as-is (deduped). Output is deduped + sorted for a
 * stable order. Pure → unit-testable; zero runtime deps (plain string ops).
 *
 * `options.exists` — REQUIRED for any shell-derived path to be emitted; see
 * `SessionPathsOptions`. Without it this function behaves exactly as it did before
 * shell scanning existed.
 */
export function sessionPaths(
  records: unknown[],
  repoRoot?: SessionRoots,
  options?: SessionPathsOptions,
): string[] {
  // Defensive on the shape as well as the contents: this is a public MIT API and a
  // JS caller can hand us anything. Anything that is neither a string nor an array
  // contributes no roots rather than throwing mid-harvest.
  const supplied = normalizeRoots(
    typeof repoRoot === 'string' ? [repoRoot] : Array.isArray(repoRoot) ? repoRoot : [],
  );
  // Only fall back to the transcript's own cwd when the caller supplied NOTHING
  // usable — an empty list is "I looked and found no roots", not "use the default".
  // The transcript's own stated cwd serves TWO purposes, and they are not the same one.
  // As a ROOT it is a last-resort fallback, used only when the caller supplied nothing.
  // As a BASE it is always relevant: it is what a relative path in a Codex record is
  // relative to, and a record that carries no cwd of its own inherits it.
  const sessionCwd = codexSessionCwd(records);
  const roots = supplied.length > 0 ? supplied : normalizeRoots([sessionCwd ?? '']);
  const exists = options?.exists;
  const escapesRepo = options?.escapesRepo;

  const seen = new Set<string>();
  let shellPathCount = 0;
  for (const rec of records) {
    for (const { raw: p, fromShell, bases } of pathsFromRecord(rec, sessionCwd)) {
      // FAIL CLOSED. A shell token is a guess until something confirms it names a
      // real file in this repo. A consumer that hasn't opted in by supplying
      // `exists` gets the pre-scan behaviour rather than unverified guesses — the
      // absence of a check must never be the reason something leaks.
      if (fromShell && exists === undefined) continue;
      // Any C0 control character, NUL included — see `CONTROL_CHARACTER`, which carries
      // the reasoning and the one honest qualification about trimming. Refused at the
      // fence, where every candidate passes, rather than asking each consumer to cope
      // with a string that cannot be, or should not be, a path.
      if (CONTROL_CHARACTER.test(p)) continue;
      // A percent-escaped path separator makes the token TWO different paths depending
      // on who decodes it, and every gate below — and the caller's filesystem check
      // above all — would then be measuring a different path from the one that
      // eventually gets opened. Refused here rather than in `isForeignRelativePath`,
      // because it is true of ABSOLUTE spellings too and that function never sees them.
      if (ENCODED_PATH_SEPARATOR.test(p)) continue;
      // A BACKSLASH, for exactly the same reason, and it was a live leak.
      //
      // This module used to treat `\` as a second path separator, so that a Windows
      // spelling could be normalized like a POSIX one. POSIX does not: there, `\` is an
      // ordinary character in a filename. So a symlink genuinely NAMED `x\y`, pointing
      // at another repository, was split by the fence into the segments `x` and `y`,
      // neither of which exists — the fence found nothing on disk, read that as empty
      // ground inside the repo, and kept the path. The kernel resolves `x\y` in one hop
      // into the other repository. Measured: the file really opens, and the path
      // reached the wire as `x/y/src/secret.ts`, a path this repo does not have.
      //
      // That is the same defect as `..` cancelled on the string, in a different
      // costume: the fence measuring a DIFFERENT PATH from the one that gets opened.
      // There is no reading of `\` that is right on both platforms, and this module
      // cannot know which one produced the string — so it refuses the ambiguity
      // instead of picking, and `\` is not a separator anywhere below this line.
      if (p.includes('\\')) continue;
      // Length cap BEFORE the fence: a base64 blob is not a path, and there is no
      // reason to normalize 17 kilobytes of it to find that out.
      if (fromShell && p.length > MAX_SHELL_PATH_CHARS) continue;

      let norm: string | null;
      if (isAbsolute(p)) {
        // Absolute path: needs a root to relativize against. No roots → skip it
        // (never emit a machine-absolute path). Under none of them → foreign → drop.
        // `relativizeUnderAny` also re-checks the relativized RESULT, because
        // string-prefix relativization can leave a `../`-escape
        // (`/repo/../etc/passwd` → `../etc/passwd`).
        if (roots.length === 0) continue;
        norm = relativizeUnderAny(p, roots);
      } else if (!isForeignRelativePath(p)) {
        // Genuinely relative — keep as-is (a path the agent referenced relative
        // to the repo). Strip any leading `./` for a stable, canonical form.
        // Foreign forms (`~`-home, `../`-escape, Windows-absolute) are dropped
        // above: they can't be confirmed inside the repo, so we never emit them.
        // `isForeignRelativePath` only catches a LEADING `../`, so normalize to
        // resolve MID-path `..` and drop any that escape the root.
        norm = normalizeRepoRelative(p.replace(/^(?:\.\/)+/, ''));
      } else {
        continue;
      }
      if (norm === null || norm.length === 0) continue;

      if (fromShell) {
        // A relative token carries no evidence of WHERE it is relative to. `cd /etc
        // && cat app/secrets.json` yields `app/secrets.json`, which the fence above
        // cannot fault — it is a well-formed in-repo-looking path naming a file
        // outside the repo. So does a scheme-less URL, a REST route, and a string
        // literal inside a heredoc. Only the filesystem can settle it, so the last
        // word belongs to the caller's predicate, not to any string rule here.
        if (norm.split('/').some((seg) => SHELL_EXCLUDED_DIRS.has(seg))) continue;
        if (!exists!(norm)) continue;
      }
      // The last word on containment, for EVERY origin. Everything above decided it
      // by string prefix and by arithmetic on `..`, and a symlink walks straight
      // through both: a path under a root by every rule this pure module can apply can
      // still name a file in another repository. Only the filesystem knows, so the
      // caller's predicate answers here — after the cheap string gates have already
      // rejected what they can, and BEFORE the shell budget is charged, so a path that
      // is about to be dropped never consumes the quota of one that would have been
      // kept.
      //
      // IT IS ASKED ABOUT `p`, NOT `norm`. `norm` is the answer to a different
      // question — what we would EMIT — and getting there cost us the `..` segments
      // that are the evidence. `dlink/../src/a.ts` is already spelled `src/a.ts` by
      // this line. The predicate needs what arrived, so that is what it gets.
      //
      // IT IS ALSO GIVEN THE DIRECTORIES THE TOOL CALL NAMED. Everything above measures a
      // relative spelling against directories this module INFERRED — the session's cwd and
      // the roots — and the kernel uses the working directory of the tool call that
      // produced it. `bases` is that directory, carried down from the record rather than
      // guessed at after the fact; see `PathCandidate.bases`.
      if (escapesRepo?.({ raw: p, absolute: isAbsolute(p), bases }, roots)) continue;
      // Cap in ENCOUNTER order (see MAX_SHELL_PATHS) — never after the sort.
      if (fromShell && !seen.has(norm)) {
        if (shellPathCount >= MAX_SHELL_PATHS) continue;
        shellPathCount += 1;
      }
      seen.add(norm);
    }
  }

  return Array.from(seen).sort();
}
