// backfill.ts — the cli-native first-run BACKFILL.
//
// WHAT + WHY: on install/first-run we want the decision log to be NON-EMPTY at the
// rescue-mode aha moment, then self-maintaining thereafter (the SessionEnd hook
// keeps it current). So onboarding chains into a one-shot backfill that walks the
// repo's PRE-EXISTING Claude Code transcripts and runs each one through the SAME
// `runCapture` pipeline the live hook uses.
//
// ARCHITECTURE DECISION (flagged on the ticket): the ORIGINAL backfill is
// `scripts/ingest/decisions/backfill-cli.ts`, but the `npx backthread` plugin CANNOT ship
// `scripts/` (it's a separate, dependency-light bundle; its tsconfig pins
// rootDir: src). So this is a CLI-NATIVE backfill: it does NOT import from
// `scripts/` and does NOT reimplement the redact/derive/persist pipeline — it
// enumerates transcripts and delegates every one to `runCapture` (capture.ts). The
// redact-LOCALLY → derive → persist contract and the never-store-source posture are
// therefore inherited verbatim from the live capture pipeline.
//
// SCOPE (flagged): this cli-native backfill is CLAUDE-CODE-ONLY. Claude Code lays
// its transcripts out per-repo at `~/.claude/projects/<encoded-cwd>/*.jsonl` (the
// layout established + slugifyCwd encodes), which we can enumerate with zero
// dependencies. The MULTI-AGENT backfill (Codex / Cursor / Gemini CLI, via the
// provider registry) stays the dogfood/server path in `scripts/` — those
// adapters live there and we must not depend on them. A founder who also uses other
// agents still gets live capture for them via the per-agent surfaces; only the
// one-shot history seed is Claude-Code-only here. Flagged as a follow-up.
//
// POSTURE — BEST-EFFORT, NEVER BLOCKS, NEVER THROWS: backfill is a nicety, not a
// gate. A missing transcripts dir, an unreadable file, or a per-transcript capture
// failure is swallowed and tallied; the run resolves a structured summary. We run
// transcripts SEQUENTIALLY (not concurrently) — there's no rush on a one-shot seed,
// and serial keeps the server-side inference load gentle and the output readable.

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runCapture, type CaptureDeps, type CaptureOutcome, type HookInput } from './capture.js';
import { slugifyCwd } from './captureCommand.js';

/** Inputs to a backfill run. */
export interface BackfillInput {
  /** The repo's working directory. Defaults to process.cwd(). Used to locate the
   *  Claude Code transcripts dir AND threaded into each capture as `cwd` (so the
   *  pipeline resolves the same repo for every transcript). */
  cwd?: string;
}

/** Seams so the backfill runs with zero real I/O / network in tests. */
export interface BackfillDeps {
  /** Env override. Defaults to process.env (threaded into each capture). */
  env?: NodeJS.ProcessEnv;
  /** Test seam: home directory. Defaults to os.homedir(). */
  homedirImpl?: () => string;
  /** Test seam: list a dir's entries (file names). Defaults to fs.readdir. */
  readDirImpl?: (dir: string) => Promise<string[]>;
  /** Test seam: the capture pipeline. Defaults to runCapture. */
  runCaptureImpl?: (input: HookInput, deps?: CaptureDeps) => Promise<CaptureOutcome>;
  /** CaptureDeps threaded into each capture (env, fetch, readers, ensureAuth). */
  captureDeps?: CaptureDeps;
  /** Where human-readable progress goes. Defaults to console.error (stderr). */
  log?: (msg: string) => void;
}

/** One transcript's outcome, for the tally. */
export interface BackfillTranscriptResult {
  /** The transcript file name (not the full path — keeps logs terse + leak-free). */
  file: string;
  /** The structured capture outcome (or a synthesized `error` outcome if it threw). */
  outcome: CaptureOutcome;
}

/** What a backfill run produced. Never thrown — onboarding tolerates any failure. */
export interface BackfillSummary {
  /** How many transcript files we found to process. */
  found: number;
  /** How many produced at least one persisted decision. */
  captured: number;
  /** Total decisions persisted across all transcripts (when the outcome reported a count). */
  decisions: number;
  /** Per-transcript results (in processing order). */
  results: BackfillTranscriptResult[];
  /** A one-line human summary for the onboarding log. */
  text: string;
}

/** The Claude Code transcripts dir for a repo path: `~/.claude/projects/<encoded-cwd>/`. */
export function claudeProjectsDir(cwd: string, home: string): string {
  return join(home, '.claude', 'projects', slugifyCwd(cwd));
}

/** Default dir listing → just the entry names. A missing/unreadable dir yields []. */
async function defaultReadDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Run the one-shot backfill: enumerate this repo's Claude Code `.jsonl` transcripts
 * and run each through `runCapture`. Best-effort + sequential; NEVER throws — every
 * failure resolves into the summary. Returns a tally the onboarding flow can print.
 *
 * Each transcript is fed to the pipeline as a hook input with `transcript_path` +
 * `cwd` (so it resolves the repo identically to a live capture). The pipeline's own
 * dedupe key makes a re-run idempotent — re-running install never double-writes.
 */
export async function runBackfill(
  input: BackfillInput = {},
  deps: BackfillDeps = {},
): Promise<BackfillSummary> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const home = (deps.homedirImpl ?? homedir)();
  const cwd = input.cwd ?? process.cwd();
  const doReadDir = deps.readDirImpl ?? defaultReadDir;
  const run = deps.runCaptureImpl ?? runCapture;

  const dir = claudeProjectsDir(cwd, home);

  let entries: string[];
  try {
    entries = await doReadDir(dir);
  } catch {
    // defaultReadDir already swallows, but an injected reader might throw — degrade.
    entries = [];
  }

  // Only `.jsonl` files are Claude Code transcripts. Sort for a stable, readable
  // order (oldest-by-name first is fine — capture derives its own decidedAt).
  const files = entries.filter((n) => n.endsWith('.jsonl')).sort();

  if (files.length === 0) {
    const text =
      'backthread backfill: no past Claude Code sessions found for this repo — nothing to backfill. ' +
      'Live capture is armed; your decision log fills as you work.';
    log(text);
    return { found: 0, captured: 0, decisions: 0, results: [], text };
  }

  log(
    `backthread backfill: found ${files.length} past Claude Code session(s) for this repo — ` +
      'seeding your decision log (best-effort, this never blocks)…',
  );

  const results: BackfillTranscriptResult[] = [];
  let captured = 0;
  let decisions = 0;

  // Sequential on purpose (see header): a one-shot seed has no latency budget, and
  // serial keeps server-side inference load gentle + the per-file log readable.
  for (const file of files) {
    const hookInput: HookInput = {
      transcript_path: join(dir, file),
      cwd,
      hook_event_name: 'SessionEnd',
    };
    let outcome: CaptureOutcome;
    try {
      outcome = await run(hookInput, deps.captureDeps);
    } catch (e) {
      // runCapture is contracted never to throw; this is belt-and-braces so one bad
      // transcript can never abort the whole backfill (or the install flow).
      outcome = { status: 'error', detail: `capture threw (swallowed): ${(e as Error).message}` };
    }
    results.push({ file, outcome });

    if (outcome.status === 'persisted' || outcome.status === 'persisted-by-server') {
      captured += 1;
      decisions += typeof outcome.count === 'number' ? outcome.count : 0;
    }
    log(`  ${file}: ${outcome.status}${typeof outcome.count === 'number' ? ` (${outcome.count})` : ''}`);
  }

  const text =
    `backthread backfill: processed ${files.length} session(s), captured ${decisions} decision(s) ` +
    `from ${captured} session(s). Your "How it works" log is no longer empty.`;
  log(text);
  return { found: files.length, captured, decisions, results, text };
}
