// Pure, hand-rolled SYNTACTIC scanner for Swift source — the install-free,
// native-dependency-free backbone of the Swift extractor (the Elixir-scanner
// precedent: no tree-sitter, no WASM, no repo-code execution — just deterministic
// string scanning). It reads the four things the Swift graph needs (imports + type
// decls + type refs for the import backbone; call sites for v2 `call` edges):
//
//   1. IMPORTS      — `import Foo`, `@testable import Foo`, `public import Foo`,
//                     `import class Foundation.NSData` — the MODULE name (first
//                     path segment). Module-level, so within a single-module app
//                     these give ~no intra-repo edges; across SPM targets / modules
//                     they're the cross-module boundary signal, and un-dropped
//                     third-party modules become `ext:<Module>` externals.
//   2. TYPE DECLS   — the PRIMARY nominal-type declarations a file defines:
//                     `class`/`struct`/`enum`/`protocol`/`actor`/`typealias Name`.
//                     These build the repo-global type-declaration registry (the
//                     Zeitwerk analogue) the resolver keys on. `extension` is
//                     deliberately NOT a declaration (it EXTENDS a type declared
//                     elsewhere) — it is picked up on the REFERENCE side instead, so
//                     a type + N extension files never self-cancel into ambiguity.
//   3. TYPE REFS    — every UpperCamelCase identifier token in the code body (import
//                     lines excluded). The adapter resolves each against the registry;
//                     a token naming a type DECLARED IN ANOTHER FILE → an intra-module
//                     `import`-kind edge. A token that names no registered type (a
//                     local, an Apple SDK type, a generic param) simply doesn't
//                     resolve — the registry lookup is the filter.
//   4. CALL SITES   — an initializer `Foo(…)` or a static call `Foo.member(…)` whose
//                     head is an UpperCamelCase type. The adapter resolves the head to
//                     its declaring file → a `call` edge (v2). Instance/dynamic calls
//                     have no resolvable head; pattern-match lines are excluded.
//
// Everything runs over a COMMENT- and STRING-STRIPPED copy of the source, so a
// `class Foo` inside a `//` comment or a `"..."` literal never registers as a decl
// or a reference (comment stripping is load-bearing: a commented-out declaration
// that DID register would spuriously make its real declaration ambiguous and drop
// it). The stripper is Swift-aware: nested `/* */` block comments, `"""` multiline
// strings, `#"…"#` raw strings, and `\(…)` interpolation are all handled.
//
// KNOWN degrades (documented, accepted): a type referenced ONLY inside string
// interpolation is not seen; `@objc`/`NSClassFromString`/selector-based references
// are not tokens; generic type PARAMETERS (`<Element>`) are best-effort (a param
// name colliding with a declared type is a rare false edge); lowercase-named types
// are missed (the UpperCamelCase reference filter).

// ---------------------------------------------------------------------------
// Comment + string stripping (the accurate foundation).

/**
 * A copy of `text` with every comment and string-literal interior replaced by
 * spaces (newlines preserved, so line indices + `loc` are stable). Handles Swift's
 * nested block comments, multiline `"""` strings, raw `#"…"#` strings (any pound
 * count, single- or multi-line), and `\(…)` interpolation (its interior is blanked
 * by balanced-paren skipping — so a `"` nested inside interpolation can't reopen the
 * string). Pure + total (an unterminated construct simply runs to end-of-input).
 */
export function stripCommentsAndStrings(text: string): string {
  const n = text.length;
  const out: string[] = [];
  const blank = (ch: string): void => {
    out.push(ch === '\n' ? '\n' : ' ');
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';

    // Line comment `// …`
    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') blank(text[i++]);
      continue;
    }
    // Nested block comment `/* … */`
    if (c === '/' && c2 === '*') {
      let depth = 1;
      blank(' ');
      blank(' ');
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++;
          blank(' ');
          blank(' ');
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--;
          blank(' ');
          blank(' ');
          i += 2;
        } else {
          blank(text[i++]);
        }
      }
      continue;
    }
    // Raw string `#"…"#` / `##"…"##` / `#"""…"""#` (pounds count P).
    if (c === '#') {
      let p = 0;
      while (i + p < n && text[i + p] === '#') p++;
      if (i + p < n && text[i + p] === '"') {
        const multiline = text.slice(i + p, i + p + 3) === '"""';
        const openLen = p + (multiline ? 3 : 1);
        const close = (multiline ? '"""' : '"') + '#'.repeat(p);
        for (let k = 0; k < openLen; k++) blank(text[i + k]);
        i += openLen;
        while (i < n) {
          if (text.slice(i, i + close.length) === close) {
            for (let k = 0; k < close.length; k++) blank(' ');
            i += close.length;
            break;
          }
          blank(text[i++]);
        }
        continue;
      }
      // A lone `#` (a `#if` / `#selector` / `#available` directive) — keep it.
    }
    // Multiline string `"""…"""`
    if (c === '"' && c2 === '"' && text[i + 2] === '"') {
      i = blankString(text, i, out, true);
      continue;
    }
    // Regular string `"…"`
    if (c === '"') {
      i = blankString(text, i, out, false);
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/**
 * Blank a regular (`multiline=false`) or triple-quoted (`multiline=true`) string
 * starting at `start` (its opening quote). Handles `\\`-escapes and `\(…)`
 * interpolation (interior skipped by balanced parens). Returns the index just past
 * the closing quote(s). A regular string also terminates at a newline (defensive —
 * Swift regular strings are single-line).
 */
function blankString(text: string, start: number, out: string[], multiline: boolean): number {
  const n = text.length;
  const blank = (ch: string): void => {
    out.push(ch === '\n' ? '\n' : ' ');
  };
  const quoteLen = multiline ? 3 : 1;
  for (let k = 0; k < quoteLen; k++) blank(text[start + k]);
  let i = start + quoteLen;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '(') {
        blank(' ');
        blank(' ');
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') depth--;
          blank(text[i++]);
        }
        continue;
      }
      blank(' ');
      i++;
      if (i < n) blank(text[i++]);
      continue;
    }
    if (multiline) {
      if (c === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
        blank(' ');
        blank(' ');
        blank(' ');
        return i + 3;
      }
    } else {
      if (c === '"') {
        blank(' ');
        return i + 1;
      }
      if (c === '\n') {
        // Unterminated single-line string — stop (defensive; keep the newline).
        out.push('\n');
        return i + 1;
      }
    }
    blank(c);
    i++;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Imports.

// An `import` line: optional leading attributes (`@testable`, `@_exported`,
// `@_implementationOnly`, `@preconcurrency`, `@_spi(…)`), an optional access
// modifier (`public`/`internal`/…), the `import` keyword, an optional import-kind
// decl keyword (`class`/`struct`/`func`/…), then the module path — the FIRST
// segment is the module name.
const IMPORT_RE =
  /^\s*(?:@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?\s+)*(?:(?:public|internal|private|fileprivate|package|open)\s+)?import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func|actor|inout)\s+)+?([A-Za-z_][A-Za-z0-9_]*)|^\s*(?:@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?\s+)*(?:(?:public|internal|private|fileprivate|package|open)\s+)?import\s+([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * The MODULE names imported by `text`, in source order (duplicates kept — the
 * adapter dedupes / weights). Reads the comment/string-stripped source so a
 * commented-out import is ignored. The first path segment is the module
 * (`import Foo.Bar` → `Foo`; `import class Foundation.NSData` → `Foundation`).
 */
export function scanImports(text: string): string[] {
  const out: string[] = [];
  for (const line of stripCommentsAndStrings(text).split('\n')) {
    const m = line.match(IMPORT_RE);
    if (m) out.push(m[1] ?? m[2]);
  }
  return out;
}

/** Is a physical (stripped) line an `import` statement? Used to exclude import lines
 *  from reference scanning (the imported module name is not a type reference). */
export function isImportLine(line: string): boolean {
  return IMPORT_RE.test(line);
}

// ---------------------------------------------------------------------------
// Type declarations (the registry keys).

// A PRIMARY nominal-type declaration keyword + its name. Leading modifiers/attributes
// are skipped by the un-anchored `\b`. `class`/`struct`/`enum`/`protocol`/`actor`/
// `typealias` only — `extension` is a reference, not a declaration.
const DECL_RE = /\b(class|struct|enum|protocol|actor|typealias)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

// `class`/`actor` used as a MEMBER modifier (`class func`, `class var`, `actor` is
// never a modifier) — the captured "name" is actually a member keyword, not a type.
const MEMBER_AFTER_MODIFIER = new Set<string>([
  'func',
  'var',
  'let',
  'subscript',
  'init',
  'deinit',
  'case',
  'associatedtype',
]);

/**
 * The PRIMARY type names `text` declares (`class`/`struct`/`enum`/`protocol`/`actor`/
 * `typealias`), in source order. Nested types are included (registered by their
 * SIMPLE name). Guards `class func` / `class var` type-member modifiers (the name
 * after would be a keyword, not a type). Reads the stripped source.
 */
export function scanTypeDecls(text: string): string[] {
  const stripped = stripCommentsAndStrings(text);
  const out: string[] = [];
  for (const m of stripped.matchAll(DECL_RE)) {
    const name = m[2];
    if ((m[1] === 'class') && MEMBER_AFTER_MODIFIER.has(name)) continue;
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Type references (resolved against the registry by the adapter).

// An UpperCamelCase identifier token — the Swift type-name convention. The negative
// lookbehind `(?<![\w.])` stops matching the tail of a dotted member access
// (`foo.Bar` → we want the receiver, not the member) and mid-identifier fragments.
// ACCEPTED DEGRADE: this also skips the tail of a module-qualified type reference,
// so `Models.Todo` resolves only `Models` (its head), missing `Todo`. Recall loss
// only (no false edge), and rare in practice — cross-module refs are usually bare
// (`import Models; … Todo`), so the type-reference backbone still connects them.
const REF_TOKEN_RE = /(?<![\w.])[A-Z][A-Za-z0-9_]*/g;

/**
 * Every UpperCamelCase reference token in `text`'s code body, in source order (one
 * entry per occurrence, so the adapter can weight an edge by reference count).
 * Import lines are excluded (the imported module name is not a type reference).
 * Reads the stripped source; the adapter resolves each token through the registry
 * and drops everything that doesn't name a type declared in ANOTHER file.
 */
export function scanTypeReferences(text: string): string[] {
  const out: string[] = [];
  for (const line of stripCommentsAndStrings(text).split('\n')) {
    if (isImportLine(line)) continue;
    for (const m of line.matchAll(REF_TOKEN_RE)) out.push(m[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Call sites (v2 — resolved against the registry by the adapter as `call` edges).
//
// Two Swift call forms have a resolvable UpperCamelCase TYPE head:
//   * INITIALIZER  `Foo(…)`        — constructing a value = calling Foo's init.
//   * STATIC CALL  `Foo.member(…)` — a type/static method or property call on Foo.
// Both resolve the HEAD type to its declaring file → a `call` edge. INSTANCE calls
// (`foo.bar()`) and dynamic dispatch have no UpperCamelCase head, so they never resolve
// — accuracy over recall (a wrong call edge teaches a false mental model). The head's
// `(?<![\w.])` lookbehind excludes a member access (`x.Foo(` is not a head) and a
// mid-identifier fragment, exactly like REF_TOKEN_RE.
const INIT_CALL_RE = /(?<![\w.])([A-Z][A-Za-z0-9_]*)[ \t]*\(/g;
const STATIC_CALL_RE = /(?<![\w.])([A-Z][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*[ \t]*\(/g;

// A pattern-match line — `case Foo.bar(let x)`, `if case Foo.status(x) = y`, … — uses
// the `Enum.case(binding)` syntax the STATIC_CALL_RE would mistake for a call. Skip
// call-site scanning on such lines (the type is still a REFERENCE → import edge; it's
// only the `call` verb we withhold — accuracy over recall). Matches a `case` keyword at
// a statement boundary (line start OR after `{`/`;`, so a single-line
// `switch x { case Foo.bar(y): … }` is caught too) or an `if/guard/while/for case`
// value binding. `case` is a reserved keyword, so `\bcase\b` never hits an identifier
// like `showcase`. Non-global (used with .test). ACCEPTED recall loss: a real call on
// the same physical line as a switch case is withheld — rare, and accuracy > recall.
const CASE_PATTERN_RE = /(?:^|[{;])\s*case\b|\b(?:if|guard|while|for)\s+case\b/;

/**
 * Every resolvable call-site HEAD token in `text`'s code body, in source order (one
 * entry per occurrence, so the adapter can weight a `call` edge by count). Import lines
 * and pattern-match lines are excluded. Reads the stripped source; the adapter resolves
 * each token through the registry and drops everything that doesn't name a type declared
 * (unambiguously) in ANOTHER file.
 */
export function scanCallSites(text: string): string[] {
  const out: string[] = [];
  for (const line of stripCommentsAndStrings(text).split('\n')) {
    if (isImportLine(line) || CASE_PATTERN_RE.test(line)) continue;
    for (const m of line.matchAll(INIT_CALL_RE)) out.push(m[1]);
    for (const m of line.matchAll(STATIC_CALL_RE)) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// One-pass parse (strip once, derive all four) — the adapter's entry point.

export interface SwiftFileScan {
  /** Imported module names (first path segment), in source order. */
  imports: string[];
  /** Primary type declarations (registry keys), in source order. */
  decls: string[];
  /** UpperCamelCase reference tokens in the code body (import lines excluded). */
  references: string[];
  /** Resolvable call-site HEAD tokens (initializer / static call), in source order. */
  callSites: string[];
}

/** Strip once, then derive imports + decls + references + call sites from stripped text. */
export function scanSwiftFile(text: string): SwiftFileScan {
  const stripped = stripCommentsAndStrings(text);
  const imports: string[] = [];
  const references: string[] = [];
  const callSites: string[] = [];
  for (const line of stripped.split('\n')) {
    const im = line.match(IMPORT_RE);
    if (im) {
      imports.push(im[1] ?? im[2]);
      continue; // an import line contributes no type references / call sites
    }
    for (const m of line.matchAll(REF_TOKEN_RE)) references.push(m[0]);
    if (CASE_PATTERN_RE.test(line)) continue; // pattern-match line: refs yes, calls no
    for (const m of line.matchAll(INIT_CALL_RE)) callSites.push(m[1]);
    for (const m of line.matchAll(STATIC_CALL_RE)) callSites.push(m[1]);
  }
  const decls: string[] = [];
  for (const m of stripped.matchAll(DECL_RE)) {
    const name = m[2];
    if (m[1] === 'class' && MEMBER_AFTER_MODIFIER.has(name)) continue;
    decls.push(name);
  }
  return { imports, decls, references, callSites };
}
