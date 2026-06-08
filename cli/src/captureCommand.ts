// captureCommand.ts — the MANUAL/explicit capture surface, behind
// the `/backthread capture` slash command (and the `backthread capture --manual` bin path).
//
// This complements the SessionEnd/Stop HOOK (also `backthread capture`, but headless
// + STDIN-fed + silent-to-stderr + always-exit-0). The MANUAL path is what a founder
// runs MID-SESSION ("capture what we just decided, now") or to RE-RUN a session. It:
//
//   1. RESOLVES a transcript_path — the load-bearing difference from the hook. The
//      hook is fed transcript_path on STDIN by Claude Code; a slash command is NOT
//      (Claude Code exposes ${CLAUDE_SESSION_ID} + the cwd to a command, but NOT the
//      transcript path — confirmed against the hooks/slash-command docs). So we
//      DERIVE it: Claude Code stores each session transcript at
//        ~/.claude/projects/<slugified-cwd>/<session_id>.jsonl
//      where the slug replaces every non-alphanumeric char in the ABSOLUTE cwd with
//      '-'. An explicit --transcript <path> always wins; otherwise we derive from
//      --session + cwd. If neither resolves a readable file we return an ACTIONABLE
//      hint (never a silent no-op, never a browser pop — see the guardrail below).
//   2. Runs the SAME `runCapture` pipeline VERBATIM (local-redact → //      router-derive → hosted-POST). We never reimplement the redact fence or the
//      router here — this module is purely (a) transcript resolution + (b) a
//      human-readable per-run SUMMARY of the structured CaptureOutcome.
//
// SUMMARY: unlike the hook (which logs one terse line to stderr), the manual command
// prints a per-run summary to STDOUT — status + decision count + repo-connected
// state — the manual analogue of the local pipeline's `summarize()` (the cli derives
// via the server router, which returns opaque decision records, so we surface the
// outcome's status/count rather than the local sig/conf/flow breakdown).
//
// GUARDRAIL (paramount): like the hook, the manual path is best-effort — runCapture
// never throws. But UNLIKE the silent hook, a manual run that finds no auth should
// tell the user to run `backthread login` rather than (a) silently doing nothing or (b)
// firing a background browser login they didn't ask for. So manual mode injects a
// NO-OP ensureAuth and reports the `no-auth` outcome as an actionable hint. The real
// browser/auth flow is NEVER reached from here.

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runCapture, type CaptureDeps, type CaptureOutcome, type HookInput } from './capture.js';

/** Inputs to a manual capture, as parsed from the bin args / slash-command env. */
export interface ManualCaptureInput {
  /** Explicit transcript path (`--transcript <path>`). Wins over derivation. */
  transcriptPath?: string;
  /** Session id (`--session <id>` / ${CLAUDE_SESSION_ID}) — used to derive the path. */
  sessionId?: string;
  /** Working directory (defaults to process.cwd()) — used to derive the path + resolve the repo. */
  cwd?: string;
}

/** Seams so resolution + the pipeline run with zero real I/O / network / browser in tests. */
export interface ManualCaptureDeps {
  /** Test seam: the capture pipeline. Defaults to runCapture. */
  runCaptureImpl?: (input: HookInput, deps?: CaptureDeps) => Promise<CaptureOutcome>;
  /** CaptureDeps threaded into the pipeline (env, fetch, readers). */
  captureDeps?: CaptureDeps;
  /** Test seam: home directory. Defaults to os.homedir(). */
  homedirImpl?: () => string;
  /** Test seam: existence check for a derived path. Defaults to fs.stat → boolean. */
  statImpl?: (path: string) => Promise<boolean>;
}

/** The result of a manual capture: a human summary + a process exit code + the raw outcome. */
export interface ManualCaptureResult {
  /** The per-run summary to print to STDOUT. */
  text: string;
  /** 0 on a normal run (including "nothing to capture"); 1 only on a genuine failure. */
  exitCode: number;
  /** The structured outcome (null when we never reached the pipeline — e.g. no path). */
  outcome: CaptureOutcome | null;
}

/**
 * Slugify an absolute cwd into Claude Code's transcript-dir name: every non-
 * alphanumeric character becomes '-' (so `/Users/jb/www/clew` →
 * `-Users-jb-www-clew`, and `/Users/jb/.claude` → `-Users-jb--claude`). Mirrors
 * Claude Code's own ~/.claude/projects/<slug>/ layout.
 */
export function slugifyCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Derive the transcript path for a session from the cwd + session id, matching
 * Claude Code's `~/.claude/projects/<slug>/<session_id>.jsonl` layout. Returns null
 * when we don't have enough to build a path (no session id).
 */
export function deriveTranscriptPath(
  sessionId: string | undefined,
  cwd: string,
  home: string,
): string | null {
  if (!sessionId || sessionId.trim().length === 0) return null;
  return join(home, '.claude', 'projects', slugifyCwd(cwd), `${sessionId}.jsonl`);
}

/** Default existence check: fs.stat → true if it's a readable file, false otherwise. */
async function defaultStat(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the transcript path for a manual capture. An explicit `transcriptPath`
 * always wins (and is returned even if we can't stat it — the pipeline's own
 * readFile surfaces an actionable error). Otherwise derive from session + cwd and
 * confirm the file exists; a derived-but-missing path resolves to null so the
 * caller can emit an actionable hint rather than feed a bogus path to the pipeline.
 */
export async function resolveTranscriptPath(
  input: ManualCaptureInput,
  deps: ManualCaptureDeps = {},
): Promise<string | null> {
  const explicit = input.transcriptPath;
  if (explicit && explicit.trim().length > 0) return explicit;

  const home = (deps.homedirImpl ?? homedir)();
  const cwd = input.cwd ?? process.cwd();
  const derived = deriveTranscriptPath(input.sessionId, cwd, home);
  if (!derived) return null;

  const exists = await (deps.statImpl ?? defaultStat)(derived);
  return exists ? derived : null;
}

const NO_PATH_HINT =
  'backthread capture: could not find this session\'s transcript. The slash command derives it from ' +
  'the session id + working directory; if that failed, pass the path explicitly:\n' +
  '  backthread capture --manual --transcript /absolute/path/to/session.jsonl\n' +
  '(Find it under ~/.claude/projects/<project>/<session-id>.jsonl.) Nothing was captured.';

/**
 * Run a manual/explicit capture: resolve the transcript, run the pipeline, and
 * format a per-run summary. Best-effort like the hook (runCapture never throws), but
 * verbose: the summary goes to STDOUT and a genuine failure exits non-zero (a manual
 * command SHOULD signal failure, unlike the always-exit-0 hook). The `no-auth`
 * outcome is rendered as an actionable `backthread login` hint — manual mode injects a
 * NO-OP ensureAuth so it NEVER triggers a background browser login.
 */
export async function runManualCapture(
  input: ManualCaptureInput,
  deps: ManualCaptureDeps = {},
): Promise<ManualCaptureResult> {
  const transcriptPath = await resolveTranscriptPath(input, deps).catch(() => null);
  if (!transcriptPath) {
    return { text: NO_PATH_HINT, exitCode: 1, outcome: null };
  }

  // Manual mode NEVER pops a browser: override ensureAuth with a no-op so a missing
  // token surfaces as a `no-auth` outcome we render as a `backthread login` hint instead.
  // The caller's captureDeps win if they set their own ensureAuthImpl (tests do).
  const captureDeps: CaptureDeps = {
    ensureAuthImpl: () => {},
    ...deps.captureDeps,
  };

  const run = deps.runCaptureImpl ?? runCapture;
  const hookInput: HookInput = {
    transcript_path: transcriptPath,
    cwd: input.cwd ?? process.cwd(),
    session_id: input.sessionId,
  };

  let outcome: CaptureOutcome;
  try {
    outcome = await run(hookInput, captureDeps);
  } catch (e) {
    // runCapture is contracted never to throw; this is belt-and-braces so a manual
    // run can never crash the agent's slash-command turn.
    return { text: `backthread capture: error — ${(e as Error).message}`, exitCode: 1, outcome: null };
  }

  return { text: formatManualSummary(outcome), exitCode: exitCodeFor(outcome), outcome };
}

/** A genuine failure (infer/persist/error) exits 1; everything else (incl. nothing-to-capture, no-auth) exits 0... */
// ...EXCEPT no-auth, which exits 1 so a manual run signals "you need to log in" to the shell.
function exitCodeFor(o: CaptureOutcome): number {
  if (o.status === 'infer-failed' || o.status === 'persist-failed' || o.status === 'error') return 1;
  if (o.status === 'no-auth' || o.status === 'no-transcript') return 1;
  return 0;
}

/**
 * Render a CaptureOutcome into the per-run summary the manual command prints. The
 * `no-auth` outcome becomes an actionable `backthread login` hint; otherwise we show the
 * status, the decision count when known, and the repo-connected state.
 */
export function formatManualSummary(outcome: CaptureOutcome): string {
  if (outcome.status === 'no-auth') {
    return 'backthread capture: not logged in — run `backthread login` to authorize this device, then capture again. Nothing was captured.';
  }

  const lines: string[] = [];
  switch (outcome.status) {
    case 'persisted':
    case 'persisted-by-server': {
      const n = typeof outcome.count === 'number' ? outcome.count : 0;
      lines.push(`backthread capture: captured ${n} decision(s).`);
      if (outcome.repoConnected === false) {
        lines.push('  repo not yet connected — decisions held as pending until you connect it.');
      }
      lines.push(`  ${outcome.detail}`);
      break;
    }
    case 'nothing-to-capture':
      lines.push('backthread capture: nothing to capture for this session.');
      lines.push(`  ${outcome.detail}`);
      break;
    case 'no-transcript':
      lines.push('backthread capture: no transcript to read.');
      lines.push(`  ${outcome.detail}`);
      break;
    case 'infer-failed':
    case 'persist-failed':
    case 'error':
      lines.push(`backthread capture: failed (${outcome.status}).`);
      lines.push(`  ${outcome.detail}`);
      break;
    default:
      lines.push(`backthread capture: ${outcome.status} — ${outcome.detail}`);
  }
  return lines.join('\n');
}

/**
 * Parse the manual-capture args from a bin argv slice (everything after `capture`).
 * Recognizes `--manual` (the mode flag), `--transcript <path>`, `--session <id>`,
 * and `--cwd <dir>`. A bare (non-flag) token is taken as the transcript path — so
 * the slash command's `[transcript-path]` argument-hint works (`/backthread:capture
 * /path/to.jsonl`). Returns `{ manual, input }`. Unknown flags are ignored (the bin
 * keeps the hook path as the default when no manual signal is present).
 */
export function parseManualArgs(argv: string[]): { manual: boolean; input: ManualCaptureInput } {
  const input: ManualCaptureInput = {};
  let manual = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manual') manual = true;
    else if (a === '--transcript') input.transcriptPath = argv[++i];
    else if (a === '--session') input.sessionId = argv[++i];
    else if (a === '--cwd') input.cwd = argv[++i];
    else if (!a.startsWith('--') && input.transcriptPath === undefined) input.transcriptPath = a;
  }
  return { manual, input };
}
