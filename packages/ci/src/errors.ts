/**
 * What can be safely PRINTED about a value that was thrown.
 *
 * A `catch` binding is `unknown`, and `(e as Error).message` is a lie the compiler
 * accepts: it silences that and then reads `.message` off whatever actually arrived.
 * When a producer throws `undefined`, the handler's own error path throws
 * `TypeError: Cannot read properties of undefined` — so a logging line turns a
 * handled refusal into an unhandled crash, one layer up from the thing it was
 * reporting.
 *
 * This module has NO imports and is the leaf of the package on purpose: an error
 * formatter that can itself fail, or that drags a dependency in, is the failure it
 * exists to prevent.
 */

/**
 * The `.message` of a thrown thing, WITHOUT assuming it is an `Error`.
 *
 * Total by construction: every branch returns a string, including the two absences.
 * `String(undefined)` is `"undefined"`, which READS as a value rather than as an
 * absence — so the two are named explicitly and the log is never quietly ambiguous
 * about whether something was thrown or nothing was.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  if (typeof m === 'string') return m;
  return e === undefined ? '<undefined thrown>' : e === null ? '<null thrown>' : String(e);
}
