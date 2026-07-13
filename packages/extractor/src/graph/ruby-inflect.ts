// Rails-style inflections for Ruby constant / route / association resolution.
//
// Two jobs the DEFAULT Zeitwerk + Rails conventions have to get right, and which
// naive string munging gets wrong:
//
//   * ACRONYM-aware camelize — `activitypub/inboxes_controller.rb` defines the
//     constant `ActivityPub::InboxesController`, not `Activitypub::…`, but ONLY
//     because the repo DECLARES `inflect.acronym "ActivityPub"`. We read the
//     declared acronyms and apply *only* those — no built-in acronym guessing (a
//     wrong guess would produce a wrong casing → a wrong or missing edge; the
//     "never a wrong edge" rule wins). An undeclared word camelizes exactly as
//     before.
//   * real English pluralize / singularize — `resource :inbox` maps to
//     `InboxesController` (inbox → inbox*es*, not the naive `inboxs`), and
//     `has_many :people` targets `Person`. Repo-declared `inflect.irregular`
//     pairs win; a small built-in irregular table + rules cover the rest.
//
// PURE + deterministic. `parseInflections(text)` regex-scans one
// config/initializers/inflections.rb; `readInflections(repoDir, fileIds)` is the
// one impure boundary (reads the file[s] once per repo). The resulting
// `Inflections` object is threaded (as an optional arg) through camelize /
// pluralize / singularize; with `DEFAULT_INFLECTIONS` (no repo file) the built-in
// irregular table still applies but behavior is otherwise the pre-inflection one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The resolved inflection tables for one repo (declared rules merged over the
 *  built-in defaults). All maps key on the lower-cased word. */
export interface Inflections {
  /** lower-cased word → canonical acronym casing, e.g. `activitypub` → `ActivityPub`. */
  acronyms: Map<string, string>;
  /** lower-cased singular → plural, e.g. `person` → `people`. */
  irregularPlural: Map<string, string>;
  /** lower-cased plural → singular, e.g. `people` → `person`. */
  irregularSingular: Map<string, string>;
  /** lower-cased words that don't inflect (same singular + plural), e.g. `series`. */
  uncountable: Set<string>;
}

// Built-in irregular pairs [singular, plural]. Kept deliberately small — the common
// English irregulars plus the few "…s → …ses" words the suffix rules can't recover
// (a bare `statuses → statuse` / `buses → buse` would be wrong), so they live here
// as exact pairs instead. A repo's own `inflect.irregular` overrides these.
const DEFAULT_IRREGULARS: ReadonlyArray<readonly [string, string]> = [
  ['person', 'people'],
  ['man', 'men'],
  ['woman', 'women'],
  ['child', 'children'],
  ['tooth', 'teeth'],
  ['foot', 'feet'],
  ['goose', 'geese'],
  ['mouse', 'mice'],
  ['ox', 'oxen'],
  // "…s / …es" words the generic sibilant rule can't singularize unambiguously.
  ['status', 'statuses'],
  ['bus', 'buses'],
  ['alias', 'aliases'],
  ['movie', 'movies'],
];

// Built-in uncountable words (same singular + plural). A repo's `inflect.uncountable`
// adds to these.
const DEFAULT_UNCOUNTABLE: readonly string[] = [
  'equipment',
  'information',
  'money',
  'species',
  'series',
  'fish',
  'sheep',
  'metadata',
];

/** The defaults-only Inflections (built-in irregulars + uncountables, no declared
 *  acronyms) — the shared fallback for callers with no repo inflections file. */
export const DEFAULT_INFLECTIONS: Inflections = buildInflections([]);

/** A partial set of declared rules parsed from ONE inflections.rb. */
export interface ParsedInflections {
  acronyms: string[];
  irregulars: Array<readonly [string, string]>;
  uncountable: string[];
}

const ACRONYM_RE = /\binflect\.acronym\s*\(?\s*['"]([^'"]+)['"]/g;
const IRREGULAR_RE = /\binflect\.irregular\s*\(?\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
const UNCOUNTABLE_ONE_RE = /\binflect\.uncountable\s*\(?\s*['"]([^'"]+)['"]/g;
const UNCOUNTABLE_WORDS_RE = /\binflect\.uncountable\s*%w[[(]([^\])]*)[\])]/g;

/**
 * Regex-scan one config/initializers/inflections.rb for the declared
 * `inflect.acronym` / `inflect.irregular` / `inflect.uncountable` rules. PURE —
 * text in, rules out. Full-line comments (Rails ships the file full of commented
 * examples) are stripped so the disabled examples never leak in.
 */
export function parseInflections(text: string): ParsedInflections {
  const code = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  const acronyms: string[] = [];
  for (const m of code.matchAll(ACRONYM_RE)) acronyms.push(m[1]);

  const irregulars: Array<readonly [string, string]> = [];
  for (const m of code.matchAll(IRREGULAR_RE)) irregulars.push([m[1], m[2]]);

  const uncountable: string[] = [];
  for (const m of code.matchAll(UNCOUNTABLE_ONE_RE)) uncountable.push(m[1]);
  for (const m of code.matchAll(UNCOUNTABLE_WORDS_RE)) {
    for (const w of m[1].split(/\s+/).filter(Boolean)) uncountable.push(w);
  }

  return { acronyms, irregulars, uncountable };
}

/**
 * Merge the built-in defaults with zero or more parsed inflection sets (later
 * sets — the repo's own — win on collision). Deterministic: the same inputs always
 * yield the same tables.
 */
export function buildInflections(parsed: readonly ParsedInflections[]): Inflections {
  const acronyms = new Map<string, string>();
  const irregularPlural = new Map<string, string>();
  const irregularSingular = new Map<string, string>();
  const uncountable = new Set<string>();

  for (const [sg, pl] of DEFAULT_IRREGULARS) {
    irregularPlural.set(sg.toLowerCase(), pl);
    irregularSingular.set(pl.toLowerCase(), sg);
  }
  for (const w of DEFAULT_UNCOUNTABLE) uncountable.add(w.toLowerCase());

  for (const p of parsed) {
    for (const a of p.acronyms) acronyms.set(a.toLowerCase(), a);
    for (const [sg, pl] of p.irregulars) {
      irregularPlural.set(sg.toLowerCase(), pl);
      irregularSingular.set(pl.toLowerCase(), sg);
    }
    for (const w of p.uncountable) uncountable.add(w.toLowerCase());
  }

  return { acronyms, irregularPlural, irregularSingular, uncountable };
}

/**
 * Read + merge every config/initializers/inflections.rb in the repo's file set
 * (the app's, plus any engine's) into one Inflections. The single impure step;
 * a file that can't be read is simply skipped. Always includes the built-in
 * defaults, so an absent file still yields a usable (defaults-only) table.
 */
export function readInflections(repoDir: string, fileIds: readonly string[]): Inflections {
  const parsed: ParsedInflections[] = [];
  for (const id of [...fileIds].sort()) {
    if (!/(^|\/)config\/initializers\/inflections\.rb$/.test(id)) continue;
    try {
      parsed.push(parseInflections(readFileSync(join(repoDir, id), 'utf8')));
    } catch {
      // unreadable — skip (defaults still apply)
    }
  }
  return buildInflections(parsed);
}

// ---------------------------------------------------------------------------
// The inflection functions.

/** Apply the leading-capitalization of `source` to `word` (irregular tables store
 *  lower-cased values; a capitalized input keeps its capital). */
function matchLeadingCase(source: string, word: string): string {
  if (!source || !word) return word;
  return source[0] === source[0].toUpperCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/**
 * Whole-word OR underscore-suffix irregular lookup. Rails' irregular rules are
 * suffix-anchored (`salespeople` → `salesperson`, `preview_cards_statuses` →
 * `preview_cards_status`), so besides the whole-word hit we also match the longest
 * irregular key that follows a `_` boundary — the boundary keeps a short suffix
 * (`men`) from matching inside an unrelated word. Returns undefined on no match.
 */
function applyIrregular(word: string, table: Map<string, string>): string | undefined {
  const lower = word.toLowerCase();
  const exact = table.get(lower);
  if (exact) return matchLeadingCase(word, exact);
  let best: { key: string; val: string } | undefined;
  for (const [key, val] of table) {
    if (lower.endsWith(`_${key}`) && (!best || key.length > best.key.length)) best = { key, val };
  }
  return best ? word.slice(0, word.length - best.key.length) + best.val : undefined;
}

/**
 * Camelize one underscore_cased path segment: `users_controller` → `UsersController`.
 * A declared acronym replaces a whole underscore-delimited word with its canonical
 * casing (`api` → `API`, `activitypub` → `ActivityPub`). This matches Zeitwerk's
 * inflector for the DECLARED acronyms; an undeclared word gets plain first-letter
 * capitalization (the pre-inflection behavior).
 */
export function camelize(segment: string, infl: Inflections = DEFAULT_INFLECTIONS): string {
  return segment
    .split('_')
    .map((w) => {
      if (!w.length) return w;
      const acronym = infl.acronyms.get(w.toLowerCase());
      if (acronym) return acronym;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
}

/**
 * The plural of an English word (`inbox` → `inboxes`, `company` → `companies`,
 * `person` → `people`). Declared/irregular pairs and uncountables win; then the
 * rules: consonant-`y` → `ies`; sibilant (`s`/`x`/`z`/`ch`/`sh`) → `+es`; else `+s`.
 */
export function pluralize(word: string, infl: Inflections = DEFAULT_INFLECTIONS): string {
  if (!word) return word;
  const lower = word.toLowerCase();
  if (infl.uncountable.has(lower)) return word;
  const irr = applyIrregular(word, infl.irregularPlural);
  if (irr) return irr;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/**
 * The singular of an English word (`inboxes` → `inbox`, `companies` → `company`,
 * `people` → `person`, `statuses` → `status`). Declared/irregular pairs and
 * uncountables win; then the rules: consonant-`ies` → `y`; sibilant-`es`
 * (`x`/`ch`/`ss`/`sh`) → strip `es`; a trailing `s` (not `ss`) → strip `s`.
 */
export function singularize(word: string, infl: Inflections = DEFAULT_INFLECTIONS): string {
  if (!word) return word;
  const lower = word.toLowerCase();
  if (infl.uncountable.has(lower)) return word;
  const irr = applyIrregular(word, infl.irregularSingular);
  if (irr) return irr;
  if (/[^aeiou]ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/(x|ch|ss|sh)es$/i.test(word)) return word.slice(0, -2);
  if (word.length > 1 && /s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}
