// backfill.ts — the install-time history seed, now a THIN ALIAS over the general
// gap-recovery SWEEP (sweep.ts).
//
// WHY THIS IS NOW A SHIM (ARP-688): the one-shot install backfill and the
// auto-on-resume gap-recovery sweep are the SAME operation — "recover this repo's
// un-captured local sessions" — differing only in WHEN they run and whether a
// freshness debounce applies. So the real engine lives in sweep.ts (worktree-aware,
// idempotent via a durable ledger, attributed to the target repo), and `backthread
// install` simply runs it with `force: true` (an explicit user action always sweeps,
// no debounce). One mechanism, not two: the first sweep after install seeds all
// history; the SessionEnd hook keeps it current + heals any later gap.
//
// This module survives ONLY to preserve the public surface `install.ts` (+ its tests)
// already depend on — `runBackfill`, `BackfillSummary`, `BackfillInput`,
// `BackfillDeps`, `claudeProjectsDir`. New code should call `runSweep` directly.
//
// POSTURE is inherited verbatim from sweep.ts: best-effort, sequential, NEVER throws —
// every failure resolves into the summary.

import { join } from 'node:path';
import { slugifyCwd } from './captureCommand.js';
import { runSweep, type SweepDeps } from './sweep.js';
import type { CaptureOutcome } from './capture.js';

/** Inputs to a backfill run. */
export interface BackfillInput {
  /** The repo's working directory. Defaults to process.cwd(). */
  cwd?: string;
}

/** Seams so the backfill runs with zero real I/O / network in tests. runBackfill
 *  forwards these straight to {@link runSweep}, so they ARE the sweep's seams. */
export type BackfillDeps = SweepDeps;

/** One transcript's outcome. Retained for back-compat; the sweep no longer populates
 *  a per-transcript list (its richer per-dir attributions + log supersede it). */
export interface BackfillTranscriptResult {
  file: string;
  outcome: CaptureOutcome;
}

/** What a backfill run produced. Never thrown — onboarding tolerates any failure. */
export interface BackfillSummary {
  /** How many sessions we processed (after skip-before-inference). */
  found: number;
  /** How many produced at least one persisted decision. */
  captured: number;
  /** Total decisions persisted across all sessions. */
  decisions: number;
  /** Retained for back-compat; always empty now (see {@link BackfillTranscriptResult}). */
  results: BackfillTranscriptResult[];
  /** A one-line human summary for the onboarding log. */
  text: string;
}

/** The Claude Code transcripts dir for a repo path: `~/.claude/projects/<encoded-cwd>/`. */
export function claudeProjectsDir(cwd: string, home: string): string {
  return join(home, '.claude', 'projects', slugifyCwd(cwd));
}

/**
 * Run the install-time history seed: a FORCED gap-recovery sweep (no debounce) of the
 * repo's past sessions. Best-effort + sequential; NEVER throws. Delegates to
 * {@link runSweep}; the BackfillDeps map 1:1 onto SweepDeps, so they pass through.
 */
export async function runBackfill(
  input: BackfillInput = {},
  deps: BackfillDeps = {},
): Promise<BackfillSummary> {
  const summary = await runSweep({ cwd: input.cwd, force: true }, deps);
  return {
    found: summary.found,
    captured: summary.captured,
    decisions: summary.decisions,
    results: [],
    text: summary.text,
  };
}
