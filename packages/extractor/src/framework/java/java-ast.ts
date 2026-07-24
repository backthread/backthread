// Java framework-analysis primitives — annotation + type-declaration scanning on the
// comment/string-stripped Java source (the analogue of framework/kotlin/kotlin-ast.ts).
// Reuses the graph extractor's Java scanner (graph/java-scan) for comment/string stripping
// so the two see identical source. Pure + deterministic; never executes repo code.
//
// Java DECLARES its framework surface with ANNOTATIONS (@RestController, @Entity, …) and
// TYPE hierarchies (a Spring-Data repository `extends JpaRepository`), both recoverable
// statically. Two things the adapters need beyond the import graph:
//   * scanAnnotations — every annotation simple-name used in the file (class + method +
//     field level), so a web adapter can ask "does this file carry @RestController?".
//   * scanTypeDecls   — each TOP-LEVEL type with the annotations on its declaration and its
//     supertypes (extends + implements, generics stripped), so a data adapter can find an
//     @Entity and a repository base.

import { sourceLines } from '../../graph/java-scan.js';

export { sourceLines };

// Leading type modifiers (mirrors java-scan's MODIFIER; kept local so this module is
// self-contained).
const MODIFIER = '(?:public|private|protected|abstract|final|static|sealed|non-sealed|strictfp)';
const TYPE_DECL_RE = new RegExp(
  `^\\s*(?:${MODIFIER}\\s+)*(?:@interface|class|interface|enum|record)\\s+([A-Za-z_$][A-Za-z0-9_$]*)`,
);
// An annotation USE: `@Name` or `@a.b.Name`, optionally with `(...)`. The `@interface`
// declaration keyword is excluded by the caller. Captures the (possibly dotted) name.
const ANNOTATION_RE = /@([A-Za-z_$][A-Za-z0-9_$.]*)/g;

/** The simple (last-segment) name of a possibly-dotted annotation, e.g. `a.b.Foo` → `Foo`. */
function simpleName(dotted: string): string {
  const i = dotted.lastIndexOf('.');
  return i >= 0 ? dotted.slice(i + 1) : dotted;
}

/** Every annotation simple-name used in `text` (comment/string aware). `@interface` (the
 *  annotation-type keyword) is not an annotation use, so it's dropped. */
export function scanAnnotations(text: string): string[] {
  const out: string[] = [];
  for (const line of sourceLines(text)) {
    for (const m of line.matchAll(ANNOTATION_RE)) {
      const name = simpleName(m[1]);
      if (name === 'interface') continue; // the `@interface` decl keyword, not an annotation
      out.push(name);
    }
  }
  return out;
}

/** Annotation simple-names appearing on ONE line (before a decl keyword, say). */
function annotationsInLine(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(ANNOTATION_RE)) {
    const name = simpleName(m[1]);
    if (name === 'interface') continue;
    out.push(name);
  }
  return out;
}

/** Replace every balanced `<…>` generic block in `s` with spaces (nesting-aware). This
 *  removes both a type's own `<T extends X>` params (so the inner `extends` isn't read as a
 *  supertype) and a base's generic args (`JpaRepository<User, Long>` → `JpaRepository`). */
function blankGenerics(s: string): string {
  let out = '';
  let depth = 0;
  for (const c of s) {
    if (c === '<') {
      depth++;
      out += ' ';
    } else if (c === '>') {
      if (depth > 0) depth--;
      out += ' ';
    } else {
      out += depth > 0 ? ' ' : c;
    }
  }
  return out;
}

/** Base type names from a decl header (`extends A implements B, C {`), generics stripped. */
function parseSupertypes(header: string): string[] {
  // Cut at the class-body open, then blank generics so an `extends` inside a type-param
  // bound (`<T extends Comparable>`) or a base's args can't be mistaken for a supertype.
  const cut = header.indexOf('{');
  const h = blankGenerics(cut >= 0 ? header.slice(0, cut) : header);
  const out: string[] = [];
  const collect = (clause: string): void => {
    for (const part of clause.split(',')) {
      const m = part.trim().match(/^([A-Za-z_$][A-Za-z0-9_$.]*)/);
      if (m) out.push(simpleName(m[1]));
    }
  };
  // `extends <list>` runs until `implements` or end; `implements <list>` runs to end.
  const ext = h.match(/\bextends\b([^]*?)(?:\bimplements\b|$)/);
  if (ext) collect(ext[1]);
  const impl = h.match(/\bimplements\b([^]*)$/);
  if (impl) collect(impl[1]);
  return out;
}

export interface JavaTypeDecl {
  name: string;
  /** Annotation simple-names on this type's declaration (its own-line + inline block). */
  annotations: string[];
  /** extends + implements base names (generics stripped). */
  supertypes: string[];
}

/**
 * Every TOP-LEVEL type the file declares, with the annotations on its declaration and its
 * supertypes. Brace/paren-depth aware (only depth-0 decls), so a nested type or member is
 * never captured. Annotations on the own-lines immediately before the decl are attributed
 * to it (Java's convention); an inline `@Foo public class Bar` catches the on-line ones too.
 */
export function scanTypeDecls(text: string): JavaTypeDecl[] {
  const lines = sourceLines(text);
  const out: JavaTypeDecl[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let pending: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (braceDepth === 0 && parenDepth === 0) {
      const declM = line.match(TYPE_DECL_RE);
      if (declM) {
        const name = declM[1];
        // Gather the decl header (this line + following lines up to the class-body `{`),
        // bounded, so a multi-line `extends … implements …` is captured. parseSupertypes
        // keys off the `extends`/`implements` keywords, so the leading `class Foo` is inert.
        let header = line;
        for (let j = i + 1; j < lines.length && j < i + 8 && !header.includes('{'); j++) {
          header += ` ${lines[j]}`;
        }
        out.push({ name, annotations: [...pending, ...annotationsInLine(line)], supertypes: parseSupertypes(header) });
        pending = [];
      } else {
        // A depth-0 non-decl line: accumulate its annotations (they precede the next decl).
        pending.push(...annotationsInLine(line));
      }
    }
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    }
  }
  return out;
}
