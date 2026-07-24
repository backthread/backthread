// Shared Java framework-adapter core — the analogue of framework/kotlin/analyze.ts. The
// reusable setup every Java adapter runs first: scan each in-scope `.java` file ONCE
// (package, imports, type decls with supertypes + annotations), build the FQN→file
// resolver, and expose a Java NAME-RESOLUTION helper. Install-free + deterministic; never
// executes repo code. Synchronous — the hand-rolled Java scanner has no parser to load.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanPackage, scanImports, scanTopLevelDecls, type JavaImport } from '../../graph/java-scan.js';
import { scanTypeDecls, type JavaTypeDecl } from './java-ast.js';
import type { FrameworkContext } from '../types.js';

/** A Java source file. */
export function isJavaFile(language: string): boolean {
  return language === 'java';
}

/** Is `fileId` within the adapter's matched root (rootPath '' = whole repo)? */
export function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

/**
 * The FQN→file-id resolver the framework adapters share — `<package>.<TypeName> → file`,
 * the cross-module registry that turns a referenced type into its defining file. First
 * (sorted-id) definition wins a duplicate, mirroring the import extractor's registry.
 */
export function buildJavaBindings(fileTexts: ReadonlyMap<string, string>): Map<string, string> {
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

/** One in-scope Java file, fully pre-scanned. */
export interface ParsedJavaFile {
  text: string;
  package: string;
  imports: JavaImport[];
  types: JavaTypeDecl[];
}

/** The parsed in-scope Java surface an adapter analyzes. */
export interface JavaScope {
  javaFiles: string[];
  internalIds: ReadonlySet<string>;
  moduleIndex: ReadonlyMap<string, string>;
  packageIndex: ReadonlyMap<string, string[]>;
  parsed: Map<string, ParsedJavaFile>;
  resolve(fqn: string): string | undefined;
  /**
   * Resolve a type NAME (simple or qualified) referenced in `fromFile` to its defining
   * file, following Java name resolution: a qualified name via the registry; a simple name
   * via (1) same package, (2) an explicit non-static `import a.b.Name`, (3) a wildcard
   * `import a.b.*` package. Java has no import alias. Undefined = unresolvable.
   */
  resolveTypeRef(name: string, fromFile: ParsedJavaFile): string | undefined;
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

/** Scan every in-scope Java file once and pre-collect its surface. Reads source
 *  server-side (never-store-source); an unreadable file is skipped. */
export function parseJavaScope(ctx: FrameworkContext): JavaScope {
  const { repoDir, rootPath, graph } = ctx;
  const javaFiles = graph.files.filter((f) => isJavaFile(f.language) && inScope(f.id, rootPath)).map((f) => f.id);
  const internalIds = new Set(javaFiles);

  const texts = new Map<string, string>();
  for (const id of javaFiles) {
    try {
      texts.set(id, readFileSync(join(repoDir, id), 'utf8'));
    } catch {
      // unreadable — skip.
    }
  }

  const moduleIndex = buildJavaBindings(texts);
  const packageIndex = new Map<string, string[]>();
  const parsed = new Map<string, ParsedJavaFile>();
  for (const [id, text] of texts) {
    const pkg = scanPackage(text);
    (packageIndex.get(pkg) ?? packageIndex.set(pkg, []).get(pkg)!).push(id);
    parsed.set(id, { text, package: pkg, imports: scanImports(text), types: scanTypeDecls(text) });
  }

  const resolveTypeRef = (name: string, fromFile: ParsedJavaFile): string | undefined => {
    if (name.includes('.')) return resolveByPrefix(name, moduleIndex);
    // 1. same package.
    const samePkg = fromFile.package ? `${fromFile.package}.${name}` : name;
    const sp = moduleIndex.get(samePkg);
    if (sp) return sp;
    // 2. an explicit non-static import whose last segment is `name` (Java has no alias;
    //    a static import brings a MEMBER, not a type, so it is skipped for type resolution).
    for (const imp of fromFile.imports) {
      if (imp.wildcard || imp.static) continue;
      const local = imp.fqn.slice(imp.fqn.lastIndexOf('.') + 1);
      if (local === name) {
        const hit = resolveByPrefix(imp.fqn, moduleIndex);
        if (hit) return hit;
      }
    }
    // 3. a wildcard `import pkg.*` — try pkg + name.
    for (const imp of fromFile.imports) {
      if (!imp.wildcard || imp.static) continue;
      const hit = moduleIndex.get(`${imp.fqn}.${name}`);
      if (hit) return hit;
    }
    return undefined;
  };

  return {
    javaFiles,
    internalIds,
    moduleIndex,
    packageIndex,
    parsed,
    resolve: (fqn) => resolveByPrefix(fqn, moduleIndex),
    resolveTypeRef,
  };
}
