// Shared Kotlin framework-analysis accessors — the analogue of
// framework/elixir/elixir-ast.ts. Where Python/Ruby drive a real parser (Pyright /
// Prism), Kotlin has no install-free parser, so these accessors are thin, line-oriented
// readers over the SAME hand-rolled scanner the import extractor uses
// (graph/kotlin-scan.ts) — reusing its comment/string-stripped line splitting so a
// `class`/`@Annotation`-looking token inside a comment or string is never misread.
//
// The framework adapters (Android, Ktor, Spring, Room/JPA/Exposed) consume these to
// recognize their conventions: a class's SUPERTYPES (`class HomeFragment : Fragment()`),
// its ANNOTATIONS (`@RestController`, `@Entity`), a top-level function's annotations
// (`@Composable fun Home()`), and DSL call names (`routing { get("/") }`).

import { sourceLines, scanPackage, scanImports, scanTopLevelDecls } from '../../graph/kotlin-scan.js';
import type { KotlinImport } from '../../graph/kotlin-scan.js';

export { sourceLines, scanPackage, scanImports, scanTopLevelDecls };
export type { KotlinImport };

/** A top-level TYPE declaration (`class`/`interface`/`object`/`enum`/`annotation`). */
export interface KotlinTypeDecl {
  kind: 'class' | 'interface' | 'object' | 'enum' | 'annotation';
  name: string;
  /** Declared supertypes (interfaces + superclass), type names only (no `()`/`<>`). */
  supertypes: string[];
  /** Annotation NAMES on this declaration (`RestController`, `Entity`; no `@`, no args). */
  annotations: string[];
}

/** A top-level function declaration (`fun`), with its annotations. */
export interface KotlinFunDecl {
  name: string;
  /** Annotation names on this function (`Composable`, `GetMapping`). */
  annotations: string[];
  /** The extension receiver type, if any (`fun Application.module()` → 'Application'). */
  receiver?: string;
}

const MODIFIER =
  '(?:public|private|internal|protected|abstract|final|open|sealed|data|enum|annotation|value|inline|expect|actual|external|const|lateinit|override|suspend|operator|infix|tailrec|companion|inner)';
// A type-decl header line. Captures the (repeated) keyword group so `enum class` /
// `annotation class` resolve their kind, plus the declared name.
const TYPE_HEAD_RE = new RegExp(
  `^\\s*((?:${MODIFIER}\\s+)*)(class|interface|object)\\s+([A-Za-z_][A-Za-z0-9_]*)`,
);
// A top-level function header. Captures optional generics, an optional extension
// receiver (`Foo.`), and the function name.
const FUN_HEAD_RE = new RegExp(
  `^\\s*(?:${MODIFIER}\\s+)*fun\\s+(?:<[^>]*>\\s*)?(?:([A-Za-z_][A-Za-z0-9_.]*)\\.)?([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`,
);
// An annotation token: `@Foo`, `@Foo.Bar`, `@field:Json`, `@Foo(...)`. Captures the
// annotation NAME (last segment after an optional use-site target `field:`/`get:`/…).
const ANNOTATION_RE = /@(?:[A-Za-z_][A-Za-z0-9_]*:)?([A-Za-z_][A-Za-z0-9_.]*)/g;
// An invocation callee: a bare identifier immediately followed by `(` OR a trailing
// lambda `{` — the DSL/route call shape (`get("/x")`, the paren-less `routing { … }` /
// `install(X)`). The negative lookbehind stops it matching a member call's method segment
// (`a.b(`) or a qualified name. Over-captures control keywords / definition names; adapters
// filter by the names they care about (the Elixir `macroCalls` discipline).
const CALL_NAME_RE = /(?<![.\w])([a-z_][A-Za-z0-9_]*)\s*[({]/g;

/** Remove balanced `(...)` and `<...>` groups from a header (depth-aware). */
function stripGroups(header: string): string {
  let out = '';
  let paren = 0;
  let angle = 0;
  for (const ch of header) {
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '<') angle++;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (paren === 0 && angle === 0) out += ch;
  }
  return out;
}

/** The supertype type-names from a type-decl header (`class X(...) : A(), B<T> {` → [A, B]). */
export function parseSupertypes(header: string): string[] {
  // Truncate at the class body so a supertype-looking token inside `{ … }` is ignored.
  const brace = header.indexOf('{');
  const decl = brace >= 0 ? header.slice(0, brace) : header;
  const flat = stripGroups(decl);
  const colon = flat.indexOf(':');
  if (colon < 0) return [];
  return flat
    .slice(colon + 1)
    .split(',')
    .map((s) => s.trim().match(/^[A-Za-z_][A-Za-z0-9_.]*/)?.[0])
    .filter((s): s is string => Boolean(s));
}

/** The annotation names sitting on the lines DIRECTLY above `index` (+ inline on it). */
function annotationsFor(lines: string[], index: number): string[] {
  const names: string[] = [];
  // Inline annotations on the decl line itself (`@Entity class User`) — everything before
  // the decl keyword. Read the whole line; annotation tokens after the keyword (e.g. a
  // param default) are rare and harmless.
  for (const m of lines[index].matchAll(ANNOTATION_RE)) names.push(lastSeg(m[1]));
  // Preceding annotation lines: walk up over `@…` / blank lines until a code line.
  for (let i = index - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === '') continue;
    if (t.startsWith('@')) {
      for (const m of t.matchAll(ANNOTATION_RE)) names.push(lastSeg(m[1]));
      continue;
    }
    break; // a non-annotation code line ends the annotation block
  }
  return [...new Set(names)];
}

/** The last dotted segment of an annotation name (`androidx.room.Entity` → 'Entity'). */
function lastSeg(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1) : name;
}

/**
 * Accumulate a declaration's HEADER — from its line up to (and including the pre-`{`
 * portion of) the line that opens its body, stopping at the statement end for a body-less
 * decl so accumulation never overruns into the NEXT declaration. Lets a multi-line
 * `class X(\n  …\n) : Super() {` resolve its supertypes, and a body-less `object X : Y`
 * stop at its own line. A line whose (paren/angle) brackets are unbalanced, or that ends
 * with a continuation char (`,` `(` `<` `:`) or `by`, continues the header.
 */
function headerFrom(lines: string[], start: number): string {
  let header = '';
  let paren = 0;
  let angle = 0;
  for (let i = start; i < lines.length && i < start + 30; i++) {
    const brace = lines[i].indexOf('{');
    const upto = brace >= 0 ? lines[i].slice(0, brace) : lines[i];
    header += ' ' + upto;
    if (brace >= 0) break; // body opened
    for (const ch of upto) {
      if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '<') angle++;
      else if (ch === '>') angle = Math.max(0, angle - 1);
    }
    const trimmed = upto.trimEnd();
    const continues = paren > 0 || angle > 0 || /[,(<:]$/.test(trimmed) || /\bby$/.test(trimmed);
    if (!continues) break; // statement complete (a body-less decl or its final line)
  }
  return header;
}

/** The enum/annotation refinement of a `class` kind from its modifiers. */
function typeKind(mods: string, keyword: string): KotlinTypeDecl['kind'] {
  if (keyword === 'interface') return 'interface';
  if (keyword === 'object') return 'object';
  if (/\benum\b/.test(mods)) return 'enum';
  if (/\bannotation\b/.test(mods)) return 'annotation';
  return 'class';
}

/**
 * Every TOP-LEVEL type declaration with its supertypes + annotations. Brace/paren-depth
 * aware (only file-top-level decls), so a nested/member type is not captured.
 */
export function scanTypeDecls(text: string): KotlinTypeDecl[] {
  const lines = sourceLines(text);
  const out: KotlinTypeDecl[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (braceDepth === 0 && parenDepth === 0) {
      const m = lines[i].match(TYPE_HEAD_RE);
      if (m) {
        out.push({
          kind: typeKind(m[1], m[2]),
          name: m[3],
          supertypes: parseSupertypes(headerFrom(lines, i)),
          annotations: annotationsFor(lines, i),
        });
      }
    }
    for (const ch of lines[i]) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    }
  }
  return out;
}

/** Every TOP-LEVEL function declaration with its annotations (+ any extension receiver). */
export function scanFunDecls(text: string): KotlinFunDecl[] {
  const lines = sourceLines(text);
  const out: KotlinFunDecl[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (braceDepth === 0 && parenDepth === 0) {
      const m = lines[i].match(FUN_HEAD_RE);
      if (m) {
        out.push({ name: m[2], receiver: m[1], annotations: annotationsFor(lines, i) });
      }
    }
    for (const ch of lines[i]) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    }
  }
  return out;
}

/** All annotation names anywhere in the file (`@RestController`, `@field:Json` → names). */
export function scanAnnotations(text: string): string[] {
  const out: string[] = [];
  for (const line of sourceLines(text)) {
    for (const m of line.matchAll(ANNOTATION_RE)) out.push(lastSeg(m[1]));
  }
  return out;
}

/**
 * Every invocation-callee name in `text`, in source order (one entry per call site, so an
 * adapter can weight by count). A bare `identifier(` — the DSL/route shape. Does NOT
 * resolve; adapters filter by the names they care about (`get`/`post`/`navigate`/…),
 * mirroring the Elixir `macroCalls` "match the names you care about" discipline.
 */
export function scanCallNames(text: string): string[] {
  const out: string[] = [];
  for (const line of sourceLines(text)) {
    for (const m of line.matchAll(CALL_NAME_RE)) out.push(m[1]);
  }
  return out;
}
