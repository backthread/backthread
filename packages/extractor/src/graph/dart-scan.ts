// Pure, hand-rolled SYNTACTIC scanner for Dart source — the install-free,
// native-dependency-free backbone of the Dart extractor (the Elixir precedent; no
// tree-sitter WASM, no `analyzer` — which IS the Dart SDK and would execute repo
// code). Dart's module graph is the SIMPLEST of any shipped language: imports are
// FILE-granular URIs on line-anchored directives, so the backbone is pure
// path-arithmetic — no class registry needed (that's built separately for the
// framework adapters).
//
// The five directives this reads (all line-anchored, `;`-terminated, URI = a single-
// or double-quoted string literal):
//   * import 'uri' [as x] [show/hide …] [if (cond) 'uri2'];  → the default URI only
//   * export 'uri' [show/hide …];                            → an import-kind reexport
//   * part 'uri';                                            → a source part (codegen)
//   * part of 'uri';  |  part of dotted.library.name;        → this file IS a part
//   * library dotted.name;                                   → the library's name
//
// Directives sit at the top of a Dart file before any declarations, but the scan is
// whole-file + line-anchored (robust: a keyword mid-expression is never a directive).
// COMMENT- and multiline-string-aware: `//` line comments, `/* … */` block comments,
// and `'''`/`"""` triple-quoted strings are stripped/blanked so a commented-out or
// doc-embedded `import` line never registers. Single-line `'…'`/`"…"` strings are
// preserved (the directive URIs live there); a `//` inside such a string is
// harmlessly cut — a real directive URI (`package:foo/bar.dart`) never contains one.

export interface DartPartOf {
  /** URI form: `part of 'parent.dart'` → the (relative) parent URI. */
  uri?: string;
  /** Library-name form: `part of my.lib.name;` → the dotted library name. */
  name?: string;
}

export interface DartDirectives {
  /** import URIs — the DEFAULT URI of a conditional import. */
  imports: string[];
  /** export URIs (treated as import-kind reexport edges). */
  exports: string[];
  /** `part 'uri'` URIs — the codegen/part files this library declares. */
  parts: string[];
  /** `part of …` — present iff this file is itself a part of another library. */
  partOf?: DartPartOf;
  /** `library <name>;` — the library name this file declares, if any. */
  library?: string;
}

const IMPORT_RE = /^\s*import\s+(['"])([^'"]+)\1/;
const EXPORT_RE = /^\s*export\s+(['"])([^'"]+)\1/;
// `part of …` — checked BEFORE `part '…'` (disjoint: `part of` has no quote after `part`).
const PART_OF_URI_RE = /^\s*part\s+of\s+(['"])([^'"]+)\1/;
const PART_OF_NAME_RE = /^\s*part\s+of\s+([A-Za-z_$][\w.]*)\s*;/;
const PART_RE = /^\s*part\s+(['"])([^'"]+)\1/;
// `library some.name;` (the name is optional in modern Dart: a bare `library;`).
const LIBRARY_RE = /^\s*library\s+([A-Za-z_$][\w.]*)?\s*;/;

/**
 * Physical lines with comments stripped and multiline-string interiors blanked, so a
 * directive-looking line inside a block comment, a `///` doc, or a `'''…'''` string
 * never registers. Line indices are preserved (interior lines become ''). Cheap +
 * deterministic; never throws. Best-effort: a block-comment / triple-quote opener
 * sitting inside a single-line string is not tracked (a directive line never has one).
 */
export function sourceLines(text: string): string[] {
  const raw = text.split('\n');
  const out: string[] = [];
  let inBlock = false; // inside a /* … */ block comment
  let inTriple = false; // inside a '''…''' / """…""" multiline string
  let tripleDelim = '';

  for (const original of raw) {
    let line = original;

    // Continue a multiline string until its closing delimiter.
    if (inTriple) {
      const idx = line.indexOf(tripleDelim);
      if (idx < 0) {
        out.push('');
        continue;
      }
      line = line.slice(idx + tripleDelim.length);
      inTriple = false;
    }
    // Continue a block comment until its terminator.
    if (inBlock) {
      const idx = line.indexOf('*/');
      if (idx < 0) {
        out.push('');
        continue;
      }
      line = line.slice(idx + 2);
      inBlock = false;
    }

    // Clean the top-level remainder char by char: drop `//`-to-EOL, skip inline
    // `/* … */`, and skip triple-quoted spans; leave a trailing unterminated
    // block-comment / triple-string opener as carried state.
    let res = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      const two = line.slice(i, i + 2);
      if (two === '//') break; // line comment → rest of line dropped
      if (two === '/*') {
        const end = line.indexOf('*/', i + 2);
        if (end < 0) {
          inBlock = true;
          break;
        }
        i = end + 2;
        continue;
      }
      const three = line.slice(i, i + 3);
      if (three === "'''" || three === '"""') {
        const end = line.indexOf(three, i + 3);
        if (end < 0) {
          inTriple = true;
          tripleDelim = three;
          break;
        }
        i = end + 3;
        continue;
      }
      res += line[i];
      i++;
    }
    out.push(res);
  }
  return out;
}

/** Every directive in `text`, resolved in one comment-aware pass. Never throws. */
export function scanDartDirectives(text: string): DartDirectives {
  const imports: string[] = [];
  const exports: string[] = [];
  const parts: string[] = [];
  let partOf: DartPartOf | undefined;
  let library: string | undefined;

  for (const line of sourceLines(text)) {
    let m = line.match(IMPORT_RE);
    if (m) {
      imports.push(m[2]);
      continue;
    }
    m = line.match(EXPORT_RE);
    if (m) {
      exports.push(m[2]);
      continue;
    }
    // `part of …` must be tried before `part '…'`.
    if (!partOf) {
      const ofUri = line.match(PART_OF_URI_RE);
      if (ofUri) {
        partOf = { uri: ofUri[2] };
        continue;
      }
      const ofName = line.match(PART_OF_NAME_RE);
      if (ofName) {
        partOf = { name: ofName[1] };
        continue;
      }
    }
    m = line.match(PART_RE);
    if (m) {
      parts.push(m[2]);
      continue;
    }
    if (library === undefined) {
      const lib = line.match(LIBRARY_RE);
      if (lib) library = lib[1] ?? '';
    }
  }

  return { imports, exports, parts, partOf, library };
}
