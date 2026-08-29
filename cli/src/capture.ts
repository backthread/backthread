// capture.ts — the capture pipeline behind the SessionEnd/Stop hook.
//
// This is the self-maintaining moat: at the end of every agent session, derive the
// session's DECISIONS (the "why") and land them in the hosted decision log, so the
// log stays current instead of going stale after the one-time backfill.
//
// THE PIPELINE (all LOCAL until the very last network hop):
//   1. read the hook input (stdin/env JSON) → transcript_path + cwd + session_id
//   2. read the .jsonl transcript off disk
//   3. parse + REDACT it LOCALLY (redact.ts — the security fence). No source code,
//      no tool I/O ever leaves the machine; only redacted natural-language prose +
//      the [code redacted] sentinel survive. We ALSO harvest two bits of METADATA
//      from the raw records before redaction drops them: the session timestamp
//      (sessionTimestamp) and the repo-relative file PATHS the session touched
//      (sessionPaths) — directory structure, NOT file contents. Paths ≠ contents,
//      so never-store-SOURCE still holds; see /security for this metadata egress.
//   4. derive decisions via the router (infer.ts). Default = the Model-2
//      server path (our keys): the REDACTED transcript (+ the file-path metadata)
//      is POSTed to the Worker's /infer-decisions, which runs the tuned pipeline,
//      returns derived decisions, and (on the persist leg) ANCHORS them to modules
//      via the harvested paths.
//   5. persist:
//        - if the router already persisted (result.persisted === true) → DONE.
//          Re-POSTing would double-write (the server's persist leg is membership-
//          gated + only fires on a connected repo).
//        - else POST the DERIVED decisions to ingest-decisions, which routes
//          connected vs repo-less server-side and persists.
//
// NON-NEGOTIABLE POSTURE — BEST-EFFORT + NON-BLOCKING (the whole point of a hook):
//   A capture hiccup must NEVER disrupt or delay the user's Claude Code session.
//   Every step is wrapped; ANY failure is swallowed and the handler resolves with a
//   structured outcome (never throws). The bin entry exits 0 regardless. We also
//   never block the session waiting on auth: if there's no device token we kick off
//   `ensureAuth` fire-and-forget (best-effort) and skip THIS capture rather than
//   stall the terminal on a browser round-trip.
//
// TRUST BOUNDARY (load-bearing): redaction (step 3) happens BEFORE inference (step
// 4), so the inference router only ever sees the redacted shape — the never-store-
// source claim holds. On the Model-2 path the *redacted* transcript reaches our
// Worker (the weaker, /security-stated claim), alongside repo-relative file-path
// METADATA (directory structure, not contents — the anchor signal); derived
// decisions are all that reach ingest-decisions.

import { readFile } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { readConfig, type BackthreadConfig } from './config.js';
import { ensureAuth } from './login.js';
import { parseJsonl, redactTranscript, sessionPaths, sessionTimestamp } from './redact.js';
import {
  resolveRepo,
  resolveGitContext,
  resolveRepoRoots,
  type RemoteReader,
  type GitRunner,
} from './repo.js';
import { inferDecisions, type DerivedDecision, type RedactedTranscriptInput } from './infer.js';
import { checkCaptureScope, type ScopeVerdict, SCOPE_REASON_COPY } from './captureScope.js';
import { buildIngestDecisionsUrl } from './urls.js';
import { describeFailure } from './failureCopy.js';
import { versionHeaders } from './version.js';
import { maybeNudge, maybeUnconnectedNudge, parseRepoStatus, parseNextStep } from './connectNudge.js';
import { maybeShowTrustGate } from './firstRun.js';
import { maybeFirstCaptureConfirm } from './firstCapture.js';
import { recordCaptureNotice } from './captureNotice.js';

/**
 * How many segments deep the containment walk will follow a single spelling before it
 * gives up and refuses the path. The walk costs one `realpath` (and sometimes one
 * `lstat`) per segment, so an unbounded depth is an unbounded number of syscalls from a
 * single hostile tool-input field. No source file anyone learns a system from is
 * anywhere near this deep, and a path that is gets DROPPED, never waved through — the
 * cap is a fail-closed limit, not a fast path.
 */
const MAX_WALK_SEGMENTS = 256;

/**
 * The Claude Code hook payload (SessionEnd / Stop). Claude Code passes this as a
 * JSON object on the hook process's STDIN. We read only the few fields we need and
 * tolerate any of them being absent (loosely typed on purpose — the hook contract
 * is owned by the agent, not us).
 *   - transcript_path: absolute path to the session's .jsonl transcript
 *   - cwd:             the session's working directory (→ resolveRepo)
 *   - session_id:      the session id (a fallback if the transcript omits it)
 *   - hook_event_name: "SessionEnd" | "Stop" (informational)
 */
export interface HookInput {
  transcript_path?: string;
  cwd?: string;
  session_id?: string;
  hook_event_name?: string;
}

/** What happened, for the bin's (stderr) log + the tests. Never thrown. */
export interface CaptureOutcome {
  /** A terse machine-readable status. */
  status:
    | 'persisted-by-server' // router persisted; we did nothing more
    | 'persisted' // we POSTed derived decisions to ingest-decisions
    | 'nothing-to-capture' // redaction left no prose / inference found no decisions
    | 'skipped-out-of-scope' // ARP-1054: pre-send scope check said the repo is off/unconnected — nothing read or sent
    | 'no-auth' // no device token; kicked off login, skipped this capture
    | 'no-transcript' // no transcript_path / unreadable transcript
    | 'infer-failed' // the inference router returned ok:false
    | 'persist-failed' // the ingest-decisions POST failed
    | 'error'; // any unexpected failure (still swallowed)
  /** A human-readable detail for the stderr log. Never contains the device token. */
  detail: string;
  /** How many decisions were persisted (when known). */
  count?: number;
  /** Whether the capture landed against a connected repo (vs repo-less / unknown). */
  repoConnected?: boolean;
  /**
   * ARP-734 — the server's non-fatal `upgrade` nudge string, when a response carried
   * one (from the infer OR the ingest leg). Kept SEPARATE from `detail` so only the
   * INTERACTIVE presenter (manual `backthread capture`) surfaces it — THROTTLED, once/
   * day — while the detached SessionEnd hook (which discards stdout anyway) stays
   * silent. Absent when the server sent no nudge.
   */
  upgrade?: string;
  /**
   * ARP-693 — the total redacted-turn count of the transcript this run saw (set on
   * every post-redaction outcome). The shared `--from-hook` entrypoint advances its
   * per-conversation WATERMARK to this so the NEXT per-turn `stop` infers only the
   * turns added since (Cursor/Codex fire per turn; a multi-turn conversation must be
   * captured completely without re-inferring old turns — ~O(N) total, not O(N²)).
   */
  turnCount?: number;
}

/**
 * Does a RESOLVED absolute path sit inside one of these RESOLVED roots?
 *
 * `separator` is a parameter, and exported with the function, for one reason: this
 * comparison is the line that decides containment, and it is wrong in a way that no
 * test running on this machine can see. `realpathSync` and `join` both answer in the
 * platform's own separator, so on Windows a root is `C:\repo` and a path below it is
 * `C:\repo\src`. Written against a hardcoded `/`, `startsWith('C:\repo/')` is false for
 * every path with a directory component — so every one of them reads as having left the
 * repo and the harvest silently empties. There is no win32 runner here, and an
 * end-to-end test on macOS cannot tell `sep` and `'/'` apart, so the separator is
 * injected and the win32 case is exercised directly. A guard that cannot fail on the
 * platform it protects is not a guard.
 *
 * Exact match counts: a path that IS a root is inside it.
 */
export function isInsideRoot(real: string, roots: readonly string[], separator: string = sep): boolean {
  return roots.some((r) => real === r || real.startsWith(r + separator));
}

export interface CaptureDeps {
  /** Env override seam. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: inject a fetch. Defaults to global fetch (threaded into the router + persist). */
  fetchImpl?: typeof fetch;
  /** Test seam: read a file. Defaults to fs.readFile. */
  readFileImpl?: (path: string) => Promise<string>;
  /**
   * Test seam: does an ABSOLUTE path exist on disk? Defaults to fs.existsSync.
   * Backs the `exists` predicate `sessionPaths` requires before it will emit any
   * path scraped out of a shell command (see below).
   */
  fileExistsImpl?: (absolutePath: string) => boolean;
  /**
   * Test seam: follow an ABSOLUTE path through every symlink to the real directory
   * it names, or null when it names nothing on disk. Defaults to `fs.realpathSync`.
   * Backs the `escapesRepo` predicate that gives `sessionPaths` its last word on
   * containment (see below) — string prefixes cannot see through a link, and the
   * filesystem is the only thing that can.
   */
  realPathImpl?: (absolutePath: string) => string | null;
  /**
   * Test seam: does the filesystem POSITIVELY say there is nothing at this name?
   * Defaults to an `fs.lstatSync` that returns true only on `ENOENT`.
   *
   * This is the predicate that separates the one case where the containment walk may
   * keep going from every case where it must stop. `realpath` returning nothing is not
   * one thing: the name may be genuinely absent (the file the session DELETED, which
   * has always kept its path), or it may be a dangling symlink, an unreadable parent
   * (`EACCES`), a symlink loop, a name too long — an entry that IS there and will not
   * say where it goes. The first is an absence and is safe to walk past; every other is
   * a refusal to answer, and walking past THOSE is precisely how an escaping link
   * behind a missing target or a `chmod 000` directory kept reaching the wire. `lstat`
   * distinguishes them and `realpath` cannot, because `lstat` does not follow the final
   * link and reports the errno of the name itself.
   *
   * Anything other than a clean `ENOENT` — including an error we have not thought of —
   * answers false and the walk fails closed. That is the rule that generalises: the
   * fence stops at any segment the filesystem will not resolve, whatever the reason.
   */
  isAbsentImpl?: (absolutePath: string) => boolean;
  /** Test seam: the config reader. Defaults to readConfig(). */
  readConfigImpl?: (env: NodeJS.ProcessEnv) => Promise<BackthreadConfig>;
  /** Test seam: the git-remote reader threaded into resolveRepo. */
  readRemoteImpl?: RemoteReader;
  /** Test seam: the git-command runner threaded into resolveGitContext (ARP-696). */
  readGitImpl?: GitRunner;
  /**
   * Test seam: which directories on this machine ARE this repo — the session's own
   * checkout plus every linked worktree sharing its git common dir. Defaults to
   * `resolveRepoRoots`. These are the roots a harvested absolute path is measured
   * against, so a file edited in a sibling worktree relativizes instead of being
   * dropped as foreign.
   */
  resolveRepoRootsImpl?: (cwd: string, run?: GitRunner, warn?: (message: string) => void) => string[];
  /**
   * Test seam: leave a notice where `backthread doctor` will find it. Defaults to
   * `recordCaptureNotice`. This is how anything capture has to say reaches a person at
   * all in the shipped delivery mode — the hook's worker is spawned with its stdio
   * discarded, so the log below goes nowhere.
   */
  recordNoticeImpl?: (message: string) => void;
  /**
   * ARP-693 — incremental capture watermark: infer ONLY the redacted turns at/after
   * this index, skipping turns already captured on an earlier `stop` of the same
   * conversation. Default 0 (whole transcript — Claude Code's single SessionEnd, and
   * every first capture). The shared entrypoint passes its stored per-conversation
   * watermark here and advances it to the returned `turnCount`.
   */
  fromTurnIndex?: number;
  /** Test seam: the auto-login trigger. Defaults to fire-and-forget ensureAuth. */
  ensureAuthImpl?: (env: NodeJS.ProcessEnv) => void;
  /**
   * ARP-1054 — test seam: the pre-send capture-scope check. Defaults to the real
   * checkCaptureScope (a POST to the Worker's /capture-scope with the repo slug + the
   * device token). Injected in tests so runCapture's scope-gating is exercised without
   * a live network. Returns the send/skip verdict (fail-open → send).
   */
  checkScopeImpl?: (repo: { owner: string; name: string }, config: BackthreadConfig) => Promise<ScopeVerdict>;
  /**
   * Test seam: the trust gate. Defaults to maybeShowTrustGate — prints the
   * never-store-source trust copy ONCE on the silent hook path before any transcript
   * is read. Returns whether it emitted (unused here; we don't gate on it). Best-
   * effort + non-throwing by contract.
   */
  showTrustGateImpl?: (log: (msg: string) => void, env: NodeJS.ProcessEnv) => Promise<boolean>;
  /**
   * Test seam: the once-only first-capture confirmation. Defaults to
   * maybeFirstCaptureConfirm — the "captured N — view at <link>" aha line shown once
   * per install after the first capture lands against a connected repo. Best-effort.
   */
  firstCaptureConfirmImpl?: (
    count: number,
    repoConnected: boolean,
    repo: { owner: string; name: string } | null,
    deps: { env: NodeJS.ProcessEnv; log: (m: string) => void },
  ) => Promise<boolean>;
  /** Where human-readable progress goes. Defaults to console.error (stderr). */
  log?: (msg: string) => void;
}

/**
 * Read + parse the hook input. Claude Code feeds it on STDIN as JSON; we also
 * accept a `BACKTHREAD_HOOK_INPUT` env var as a test/dev fallback. A missing or
 * unparseable input yields an empty object (best-effort — never throw).
 */
export async function readHookInput(
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<HookInput> {
  return parseHookInput(await readRawHookInput(env, stdin));
}

/**
 * Read the RAW hook payload (the bytes, before JSON parsing). The shared
 * entrypoint (`--from-hook`, fromHook.ts) needs the raw string so its detached mode
 * can re-hand the EXACT payload to a detached child via BACKTHREAD_HOOK_INPUT. The
 * env fallback wins when present (the detached child's path + tests); otherwise we
 * read stdin to end. A TTY (no piped input) yields '' rather than hanging. Never
 * throws — a read error degrades to '' (the parse layer then yields {}).
 */
export async function readRawHookInput(
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<string> {
  // Env fallback wins when present (handy for tests + manual + detached-child invocation).
  const fromEnv = env.BACKTHREAD_HOOK_INPUT;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  // Read stdin to end. If stdin is a TTY (no piped input) don't hang — resolve ''.
  if (stdin.isTTY) return '';
  return readStream(stdin).catch(() => '');
}

/** Parse the hook input JSON defensively → {} on any problem. */
export function parseHookInput(raw: string): HookInput {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as HookInput;
  } catch {
    // fall through
  }
  return {};
}

function readStream(stream: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (data += chunk));
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

/**
 * Run the capture pipeline for one hook invocation. NEVER throws — every failure
 * mode resolves with a `CaptureOutcome`. The caller (the bin) logs it and exits 0.
 */
export async function runCapture(input: HookInput, deps: CaptureDeps = {}): Promise<CaptureOutcome> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((m: string) => console.error(m));
  const doReadFile = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  const doFileExists = deps.fileExistsImpl ?? existsSync;
  const doRealPath =
    deps.realPathImpl ??
    ((p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return null; // the filesystem will not resolve this name — see `isAbsentImpl`
      }
    });
  const doIsAbsent =
    deps.isAbsentImpl ??
    ((p: string) => {
      try {
        lstatSync(p); // an entry IS here (possibly a dangling or looping link)
        return false;
      } catch (err) {
        // ONLY a clean ENOENT is an absence. EACCES, ELOOP, ENOTDIR, ENAMETOOLONG and
        // anything else are the filesystem declining to answer, and the walk that asks
        // this must treat a declined answer as an escape, never as empty ground.
        return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      }
    });
  const doResolveRepoRoots = deps.resolveRepoRootsImpl ?? resolveRepoRoots;
  const doReadConfig = deps.readConfigImpl ?? readConfig;
  const fireEnsureAuth =
    deps.ensureAuthImpl ??
    ((e: NodeJS.ProcessEnv) => {
      // Fire-and-forget: kick off the browser login but DON'T await it — the user's
      // session must not stall on an OAuth round-trip. Errors are swallowed; the
      // NEXT session captures once a token exists. ensureAuth logs to stderr itself.
      void ensureAuth({ env: e }).catch(() => {});
    });

  try {
    // (0) TRUST GATE. The plugin's SessionEnd hook can fire BEFORE
    // any install/start ran (the manifest auto-arms it), so the never-store-source
    // trust copy must be guaranteed FIRST on this path too — before we read the
    // transcript or fire the background login. maybeShowTrustGate prints TRUST_COPY
    // exactly once per install (throttled), then no-ops. It is best-effort + NEVER
    // throws + NEVER blocks (no network/browser), so it can't break the always-exit-0
    // capture contract. Awaited (a tiny disk read/write) so the copy reliably lands
    // before the rest of the pipeline runs — NOT before, e.g., a browser pops.
    const showTrustGate =
      deps.showTrustGateImpl ??
      ((l: (m: string) => void, e: NodeJS.ProcessEnv) => maybeShowTrustGate({ log: l, env: e }));
    await showTrustGate(log, env).catch(() => false);

    // (1) Need a transcript path to do anything.
    const transcriptPath = input.transcript_path;
    if (!transcriptPath || transcriptPath.trim().length === 0) {
      return { status: 'no-transcript', detail: 'hook input had no transcript_path.' };
    }

    // Auth gate — but NEVER block on it. No token → kick off login fire-and-forget
    // and skip THIS capture (the next session captures once a token is stored).
    // Wrapped so even a SYNC throw from a (mis)injected reader degrades to "no
    // config" rather than escaping — defense-in-depth around the best-effort posture.
    const config = await Promise.resolve()
      .then(() => doReadConfig(env))
      .catch(() => ({}) as BackthreadConfig);
    if (!config.device_token) {
      fireEnsureAuth(env);
      return {
        status: 'no-auth',
        detail: 'no device token yet — started `backthread login` in the background; this session was not captured.',
      };
    }

    // (1b) ARP-1054 — PRE-SEND capture-scope check. Resolve the repo from cwd (cheap;
    // no transcript read yet) and ask the server whether capture is ON for it, for us.
    // On an explicit `skip` (repo turned OFF, or not connected to Backthread) we send
    // NOTHING — we don't even read the transcript, so the source never leaves the
    // machine (the client-side half of per-repo capture scoping; the server enforces
    // the same decision post-send, ARP-1053). FAIL-OPEN: any doubt — endpoint down,
    // an unknown verdict — resolves to send, so a preflight hiccup can never silently
    // drop a real capture. Only runs when a repo is resolvable; a no-git-remote cwd
    // has no slug to check and falls through to the existing "can't claim → skip" path.
    const repo = input.cwd ? resolveRepo(input.cwd, deps.readRemoteImpl) : null;
    if (repo) {
      const checkScope =
        deps.checkScopeImpl ??
        ((r: { owner: string; name: string }, c: BackthreadConfig) =>
          checkCaptureScope(r, c, { env, fetchImpl: deps.fetchImpl }));
      const scope = await checkScope(repo, config);
      if (!scope.send) {
        // For an UNCONNECTED repo, surface the occasional local connect nudge (repo-slug
        // only, throttled once/session via the hook's session_id) — the signal that used
        // to ride the post-send response. Every other skip reason (paused / not-a-member
        // / not-writable) is silent: a deliberate or known state, no nudge. Best-effort +
        // non-throwing (maybeUnconnectedNudge swallows all failures).
        if (scope.reason === 'not_connected') {
          await maybeUnconnectedNudge(repo, input.session_id ?? null, { env, log });
        }
        return {
          status: 'skipped-out-of-scope',
          // The reason is a closed enum, so it renders as the sentence it means. It used to
          // print as `capture skipped (not_a_member) — repo not in capture scope`, which is
          // a slug in front of a person however respectable its provenance.
          detail: `capture skipped — ${SCOPE_REASON_COPY[scope.reason]}.`,
          count: 0,
        };
      }
    }

    // (2) Read the transcript off disk.
    let rawTranscript: string;
    try {
      rawTranscript = await doReadFile(transcriptPath);
    } catch (e) {
      return { status: 'no-transcript', detail: `could not read transcript: ${(e as Error).message}` };
    }

    // (3) Parse + REDACT locally — the security fence. Nothing past this carries
    // source code or tool I/O.
    const records = parseJsonl(rawTranscript);
    const redacted = redactTranscript(records);
    const decidedAt = sessionTimestamp(records) ?? undefined;
    // Harvest the repo-relative file PATHS the session touched, from the RAW records
    // — BEFORE redaction drops the tool-use records those paths live in (same pre-
    // redaction scan discipline as sessionTimestamp). The roots let sessionPaths
    // normalize absolute tool-use paths to repo-relative, the format the server's
    // reconcile pass joins on.
    // METADATA only — directory structure, never file contents; the never-store-source
    // claim still holds (paths ≠ contents). Absent cwd → only already-relative paths
    // survive (often []), which the server treats as "unanchored" — correct, not an error.
    //
    // WHY A SET OF ROOTS, not the hook's cwd. Measuring against cwd alone dropped every
    // path in a sibling git WORKTREE as foreign — but a worktree is the same repo, and
    // the same file, at the same repo-relative path. On a machine where parallel
    // worktrees are the normal workflow that emptied the path list for entire sessions:
    // one measured session recorded hundreds of decisions and zero file paths, because
    // everything it edited lived in a worktree next door. resolveRepoRoots settles which
    // directories really are this repo (shared git common dir) and hands the answer to
    // sessionPaths, which stays pure and asks git nothing.
    //
    // `exists` is what lets sessionPaths emit anything it scraped out of a shell
    // COMMAND string. A relative token in a command proves nothing on its own: after
    // `cd /etc`, `cat app/secrets.json` reads a file that has no relationship to this
    // repo while looking exactly like one that does. Only the filesystem can settle
    // it, and sessionPaths is pure by design, so the check is injected from here —
    // where the repo root already is. Memoised: one session asks thousands of times
    // and a session's working tree does not change under us mid-capture. Bounded by
    // the caps inside sessionPaths, so the map cannot grow without limit either.
    // Where a warning from root resolution goes. BOTH channels, because there are two
    // delivery modes and each one's channel is dead in the other. `backthread capture`
    // run by hand has a terminal attached and stderr is the right place; the shipped
    // SessionEnd/Stop hook re-spawns its worker with `stdio: 'ignore'`, so the same
    // line reaches nobody. The file is what `backthread doctor` reads, which is where
    // somebody goes when they notice capture doing less than they expected.
    const doRecordNotice = deps.recordNoticeImpl ?? ((m: string) => void recordCaptureNotice(m, env));
    const warnAboutRoots = (message: string) => {
      log(message);
      doRecordNotice(message);
    };
    const repoRoots = input.cwd ? doResolveRepoRoots(input.cwd, deps.readGitImpl, warnAboutRoots) : [];
    const existsCache = new Map<string, boolean>();
    // One realpath per distinct absolute path, for the whole capture. Both the root
    // resolution and the ancestor walk below ask about the same handful of directories
    // over and over, and a session's working tree does not change under us mid-capture.
    const realPathCache = new Map<string, string | null>();
    const realOf = (abs: string): string | null => {
      const hit = realPathCache.get(abs);
      if (hit !== undefined) return hit;
      const real = doRealPath(abs);
      realPathCache.set(abs, real);
      return real;
    };
    // The roots as the FILESYSTEM spells them, which is what a resolved path has to be
    // compared against. A root set deliberately carries logical spellings too (a
    // checkout reached through a symlinked parent is named both ways, or every path a
    // session under that link reports would be refused), and a logical spelling never
    // prefix-matches a resolved path. Resolving them collapses both spellings onto the
    // one directory they name, so the comparison is physical-against-physical. A root
    // that no longer resolves is dropped: it cannot confirm anything, and treating it
    // as a match would confirm everything. Cached per root SET, because the harvest can
    // measure against a set we did not pass in (see `escapesRepo`).
    const realRootsCache = new Map<string, string[]>();
    const realRootsOf = (roots: readonly string[]): string[] => {
      const key = JSON.stringify(roots);
      const hit = realRootsCache.get(key);
      if (hit !== undefined) return hit;
      const out: string[] = [];
      for (const root of roots) {
        const real = realOf(root);
        if (real !== null && !out.includes(real)) out.push(real);
      }
      realRootsCache.set(key, out);
      return out;
    };
    const inside = (real: string, realRoots: readonly string[]): boolean =>
      isInsideRoot(real, realRoots);
    // WALK THE SPELLING THROUGH THE FILESYSTEM, ONE SEGMENT AT A TIME, and return where
    // it physically lands — or null when the filesystem refused to say.
    //
    // This is the whole fix, and it replaces resolving the reduced path in one call.
    // `..` is only safe to cancel arithmetically when the segment it cancels is a real
    // directory; against a SYMLINK it is simply wrong, because the link does not go
    // where its name says. So `..` is never cancelled on the string here: by the time a
    // `..` is reached, everything to its left has already been followed on disk, `cur`
    // is a resolved physical path, and its parent directory is therefore the true one.
    // That is what turns `dlink/../src/secret.ts` from "obviously our own `src`" into
    // "the other repository's `src`", which is what it always was.
    //
    // THE FINAL SEGMENT IS NOT FOLLOWED — the caller pops it. What leaks is a path
    // DESCENDING THROUGH a link into somebody else's directory structure; a symlinked
    // FILE at a name this repo really has (`src/linked.ts` pointing anywhere at all) is
    // different in kind — that name is in our own tree, git tracks it, and the path
    // gives away nothing about where the contents live. Following it would drop our own
    // metadata to a rule aimed at somebody else's.
    //
    // A SEGMENT THE FILESYSTEM WILL NOT RESOLVE STOPS THE WALK — it does not get
    // skipped. `realpath` failing is not one condition but several, and only one of
    // them is an absence: the name may be genuinely missing (`ENOENT`), or it may be a
    // dangling link, a `chmod 000` parent, a symlink loop. The previous fence climbed
    // PAST any unresolvable segment to an ancestor that was inside the repo and kept
    // the path, which let both a dangling escaping link and an escaping link behind an
    // unreadable directory through. Only positive absence continues, and then only
    // lexically, on ground we know is not a link. Everything else fails closed. Two
    // mechanisms were measured; the rule is written to cover the ones nobody measured.
    //
    // Positive absence continuing is what keeps the DELETED-file case: `src/deleted.ts`
    // pops its leaf, resolves `src`, lands inside, survives. Resolving to somewhere
    // else is a reason to drop; resolving to nothing never was.
    const resolveWalk = (start: string, segments: readonly string[]): string | null => {
      // A path with this many segments is not a source file anyone learns from, and the
      // walk costs a syscall each. Fail closed rather than let one hostile tool-input
      // field spend an unbounded number of them.
      if (segments.length > MAX_WALK_SEGMENTS) return null;
      let cur = start;
      for (const seg of segments) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
          // `cur` is already fully resolved, so its lexical parent IS its real parent.
          cur = dirname(cur);
          continue;
        }
        const next = join(cur, seg);
        const real = realOf(next);
        if (real !== null) {
          cur = real;
          continue;
        }
        if (doIsAbsent(next)) {
          cur = next; // nothing is here; nothing here can be a link either
          continue;
        }
        return null; // something IS here and will not say where it goes
      }
      return cur;
    };
    // The segments of a raw spelling, minus the leaf the walk must not follow. Split on
    // `/` ONLY, which is what the kernel does and therefore the only split that measures
    // the path that actually gets opened: a symlink genuinely named `x\y` is one segment
    // to the filesystem, and treating it as two was a live escape. `sessionPaths` refuses
    // any candidate carrying a `\` before it reaches here, so there is nothing left to
    // disagree about.
    //
    // A trailing `..` or `.` is NOT a leaf — it is part of how the directory is named —
    // so only a plain trailing name is dropped. No spelling that survives normalization
    // ends in `..` today (`dlink/..` reduces to the empty path and is skipped upstream),
    // so that condition is defence-in-depth for a shape the normalizer currently eats,
    // and it is deliberately the conservative branch: keeping a segment costs nothing,
    // dropping the wrong one loses a directory the walk needed to follow.
    const walkableSegments = (raw: string): string[] => {
      const segs = raw.split('/').filter((s) => s !== '' && s !== '.');
      if (segs.length > 0 && segs[segs.length - 1] !== '..') segs.pop();
      return segs;
    };
    const escapesCache = new Map<string, boolean>();
    const filePaths = sessionPaths(records, repoRoots, {
      exists: (rel) => {
        const hit = existsCache.get(rel);
        if (hit !== undefined) return hit;
        // `rel` is already normalized + confirmed inside a root by sessionPaths (no
        // `..`, never absolute), so these joins cannot climb out of any of them.
        // ANY root counts: the worktrees are one repo, and a file the session edited
        // in a sibling worktree is as real as one in the checkout the hook fired in.
        const ok = repoRoots.some((root) => doFileExists(join(root, rel)));
        existsCache.set(rel, ok);
        return ok;
      },
      // Containment, decided by the filesystem instead of by string prefix. A repo can
      // contain a symlink that leaves it — `repoA/vendor` pointing at `repoB` is an
      // ordinary thing for a checkout to have — and every rule inside sessionPaths is a
      // string rule, so `<repoA>/vendor/src/secret.ts` reads as in-repo and is emitted
      // under repoA's name while naming a file that belongs to repoB. That is another
      // repository's directory structure entering this one's capture.
      //
      // WE FOLLOW THE DIRECTORY, NOT THE FILE. What leaks is a path DESCENDING THROUGH
      // a link: only `vendor` exists in repoA, so `vendor/src/secret.ts` is repoB's
      // structure wearing repoA's name. A symlinked FILE at a name this repo really has
      // — `src/linked.ts` pointing anywhere at all — is different in kind: that name is
      // in repoA's own tree, git tracks it, and the path gives away nothing about where
      // its contents live. Resolving the full path would drop it too, which is losing
      // our own metadata to a rule aimed at somebody else's.
      //
      // ONE ROOT SAYING "OUTSIDE" IS ENOUGH. The tempting rule — keep it if SOME root
      // resolves it inside — is wrong, and wrong in the way that reopens the leak it is
      // meant to close. Roots are checkouts of one repo, so every tracked directory
      // exists in all of them: put the escaping link at a name the repo genuinely has
      // (`ln -s ../../other packages/foo`, with `packages/foo` a real directory in a
      // sibling worktree) and the sibling vouches for it, laundering the escape. So the
      // question asked is the opposite one, and a single contradiction drops the path.
      //
      // AND WE ASK ABOUT THE SPELLING THAT ARRIVED, not the one we would emit. This is
      // the correction to the previous release, which resolved the NORMALIZED path in a
      // single call and could not close the leak it was written for. Two mechanisms
      // defeated it, and they are one shape:
      //   1. `..` CANCELLED ON THE STRING. `normalizeRepoRelative` reduces
      //      `dlink/../src/secret.ts` to `src/secret.ts` before the predicate is called,
      //      so a link out is erased and the path arrives looking like one of our own.
      //      Cancelling `..` is only valid against a real directory; against a symlink
      //      it is wrong, because the link does not go where its name says.
      //   2. AN UNRESOLVABLE SEGMENT CLIMBED PAST. Resolving the deepest ancestor that
      //      exists treats "cannot say" as "keep looking upward", lands on an ancestor
      //      that IS inside the repo, and keeps the path. Measured for a DANGLING link
      //      (`ENOENT`) and for an escaping link behind a `chmod 000` directory
      //      (`EACCES`) — and the earlier note here named only the first, which
      //      understated the class. The class is: anything that makes the filesystem
      //      unable to answer at the point the fence asks.
      // `resolveWalk` closes both by following the raw spelling segment by segment and
      // failing closed on any segment that will not resolve.
      escapesRepo: ({ raw, absolute }, roots) => {
        // Memoised on the raw spelling, keyed with its kind — an absolute and a relative
        // spelling are different questions and must never share an answer.
        // Memoised on the raw spelling. It needs no other key: `absolute` is a pure
        // function of `raw` (it IS `raw.startsWith('/')`), so an absolute and a relative
        // spelling can never collide on one entry, and a kind prefix here would be dead
        // code dressed as a precaution.
        const key = raw;
        const hit = escapesCache.get(key);
        if (hit !== undefined) return hit;
        const realRoots = realRootsOf(roots);
        const escapes = (): boolean => {
          if (absolute) {
            // An absolute spelling names exactly ONE place on this machine, so it is
            // resolved on its own, from the filesystem root, and no root can vouch for
            // it. If nothing resolved, there is nothing to measure against and the
            // pre-existing behaviour (keep) stands rather than emptying the harvest.
            if (realRoots.length === 0) return false;
            const dest = resolveWalk('/', walkableSegments(raw));
            return dest === null || !inside(dest, realRoots);
          }
          // A relative spelling carries no evidence of what it is relative to, so it is
          // measured against EVERY root.
          //
          // ONE ROOT SAYING "OUTSIDE" IS ENOUGH. The tempting rule — keep it if SOME
          // root resolves it inside — is wrong, and wrong in the way that reopens the
          // leak it is meant to close. Roots are checkouts of one repo, so every tracked
          // directory exists in all of them: put the escaping link at a name the repo
          // genuinely has (`ln -s ../../other packages/foo`, with `packages/foo` a real
          // directory in a sibling worktree) and the sibling vouches for it, laundering
          // the escape. So the question asked is the opposite one, and a single
          // contradiction drops the path. It has a real cost, and it is deliberate: an
          // honest file at a colliding name in a sibling checkout is dropped with it.
          const segments = walkableSegments(raw);
          for (const root of roots) {
            const realRoot = realOf(root);
            if (realRoot === null) continue; // this root can say nothing about anything
            const dest = resolveWalk(realRoot, segments);
            if (dest === null || !inside(dest, realRoots)) return true;
          }
          return false;
        };
        const verdict = escapes();
        escapesCache.set(key, verdict);
        return verdict;
      },
    });
    // Prefer the transcript's own session id; fall back to the hook's session_id.
    const sessionId = redacted.sessionId ?? input.session_id ?? null;

    // ARP-693 — INCREMENTAL capture. We redact the FULL transcript (cheap, local) so
    // the session id + decidedAt + the touched-path union stay session-level, but we
    // only INFER the turns added since the last `stop` (the expensive LLM leg). The
    // transcript is append-only, so redacted.turns is a stable growing prefix:
    // turns[0..watermark) were already captured on earlier turn-fires. turnCount is
    // returned on every outcome below so the entrypoint can advance its watermark.
    const turnCount = redacted.turns.length;
    const fromTurn = deps.fromTurnIndex ?? 0;
    const newTurns = fromTurn > 0 ? redacted.turns.slice(fromTurn) : redacted.turns;

    if (newTurns.length === 0) {
      return {
        status: 'nothing-to-capture',
        detail:
          turnCount === 0
            ? 'redaction left no natural-language turns (session was all code / tool I/O).'
            : `no new turns since the last capture (watermark ${fromTurn} of ${turnCount}).`,
        count: 0,
        turnCount,
      };
    }

    const transcript: RedactedTranscriptInput = {
      sessionId,
      turns: newTurns,
      stats: redacted.stats,
    };

    // `repo` was resolved above (1b) for the pre-send scope check; reuse it here.
    // ARP-696 — resolve the session's local git context (current branch + HEAD sha)
    // so the server can HOLD the decision as pending_merge until that work merges.
    // `at` is the session timestamp (decidedAt); the server defaults to now() when
    // absent. Best-effort: a non-git cwd → both null → the server keeps it merged
    // (shown immediately). Reported to BOTH persist paths (worker + ingest-decisions).
    const gitContext = input.cwd
      ? resolveGitContext(input.cwd, deps.readGitImpl)
      : { branch: null, headSha: null, gitUser: null };
    const captured = {
      branch: gitContext.branch,
      headSha: gitContext.headSha,
      gitUser: gitContext.gitUser, // committer identity, for merge scoping
      at: decidedAt ?? null,
    };

    // (4) Derive decisions via the router. We ask the server to ALSO persist
    // when (and only when) we have a repo to attribute to — that's the membership-
    // gated connected path; the server returns persisted:true and we stop. When we
    // have no resolvable repo, we derive-only and persist ourselves below (the
    // ingest-decisions repo-less path needs a claimed slug, which we don't have).
    const result = await inferDecisions(transcript, config, {
      env,
      fetchImpl: deps.fetchImpl,
      decidedAt,
      filePaths,
      captured,
      ...(repo ? { persist: true, repo } : {}),
    });

    if (!result.ok) {
      return { status: 'infer-failed', detail: result.error ?? 'inference failed (no detail).' };
    }

    // ARP-734 — the server's non-fatal upgrade nudge off the infer response (the
    // server-persist + no-decision paths report it here; the ingest path reports its
    // own below). Carried onto the outcome as a SEPARATE field; only the interactive
    // presenter surfaces it (throttled), never the detached hook.
    const inferUpgrade = result.upgrade;

    // (5a) Server already wrote them — DONE. Re-POSTing would double-write.
    if (result.persisted) {
      // once-only aha confirmation: the server persisted against a CONNECTED repo
      // (the persist leg is membership-gated → only fires connected), so this is the
      // first-capture "view it" moment. Shown once per install, then no-ops. Best-
      // effort: any failure is swallowed and can't break the always-exit-0 contract.
      const confirm = deps.firstCaptureConfirmImpl ?? maybeFirstCaptureConfirm;
      await confirm(result.decisions.length, true, repo, { env, log }).catch(() => false);
      return {
        status: 'persisted-by-server',
        detail: `inference router persisted ${result.decisions.length} decision(s) server-side.`,
        count: result.decisions.length,
        repoConnected: true,
        turnCount,
        ...(inferUpgrade ? { upgrade: inferUpgrade } : {}),
      };
    }

    // Nothing derived → nothing to persist (a valid, cheap outcome).
    if (result.decisions.length === 0) {
      return {
        status: 'nothing-to-capture',
        detail: 'inference returned no decisions for this session.',
        count: 0,
        turnCount,
        ...(inferUpgrade ? { upgrade: inferUpgrade } : {}),
      };
    }

    // (5b) We own persistence. POST the DERIVED decisions to ingest-decisions, which
    // routes connected vs repo-less server-side. ingest-decisions REQUIRES a repo
    // slug in the body (it's the claimed repo for the repo-less path too). Without
    // any resolvable repo there's nothing to claim → we keep the derived decisions
    // out rather than guess. (This only bites the rare no-git-remote session; once a
    // repo is resolvable the very next capture lands.)
    if (!repo) {
      return {
        status: 'nothing-to-capture',
        detail:
          'derived decisions but could not resolve a repo from cwd (no git remote) — nothing to claim them under; skipped.',
        count: 0,
        turnCount,
        ...(inferUpgrade ? { upgrade: inferUpgrade } : {}),
      };
    }

    // Carry the run's turnCount onto whatever persistDerived returns so the
    // entrypoint advances its watermark on a successful (or empty) capture.
    const out = await persistDerived(result.decisions, repo, config, decidedAt, {
      env,
      fetchImpl: deps.fetchImpl,
      log,
      // Carry the session id so the connect-nudge can throttle once-per-session
      // — the SessionEnd hook fires once, but manual/MCP captures fire many times.
      sessionId,
      // The session's git context, for the held-state decision server-side.
      captured,
      // first-capture confirmation seam (threaded so tests can stub it).
      firstCaptureConfirmImpl: deps.firstCaptureConfirmImpl,
    });
    return { ...out, turnCount };
  } catch (e) {
    // The ultimate backstop — a hook must never throw into the user's session.
    return { status: 'error', detail: `capture failed (swallowed): ${(e as Error).message}` };
  }
}

/**
 * POST derived decisions to the ingest-decisions Edge Function, authenticated with
 * the device token. The server routes connected vs repo-less. Best-effort:
 * any failure resolves to a `persist-failed` outcome, never throws.
 *
 * The decisions are the router's opaque records; we wrap them with the `repo` slug
 * and a `sessionId`/`decidedAt` so the validator can derive a stable dedupe key.
 * We deliberately set neither — the SERVER's validator already derives dedupeKey
 * from (sessionId, decidedAt, title) when absent (see ingest-decisions/validate.ts);
 * we just make sure each decision carries those inputs.
 */
async function persistDerived(
  decisions: DerivedDecision[],
  repo: { owner: string; name: string },
  config: BackthreadConfig,
  decidedAt: string | undefined,
  ctx: {
    env: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    log: (m: string) => void;
    /** Session id for the connect-nudge throttle (null → nudge suppressed). */
    sessionId: string | null;
    /** ARP-696 — the session's git context, sent so the server holds the decision.
     * gitUser (ARP-1208) is the committer identity for the merge-scoping heuristic. */
    captured?: { branch?: string | null; headSha?: string | null; gitUser?: string | null; at?: string | null };
    /** Test seam: the once-only first-capture confirmation. Defaults to maybeFirstCaptureConfirm. */
    firstCaptureConfirmImpl?: (
      count: number,
      repoConnected: boolean,
      repo: { owner: string; name: string } | null,
      deps: { env: NodeJS.ProcessEnv; log: (m: string) => void },
    ) => Promise<boolean>;
  },
): Promise<CaptureOutcome> {
  const doFetch = ctx.fetchImpl ?? fetch;
  const token = config.device_token;
  if (!token) {
    // Shouldn't happen (we checked earlier) — but never POST without a credential.
    return { status: 'no-auth', detail: 'no device token at persist time; skipped.' };
  }

  // The validator wants `decidedAt`/`sessionId` present on each decision so it can
  // derive a stable dedupe key. Only fill them in when the router didn't already
  // (respect any explicit dedupeKey/sessionId the server-side derivation set).
  const body = {
    repo: { owner: repo.owner, name: repo.name },
    // Session-level git context (the ingest-decisions validator reads it
    // body-level and stamps each decision). Each field only when present; absent →
    // the server keeps the decision merged (back-compat). It's the repo-less /
    // self-persist path, so a held decision waits for the repo to connect + reconcile.
    ...(ctx.captured?.branch != null ? { capturedBranch: ctx.captured.branch } : {}),
    ...(ctx.captured?.headSha != null ? { capturedHeadSha: ctx.captured.headSha } : {}),
    ...(ctx.captured?.gitUser != null ? { capturedGitUser: ctx.captured.gitUser } : {}),
    ...(ctx.captured?.at != null ? { capturedAt: ctx.captured.at } : {}),
    decisions: decisions.map((d) => ({
      ...d,
      ...(decidedAt && (d as { decidedAt?: unknown }).decidedAt === undefined ? { decidedAt } : {}),
    })),
  };

  let res: Response;
  try {
    res = await doFetch(buildIngestDecisionsUrl(ctx.env), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, // device token — never logged
        'Content-Type': 'application/json',
        ...versionHeaders(), // x-backthread-version — server-side compat guard
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { status: 'persist-failed', detail: `ingest request failed: ${(e as Error).message}` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    // `backthread capture --manual` prints this under the summary, so it is product copy
    // whatever the detached hook does with it. A 426 soft-block still renders its
    // worker-authored "please update backthread …" message verbatim — that branch is
    // inside `describeFailure`, not a special case here.
    const obj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    return {
      status: 'persist-failed',
      detail: describeFailure({
        lead: "the decisions weren't saved",
        status: res.status,
        payload: obj,
        env: ctx.env,
      }),
    };
  }

  const rec = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const count = typeof rec.count === 'number' ? rec.count : decisions.length;
  const repoConnected = rec.repoConnected === true;
  // Non-fatal upgrade nudge: the server lets an outdated-but-supported client through
  // and returns an `upgrade` string (mirrors the x-backthread-upgrade header). Carried
  // as a SEPARATE outcome field (ARP-734) — NOT baked into detail — so only the
  // interactive `backthread capture` presenter surfaces it (throttled once/day), while
  // the detached SessionEnd hook (which discards stdout) stays silent.
  const upgrade = typeof rec.upgrade === 'string' && rec.upgrade.length > 0 ? rec.upgrade : undefined;
  const base = repoConnected
    ? `captured ${count} decision(s) to ${repo.owner}/${repo.name}.`
    : `captured ${count} decision(s) (repo not yet connected — held as pending).`;

  // + — the throttled connect-nudge. The server
  // piggybacks two signals on EVERY capture response (no extra round-trip): the
  // legacy `repoStatus` health signal AND the UNIFIED `nextStep` (the cell→next-step
  // decision made once server-side). We pass both to maybeNudge: the unified
  // `nextStep` wins when present (render the server's copy, or suppress on the
  // terminal `null`), falling back to the `repoStatus` branch for an older server.
  // At most ONCE per session (manual/MCP captures can fire many times). Best-effort
  // + non-throwing: maybeNudge swallows every failure, so it can never break the
  // always-exit-0 capture contract.
  await maybeNudge(parseRepoStatus(rec.repoStatus), repo, ctx.sessionId, {
    env: ctx.env,
    log: ctx.log,
    nextStep: parseNextStep(rec.nextStep),
    // The two silent skips: over the free-plan decision cap
    // (`captureSkipped: 'free_limit_reached'`) or an elapsed trial
    // (`'trial_expired'`, which also stops the diagram updating). Both come back as
    // a 200 with count 0 — never an error — and maybeNudge surfaces at most ONE
    // line per session for either (that repo is connected, so no other nudge fires).
    captureSkipped: typeof rec.captureSkipped === 'string' ? rec.captureSkipped : undefined,
  });

  // — the once-only first-capture "view it" confirmation. Fires only
  // when this capture LANDED against a CONNECTED repo (the connect nudge owns the
  // not-connected case above), exactly once per install. Mutually exclusive with the
  // nudge by the repoConnected branch. Best-effort + non-throwing: it can never break
  // the always-exit-0 capture contract.
  const confirm = ctx.firstCaptureConfirmImpl ?? maybeFirstCaptureConfirm;
  await confirm(count, repoConnected, repo, { env: ctx.env, log: ctx.log }).catch(() => false);

  return {
    status: 'persisted',
    detail: base,
    count,
    repoConnected,
    ...(upgrade ? { upgrade } : {}),
  };
}
