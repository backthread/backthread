// Shared Go framework-adapter core — the analogue of framework/kotlin/analyze.ts, adapted
// for Go's DIR-GRANULAR graph (a node is a package directory, not a file). The reusable
// setup every Go adapter runs first: enumerate the package-dir nodes, read each package's
// `.go` files, and expose (a) the module info (for import→dir resolution), (b) a
// type-name→dir registry (for resolving a model reference to its package), and (c) a
// package-ref resolver (for resolving `pkg.Symbol` to a package dir through the file's
// imports). Install-free + deterministic; never executes repo code.
//
// A framework contribution is keyed by GRAPH NODE ID = the package DIRECTORY, so a finding
// in `internal/api/users.go` is attributed to the node `internal/api`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../../graph/go-scan.js';
import { listSourceFiles } from '../../graph/language.js';
import { dirIdOf, importToDir } from '../../graph/go-adapter.js';
import { readGoModuleInfo } from '../../graph/go-manifest.js';
import type { FrameworkContext } from '../types.js';

/** A Go graph node — a package directory. */
export function isGoDir(language: string): boolean {
  return language === 'go';
}

export interface GoImportRef {
  /** The import path (`github.com/gin-gonic/gin`). */
  path: string;
  /** The local qualifier name — the alias, or the last path segment. Undefined for `_`/`.`. */
  name?: string;
}

/** Alias-aware Go import scan — like go-scan's scanImports but keeping the local name so a
 *  `pkg.Symbol` reference can be resolved. `import _ "x"` / `import . "x"` yield no name. */
export function scanGoImportRefs(text: string): GoImportRef[] {
  const out: GoImportRef[] = [];
  const lines = stripComments(text).split('\n');
  let inBlock = false;
  let sawPackage = false;
  const IMP_LINE = /^(?:([A-Za-z0-9_.]+)\s+)?"([^"]+)"/;
  const add = (aliasTok: string | undefined, path: string): void => {
    let name: string | undefined;
    if (aliasTok === '_' || aliasTok === '.') name = undefined; // blank / dot import → no qualifier
    else if (aliasTok) name = aliasTok;
    else name = path.slice(path.lastIndexOf('/') + 1);
    out.push({ path, name });
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      const m = line.match(IMP_LINE);
      if (m) add(m[1], m[2]);
      if (line.includes(')')) inBlock = false;
      continue;
    }
    if (!sawPackage) {
      if (/^package\s+\w+/.test(line)) sawPackage = true;
      continue;
    }
    if (line === '') continue;
    if (/^import\s*\(/.test(line)) {
      inBlock = true;
      const m = line.match(/^import\s*\(\s*(?:([A-Za-z0-9_.]+)\s+)?"([^"]+)"/);
      if (m) add(m[1], m[2]);
      if (line.includes(')')) inBlock = false;
      continue;
    }
    const s = line.match(/^import\s+(?:([A-Za-z0-9_.]+)\s+)?"([^"]+)"/);
    if (s) {
      add(s[1], s[2]);
      continue;
    }
    if (/^(?:func|type|var|const)\b/.test(line)) break; // first declaration → imports done
  }
  return out;
}

// A `type Name struct` / `type Name interface` top-level declaration (comment-stripped).
const TYPE_STRUCT_RE = /^\s*type\s+([A-Z][A-Za-z0-9_]*)\s+struct\b/;

/** Top-level exported struct type names declared in `text`. */
export function scanStructTypeNames(text: string): string[] {
  const out: string[] = [];
  for (const line of stripComments(text).split('\n')) {
    const m = line.match(TYPE_STRUCT_RE);
    if (m) out.push(m[1]);
  }
  return out;
}

// A struct field line: `Name  []*Type` / `Name  pkg.Type` (comment/tag stripped). Captures
// the type's PascalCase tail (a lowercase primitive like `string`/`uint` never matches, so
// only model-ish types survive). An embedded field (`gorm.Model`, one token) never matches.
const FIELD_RE = /^\s*[A-Z]\w*\s+(?:\[\])?\*?((?:[a-z]\w*\.)?[A-Z]\w*)\b/;
const STRUCT_START_RE = /\btype\s+[A-Z]\w*\s+struct\s*\{/;

/**
 * The associated TYPE references inside a file's struct BODIES (brace-tracked). Each is a
 * simple `Type` or qualified `pkg.Type` PascalCase name (resolved by the caller). Pass
 * comment-stripped source — a field type is code (preserved), a `gorm:` tag is a backtick
 * string (blanked), so the type survives while the tag doesn't interfere. Never throws.
 */
export function scanStructFieldTypes(strippedText: string): string[] {
  const out: string[] = [];
  const lines = strippedText.split('\n');
  let depth = 0; // brace depth once inside a struct body
  for (const line of lines) {
    if (depth === 0) {
      if (STRUCT_START_RE.test(line)) depth = 1; // enter the struct body (its own `{` is what depth=1 represents)
      continue;
    }
    const m = line.match(FIELD_RE);
    if (m) out.push(m[1]);
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth <= 0) {
          depth = 0;
          break;
        }
      }
    }
  }
  return out;
}

/** One in-scope Go file: its package dir (graph node), id, source, imports. */
export interface GoFile {
  dir: string;
  fileId: string;
  text: string;
  imports: GoImportRef[];
}

export interface GoScope {
  /** Package-dir node ids (from the graph, post-noise-filter). */
  goDirs: ReadonlySet<string>;
  /** In-scope `.go` files grouped by package dir. */
  filesByDir: ReadonlyMap<string, GoFile[]>;
  /** All in-scope files (flat). */
  files: GoFile[];
  modulePath: string;
  moduleDir: string;
  /** Exported struct type name → the package dir that declares it (first wins). */
  typeToDir: ReadonlyMap<string, string>;
  /** Resolve a `pkg.Symbol` package qualifier (via `file`'s imports) to a first-party
   *  package dir that is a graph node, or undefined. */
  resolvePackageRef(pkgName: string, file: GoFile): string | undefined;
}

/** Scan every in-scope Go package once and pre-collect its surface. Reads source
 *  server-side (never-store-source); an unreadable file is skipped. */
export function parseGoScope(ctx: FrameworkContext): GoScope {
  const { repoDir, graph } = ctx;
  const goDirs = new Set(graph.files.filter((f) => isGoDir(f.language)).map((f) => f.id));
  const { modulePath, moduleDir } = readGoModuleInfo(repoDir);

  const filesByDir = new Map<string, GoFile[]>();
  const files: GoFile[] = [];
  for (const fileId of listSourceFiles(repoDir, 'go')) {
    const dir = dirIdOf(fileId);
    if (!goDirs.has(dir)) continue; // dir noise-filtered out of the graph → skip
    let text = '';
    try {
      text = readFileSync(join(repoDir, fileId), 'utf8');
    } catch {
      text = '';
    }
    const gf: GoFile = { dir, fileId, text, imports: scanGoImportRefs(text) };
    files.push(gf);
    (filesByDir.get(dir) ?? filesByDir.set(dir, []).get(dir)!).push(gf);
  }

  const typeToDir = new Map<string, string>();
  for (const gf of [...files].sort((a, b) => (a.fileId < b.fileId ? -1 : 1))) {
    for (const t of scanStructTypeNames(gf.text)) if (!typeToDir.has(t)) typeToDir.set(t, gf.dir);
  }

  const resolvePackageRef = (pkgName: string, file: GoFile): string | undefined => {
    for (const imp of file.imports) {
      if (imp.name !== pkgName) continue;
      const dir = importToDir(imp.path, modulePath, moduleDir);
      if (dir && goDirs.has(dir)) return dir;
    }
    return undefined;
  };

  return { goDirs, filesByDir, files, modulePath, moduleDir, typeToDir, resolvePackageRef };
}
