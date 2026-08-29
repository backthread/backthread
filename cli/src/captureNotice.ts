// captureNotice.ts — the one thing capture has to say, left where somebody will read it.
//
// THE PROBLEM THIS EXISTS FOR. Capture ships as a DETACHED hook: the SessionEnd/Stop
// command re-spawns a worker with `stdio: 'ignore'` (see fromHook.ts) so a slow
// inference cannot be killed when the host agent exits. That is the right shape for
// the work, and it means the worker's stdout and stderr go to the kernel's bin. So a
// `console.warn` from inside a capture is not a quiet channel — it is NO channel. In
// the shipped delivery mode nothing written there has ever reached a person, and the
// one thing capture currently needs to say (that it left some of a session's file
// paths out, and why) was announced only there.
//
// So the notice is written to a file instead, and `backthread doctor` reads it. That
// is the channel that is actually read: doctor exists for exactly the moment somebody
// notices Backthread is doing less than they expected and goes looking for the reason.
//
// SYNCHRONOUS ON PURPOSE. Everything else in this directory that touches
// ~/.backthread is async, and this is the one caller that cannot be: it runs inside a
// detached process that may exit at any point after the capture completes, and an
// awaited write that has not landed by then is a notice nobody ever gets. One ~200-byte
// write against a process that is about to make network round-trips is not a cost worth
// a race.
//
// BEST-EFFORT, NEVER THROWS (load-bearing). Every caller is inside an always-exit-0
// hook. An unwritable home directory, a corrupt file, a full disk: all of them degrade
// to "no notice", never to a crashed session. Losing a diagnostic is a nuisance;
// breaking somebody's agent to deliver one is not a trade we get to make.
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { configDir, CONFIG_MODE, DIR_MODE } from './config.js';

/** What was left on disk for `doctor` to find. */
export interface CaptureNotice {
  /** When capture said it, ISO-8601. */
  at: string;
  /** The sentence to show. Product copy, written at the call site. */
  message: string;
}

/**
 * How recently capture must have said it for `doctor` to still report it.
 *
 * There is no "clear" step and there must not be one: nothing in the product knows
 * when the condition stopped, and a notice that has to be dismissed by hand is a
 * notice that gets dismissed while still true. The window does the work in both
 * directions instead. A machine where the condition still holds re-announces it on the
 * NEXT capture — the notice is rewritten every time — so a live problem stays visible
 * indefinitely. A machine where it has stopped goes quiet on its own after a week,
 * without anybody being asked to confirm a thing they cannot check.
 */
export const CAPTURE_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The notice file. One file, overwritten — the latest word, not a log. */
export function captureNoticePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'capture-notice.json');
}

/**
 * Record what capture has to say. Overwrites any previous notice: this is the CURRENT
 * state of a recurring condition, not a history of it, and a growing file in somebody's
 * home directory is a thing to maintain rather than a thing to read.
 *
 * Returns whether it landed, for tests and for callers that want to know. Never throws.
 */
export function recordCaptureNotice(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0) return false;
  try {
    const dir = configDir(env);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const notice: CaptureNotice = { at: now.toISOString(), message: trimmed };
    writeFileSync(captureNoticePath(env), JSON.stringify(notice, null, 2) + '\n', { mode: CONFIG_MODE });
    return true;
  } catch {
    return false; // unwritable home, full disk, … — a lost diagnostic, never a crash
  }
}

/**
 * The notice `doctor` should show, or null when there is nothing to say.
 *
 * Null covers all four ways there is nothing: no file, an unreadable one, a file whose
 * contents are not a notice, and a notice older than the window above. A corrupt read
 * MUST be silence rather than an error line — the file is a diagnostic aid, and a
 * diagnostic aid that reports on its own storage instead of on the product is noise at
 * the exact moment somebody is trying to read past it.
 */
export function readCaptureNotice(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): CaptureNotice | null {
  let raw: string;
  try {
    raw = readFileSync(captureNoticePath(env), 'utf8');
  } catch {
    return null; // nothing recorded, or we cannot read it — the same thing to a reader
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { at, message } = parsed as { at?: unknown; message?: unknown };
  if (typeof at !== 'string' || typeof message !== 'string') return null;
  if (message.trim().length === 0) return null;
  const when = Date.parse(at);
  if (!Number.isFinite(when)) return null;
  // A timestamp from the future is a clock that moved, not a fresh notice. Age it the
  // same way — `now - when` goes negative, which is inside the window — because the
  // alternative is discarding a real notice over a machine's clock.
  if (now.getTime() - when > CAPTURE_NOTICE_MAX_AGE_MS) return null;
  return { at, message: message.trim() };
}
