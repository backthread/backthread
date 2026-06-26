// prompt.ts — a tiny interactive yes/no readline prompt with a HARD TTY guard.
//
// The front door (firstRun.ts) wants to ASK before it wires anything up — capture
// install is consent-gated, never silent. But the same code paths also run in hooks,
// pipes, and CI where there is no human and no terminal; blocking on stdin there would
// HANG the process forever. So the one load-bearing rule here is the TTY guard: with no
// interactive terminal on BOTH stdin and stdout we resolve immediately (the caller's
// non-interactive default) WITHOUT ever opening readline — we never read a byte we can't
// expect an answer to. On a real TTY we read one line: empty ⇒ the default, y/yes ⇒ true,
// anything else ⇒ false.

import { createInterface } from 'node:readline';

export interface PromptOptions {
  /**
   * The answer for "just hit enter" on a TTY, AND the value returned when there's no
   * TTY at all. Defaults to false (the safe non-interactive answer: don't do the thing).
   * The bare-terminal install offer passes true so the prompt reads as `[Y/n]`.
   */
  defaultAnswer?: boolean;
  /** Input stream (tests). Defaults to process.stdin. Its `.isTTY` is the guard. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Output stream (tests). Defaults to process.stdout. Its `.isTTY` is the guard. */
  output?: NodeJS.WritableStream & { isTTY?: boolean };
}

/**
 * Ask `question` and resolve true/false. NON-TTY (no interactive terminal on stdin OR
 * stdout) resolves to `defaultAnswer` (default false) IMMEDIATELY, without prompting or
 * reading stdin — so this never hangs a headless / piped / hooked process. On a TTY:
 * empty input ⇒ `defaultAnswer`; `y`/`yes` (case-insensitive) ⇒ true; anything else ⇒ false.
 */
export async function promptYesNo(question: string, opts: PromptOptions = {}): Promise<boolean> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const defaultAnswer = opts.defaultAnswer ?? false;

  // TTY GUARD — the whole point of this module. No interactive terminal ⇒ no prompt.
  if (!input.isTTY || !output.isTTY) return defaultAnswer;

  const rl = createInterface({ input, output });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    const a = answer.trim().toLowerCase();
    if (a === '') return defaultAnswer;
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}
