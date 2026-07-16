// Shared Swift framework-analysis accessors — the analogue of
// framework/elixir/elixir-ast.ts and framework/ruby/ruby-ast.ts. Where those drive a
// real parser (Pyright / Prism), Swift has no install-free parser, so these are thin
// readers over the SAME hand-rolled scanner the import extractor uses
// (graph/swift-scan.ts) — reusing its comment/string-stripping so a `class Foo` or a
// `@Model` inside a comment/string is never misread as a declaration.
//
// The framework adapters (SwiftUI/UIKit, SwiftData/CoreData/Fluent, Vapor) consume
// these to recognize their conventions: a `: View` conformance + a `var body`, a
// `UIViewController` superclass, a `@main`/`App` app-entry, a `@Model` / `@Parent` /
// `@Relationship` data annotation, a `RouteCollection` controller. All pure +
// deterministic (SYNC — no parser to load).

import { stripCommentsAndStrings, scanImports } from '../../graph/swift-scan.js';

export { scanImports };
export { stripCommentsAndStrings };

// ---------------------------------------------------------------------------
// Types.

export type SwiftDeclKind = 'class' | 'struct' | 'enum' | 'protocol' | 'actor' | 'extension';

/** A nominal-type declaration (or an `extension`) with its conformance + attributes. */
export interface SwiftTypeDecl {
  kind: SwiftDeclKind;
  /** Simple name — the declared identifier (an `extension A.B` keeps `B`). */
  name: string;
  /** The extended type as written (`extension A.B` → `A.B`), else the simple name. */
  fullName: string;
  /** Superclass + protocol conformances from the `: A, B` clause (best-effort). */
  inherits: string[];
  /** Preceding `@attributes` (same-line + attribute-only lines above), e.g. `main`, `Model`, `objc`. */
  attributes: string[];
  /** 0-based line index of the declaration keyword (stripped-text line space). */
  line: number;
}

/** A stored/computed property declaration with its property-wrapper attributes + type. */
export interface SwiftProperty {
  /** Attribute names WITHOUT the `@` (`Relationship`, `Parent`, `NSManaged`, `State`). */
  attributes: string[];
  name: string;
  /** The declared type as written (`[Comment]`, `Star?`, `Set<Tag>`), or undefined. */
  rawType: string | undefined;
  /** The associated simple type name (`[Comment]` → `Comment`, `Star?` → `Star`), or undefined. */
  type: string | undefined;
}

// ---------------------------------------------------------------------------
// Declaration scanning.

const DECL_LINE_RE =
  /\b(class|struct|enum|protocol|actor|extension)\s+([A-Za-z_][A-Za-z0-9_.]*)/;
const ATTR_ONLY_LINE_RE = /^\s*@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?\s*$/;
const LEADING_ATTRS_RE = /@([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))?/g;
const MEMBER_AFTER_MODIFIER = new Set<string>([
  'func', 'var', 'let', 'subscript', 'init', 'deinit', 'case', 'associatedtype',
]);

/** The simple (last) segment of a possibly-dotted type name (`A.B` → `B`). */
function lastSegment(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1) : name;
}

/**
 * Parse the inheritance/conformance clause following a declaration's name. Returns the
 * comma-separated identifiers between `:` and the body `{` (or a `where` clause),
 * joining a few continuation lines. Generic-arg + dotted conformances collapse to
 * their leading simple name (`Codable`, `View`, `Vapor.Content` → `Content`). Best-effort.
 */
function parseInherits(lines: string[], startLine: number, afterName: string): string[] {
  // Gather text from just after the name up to the opening brace / where, bounded.
  let buf = afterName;
  let i = startLine;
  while (!buf.includes('{') && !/\bwhere\b/.test(buf) && i + 1 < lines.length && i - startLine < 6) {
    i++;
    buf += ' ' + lines[i];
  }
  // Cut at the body brace / where clause.
  buf = buf.split('{')[0].split(/\bwhere\b/)[0];
  const colon = buf.indexOf(':');
  if (colon < 0) return [];
  const clause = buf.slice(colon + 1);
  const out: string[] = [];
  // Split on top-level commas (ignore commas inside generic <> or [] brackets).
  let depth = 0;
  let cur = '';
  for (const ch of clause) {
    if (ch === '<' || ch === '[' || ch === '(') depth++;
    else if (ch === '>' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  // Normalize each to a simple identifier (drop generic args + module qualifier).
  return out
    .map((s) => {
      const m = s.match(/[A-Za-z_][A-Za-z0-9_.]*/);
      return m ? lastSegment(m[0]) : '';
    })
    .filter(Boolean);
}

/**
 * Every type declaration + `extension` in `text`, with conformances + attributes.
 * Reads the comment/string-stripped source (so a commented decl is ignored). One
 * entry per declaration keyword, in source order.
 */
export function typeDeclarations(text: string): SwiftTypeDecl[] {
  const lines = stripCommentsAndStrings(text).split('\n');
  const out: SwiftTypeDecl[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(DECL_LINE_RE);
    if (!m) continue;
    const kind = m[1] as SwiftDeclKind;
    const fullName = m[2];
    const name = lastSegment(fullName);
    if (kind === 'class' && MEMBER_AFTER_MODIFIER.has(name)) continue; // `class func` etc.

    // Attributes: leading same-line attrs + contiguous attribute-only lines above.
    const attributes: string[] = [];
    const preKeyword = line.slice(0, m.index ?? 0);
    for (const a of preKeyword.matchAll(LEADING_ATTRS_RE)) attributes.push(a[1]);
    for (let j = i - 1; j >= 0; j--) {
      const above = lines[j];
      if (above.trim() === '') continue;
      if (ATTR_ONLY_LINE_RE.test(above)) {
        const am = above.trim().match(/@([A-Za-z_][A-Za-z0-9_]*)/);
        if (am) attributes.unshift(am[1]);
        continue;
      }
      break;
    }

    const afterName = line.slice((m.index ?? 0) + m[0].length);
    const inherits = kind === 'extension' ? [] : parseInherits(lines, i, afterName);
    out.push({ kind, name, fullName, inherits, attributes: [...new Set(attributes)], line: i });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Property scanning (for the data adapter's association edges + wrapper roles).

const PROP_RE =
  /^(?<pre>[^\n]*?)\b(?:var|let)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(?<type>[^={\n]+))?/;

/**
 * The associated simple type name for a declared type string: the LAST UpperCamelCase
 * identifier after dropping container wrappers — `[Comment]` → `Comment`,
 * `Set<Tag>` → `Tag`, `Star?` → `Star`, `[UserID: Profile]` → `Profile`. Undefined
 * when the type names no UpperCamelCase identifier (a scalar like `String` still
 * returns `String`; callers decide relevance). Best-effort (generics collapse).
 */
export function simpleTypeName(rawType: string): string | undefined {
  const toks = rawType.match(/[A-Z][A-Za-z0-9_]*/g);
  return toks && toks.length ? toks[toks.length - 1] : undefined;
}

/**
 * Property (`var`/`let`) declarations with their property-wrapper attributes + type.
 * Reads the stripped source. Attribute names are captured from the line prefix
 * Property-wrapper attributes are captured from the SAME line prefix
 * (`@Relationship(deleteRule: .cascade) var author: Author`) AND from contiguous
 * attribute-only lines directly above — the idiomatic Fluent/SwiftData layout puts
 * the wrapper on its own line (`@Parent(key: "userID")` \n `var user: User`).
 * Best-effort (a multi-line type annotation is truncated at the `var`/`let` line).
 */
export function properties(text: string): SwiftProperty[] {
  const lines = stripCommentsAndStrings(text).split('\n');
  const out: SwiftProperty[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PROP_RE);
    if (!m || !m.groups) continue;
    const attributes: string[] = [];
    // Same-line leading attributes.
    for (const a of (m.groups.pre ?? '').matchAll(LEADING_ATTRS_RE)) attributes.push(a[1]);
    // Contiguous attribute-only lines directly above (break on the first non-attribute
    // line — a blank line or another statement ends this property's attribute run).
    for (let j = i - 1; j >= 0; j--) {
      if (!ATTR_ONLY_LINE_RE.test(lines[j])) break;
      const am = lines[j].trim().match(/@([A-Za-z_][A-Za-z0-9_]*)/);
      if (am) attributes.unshift(am[1]);
    }
    const rawType = m.groups.type?.trim();
    out.push({
      attributes,
      name: m.groups.name,
      rawType,
      type: rawType ? simpleTypeName(rawType) : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small predicates the adapters share.

/** Does the file body contain a `var body` (the SwiftUI View/Scene marker)? */
export function hasBodyProperty(text: string): boolean {
  return /\bvar\s+body\b/.test(stripCommentsAndStrings(text));
}

/** Does a decl declare/attribute-carry `name` (case-sensitive attribute check)? */
export function hasAttribute(decl: SwiftTypeDecl, name: string): boolean {
  return decl.attributes.includes(name);
}

/** Does a decl inherit-from / conform-to `name`? */
export function conformsTo(decl: SwiftTypeDecl, name: string): boolean {
  return decl.inherits.includes(name);
}

/** All UpperCamelCase reference tokens on lines matching `predicate` (for edge scans). */
export function referenceTokensOnLines(text: string, predicate: (line: string) => boolean): string[] {
  const out: string[] = [];
  for (const line of stripCommentsAndStrings(text).split('\n')) {
    if (!predicate(line)) continue;
    for (const m of line.matchAll(/(?<![\w.])[A-Z][A-Za-z0-9_]*/g)) out.push(m[0]);
  }
  return out;
}
