// Pure, hand-rolled SYNTACTIC scanner for Go source — the install-free,
// native-dependency-free backbone of the Go extractor (the Elixir/Dart/Kotlin precedent:
// no tree-sitter, no Go toolchain, no repo-code execution). Go's import graph is unusually
// simple to recover statically: an import is a STRING LITERAL naming a package PATH, and a
// first-party path maps DIRECTLY to a repo directory (import path minus the go.mod module
// prefix IS the dir) — no symbol registry needed, unlike the class-granular languages.
//
// It reads the two things the import graph needs:
//   1. the file's `package <name>` clause (the Go package name — for reference; the graph
//      is keyed by DIRECTORY, since a Go package is exactly one directory of `.go` files);
//   2. every `import` path string — the single form `import "path"` (with an optional
//      alias / `_` / `.` prefix) and the grouped `import ( "a"\n  alias "b" )` block.
//
// Comments (`//`, `/* */` — NON-nesting, Go semantics) and RAW backtick strings +
// rune literals are blanked FIRST by a character-scan state machine, so an `import`-looking
// token inside a comment or a `\`...\`` raw string never registers. INTERPRETED (double-
// quoted) string contents are DELIBERATELY KEPT — they carry the import paths — which is
// safe because an interpreted string cannot span lines, so it can never make a later line
// falsely begin with `import`. Import scanning also stops at the first non-import top-level
// line after the package clause (Go requires all imports before any other declaration).
//
// KNOWN degrades (documented, accepted): no call edges (the locked v1 scope). A dot import
// (`import . "path"`) is treated like any other import (an edge to the package), which is
// correct for the graph. A go.mod-less (legacy GOPATH) repo has no module prefix, so
// nothing resolves as first-party — but detection requires a go.mod, so this can't occur
// in practice.

/**
 * Replace comments (`//`, non-nesting `/* *​/`), RAW backtick strings, and rune literals
 * with spaces, preserving newlines so line indices stay stable. INTERPRETED double-quoted
 * strings are kept intact (they hold import paths). A character-scan state machine that
 * correctly transits string state, so a `//` inside `"http://x"` or a `/*` inside a raw
 * string is never mistaken for a comment. Never throws.
 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';
    // line comment
    if (c === '/' && c2 === '/') {
      out += '  ';
      i += 2;
      while (i < n && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    // block comment (non-nesting)
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    // interpreted string — KEEP its content (it carries import paths). Handle \-escapes so
    // an escaped quote doesn't end it early; interpreted strings never contain a newline.
    if (c === '"') {
      out += '"';
      i++;
      while (i < n && text[i] !== '"' && text[i] !== '\n') {
        if (text[i] === '\\') {
          out += text[i];
          i++;
          if (i < n) {
            out += text[i];
            i++;
          }
          continue;
        }
        out += text[i];
        i++;
      }
      if (i < n && text[i] === '"') {
        out += '"';
        i++;
      }
      continue;
    }
    // raw backtick string — BLANK its content (can span lines; no escapes).
    if (c === '`') {
      out += ' ';
      i++;
      while (i < n && text[i] !== '`') {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += ' ';
        i++;
      }
      continue;
    }
    // rune literal — BLANK (handle \-escape).
    if (c === "'") {
      out += ' ';
      i++;
      while (i < n && text[i] !== "'" && text[i] !== '\n') {
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
      if (i < n && text[i] === "'") {
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

const PACKAGE_RE = /^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/;
// A single `import "path"`, with an optional alias / `_` (blank) / `.` (dot) prefix.
const SINGLE_IMPORT_RE = /^\s*import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/;
// A top-level declaration keyword — marks the end of the import section (Go requires all
// imports to precede any other declaration).
const TOP_DECL_RE = /^\s*(?:func|type|var|const)\b/;
// A path string inside an import block line (`"path"` or `alias "path"`).
const BLOCK_PATH_RE = /"([^"]+)"/;

/** The file's `package` clause name, or '' if none found. */
export function scanPackage(text: string): string {
  for (const line of stripComments(text).split('\n')) {
    const m = line.match(PACKAGE_RE);
    if (m) return m[1];
  }
  return '';
}

/**
 * Every import PATH in the file, in source order — the single `import "p"` form and every
 * path inside an `import ( … )` block. Comment/raw-string aware; bounded to the header
 * (stops at the first top-level declaration after `package`). Never throws.
 */
export function scanImports(text: string): string[] {
  const out: string[] = [];
  const lines = stripComments(text).split('\n');
  let inBlock = false;
  let sawPackage = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      const pm = line.match(BLOCK_PATH_RE);
      if (pm) out.push(pm[1]);
      if (line.includes(')')) inBlock = false;
      continue;
    }
    if (!sawPackage) {
      if (PACKAGE_RE.test(line)) sawPackage = true;
      continue; // build tags / doc comment / blank before `package`
    }
    if (line === '') continue;
    if (/^import\s*\(/.test(line)) {
      inBlock = true;
      const pm = line.match(BLOCK_PATH_RE); // a path on the same line as `import (` (rare)
      if (pm) out.push(pm[1]);
      if (line.includes(')')) inBlock = false; // single-line `import ("fmt")`
      continue;
    }
    const sm = line.match(SINGLE_IMPORT_RE);
    if (sm) {
      out.push(sm[1]);
      continue;
    }
    if (TOP_DECL_RE.test(line)) break; // first real declaration → imports are done
    // a stray line that is neither import nor a top-level decl (rare) — keep scanning
  }
  return out;
}

/**
 * Is an import path a Go STANDARD-LIBRARY package? The Go tool's own rule: a standard
 * package's import path has NO dot in its first path element (`fmt`, `net/http`,
 * `encoding/json`), whereas a third-party module path begins with a domain
 * (`github.com/…`, `golang.org/…`, `gopkg.in/…`). A first-party import (under the module
 * path) is checked BEFORE this, so this only ever sees genuinely external references.
 */
export function isGoStdlib(importPath: string): boolean {
  const first = importPath.split('/')[0];
  return !first.includes('.');
}

/**
 * The external-node id for a non-first-party, non-stdlib import — its MODULE, bucketed by
 * the LONGEST declared-require-module prefix (from go.mod), falling back to the first THREE
 * path segments (`host/org/repo`) when no declared module is a prefix. So
 * `github.com/gin-gonic/gin/render` → `ext:github.com/gin-gonic/gin` and
 * `golang.org/x/sync/errgroup` → `ext:golang.org/x/sync` — ONE box per dependency MODULE,
 * not per sub-package. A shorter path (`gopkg.in/yaml.v3`) buckets to itself. Pure.
 */
export function goExternalId(
  importPath: string,
  declaredModules: ReadonlySet<string>,
): { id: string; specifier: string } {
  let best: string | undefined;
  for (const m of declaredModules) {
    if (importPath === m || importPath.startsWith(m + '/')) {
      if (best === undefined || m.length > best.length) best = m;
    }
  }
  const bucket = best ?? importPath.split('/').slice(0, 3).join('/');
  return { id: `ext:${bucket}`, specifier: bucket };
}
