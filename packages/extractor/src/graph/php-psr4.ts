// Pure PHP autoload namespace↔path resolution — the PHP analogue of
// ruby-zeitwerk.ts. The reusable core the PHP graph extractor AND every PHP
// framework adapter share.
//
// PHP's cross-boundary dependency mechanism is the `use` statement: a class in one
// namespace references a class in another by its fully-qualified name (FQN), which
// Composer's autoloader maps to a file. Three strategies, tried in order of how
// reliably a repo declares them:
//
//   * PSR-4 (the modern default) — `autoload.psr-4` = { "App\\": "app/", … } maps
//     a namespace PREFIX → base directory; an FQN `App\Models\User` under prefix
//     `App\` (base `app/`) lives at `app/Models/User.php` — STRIP the prefix, swap
//     `\`→`/`, append `.php`, rooted at the base dir.
//   * PSR-0 (the legacy standard) — `autoload.psr-0` = { "Twig_": "lib/", … }.
//     Unlike PSR-4 the prefix is matched but NOT stripped (the full namespace path
//     is placed UNDER the base dir), and underscores in the CLASS NAME segment
//     become directory separators (the legacy quirk). `App\Models\User` under
//     `App\`→`lib/` lives at `lib/App/Models/User.php`; `Twig_Environment` under
//     `Twig_`→`lib/` lives at `lib/Twig/Environment.php`.
//   * classmap / declared-class index — a repo with `autoload.classmap` (or a
//     PSR-4-declared class that simply isn't at its conventional path) resolves by
//     the class→file index the extractor builds by parsing every file's declared
//     class/interface/trait/enum FQNs. That index is passed IN (it is extraction
//     state, not a pure function of composer.json), so the resolver stays pure.
//
// LONGEST-PREFIX wins within each strategy (a `App\Tests\` mapping beats `App\`),
// mirroring how the Zeitwerk resolver picks the most specific autoload root.
// Deterministic + PURE (no fs, no parser) — every function here is a total
// function of its inputs; the composer.json read happens in the caller.

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

// ---------------------------------------------------------------------------
// PSR-0 (the legacy autoload standard).

/** One PSR-0 mapping: a namespace/underscore prefix → one or more base dirs. */
export interface Psr0Entry {
  /**
   * The PSR-0 prefix VERBATIM as composer declares it: a namespace prefix
   * (`Symfony\`, `App\`) or an underscore pseudo-namespace (`Twig_`, `Zend_`), or
   * `` for the fallback root. Unlike PSR-4 the trailing separator is NOT forced —
   * `Twig_` is a valid underscore-style prefix and must match verbatim.
   */
  prefix: string;
  /** Repo-relative posix base dir(s), trailing slash stripped (`` = repo root). */
  baseDirs: string[];
}

/**
 * The PSR-0 entries a composer.json declares — `autoload.psr-0` and
 * `autoload-dev.psr-0` merged, longest-prefix-first. A base-dir value may be a
 * string or an array of strings. Never throws: a malformed field yields no
 * entries. Distinct from parsePsr4Map only in that the prefix is kept verbatim
 * (no forced trailing `\`), since PSR-0 allows underscore-style prefixes.
 */
export function parsePsr0Map(composer: unknown): Psr0Entry[] {
  const out: Psr0Entry[] = [];
  if (!composer || typeof composer !== 'object') return out;
  const c = composer as Record<string, unknown>;
  const sections = [c['autoload'], c['autoload-dev']];
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const psr0 = (section as Record<string, unknown>)['psr-0'];
    if (!psr0 || typeof psr0 !== 'object') continue;
    for (const [prefix, rawBase] of Object.entries(psr0 as Record<string, unknown>)) {
      const bases = (Array.isArray(rawBase) ? rawBase : [rawBase])
        .filter((b): b is string => typeof b === 'string')
        .map(normalizeBaseDir);
      if (bases.length === 0) continue;
      out.push({ prefix, baseDirs: bases });
    }
  }
  return out.sort((a, b) => b.prefix.length - a.prefix.length || (a.prefix < b.prefix ? -1 : 1));
}

/**
 * The PSR-0 relative path for a full FQN (prefix NOT stripped): the namespace
 * segment maps `\`→`/`, then the trailing class-name segment additionally maps
 * `_`→`/` (the legacy underscore quirk — underscores in the namespace part are
 * NOT converted). `App\Models\User` → `App/Models/User.php`; `Twig_Environment`
 * → `Twig/Environment.php`.
 */
function psr0RelPath(clean: string): string {
  const lastSep = clean.lastIndexOf('\\');
  const nsPart = lastSep >= 0 ? clean.slice(0, lastSep) : '';
  const classPart = lastSep >= 0 ? clean.slice(lastSep + 1) : clean;
  const nsPath = nsPart ? `${nsPart.split('\\').join('/')}/` : '';
  const classPath = classPart.split('_').join('/');
  return `${nsPath}${classPath}.php`;
}

/**
 * Resolve a class FQN to its file via the PSR-0 entries, checking membership in
 * `fileset`. Returns the first existing candidate (entries are longest-prefix-
 * first), or undefined. `entries` MUST be longest-first. The prefix is matched
 * against the FQN but the FULL FQN path is placed under the base dir (the PSR-0
 * rule).
 */
export function resolvePsr0ToFile(
  fqn: string,
  entries: readonly Psr0Entry[],
  fileset: ReadonlySet<string>,
): string | undefined {
  const clean = normalizeFqn(fqn);
  if (!clean) return undefined;
  const relPath = psr0RelPath(clean);
  for (const { prefix, baseDirs } of entries) {
    if (prefix !== '' && !clean.startsWith(prefix)) continue;
    for (const base of baseDirs) {
      const cand = joinUnder(base, relPath);
      if (fileset.has(cand)) return cand;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The combined autoload resolver — PSR-4 → PSR-0 → declared-class index.

/**
 * Resolve a class FQN to the repo-relative file that defines it, trying the
 * autoload strategies in order of declaration reliability: PSR-4 (convention),
 * then PSR-0 (legacy convention), then the declared-class index (classmap-
 * equivalent — the ground truth built by parsing every file's declared classes,
 * which also catches a first-party class that simply isn't at its
 * PSR-4-conventional path). `classIndex` is keyed by NORMALIZED FQN (no leading
 * separator). Undefined ⇒ vendor/global class (the caller decides it's an
 * external). Pure — all state is passed in.
 */
export function resolveAutoload(
  fqn: string,
  psr4: readonly Psr4Entry[],
  psr0: readonly Psr0Entry[],
  fileset: ReadonlySet<string>,
  classIndex?: ReadonlyMap<string, string>,
): string | undefined {
  const clean = normalizeFqn(fqn);
  if (!clean) return undefined;
  return (
    resolveFqnToFile(clean, psr4, fileset) ??
    resolvePsr0ToFile(clean, psr0, fileset) ??
    classIndex?.get(clean)
  );
}
