// Shared Dart framework-analysis accessors — the analogue of
// framework/elixir/elixir-ast.ts. Where Python/Ruby drive a real parser
// (Pyright/Prism), Dart (like Elixir) has no install-free parser, so these
// accessors are thin, line-oriented readers over the SAME hand-rolled, comment-aware
// scanner the import extractor uses (graph/dart-scan.ts's `sourceLines`). No native
// grammar, no repo-code execution.
//
// The framework adapters (Flutter widgets, state-management, data) consume these to
// recognize their conventions: a `class Home extends StatelessWidget`, a `class
// Counter extends Bloc<Event, State>`, a `@riverpod` / `@collection` / `@DriftDatabase`
// annotation, a top-level `main()`. All are DETERMINISTIC + best-effort (a hand-rolled
// scanner, not a full Dart grammar) — documented degrades over false precision.

import { sourceLines } from '../../graph/dart-scan.js';

export { sourceLines };

/** A class/mixin/enum/extension declaration header, decomposed. */
export interface DartClass {
  /** Declaration keyword the name follows. */
  kind: 'class' | 'mixin' | 'enum' | 'extension';
  /** The declared type name (an anonymous `extension on X {}` yields ''). */
  name: string;
  /** `extends <Type>` base name (classes only), or undefined. */
  superclass?: string;
  /** The base type's top-level generic args (`Bloc<Event, State>` → ['Event','State']). */
  superTypeArgs: string[];
  /** `with <T1, T2>` mixin base names (mixin-application `class X = A with B` included). */
  mixins: string[];
  /** `implements <I1, I2>` base names. */
  interfaces: string[];
  /** `on <T1, T2>` constraint base names (a `mixin M on Base`) / `extension on <T>`. */
  on: string[];
}

// A declaration header START — an optional modifier chain then the keyword + name.
// `base`/`final`/`sealed`/`interface`/`abstract`/`mixin` are Dart 3 class modifiers.
const DECL_RE =
  /^\s*(?:@[\w$.]+(?:\([^)]*\))?\s+)*(?:(?:abstract|base|final|interface|sealed|mixin)\s+)*(class|mixin|enum|extension)\s+([A-Za-z_$][\w$]*)?/;

/** Skip a balanced `<…>` starting at `s[i] === '<'`; returns the index after `>`. */
function skipAngles(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === '<') depth++;
    else if (s[i] === '>') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}

/** Split a type list on TOP-LEVEL commas (respecting `<…>` nesting). */
function splitTypeList(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The bare base name of a type expression (`foo.Bar<T>` → `Bar`, `Baz` → `Baz`). */
export function baseTypeName(typeExpr: string): string {
  const m = typeExpr.trim().match(/([A-Za-z_$][\w$]*)\s*(?:<|$|\s)/);
  if (!m) {
    const m2 = typeExpr.trim().match(/([A-Za-z_$][\w$]*)/);
    return m2 ? m2[1] : '';
  }
  // Handle a prefixed type `prefix.Name` — take the last dotted segment.
  const head = typeExpr.trim().split('<')[0].trim();
  const seg = head.split('.').pop() ?? head;
  return seg.match(/[A-Za-z_$][\w$]*/)?.[0] ?? m[1];
}

/** The top-level generic args of a type expression (`Bloc<A, B>` → ['A','B']). */
export function typeArgsOf(typeExpr: string): string[] {
  const lt = typeExpr.indexOf('<');
  if (lt < 0) return [];
  const end = skipAngles(typeExpr, lt);
  return splitTypeList(typeExpr.slice(lt + 1, end - 1)).map((t) => t.trim());
}

/**
 * Every class/mixin/enum/extension declared in `text`, with its extends/with/
 * implements/on clauses decomposed. Comment-aware (uses `sourceLines`). A header that
 * spans multiple lines is joined up to the opening `{` or the `;` of a mixin-
 * application (`class X = A with B;`). Best-effort; never throws.
 */
export function classDeclarations(text: string): DartClass[] {
  const lines = sourceLines(text);
  const out: DartClass[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DECL_RE);
    if (!m) continue;
    const kind = m[1] as DartClass['kind'];
    // Gather the header text up to `{` or `;` (join continuation lines).
    let header = lines[i];
    let j = i;
    while (!/[{;]/.test(header) && j + 1 < lines.length) {
      j++;
      header += ' ' + lines[j];
    }
    const brace = header.search(/[{;]/);
    if (brace >= 0) header = header.slice(0, brace);
    out.push(parseClassHeader(kind, header));
  }
  return out;
}

/** Parse a gathered declaration header (keyword..pre-`{`) into a DartClass. */
function parseClassHeader(kind: DartClass['kind'], header: string): DartClass {
  const decl: DartClass = { kind, name: '', superTypeArgs: [], mixins: [], interfaces: [], on: [] };
  // Advance a cursor: skip modifiers + the keyword, read the name, skip its own <…>.
  const kwMatch = header.match(new RegExp(`\\b${kind}\\s+`));
  let rest = kwMatch ? header.slice((kwMatch.index ?? 0) + kwMatch[0].length) : header;
  const nameMatch = rest.match(/^([A-Za-z_$][\w$]*)/);
  if (nameMatch) {
    decl.name = nameMatch[1];
    rest = rest.slice(nameMatch[1].length).trimStart();
    if (rest.startsWith('<')) rest = rest.slice(skipAngles(rest, 0)).trimStart();
  }
  // Mixin-application form: `class X = Super with M1, M2`.
  const eq = rest.indexOf('=');
  if (kind === 'class' && eq >= 0) {
    rest = rest.slice(eq + 1).trim();
    const withIdx = clauseIndex(rest, 'with');
    if (withIdx >= 0) {
      decl.superclass = baseTypeName(rest.slice(0, withIdx));
      decl.superTypeArgs = typeArgsOf(rest.slice(0, withIdx));
      decl.mixins = splitTypeList(rest.slice(withIdx + 'with'.length)).map(baseTypeName).filter(Boolean);
    } else {
      decl.superclass = baseTypeName(rest);
      decl.superTypeArgs = typeArgsOf(rest);
    }
    return decl;
  }
  // Standard clauses: extends / with / implements / on (any subset, in order).
  const clauses = splitClauses(rest);
  if (clauses.extends) {
    decl.superclass = baseTypeName(clauses.extends);
    decl.superTypeArgs = typeArgsOf(clauses.extends);
  }
  if (clauses.with) decl.mixins = splitTypeList(clauses.with).map(baseTypeName).filter(Boolean);
  if (clauses.implements)
    decl.interfaces = splitTypeList(clauses.implements).map(baseTypeName).filter(Boolean);
  if (clauses.on) decl.on = splitTypeList(clauses.on).map(baseTypeName).filter(Boolean);
  return decl;
}

/** The index of a top-level clause keyword (`with`/`implements`/…) in a header tail. */
function clauseIndex(s: string, kw: string): number {
  const re = new RegExp(`(?:^|[\\s>])${kw}\\s`);
  const m = s.match(re);
  if (!m) return -1;
  return (m.index ?? -1) + m[0].length - kw.length - 1;
}

/** Split a class header tail into its extends/with/implements/on clause bodies. */
function splitClauses(tail: string): {
  extends?: string;
  with?: string;
  implements?: string;
  on?: string;
} {
  const markers: Array<{ kw: 'extends' | 'with' | 'implements' | 'on'; at: number }> = [];
  for (const kw of ['extends', 'with', 'implements', 'on'] as const) {
    const at = clauseIndex(tail, kw);
    if (at >= 0) markers.push({ kw, at });
  }
  markers.sort((a, b) => a.at - b.at);
  const res: { extends?: string; with?: string; implements?: string; on?: string } = {};
  for (let k = 0; k < markers.length; k++) {
    const { kw, at } = markers[k];
    const bodyStart = at + kw.length;
    const bodyEnd = k + 1 < markers.length ? markers[k + 1].at : tail.length;
    res[kw] = tail.slice(bodyStart, bodyEnd).trim();
  }
  return res;
}

// A top-level `@Annotation` / `@Annotation(...)` / `@lib.Annotation`. Captures the
// bare annotation NAME (`@DriftDatabase(...)` → 'DriftDatabase', `@riverpod` →
// 'riverpod'). Comment-aware via sourceLines.
const ANNOTATION_RE = /^\s*@([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/;

/** Every annotation NAME used in `text` (last dotted segment), in source order. */
export function annotationNames(text: string): string[] {
  const out: string[] = [];
  for (const line of sourceLines(text)) {
    const m = line.match(ANNOTATION_RE);
    if (m) out.push(m[1].split('.').pop() ?? m[1]);
  }
  return out;
}

// A top-level function/getter declaration `Type name(` / `void main() {`. Best-effort
// (matches a leading-column declaration to avoid nested/method noise). Captures the
// function name. Used to spot `main` (the Flutter app entry).
const TOP_FN_RE = /^(?:[A-Za-z_$][\w$<>, ?]*\s+)?([A-Za-z_$][\w$]*)\s*\(/;

/** Top-level function names declared at column 0 in `text` (best-effort). */
export function topLevelFunctionNames(text: string): string[] {
  const out: string[] = [];
  for (const line of sourceLines(text)) {
    if (/^\s/.test(line)) continue; // indented → a method / nested, not top-level
    if (/^(?:import|export|part|library|class|mixin|enum|extension|typedef)\b/.test(line)) continue;
    const m = line.match(TOP_FN_RE);
    if (m) out.push(m[1]);
  }
  return out;
}
