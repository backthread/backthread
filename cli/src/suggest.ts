// suggest.ts — "did you mean …?" for an unknown subcommand.
//
// A tiny Levenshtein nearest-match so a typo (`backthread lgoin`) earns a friendly pointer
// instead of a bare error. Pure + dependency-free (keeps the bundle light), unit-tested in
// isolation. Conservative by design: it only suggests when the edit distance is small
// relative to the input, so `backthread frobnicate` suggests nothing rather than a nonsense
// "did you mean install?".

/** Max edit distance at which we'll offer a suggestion. Two covers the common typos
 *  (a dropped letter, a transposition, a doubled key) without matching unrelated words. */
const MAX_DISTANCE = 2;

/** Classic Levenshtein edit distance (insert / delete / substitute each cost 1). Iterative
 *  two-row DP — O(m·n) time, O(n) space; inputs here are short command names. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Stable tie-break: prefer the shorter command, then alphabetical, so a given typo always
// yields the same suggestion regardless of the order commands are listed in.
function preferable(candidate: string, incumbent: string): boolean {
  if (candidate.length !== incumbent.length) return candidate.length < incumbent.length;
  return candidate < incumbent;
}

/**
 * The nearest known command to `input`, or null when nothing is close enough. Case-
 * insensitive. A candidate qualifies only when its edit distance is ≤ MAX_DISTANCE AND
 * strictly less than the input length (so a short typo can't "match" a same-length command
 * it shares nothing with). Deterministic tie-break (see preferable). Never throws.
 */
export function nearestCommand(input: string, commands: readonly string[]): string | null {
  const needle = input.toLowerCase();
  if (needle.length === 0) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const cmd of commands) {
    const d = editDistance(needle, cmd.toLowerCase());
    if (d > MAX_DISTANCE || d >= needle.length) continue;
    if (d < bestDist || (d === bestDist && best !== null && preferable(cmd, best))) {
      best = cmd;
      bestDist = d;
    }
  }
  return best;
}
