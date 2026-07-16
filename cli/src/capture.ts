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
import { readConfig, type BackthreadConfig } from './config.js';
import { ensureAuth } from './login.js';
import { parseJsonl, redactTranscript, sessionPaths, sessionTimestamp } from './redact.js';
import { resolveRepo, resolveGitContext, type RemoteReader, type GitRunner } from './repo.js';
import { inferDecisions, type DerivedDecision, type RedactedTranscriptInput } from './infer.js';
import { buildIngestDecisionsUrl } from './urls.js';
import { versionHeaders } from './version.js';
import { maybeNudge, parseRepoStatus, parseNextStep } from './connectNudge.js';
import { maybeShowTrustGate } from './firstRun.js';
import { maybeFirstCaptureConfirm } from './firstCapture.js';

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

export interface CaptureDeps {
  /** Env override seam. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: inject a fetch. Defaults to global fetch (threaded into the router + persist). */
  fetchImpl?: typeof fetch;
  /** Test seam: read a file. Defaults to fs.readFile. */
  readFileImpl?: (path: string) => Promise<string>;
  /** Test seam: the config reader. Defaults to readConfig(). */
  readConfigImpl?: (env: NodeJS.ProcessEnv) => Promise<BackthreadConfig>;
  /** Test seam: the git-remote reader threaded into resolveRepo. */
  readRemoteImpl?: RemoteReader;
  /** Test seam: the git-command runner threaded into resolveGitContext (ARP-696). */
  readGitImpl?: GitRunner;
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
    // redaction scan discipline as sessionTimestamp). `input.cwd` (the hook's working
    // directory, == the repo/worktree root) lets sessionPaths normalize absolute
    // tool-use paths to repo-relative, the format the server's reconcile pass joins on.
    // METADATA only — directory structure, never file contents; the never-store-source
    // claim still holds (paths ≠ contents). Absent cwd → only already-relative paths
    // survive (often []), which the server treats as "unanchored" — correct, not an error.
    const filePaths = sessionPaths(records, input.cwd);
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

    // Resolve the repo from cwd (best-effort; null → no claimable repo, see below).
    const repo = input.cwd ? resolveRepo(input.cwd, deps.readRemoteImpl) : null;

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
      gitUser: gitContext.gitUser, // ARP-1208 — committer identity for merge scoping
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
      // ARP-696 — the session's git context, for the held-state decision server-side.
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
    // ARP-696 — session-level git context (the ingest-decisions validator reads it
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
    // A 426 means the server soft-blocked this `backthread` as too old for the API.
    // The friendly "please update backthread …" copy is in `message`; prefer it over the
    // machine `error` code so the hook surfaces the actionable upgrade instruction.
    const obj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const serverErr =
      typeof obj.message === 'string' && obj.message.length > 0
        ? obj.message
        : 'error' in obj
          ? String(obj.error)
          : `HTTP ${res.status}`;
    return { status: 'persist-failed', detail: `ingest rejected (${res.status}): ${serverErr}` };
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
    // The free-plan decision cap: when the server skips a capture over the free
    // limit it flags `captureSkipped: 'free_limit_reached'`, and maybeNudge surfaces
    // a one-per-session upgrade line (that repo is connected, so no other nudge fires).
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
