// Shared Kotlin framework-adapter core — the analogue of framework/elixir/analyze.ts.
// The reusable setup every Kotlin adapter runs first: scan each in-scope `.kt` file ONCE
// (package, imports, type decls with supertypes + annotations, top-level funcs, call
// names), and expose the FQN→file resolver + a Kotlin NAME-RESOLUTION helper. All
// install-free + deterministic (the hand-rolled syntactic scanner; never executes repo
// code). Synchronous — like the Elixir layer there is no parser WASM to load.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  scanPackage,
  scanImports,
  scanTopLevelDecls,
  scanTypeDecls,
  scanFunDecls,
  scanCallNames,
  type KotlinImport,
  type KotlinTypeDecl,
  type KotlinFunDecl,
} from './kotlin-ast.js';
import { readGradleDeps } from '../../graph/kotlin-manifest.js';
import type { FrameworkContext } from '../types.js';

export { readGradleDeps };

/** A Kotlin source file (`.kt`). */
export function isKotlinFile(language: string): boolean {
  return language === 'kt';
}

/** Is `fileId` within the adapter's matched root (rootPath '' = whole repo)? */
export function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

/**
 * The FQN→file-id resolver the framework adapters share — `<package>.<TypeName> → file`,
 * the cross-module registry that turns a referenced type (a controller, an entity) into
 * its defining file. First (sorted-id) definition wins a duplicate, mirroring the import
 * extractor's registry so both resolve identically.
 */
export function buildKotlinBindings(fileTexts: ReadonlyMap<string, string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const id of [...fileTexts.keys()].sort()) {
    const text = fileTexts.get(id) ?? '';
    const pkg = scanPackage(text);
    for (const decl of scanTopLevelDecls(text)) {
      const fqn = pkg ? `${pkg}.${decl}` : decl;
      if (!index.has(fqn)) index.set(fqn, id);
    }
  }
  return index;
}

/** One in-scope Kotlin file, fully pre-scanned. */
export interface ParsedKotlinFile {
  text: string;
  package: string;
  imports: KotlinImport[];
  types: KotlinTypeDecl[];
  funs: KotlinFunDecl[];
  callNames: string[];
}

/** The parsed in-scope Kotlin surface an adapter analyzes. */
export interface KotlinScope {
  /** In-scope `.kt` file ids (from the graph, post-noise-filter). */
  ktFiles: string[];
  /** The resolution id set (all in-scope Kotlin files). */
  internalIds: ReadonlySet<string>;
  /** `<pkg>.<TypeName>` → file-id index. */
  moduleIndex: ReadonlyMap<string, string>;
  /** package → file-ids in it (for name resolution + wildcard). */
  packageIndex: ReadonlyMap<string, string[]>;
  /** fileId → its pre-scanned surface (unreadable files omitted). */
  parsed: Map<string, ParsedKotlinFile>;
  /** Resolve a fully-qualified name to its defining file (longest-prefix). */
  resolve(fqn: string): string | undefined;
  /**
   * Resolve a type NAME (simple or qualified) referenced in `fromFile` to its defining
   * file, following Kotlin name resolution: a qualified name via the registry; a simple
   * name via (1) same package, (2) an explicit `import a.b.Name` / `import a.b.X as Name`,
   * (3) a wildcard `import a.b.*` package. Undefined = unresolvable.
   */
  resolveTypeRef(name: string, fromFile: ParsedKotlinFile): string | undefined;
}

/** Resolve a fully-qualified name by longest prefix over the registry. */
function resolveByPrefix(fqn: string, index: ReadonlyMap<string, string>): string | undefined {
  let prefix = fqn;
  while (prefix.includes('.')) {
    const hit = index.get(prefix);
    if (hit !== undefined) return hit;
    prefix = prefix.slice(0, prefix.lastIndexOf('.'));
  }
  return index.get(fqn);
}

/**
 * Scan every in-scope Kotlin file once and pre-collect its surface — the common first
 * step of every Kotlin framework adapter's analysis. Reads source server-side
 * (never-store-source); a file that can't be read is skipped.
 */
export function parseKotlinScope(ctx: FrameworkContext): KotlinScope {
  const { repoDir, rootPath, graph } = ctx;
  const ktFiles = graph.files
    .filter((f) => isKotlinFile(f.language) && inScope(f.id, rootPath))
    .map((f) => f.id);
  const internalIds = new Set(ktFiles);

  const texts = new Map<string, string>();
  for (const id of ktFiles) {
    try {
      texts.set(id, readFileSync(join(repoDir, id), 'utf8'));
    } catch {
      // unreadable — skip (omitted from the parsed map).
    }
  }

  const moduleIndex = buildKotlinBindings(texts);
  const packageIndex = new Map<string, string[]>();
  const parsed = new Map<string, ParsedKotlinFile>();
  for (const [id, text] of texts) {
    const pkg = scanPackage(text);
    (packageIndex.get(pkg) ?? packageIndex.set(pkg, []).get(pkg)!).push(id);
    parsed.set(id, {
      text,
      package: pkg,
      imports: scanImports(text),
      types: scanTypeDecls(text),
      funs: scanFunDecls(text),
      callNames: scanCallNames(text),
    });
  }

  const resolveTypeRef = (name: string, fromFile: ParsedKotlinFile): string | undefined => {
    if (name.includes('.')) return resolveByPrefix(name, moduleIndex);
    // 1. same package.
    const samePkg = fromFile.package ? `${fromFile.package}.${name}` : name;
    const sp = moduleIndex.get(samePkg);
    if (sp) return sp;
    // 2. an explicit import whose local name is `name` (alias or last segment).
    for (const imp of fromFile.imports) {
      if (imp.wildcard) continue;
      const local = imp.alias ?? imp.fqn.slice(imp.fqn.lastIndexOf('.') + 1);
      if (local === name) {
        const hit = resolveByPrefix(imp.fqn, moduleIndex);
        if (hit) return hit;
      }
    }
    // 3. a wildcard `import pkg.*` — try pkg + name.
    for (const imp of fromFile.imports) {
      if (!imp.wildcard) continue;
      const hit = moduleIndex.get(`${imp.fqn}.${name}`);
      if (hit) return hit;
    }
    return undefined;
  };

  return {
    ktFiles,
    internalIds,
    moduleIndex,
    packageIndex,
    parsed,
    resolve: (fqn) => resolveByPrefix(fqn, moduleIndex),
    resolveTypeRef,
  };
}
