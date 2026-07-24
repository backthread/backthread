// Pure, hand-rolled SYNTACTIC scanner for Java source — the install-free,
// native-dependency-free backbone of the Java extractor (the Kotlin precedent:
// tree-sitter-java is a native/node-gyp grammar we don't ship, and Java's `package`/
// `import` is class-granular just like Kotlin's, so the import backbone is a trivial
// line scan — no AST, no JVM, no repo-code execution — just deterministic string
// scanning).
//
// It reads the three things the import graph needs:
//   1. the file's `package` declaration (0 or 1 — the FQN prefix of its top-level types);
//   2. every top-level TYPE the file declares (`class`/`interface`/`enum`/`record`/
//      `@interface`) — Java has NO top-level functions or fields, so types are the WHOLE
//      top-level surface, keyed `<pkg>.<Type> → file`;
//   3. every `import` directive — `import a.b.C;`, wildcard `import a.b.*;`, and the two
//      static forms `import static a.b.C.member;` / `import static a.b.C.*;` — so the
//      adapter can resolve each to a file (a static import's target class is a PREFIX of
//      the imported name, so both static forms resolve to the class by longest-prefix).
//
// Comments (`//`, and `/* */` — NON-nesting, matching Java semantics: the first `*/`
// closes the comment, unlike Kotlin's nesting blocks) and string/char literals
// (including Java-15 text blocks `"""…"""`) are stripped FIRST by a character-scan state
// machine, so a `class`/`import`-looking token inside a comment or a string never
// registers. Type scanning is brace/paren-depth-aware: a keyword is recorded only at the
// file's TOP level (both depths 0), so a nested type or a member is never mistaken for a
// top-level declaration; an annotation with a parenthesized argument on its OWN line
// (`@RequestMapping("/api")`, single- or multi-line) is balanced by the paren tracking,
// so the type it decorates is still seen.
//
// KNOWN degrades (documented, accepted): an INLINE-annotated top-level decl on ONE line
// (`@Foo public class Bar {`) is NOT captured — annotations are conventionally on their
// own line, which IS handled. A same-package implicit reference (no `import`) is not an
// edge (import-only backbone). No call edges (the locked v1 scope). Package/type names
// with the legal-but-rare `$`/unicode identifier chars beyond `[A-Za-z0-9_$]` aren't
// handled (vanishingly rare in real FQNs).

export interface JavaImport {
  /** Fully-qualified name, WITHOUT any trailing `.*`. For a static member import
   *  (`import static a.b.C.member`) this is the whole `a.b.C.member`; the caller
   *  resolves the target class by longest-prefix. */
  fqn: string;
  /** `import a.b.*;` (package) or `import static a.b.C.*;` (static) — the `.*` marker. */
  wildcard: boolean;
  /** `import static …` — the imported name denotes a MEMBER (or all static members)
   *  of the class that prefixes it, not a package. */
  static: boolean;
}

// Leading type-declaration modifiers (any order, repeated) that can precede the keyword.
// `non-sealed` carries a hyphen (a legal Java contextual modifier). `static` can't apply
// to a top-level type, but is harmless in the set (we only scan at depth 0).
const MODIFIER = '(?:public|private|protected|abstract|final|static|sealed|non-sealed|strictfp)';
const PACKAGE_RE = /^\s*package\s+([A-Za-z_$][A-Za-z0-9_$.]*)/;
// The FQN is captured LAZILY so a trailing `.*` (the wildcard group) is matched by
// `(\.\*)?` rather than swallowed by the FQN's char class. group1 = optional `static`,
// group2 = FQN (no `.*`), group3 = the wildcard marker. A trailing `;` (+ any residue of
// a stripped comment) is tolerated. Anchored at end (comments/strings are pre-stripped).
const IMPORT_RE =
  /^\s*import\s+(static\s+)?([A-Za-z_$][A-Za-z0-9_$.]*?)(\.\*)?\s*;?\s*$/;
// A top-level TYPE declaration. `@interface` (annotation type) is listed FIRST so it's
// tried before bare `interface` (a bare `interface` alternative can't match at the `@`
// anyway, but being explicit keeps intent clear). The name is captured up to the first
// non-identifier char, so `class Box<T>` → `Box`, `record Point(int x)` → `Point`.
const TYPE_DECL_RE = new RegExp(
  `^\\s*(?:${MODIFIER}\\s+)*(?:@interface|class|interface|enum|record)\\s+([A-Za-z_$][A-Za-z0-9_$]*)`,
);

/**
 * Replace every comment (a `//` line comment or a NON-nesting `/* *​/` block comment)
 * and every string/char literal (including Java-15 text blocks `"""…"""`) with spaces,
 * preserving newlines so line indices stay stable. A character-scan state machine —
 * robust against a keyword living inside a comment or string. Block comments do NOT nest
 * (Java semantics: the first `*​/` closes). Never throws.
 */
export function stripCommentsAndStrings(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  let inBlock = false;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    if (inBlock) {
      if (c === '*' && c2 === '/') {
        inBlock = false;
        out += '  ';
        i += 2;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      inBlock = true;
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
    // Java 15+ text block: """ … """ (may span lines).
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

/** The file's `package` declaration (dotted), or '' for the default/unnamed package. */
export function scanPackage(text: string): string {
  for (const line of sourceLines(text)) {
    const m = line.match(PACKAGE_RE);
    if (m) return m[1];
  }
  return '';
}

/** Every `import` directive in `text`, in source order (comment/string aware). */
export function scanImports(text: string): JavaImport[] {
  const out: JavaImport[] = [];
  for (const line of sourceLines(text)) {
    const m = line.match(IMPORT_RE);
    if (!m) continue;
    const fqn = m[2];
    if (fqn.length === 0) continue;
    out.push({ fqn, wildcard: m[3] !== undefined, static: m[1] !== undefined });
  }
  return out;
}

/**
 * Every TOP-LEVEL type name the file declares, in source order. Brace/paren-depth aware:
 * a keyword is recorded only when both depths are 0 at the line's start, so a nested
 * type or a class member is never captured. Java has no top-level functions/fields, so
 * this is the file's whole exported-name surface.
 */
export function scanTopLevelDecls(text: string): string[] {
  const names: string[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  for (const line of sourceLines(text)) {
    if (braceDepth === 0 && parenDepth === 0) {
      const m = line.match(TYPE_DECL_RE);
      if (m) names.push(m[1]);
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
 * The external-node id for a non-internal import — its PACKAGE (or a static import's
 * class) bucketed into the declared-dependency-group set by LONGEST group prefix. A group
 * is a declared Maven `groupId` (`org.springframework`, `com.google.guava`) or Gradle
 * coordinate group, so `org.springframework.web.bind.annotation` → `ext:org.springframework`
 * — ONE box per dependency FAMILY, not per sub-namespace. When no declared group is a
 * dot-aligned prefix, fall back to the first TWO segments (never a top-segment `ext:org`/
 * `ext:com` mega-node); a 1-segment name buckets to itself.
 *
 * NOTE the Maven quirk (unlike npm): a `groupId` need not prefix the java PACKAGE — Guava
 * is `com.google.guava` but packages `com.google.common.*`, so `com.google.common` won't
 * match the group and falls back to `ext:com.google` (still a sensible single box). Pure.
 */
export function javaExternalId(
  pkg: string,
  declaredGroups: ReadonlySet<string>,
): { id: string; specifier: string } {
  let best: string | undefined;
  for (const g of declaredGroups) {
    if (pkg === g || pkg.startsWith(g + '.')) {
      if (best === undefined || g.length > best.length) best = g;
    }
  }
  const bucket = best ?? pkg.split('.').slice(0, 2).join('.');
  return { id: `ext:${bucket}`, specifier: bucket };
}
