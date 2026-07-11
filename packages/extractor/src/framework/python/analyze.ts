// Shared Python framework-adapter core (+). The reusable helpers the
// FastAPI adapter established, promoted so the Django / Flask / ORM /
// Celery / … fleet share ONE cross-module resolver + ONE parse-scope setup
// instead of each reinventing them. All install-free + deterministic (pure
// syntactic Pyright parse via ./py-ast.js; never executes repo code).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inferSourceRoots, syntacticResolve } from '../../graph/python-adapter.js';
import { collectNodes, parsePython, PN, type CollectedNodes } from './py-ast.js';
import type {
  ImportFromNode,
  ImportNode,
  ParseNode,
} from '@zzzen/pyright-internal/dist/parser/parseNodes.js';
import type { FrameworkContext } from '../types.js';

/** A Python source file (module or stub). */
export function isPythonFile(language: string): boolean {
  return language === 'py' || language === 'pyi';
}

/** Is `fileId` within the adapter's matched root (rootPath '' = whole repo)? */
export function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

/**
 * A file's `localName → target file id` import map, resolving module paths with
 * the extractor's path-anchored, nested-root-aware `syntacticResolve` (consistent
 * with /988). Handles `import a.b as c`, `from pkg import submod` (prefers
 * the submodule file), and `from pkg import symbol` (the symbol's module file).
 * The tricky, load-bearing piece every Python adapter needs for cross-module edges.
 */
export function buildImportBindings(
  fromId: string,
  imports: ReadonlyArray<ImportNode | ImportFromNode>,
  internalIds: ReadonlySet<string>,
  roots: readonly string[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of imports) {
    if ((imp as ParseNode).nodeType === PN.Import) {
      // `import a.b.c as d` → d; `import a.b` → the top package name `a`. LIMITATION
      // (accepted): a non-aliased `import a.b.c` binds only `a` (→ its __init__), so a
      // later `a.b.c.x` access resolves imprecisely — rare; the `from … import x`
      // forms below resolve exactly.
      for (const entry of (imp as ImportNode).d.list) {
        const parts = entry.d.module.d.nameParts.map((p) => p.d.value);
        if (parts.length === 0) continue;
        const dotted = parts.join('.');
        const local = entry.d.alias ? entry.d.alias.d.value : parts[0];
        const target = entry.d.alias
          ? syntacticResolve(dotted, fromId, internalIds, roots)
          : syntacticResolve(parts[0], fromId, internalIds, roots);
        if (target) map.set(local, target);
      }
      continue;
    }
    if ((imp as ParseNode).nodeType !== PN.ImportFrom) continue;
    const from = imp as ImportFromNode;
    const dots = '.'.repeat(from.d.module.d.leadingDots);
    const body = from.d.module.d.nameParts.map((p) => p.d.value).join('.');
    const modulePrefix = dots + body; // '' | 'app.api.routes' | '.routers' | '.'
    for (const spec of from.d.imports) {
      const imported = spec.d.name.d.value;
      const local = spec.d.alias ? spec.d.alias.d.value : imported;
      // Prefer the SUBMODULE resolution (`from app.api.routes import users` →
      // users.py); fall back to the MODULE (`from …users import symbol` → users.py).
      const submodule = modulePrefix ? `${modulePrefix}.${imported}` : imported;
      const target =
        syntacticResolve(submodule, fromId, internalIds, roots) ??
        (modulePrefix ? syntacticResolve(modulePrefix, fromId, internalIds, roots) : undefined);
      if (target) map.set(local, target);
    }
  }
  return map;
}

/** One in-scope Python file: its collected nodes + its import bindings. */
export interface ParsedPythonFile {
  nodes: CollectedNodes;
  bindings: Map<string, string>;
}

/** The parsed in-scope Python surface an adapter analyzes. */
export interface PythonScope {
  /** In-scope Python file ids (from the graph, post-noise-filter). */
  pyFiles: string[];
  /** The resolution id set (all in-scope Python files). */
  internalIds: ReadonlySet<string>;
  /** Inferred first-party source roots (nested-package aware). */
  roots: readonly string[];
  /** fileId → parsed nodes + import bindings (unparseable files are omitted). */
  parsed: Map<string, ParsedPythonFile>;
}

/**
 * Parse every in-scope Python file once and build its import bindings — the
 * common first step of every Python framework adapter's analysis. Reads source
 * server-side (never-store-source); a file that can't be read/parsed is skipped.
 */
export function parsePythonScope(ctx: FrameworkContext): PythonScope {
  const { repoDir, rootPath, graph } = ctx;
  const pyFiles = graph.files
    .filter((f) => isPythonFile(f.language) && inScope(f.id, rootPath))
    .map((f) => f.id);
  const internalIds = new Set(pyFiles);
  const roots = inferSourceRoots(internalIds);
  const parsed = new Map<string, ParsedPythonFile>();
  for (const id of pyFiles) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, id), 'utf8');
    } catch {
      continue;
    }
    const tree = parsePython(text);
    if (!tree) continue;
    const nodes = collectNodes(tree);
    parsed.set(id, { nodes, bindings: buildImportBindings(id, nodes.imports, internalIds, roots) });
  }
  return { pyFiles, internalIds, roots, parsed };
}
