// Pure PSR-4 namespace↔path resolution — the PHP analogue of ruby-zeitwerk.ts.
// The reusable core the PHP graph extractor AND every PHP framework adapter share.
//
// PHP's cross-boundary dependency mechanism is the `use` statement: a class in one
// namespace references a class in another by its fully-qualified name (FQN), which
// Composer's PSR-4 autoloader maps to a file by convention. So the import backbone
// is recovered by inverting PSR-4:
//   * composer.json declares `autoload.psr-4` = { "App\\": "app/", … } — a map of
//     namespace PREFIX → base directory;
//   * an FQN `App\Models\User` under prefix `App\` (base `app/`) lives at
//     `app/Models/User.php` — strip the prefix, swap `\`→`/`, append `.php`,
//     rooted at the base dir.
//
// LONGEST-PREFIX wins (a `App\Tests\` mapping beats `App\`), mirroring how the
// Zeitwerk resolver picks the most specific autoload root. Deterministic + PURE
// (no fs, no parser) — every function here is a total function of its inputs; the
// composer.json read happens in the caller.

/** One PSR-4 mapping: a namespace prefix (trailing `\`) → one or more base dirs. */
export interface Psr4Entry {
  /** Namespace prefix, e.g. `App\` (with trailing separator), or `` for the root. */
  prefix: string;
  /** Repo-relative posix base dir(s), trailing slash stripped (`` = repo root). */
  baseDirs: string[];
}

/** Strip a leading namespace separator: `\App\Foo` → `App\Foo`. */
export function normalizeFqn(name: string): string {
  return name.replace(/^\\+/, '');
}

/** A posix base dir with a trailing slash stripped; `.`/`` collapse to repo root. */
function normalizeBaseDir(dir: string): string {
  const p = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return p === '.' || p === '' ? '' : p;
}

/**
 * The PSR-4 entries a composer.json declares — `autoload.psr-4` and
 * `autoload-dev.psr-4` merged, longest-prefix-first (so the most specific mapping
 * matches). A base-dir value may be a string or an array of strings (PSR-4 allows
 * several roots per prefix). Never throws: a malformed field yields no entries.
 */
export function parsePsr4Map(composer: unknown): Psr4Entry[] {
  const out: Psr4Entry[] = [];
  if (!composer || typeof composer !== 'object') return out;
  const c = composer as Record<string, unknown>;
  const sections = [c['autoload'], c['autoload-dev']];
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const psr4 = (section as Record<string, unknown>)['psr-4'];
    if (!psr4 || typeof psr4 !== 'object') continue;
    for (const [rawPrefix, rawBase] of Object.entries(psr4 as Record<string, unknown>)) {
      // A non-empty prefix always ends with `\` in composer; normalize defensively.
      const prefix = rawPrefix === '' ? '' : rawPrefix.endsWith('\\') ? rawPrefix : `${rawPrefix}\\`;
      const bases = (Array.isArray(rawBase) ? rawBase : [rawBase])
        .filter((b): b is string => typeof b === 'string')
        .map(normalizeBaseDir);
      if (bases.length === 0) continue;
      out.push({ prefix, baseDirs: bases });
    }
  }
  // Longest prefix first; a stable name tiebreak keeps resolution deterministic.
  return out.sort((a, b) => b.prefix.length - a.prefix.length || (a.prefix < b.prefix ? -1 : 1));
}

/** Join a base dir + a relative posix path (`` base = repo root). */
function joinUnder(baseDir: string, rel: string): string {
  return baseDir ? `${baseDir}/${rel}` : rel;
}

/**
 * Resolve a class FQN to the repo-relative file that defines it, via the PSR-4
 * entries, checking membership in `fileset`. Returns the first existing candidate
 * (entries are longest-prefix-first), or undefined when the FQN belongs to no
 * mapped namespace / no matching file exists (a vendor/global class — the caller
 * decides whether that's an external node). `entries` MUST be longest-first.
 */
export function resolveFqnToFile(
  fqn: string,
  entries: readonly Psr4Entry[],
  fileset: ReadonlySet<string>,
): string | undefined {
  const clean = normalizeFqn(fqn);
  if (!clean) return undefined;
  for (const { prefix, baseDirs } of entries) {
    let rest: string;
    if (prefix === '') {
      rest = clean; // the fallback root maps the whole FQN under its base dir
    } else {
      // An FQN equal to the bare namespace (no trailing class) defines no file.
      if (clean === prefix.slice(0, -1)) continue;
      if (!clean.startsWith(prefix)) continue;
      rest = clean.slice(prefix.length);
    }
    const relPath = `${rest.split('\\').join('/')}.php`;
    for (const base of baseDirs) {
      const cand = joinUnder(base, relPath);
      if (fileset.has(cand)) return cand;
    }
  }
  return undefined;
}
