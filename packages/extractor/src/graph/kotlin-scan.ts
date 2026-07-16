// Pure, hand-rolled SYNTACTIC scanner for Kotlin source — the install-free,
// native-dependency-free backbone of the Kotlin extractor (the Elixir precedent:
// tree-sitter-kotlin is a stale native/node-gyp grammar with ABI-mismatch problems, and
// Kotlin's `package`/`import` is class-granular like Java, so an import backbone is a
// trivial line scan — no AST needed for v1). No tree-sitter, no WASM, no repo-code
// execution — just deterministic string scanning.
//
// It reads the three things the import graph needs:
//   1. the file's `package` declaration (0 or 1 — the FQN prefix of its top-level decls);
//   2. every top-level DECLARATION name the file defines (`class`/`interface`/`object`/
//      `enum class`/`annotation class`/`typealias`, plus non-extension top-level `fun`/
//      `val`/`var`), so the adapter can key `<pkg>.<Decl> → file`;
//   3. every `import` directive — `import a.b.C`, wildcard `import a.b.*`, and the
//      rename form `import a.b.C as D` — so the adapter can resolve each to a file.
//
// Comments (`//`, nesting `/* */`) and string/char literals (including raw `"""…"""`)
// are stripped FIRST by a character-scan state machine, so a `class`/`import`-looking
// token inside a comment or a string never registers. Declaration scanning is
// brace/paren-depth-aware: a decl keyword is recorded only at the file's TOP level
// (both depths 0), so a member `fun`/nested `class` or a constructor `val` parameter is
// never mistaken for a top-level declaration.
//
// KNOWN degrades (documented, accepted): an extension declaration (`fun Foo.bar()`,
// `val List<T>.x`) is NOT registered under its member name (its receiver `.` is
// detected and the decl skipped) — extension members are rarely cross-module import
// targets and registering the receiver name would pollute the registry. A same-package
// implicit reference (no `import`) is not an edge (import-only backbone). Backtick-
// quoted identifiers (`` `is` ``) in package/import names are not handled (vanishingly
// rare in FQNs).

export interface KotlinImport {
  /** Fully-qualified name, WITHOUT any trailing `.*`. */
  fqn: string;
  /** `import a.b.*` — resolves to every file in package `a.b`. */
  wildcard: boolean;
  /** `import a.b.C as D` → 'D' (the local rename); undefined otherwise. */
  alias?: string;
}

// Leading declaration modifiers (any order, repeated) that can precede the decl keyword.
const MODIFIER =
  '(?:public|private|internal|protected|abstract|final|open|sealed|data|enum|annotation|value|inline|expect|actual|external|const|lateinit|override|suspend|operator|infix|tailrec|companion|inner)';
const PACKAGE_RE = /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)/;
// The FQN is captured LAZILY so a trailing `.*` (the wildcard group) is matched by
// `(\.\*)?` rather than swallowed by the FQN's char class (a greedy `[.\w]*` eats the
// dot before `*`, breaking wildcard detection). group1 = FQN (no `.*`), group2 = the
// wildcard marker, group3 = an `as` rename. Anchored at end (comments are pre-stripped).
const IMPORT_RE = /^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*?)(\.\*)?(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*;?\s*$/;
const TYPE_DECL_RE = new RegExp(
  `^\\s*(?:${MODIFIER}\\s+)*(?:class|interface|object|typealias)\\s+([A-Za-z_][A-Za-z0-9_]*)`,
);
// A top-level callable: after the keyword, an optional `<generics>`, then the name; a
// trailing `.` (captured) means it's an EXTENSION receiver → the decl is skipped.
const CALLABLE_DECL_RE = new RegExp(
  `^\\s*(?:${MODIFIER}\\s+)*(?:fun|val|var)\\s+(?:<[^>]*>\\s*)?([A-Za-z_][A-Za-z0-9_]*)(\\s*\\.)?`,
);

/**
 * Replace every comment (a `//` line comment or a nesting block comment) and every
 * string/char literal (including raw triple-quoted strings) with spaces, preserving
 * newlines so line indices stay stable. A character-scan state machine — robust against
 * a `class`/`import` token living inside a comment or string. Never throws.
 */
export function stripCommentsAndStrings(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  let blockDepth = 0;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    if (blockDepth > 0) {
      if (c === '/' && c2 === '*') {
        blockDepth++;
        out += '  ';
        i += 2;
      } else if (c === '*' && c2 === '/') {
        blockDepth--;
        out += '  ';
        i += 2;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      blockDepth++;
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '/' && c2 === '/') {
      out += '  ';
      i += 2;
      while (i < n && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '"' && c2 === '"' && text[i + 2] === '"') {
      out += '   ';
      i += 3;
      while (i < n && !(text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '   ';
        i += 3;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += ' ';
      i++;
      while (i < n && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\') {
          out += ' ';
          i++;
          if (i < n) {
            out += ' ';
            i++;
          }
          continue;
        }
        out += ' ';
        i++;
      }
      if (i < n && text[i] === quote) {
        out += ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Comment/string-stripped physical lines — the input every scan below reads. */
export function sourceLines(text: string): string[] {
  return stripCommentsAndStrings(text).split('\n');
}

/** The file's `package` declaration (dotted), or '' for the default/root package. */
export function scanPackage(text: string): string {
  for (const line of sourceLines(text)) {
    const m = line.match(PACKAGE_RE);
    if (m) return m[1];
  }
  return '';
}

/** Every `import` directive in `text`, in source order (comment/string aware). */
export function scanImports(text: string): KotlinImport[] {
  const out: KotlinImport[] = [];
  for (const line of sourceLines(text)) {
    const m = line.match(IMPORT_RE);
    if (!m) continue;
    const fqn = m[1];
    if (fqn.length === 0) continue;
    out.push({ fqn, wildcard: m[2] !== undefined, alias: m[3] });
  }
  return out;
}

/**
 * Every TOP-LEVEL declaration name the file defines, in source order. Brace/paren-depth
 * aware: a keyword is recorded only when both depths are 0 at the line's start, so a
 * class member, a nested type, or a constructor `val` parameter is never captured. An
 * extension `fun`/`val`/`var` (a receiver `.` after the name) is skipped.
 */
export function scanTopLevelDecls(text: string): string[] {
  const names: string[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  for (const line of sourceLines(text)) {
    if (braceDepth === 0 && parenDepth === 0) {
      const typeMatch = line.match(TYPE_DECL_RE);
      if (typeMatch) {
        names.push(typeMatch[1]);
      } else {
        const callMatch = line.match(CALLABLE_DECL_RE);
        if (callMatch && !callMatch[2]) names.push(callMatch[1]); // group2 = the extension-receiver dot

      }
    }
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    }
  }
  return names;
}

/** The top-level (leftmost) segment of a dotted name. */
export function topSegment(fqn: string): string {
  return fqn.split('.')[0];
}

/**
 * The external-node id for a non-internal import — its PACKAGE (`import io.ktor.server.
 * application.Application` → package `io.ktor.server.application`) bucketed into the
 * declared-dependency-group set by LONGEST group prefix. A group is a declared Gradle
 * coordinate group (`io.ktor`, `androidx.room`), so `io.ktor.server.application` →
 * `ext:io.ktor` and `androidx.room.util` → `ext:androidx.room` — ONE box per dependency
 * FAMILY, not per sub-namespace. When no declared group is a prefix, fall back to the
 * package's first TWO segments (never a top-segment `ext:com`/`ext:io` mega-node); a
 * 1-segment package (`retrofit2`) buckets to itself.
 *
 * `pkg` is the import's PACKAGE (its class segment already stripped by the caller for a
 * non-wildcard import; the whole FQN for a wildcard). Pure.
 */
export function kotlinExternalId(pkg: string, declaredGroups: ReadonlySet<string>): { id: string; specifier: string } {
  let best: string | undefined;
  for (const g of declaredGroups) {
    if (pkg === g || pkg.startsWith(g + '.')) {
      if (best === undefined || g.length > best.length) best = g;
    }
  }
  const bucket = best ?? pkg.split('.').slice(0, 2).join('.');
  return { id: `ext:${bucket}`, specifier: bucket };
}
