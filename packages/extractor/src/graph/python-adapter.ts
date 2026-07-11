// Pyright-driven Python structural extractor — the first non-TS
// GraphExtractor. Mirrors the ts-morph adapter's contract: emit FileRecords, hand
// them to the shared graphFromState assembler, and let everything downstream
// (Louvain, stabilizeModuleIds, subsystem/domain grouping, the whole enrich stage)
// consume the identical NormalizedGraph unchanged.
//
// INSTALL-FREE + PURE-STATIC by construction — the two locked constraints:
//   • We drive Pyright DIRECTLY (its ImportResolver, via a Program) as the
//     semantic tier. Pyright resolves FIRST-PARTY (in-repo) imports from workspace
//     source with NO venv — workspace-root + `src/` + namespace-package + relative
//     resolution all work out of the box (verified). It is pure TypeScript: no
//     native binary, so it runs identically local + in the destroy-on-exit
//     container.
//   • We use `NoAccessHost`, NOT FullAccessHost — FullAccessHost shells out to the
//     host's Python interpreter to discover search paths (a subprocess + a host
//     dependency + non-determinism). NoAccessHost never spawns anything and never
//     touches a venv, so resolution depends ONLY on the repo's own source — the
//     install-free promise, enforced. The toolchain never executes repo code
//     (no setup.py, no import of target modules, no app boot).
//
// Third-party + stdlib imports resolve to nothing under NoAccessHost (there's no
// venv, and stdlib typeshed isn't on the path); we then DROP stdlib names (the
// analogue of the ts-morph Node-builtin drop) and turn the rest into EXTERNAL
// nodes — exactly the ts-morph "unresolved bare specifier = external" convention.
// Losing third-party SYMBOL resolution is expected and fine: the module/edge graph
// never needed it.
//
// Import edges are the reliable backbone. Typed cross-module CALL edges (the
// ts-morph adapter's expensive half) need a full type-evaluator pass and degrade
// to nothing here — an explicit, documented best-effort gap (import-only degrade,
// mirroring the ts-morph try/catch), left as a clean follow-on. A pure-static
// path-anchored SYNTACTIC fallback recovers first-party import edges for the rare
// repo whose root Pyright can't infer.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFromRealFileSystem, RealTempFile } from '@zzzen/pyright-internal/dist/common/realFileSystem.js';
import { createServiceProvider } from '@zzzen/pyright-internal/dist/common/serviceProviderExtensions.js';
import { ConfigOptions } from '@zzzen/pyright-internal/dist/common/configOptions.js';
import { NoAccessHost } from '@zzzen/pyright-internal/dist/common/host.js';
import { NullConsole } from '@zzzen/pyright-internal/dist/common/console.js';
import { Uri } from '@zzzen/pyright-internal/dist/common/uri/uri.js';
import { AnalyzerService } from '@zzzen/pyright-internal/dist/analyzer/service.js';
import { Program } from '@zzzen/pyright-internal/dist/analyzer/program.js';
import { ParseTreeWalker } from '@zzzen/pyright-internal/dist/analyzer/parseTreeWalker.js';
import type { CallNode, ModuleNode, ParseNode } from '@zzzen/pyright-internal/dist/parser/parseNodes.js';
import { pythonExternalIdFor, type GraphExtractor, type NormalizedGraph } from './types.js';
import { graphFromState, type FileRecord, type FileGraphState } from './file-graph.js';
import { listSourceFiles } from './language.js';
import { PYTHON_STDLIB } from './python-stdlib.js';

// Pyright's ImportType is a `const enum` (erased at runtime), so we can't import
// it from the compiled .js — pin the value locally. BuiltIn = 0, ThirdParty = 1,
// Local = 2 (analyzer/importResult.ts). Only `Local` is a first-party candidate.
const IMPORT_TYPE_LOCAL = 2;

// Candidate source roots the syntactic fallback anchors absolute imports against —
// Pyright's own default first-party roots (workspace root, then `src/`). 
// ADDS inferred package roots on top (inferSourceRoots), so a nested backend
// (`backend/app/` with imports rooted at `app`) resolves when the whole polyglot
// repo is ingested at its true root — the -deferred item, needed to make
// the multi-language merge produce a legible (not one-blob) backend.
const FALLBACK_ROOTS = ['', 'src'] as const;

/**
 * The first-party source roots for a Python file set — every default root plus
 * each directory that CONTAINS a top-level package (a dir with `__init__.py`
 * whose parent is not itself a package). For `backend/app/__init__.py` the
 * top-level package is `backend/app` and its containing root is `backend`, so
 * `from app.x import y` resolves against `backend/app/x/y.py`. Additive: a
 * root-layout repo already infers `''` and a src-layout `'src'` (both defaults),
 * so single-package output is unchanged; only a NESTED package gains a root.
 * Deterministic (sorted).
 */
export function inferSourceRoots(internalIds: ReadonlySet<string>): string[] {
  const packageDirs = new Set<string>();
  for (const id of internalIds) {
    if (id.endsWith('/__init__.py') || id.endsWith('/__init__.pyi')) {
      packageDirs.add(id.slice(0, id.lastIndexOf('/')));
    } else if (id === '__init__.py' || id === '__init__.pyi') {
      packageDirs.add('');
    }
  }
  const roots = new Set<string>(FALLBACK_ROOTS);
  for (const pkgDir of packageDirs) {
    const parent = pkgDir.includes('/') ? pkgDir.slice(0, pkgDir.lastIndexOf('/')) : '';
    // A top-level package's parent is NOT itself a package → it's a source root.
    if (!packageDirs.has(parent)) roots.add(parent);
  }
  return [...roots].sort();
}

/** The line-of-code count for one source file (size/centrality signal). */
function locOf(absPath: string): number {
  try {
    const text = readFileSync(absPath, 'utf8');
    if (text.length === 0) return 0;
    return text.split('\n').length;
  } catch {
    return 0;
  }
}

/** Top-level (leftmost) dotted segment of an absolute module name. */
function topLevel(moduleName: string): string {
  return moduleName.replace(/^\.+/, '').split('.')[0];
}

/**
 * Pure, path-anchored SYNTACTIC resolution — the tree-sitter-fallback role
 * (recover the import graph from the on-disk layout) implemented over Pyright's
 * already-parsed import name, so no second parser / native grammar is needed. Used
 * ONLY when Pyright resolved nothing internal. Returns a repo-relative id in
 * `internalIds`, or undefined.
 *
 * `importName` carries leading dots for relative imports (`.util`, `..pkg.mod`);
 * `fromId` is the importing file's repo-relative id. Absolute names try each
 * FALLBACK_ROOT; relative names anchor on the importing file's package, ascending
 * one level per leading dot beyond the first.
 */
// Order candidate roots so those that are ancestor dirs of `fromId` come first
// (deepest — most specific — first), then the rest in their given order. A tie
// among non-ancestors keeps input order (deterministic). Backward-compatible: a
// root/`src`-layout file has only `''` as an ancestor, so the order is unchanged.
function orderRootsByProximity(roots: readonly string[], fromId: string): string[] {
  const fromDir = fromId.includes('/') ? fromId.slice(0, fromId.lastIndexOf('/')) : '';
  const isAncestor = (r: string): boolean => r === '' || fromDir === r || fromDir.startsWith(`${r}/`);
  const ancestors = roots.filter(isAncestor).sort((a, b) => b.length - a.length);
  const others = roots.filter((r) => !isAncestor(r));
  return [...ancestors, ...others];
}

export function syntacticResolve(
  importName: string,
  fromId: string,
  internalIds: ReadonlySet<string>,
  roots: readonly string[] = FALLBACK_ROOTS,
): string | undefined {
  const leadingDots = importName.match(/^\.*/)?.[0].length ?? 0;
  const rest = importName.slice(leadingDots);
  const parts = rest.length ? rest.split('.') : [];

  const candidateBases: string[] = [];
  if (leadingDots === 0) {
    // Try roots that are ANCESTORS of the importing file first (deepest first), so
    // a `backend/app/x.py` importing `app.y` prefers its own `backend` root over a
    // second, unrelated top-level `app/` package at the repo root.
    for (const root of orderRootsByProximity(roots, fromId)) candidateBases.push(root);
  } else {
    // Relative: start from the importing file's directory (its package), then
    // ascend (leadingDots - 1) more levels. A `from . import x` (no parts) can't
    // be resolved to the submodule here — Pyright's implicit-import path already
    // covers it — so we only anchor the package dir.
    const fromDir = fromId.includes('/') ? fromId.slice(0, fromId.lastIndexOf('/')) : '';
    let segs = fromDir.length ? fromDir.split('/') : [];
    const up = leadingDots - 1;
    if (up > segs.length) return undefined; // ascends past the repo root
    segs = segs.slice(0, segs.length - up);
    candidateBases.push(segs.join('/'));
  }

  if (parts.length === 0) return undefined; // nothing concrete to anchor to
  for (const base of candidateBases) {
    const prefix = [base, ...parts].filter(Boolean).join('/');
    for (const cand of [`${prefix}.py`, `${prefix}.pyi`, `${prefix}/__init__.py`, `${prefix}/__init__.pyi`]) {
      if (internalIds.has(cand)) return cand;
    }
  }
  return undefined;
}

/** Build a Program over `fileIds` (repo-relative posix) rooted at `absRoot`. */
function buildProgram(absRoot: string, fileIds: readonly string[]) {
  const tempFile = new RealTempFile();
  const console = new NullConsole();
  const fs = createFromRealFileSystem(tempFile, console);
  const serviceProvider = createServiceProvider(fs, tempFile, console);
  const rootUri = Uri.file(absRoot, serviceProvider);
  const config = new ConfigOptions(rootUri);
  const host = new NoAccessHost();
  const importResolver = AnalyzerService.createImportResolver(serviceProvider, config, host);
  // disableChecker = true: we only need parse + import resolution, never the
  // type checker (call-edge type-eval is out of scope; import-only degrade).
  const program = new Program(importResolver, config, serviceProvider, undefined, true);
  const uriById = new Map<string, Uri>();
  for (const id of fileIds) uriById.set(id, Uri.file(`${absRoot}/${id}`, serviceProvider));
  program.addTrackedFiles([...uriById.values()]);
  const relOf = (uri: Uri): string => {
    const p = uri.getFilePath();
    const prefix = `${absRoot}/`;
    return p.startsWith(prefix) ? p.slice(prefix.length) : '';
  };
  return { program, uriById, relOf, dispose: () => program.dispose() };
}

/**
 * Extract ONE Python file: resolved internal import edges + external packages.
 * `calls` is left empty (import-only degrade — see the module header). Never
 * throws: a file Pyright can't parse/bind degrades to no edges rather than
 * failing the whole extraction (mirrors the ts-morph adapter's defensive posture).
 */
function extractFileRecord(
  fromId: string,
  imports: ReadonlyArray<PyImport>,
  absRoot: string,
  internalIds: ReadonlySet<string>,
  relOf: (uri: Uri) => string,
  roots: readonly string[],
  callTargets: ReadonlyMap<string, number>,
): FileRecord {
  const importWeights = new Map<string, number>();
  const externalWeights = new Map<string, { specifier: string; weight: number }>();

  const addInternal = (toId: string): void => {
    if (toId === fromId) return; // no self-edges
    if (!internalIds.has(toId)) return;
    importWeights.set(toId, (importWeights.get(toId) ?? 0) + 1);
  };

  for (const imp of imports) {
    const name = imp.importName;
    if (!name) continue;

    // The module/package named by the import clause = the last resolved uri
    // (Pyright returns the package chain; the leaf is the module). Plus every
    // SUBMODULE actually pulled in by `from pkg import submod` — Python `__init__`
    // files are usually empty (unlike TS barrels), so without these the real
    // dependency on `submod` would be lost.
    const internalTargets: string[] = [];
    if (imp.isImportFound && imp.importType === IMPORT_TYPE_LOCAL) {
      if (imp.resolvedUris.length) {
        const leaf = relOf(imp.resolvedUris[imp.resolvedUris.length - 1]);
        if (leaf) internalTargets.push(leaf);
      }
      for (const uri of imp.implicitSubmoduleUris) {
        const id = relOf(uri);
        if (id) internalTargets.push(id);
      }
    }

    if (internalTargets.length) {
      for (const id of internalTargets) addInternal(id);
      continue;
    }

    // Pyright resolved nothing internal → syntactic fallback (path-anchored).
    const fallback = syntacticResolve(name, fromId, internalIds, roots);
    if (fallback) {
      addInternal(fallback);
      continue;
    }

    // Genuinely unresolved. Relative-but-unresolved is a missing/dynamic
    // first-party import, NOT an external (mirrors the ts-morph relative-skip).
    // The leading dot in the module name is the authoritative signal — Pyright's
    // `isRelative` flag is unset when the relative import didn't resolve, so a
    // dangling `from .gone import x` would otherwise leak as `ext:gone`.
    if (imp.isRelative || name.startsWith('.')) continue;
    const top = topLevel(name);
    if (!top || PYTHON_STDLIB.has(top)) continue; // stdlib → substrate, dropped
    const ext = pythonExternalIdFor(name);
    const existing = externalWeights.get(ext.id);
    if (existing) existing.weight += 1;
    else externalWeights.set(ext.id, { specifier: ext.specifier, weight: 1 });
  }

  return {
    loc: locOf(`${absRoot}/${fromId}`),
    language: fromId.endsWith('.pyi') ? 'pyi' : 'py',
    imports: [...importWeights].map(([to, weight]) => ({ to, weight })),
    externals: [...externalWeights].map(([id, v]) => ({ id, specifier: v.specifier, weight: v.weight })),
    calls: [...callTargets].map(([to, weight]) => ({ to, weight })),
    reexports: [],
  };
}

// ---------------------------------------------------------------------------
// typed call edges (best-effort). The ts-morph adapter's expensive
// half: resolve each call site's callee to its DECLARING in-repo file via
// Pyright's type evaluator (getDeclInfoForNameNode). This works with the CHECKER
// DISABLED — the evaluator resolves lazily on demand (including a method call
// through an inferred receiver type), so we get typed call edges WITHOUT the
// full-check cost (staying inside the container watchdog budget). Every
// resolution is wrapped defensively: an unresolvable / erroring call degrades to
// no edge (mirrors the ts-morph extractFileCalls try/catch — import-only fallback).

// Pinned ParseNodeType values (parseNodes.js const enum — Call=9, MemberAccess=35,
// Name=38). Kept LOCAL (the graph layer must not import the framework's py-ast).
const NODE_CALL = 9;
const NODE_MEMBER_ACCESS = 35;
const NODE_NAME = 38;

// The single evaluator method this adapter needs (a decoupling shim over the
// pyright TypeEvaluator, whose deep type we don't want to import).
interface DeclResolver {
  getDeclInfoForNameNode(node: ParseNode): { decls: Array<{ uri: Uri }> } | undefined;
}

// A DETERMINISTIC per-file bound on call-site type-eval, so a pathological
// god-file (thousands of calls) can't blow the container watchdog. Set high
// enough that no ordinary file is capped; a capped file is LOGGED (no silent
// caps), and the whole file degrades to import-only (call resolution is
// best-effort). A time budget would break snapshot determinism, so we bound by
// count in the (stable) tree order instead.
const MAX_CALL_SITES_PER_FILE = 2500;

// Every CallNode in a module (recursive — nested calls count).
function collectCallNodes(tree: ModuleNode): CallNode[] {
  const out: CallNode[] = [];
  class Walker extends ParseTreeWalker {
    override visitCall(node: CallNode): boolean {
      out.push(node);
      return true;
    }
  }
  new Walker().walk(tree);
  return out;
}

// The callee NAME node of a call: `foo(...)` → `foo`; `obj.method(...)` → `method`.
// A more complex callee (a subscript / a call result) → undefined (skipped).
function calleeNameNode(call: CallNode): ParseNode | undefined {
  const callee = call.d.leftExpr as ParseNode;
  if (callee.nodeType === NODE_CALL) return undefined; // chained call result
  if (callee.nodeType === NODE_NAME) return callee;
  if (callee.nodeType === NODE_MEMBER_ACCESS) {
    return (callee as unknown as { d: { member: ParseNode } }).d.member;
  }
  return undefined;
}

/**
 * The internal call-edge targets (target file id → weight) for one file: each
 * call site's callee resolved to its declaring in-repo file. Never throws — a
 * single unresolvable call is skipped, and a broken evaluator degrades the whole
 * file to no call edges. Self-calls (same file) + external/stdlib targets are
 * dropped; a call resolving to several decls in ONE file counts once.
 */
export function extractCallTargets(
  fromId: string,
  tree: ModuleNode,
  evaluator: DeclResolver,
  internalIds: ReadonlySet<string>,
  relOf: (uri: Uri) => string,
): Map<string, number> {
  const weights = new Map<string, number>();
  const calls = collectCallNodes(tree);
  if (calls.length > MAX_CALL_SITES_PER_FILE) {
    // A god-file — bounding call-edge extraction to protect the watchdog. Degrade
    // to import-only for it (deterministic + logged; the module is one box anyway).
    console.log(
      `  [python] ${fromId}: ${calls.length} call sites exceed the ${MAX_CALL_SITES_PER_FILE} cap — call edges skipped for this file (import-only)`,
    );
    return weights;
  }
  for (const call of calls) {
    try {
      const nameNode = calleeNameNode(call);
      if (!nameNode) continue;
      const info = evaluator.getDeclInfoForNameNode(nameNode);
      if (!info) continue;
      const targets = new Set<string>();
      for (const decl of info.decls) {
        const toId = relOf(decl.uri);
        if (toId && toId !== fromId && internalIds.has(toId)) targets.add(toId);
      }
      for (const t of targets) weights.set(t, (weights.get(t) ?? 0) + 1);
    } catch {
      // this call site failed to resolve — skip it (import-only degrade).
    }
  }
  return weights;
}

/** The subset of a Pyright ImportResult this adapter reads (decoupling shim). */
interface PyImport {
  importName: string;
  isImportFound: boolean;
  isRelative: boolean;
  importType: number;
  resolvedUris: Uri[];
  implicitSubmoduleUris: Uri[];
}

export class PythonExtractor implements GraphExtractor {
  readonly language = 'python';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    const fileIds = listSourceFiles(root, 'python');
    const internalIds = new Set(fileIds);
    // the first-party source roots (defaults + inferred nested package
    // roots), so a `backend/app/` package resolves when the whole repo is the root.
    const roots = inferSourceRoots(internalIds);
    const files: Record<string, FileRecord> = {};

    if (fileIds.length === 0) {
      return graphFromState(root, { headSha: '', files });
    }

    const { program, uriById, relOf, dispose } = buildProgram(root, fileIds);
    try {
      for (const id of fileIds) {
        const uri = uriById.get(id)!;
        let imports: PyImport[] = [];
        let callTargets = new Map<string, number>();
        try {
          const sf = program.getBoundSourceFile(uri);
          imports = (sf?.getImports() ?? []).map((imp) => ({
            importName: imp.importName,
            isImportFound: imp.isImportFound,
            isRelative: imp.isRelative,
            importType: imp.importType as number,
            resolvedUris: imp.resolvedUris,
            implicitSubmoduleUris: imp.filteredImplicitImports
              ? [...imp.filteredImplicitImports.values()].map((v) => v.uri)
              : [],
          }));
          // typed call edges (best-effort; degrades to none on error).
          const tree = sf?.getParserOutput()?.parseTree;
          if (tree && program.evaluator) {
            callTargets = extractCallTargets(
              id,
              tree,
              program.evaluator as unknown as DeclResolver,
              internalIds,
              relOf,
            );
          }
        } catch {
          // parse/bind failed for this file — import-only degrade to no edges.
          imports = [];
          callTargets = new Map();
        }
        files[id] = extractFileRecord(id, imports, root, internalIds, relOf, roots, callTargets);
      }
    } finally {
      dispose();
    }

    // headSha is irrelevant for a one-shot batch extract; graphFromState only
    // reads the per-file records.
    const state: FileGraphState = { headSha: '', files };
    return graphFromState(root, state);
  }
}
