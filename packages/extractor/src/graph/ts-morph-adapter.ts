// ts-morph (TS compiler API) extractor (/325) — the P3 structural adapter.
//
// INSTALL-FREE by design: we never `npm install` the target repo. Internal
// imports/calls resolve from SOURCE (the clone's own files + its tsconfig
// paths/baseUrl); anything that doesn't resolve internally is a bare specifier
// → an EXTERNAL node. This is both a feature (we want externals as nodes, not
// resolved into node_modules) and a safety property (no untrusted postinstall
// scripts run). Plain-JS repos (no tsconfig) are handled with sane defaults.
//
// Stage A: the per-file extraction is factored into exported helpers
// (buildExtractionProject / addAllSourceFiles / extractFileRecord) shared with
// the diff-driven incremental engine (incremental.ts), so the batch and
// incremental paths CANNOT drift — both produce FileRecords and assemble the
// NormalizedGraph through graphFromState. The equivalence fixture test guards
// this (full extract vs seed+patches must be identical).

import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve, dirname } from 'node:path';
import { isBuiltin } from 'node:module';
import {
  Project,
  SyntaxKind,
  ModuleResolutionKind,
  ModuleKind,
  ScriptTarget,
  type SourceFile,
  type Node,
} from 'ts-morph';
import { externalIdFor, isRelativeSpecifier, type GraphExtractor, type NormalizedGraph } from './types.js';
import {
  graphFromState,
  SOURCE_EXTENSIONS,
  EXCLUDE_DIRS,
  type FileRecord,
} from './file-graph.js';

export function toId(root: string, absPath: string): string {
  return relative(root, absPath).split(/[\\/]/).join('/');
}

function languageOf(path: string): string {
  const m = path.match(/\.([cm]?[tj]sx?)$/);
  return m ? m[1] : 'ts';
}

/**
 * Read + JSONC-parse the nearest tsconfig/jsconfig in `repoDir`, returning the
 * config dir plus its raw compilerOptions baseUrl/paths — or undefined if none
 * of the candidates declares either.
 *
 * tsconfig is JSONC, NOT strict JSON: it permits `//` + block comments AND
 * trailing commas. A plain `JSON.parse` THROWS on a trailing comma, which
 * silently dropped EVERY path alias on the very common real-world shape (e.g.
 * Bluesky's `"paths": { "#/*": ["./src/*"], }`). We strip comments
 * AND trailing commas before parsing. We do NOT follow `extends` chains (a
 * deliberate non-goal — `paths` lives in the root tsconfig in practice; an
 * inherited-only paths block degrades to no aliasing rather than misfiring).
 * The FIRST candidate that declares baseUrl||paths wins (the config the TS
 * compiler itself would load); a malformed candidate is skipped.
 *
 * Exported so the framework adapters (React-Native's alias reader) consume the
 * SAME comment/comma tolerance — the central resolver and the adapters cannot
 * drift on what counts as a parseable tsconfig.
 */
export function readTsconfigCompilerOptions(repoDir: string):
  | { dir: string; baseUrl?: string; paths?: Record<string, string[]> }
  | undefined {
  for (const name of ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json']) {
    const p = resolve(repoDir, name);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '') // /* block comments */
        .replace(/(^|[^:])\/\/.*$/gm, '$1') // // line comments (not the // in a URL)
        .replace(/,(\s*[}\]])/g, '$1'); // trailing commas (JSONC allows; JSON.parse doesn't)
      const json = JSON.parse(raw) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const co = json.compilerOptions ?? {};
      if (co.baseUrl || co.paths) {
        return { dir: dirname(p), baseUrl: co.baseUrl, paths: co.paths };
      }
    } catch {
      // Malformed candidate — try the next name, else fall through to undefined.
    }
  }
  return undefined;
}

// Lightweight tsconfig read for path-alias resolution feeding the in-memory
// extraction Project. Returns the ABSOLUTE baseUrl + alias paths.
//
// when `paths` is declared with NO `baseUrl`, the relative `./src/*`
// targets must anchor on the tsconfig's OWN directory (the TS ≥4.1 implicit
// base). An on-disk tsconfig gives the compiler that location for free; our
// in-memory Project (compilerOptions only, no tsconfig path) does NOT, so
// ts-morph mis-anchors the relative target and every aliased internal import
// silently falls out as an EXTERNAL node — under-connecting the graph. We set
// baseUrl to the config dir explicitly to recover the standard semantics.
//
// We anchor ONLY when there are actual alias entries: an explicit `baseUrl`, or
// a NON-EMPTY `paths`. A bare `paths: {}` (no baseUrl) must stay baseUrl-less —
// setting one would switch on baseUrl-relative resolution of *bare* specifiers
// against the repo root (which TS ≥4.1 paths-without-baseUrl does NOT do), risking
// a genuine external being mis-resolved as internal.
function readTsconfigPaths(repoDir: string): {
  baseUrl?: string;
  paths?: Record<string, string[]>;
} {
  const co = readTsconfigCompilerOptions(repoDir);
  if (!co) return {};
  const hasAliases = co.paths != null && Object.keys(co.paths).length > 0;
  const baseUrl = co.baseUrl
    ? resolve(co.dir, co.baseUrl)
    : hasAliases
      ? co.dir // no baseUrl + non-empty paths → anchor on the tsconfig dir (TS ≥4.1)
      : undefined;
  return { baseUrl, paths: co.paths };
}

/**
 * Build the install-free extraction Project for `root` (tsconfig paths/baseUrl
 * read fresh — so a config-invalidator re-seed picks up resolution changes).
 * Resolution settings chosen to resolve BOTH extensionless and .js-suffixed
 * relative imports against .ts sources, plus tsconfig path aliases — without
 * any installed dependencies.
 */
export function buildExtractionProject(root: string): Project {
  const { baseUrl, paths } = readTsconfigPaths(root);
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      moduleResolution: ModuleResolutionKind.Bundler,
      module: ModuleKind.ESNext,
      target: ScriptTarget.ESNext,
      allowImportingTsExtensions: true,
      baseUrl,
      paths,
    },
  });
}

/** Add every source file under `root` to the project (the adapter's glob). */
export function addAllSourceFiles(project: Project, root: string): void {
  const includeGlobs = [`${root}/**/*.{${SOURCE_EXTENSIONS.join(',')}}`];
  const excludeGlobs = EXCLUDE_DIRS.map((d) => `!${root}/**/${d}/**`);
  project.addSourceFilesAtPaths([...includeGlobs, ...excludeGlobs]);
}

/**
 * Extract ONE file's CHEAP half: loc/language, resolved internal import +
 * re-export targets, and external packages — an AST walk of the top-level
 * declarations + module resolution, NO type-checker symbol work. `calls` is
 * left empty; extractFileCalls below fills it. The incremental engine uses
 * this pass alone for files whose imports must re-resolve but whose call
 * bindings provably didn't move.
 *
 * `internalIds` is the CURRENT tree's source-file id set — resolution outside
 * it (e.g. a stray .d.ts) is ignored, matching the original batch behavior.
 */
export function extractFileImportsRecord(
  sf: SourceFile,
  root: string,
  internalIds: ReadonlySet<string>,
): FileRecord {
  const fromId = toId(root, sf.getFilePath());
  const importWeights = new Map<string, number>();
  const externalWeights = new Map<string, { specifier: string; weight: number }>();
  const reexports = new Set<string>();

  // Static import/export declarations → import edges. Internal when the
  // specifier resolves to a project source file; bare unresolved specifier →
  // external node.
  const decls = [...sf.getImportDeclarations(), ...sf.getExportDeclarations()];
  for (const decl of decls) {
    const spec = decl.getModuleSpecifierValue();
    if (!spec) continue; // e.g. bare `export { x }` with no `from`
    const resolved = decl.getModuleSpecifierSourceFile();
    if (resolved) {
      const toId_ = toId(root, resolved.getFilePath());
      if (toId_ === fromId) continue; // ignore self-references
      if (internalIds.has(toId_)) {
        importWeights.set(toId_, (importWeights.get(toId_) ?? 0) + 1);
        // `export … from` — the re-export surface a change propagates through
        // (the incremental engine's dependents closure follows these).
        if (decl.getKind() === SyntaxKind.ExportDeclaration) reexports.add(toId_);
      }
      // resolved-but-outside-project (e.g. a .d.ts) → ignore
    } else if (!isRelativeSpecifier(spec) && !isBuiltin(spec)) {
      // Builtins shortcut ( / , fixes ): Node builtins
      // (`fs`, `node:fs`, `path`, `crypto`, …) are substrate, never diagram
      // nodes. Dropping them at the source means they never become a graph
      // external, never reach the LLM classifier, and never cost a token.
      // `isBuiltin` matches both the bare (`fs`) and `node:`-prefixed
      // (`node:fs`) forms, so the policy is uniform regardless of import style.
      const ext = externalIdFor(spec);
      const existing = externalWeights.get(ext.id);
      if (existing) existing.weight += 1;
      else externalWeights.set(ext.id, { specifier: ext.specifier, weight: 1 });
    }
    // unresolved relative specifier → skip (missing file / dynamic)
  }

  return {
    loc: sf.getEndLineNumber(),
    language: languageOf(fromId),
    imports: [...importWeights].map(([to, weight]) => ({ to, weight })),
    externals: [...externalWeights].map(([id, v]) => ({ id, specifier: v.specifier, weight: v.weight })),
    calls: [],
    reexports: [...reexports],
  };
}

/**
 * The EXPENSIVE half: best-effort typed call edges — resolve each call
 * target's symbol to its declaring source file via the type checker.
 * Internal-only (externals already captured via imports). Wrapped defensively
 * — without installed types some resolutions throw; we degrade to import-only
 * edges rather than fail the extraction.
 */
export function extractFileCalls(
  sf: SourceFile,
  root: string,
  internalIds: ReadonlySet<string>,
): FileRecord['calls'] {
  const callWeights = new Map<string, number>();
  try {
    // CallExpression (`foo()`, `obj.method()`) AND NewExpression (`new Foo()`).
    // adds instantiation: `new ServiceClass()` is a real
    // runtime dependency, stronger evidence than a bare import, and gives the
    // edge-kind LLM more non-import signal to label `calls` over coupling.
    // Both node kinds expose getExpression(); method dispatch on a typed
    // receiver resolves through the PropertyAccessExpression's symbol.
    const sites = [
      ...sf.getDescendantsOfKind(SyntaxKind.CallExpression),
      ...sf.getDescendantsOfKind(SyntaxKind.NewExpression),
    ];
    for (const site of sites) {
      const expr = site.getExpression();
      if (!expr) continue; // malformed `new` with no callee
      const sym = symbolOf(expr);
      const sdecls = sym?.getDeclarations() ?? [];
      for (const d of sdecls) {
        const declSf = d.getSourceFile();
        if (declSf === sf) continue;
        const toId_ = toId(root, declSf.getFilePath());
        if (internalIds.has(toId_)) callWeights.set(toId_, (callWeights.get(toId_) ?? 0) + 1);
      }
    }
  } catch {
    // resolution unavailable for this file — import edges still stand
  }
  return [...callWeights].map(([to, weight]) => ({ to, weight }));
}

/** Both halves: the complete per-file extraction (imports + calls). */
export function extractFileRecord(sf: SourceFile, root: string, internalIds: ReadonlySet<string>): FileRecord {
  const rec = extractFileImportsRecord(sf, root, internalIds);
  rec.calls = extractFileCalls(sf, root, internalIds);
  return rec;
}

function symbolOf(expr: Node) {
  try {
    return expr.getSymbol();
  } catch {
    return undefined;
  }
}

export class TsMorphExtractor implements GraphExtractor {
  readonly language = 'typescript';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    const project = buildExtractionProject(root);
    addAllSourceFiles(project, root);

    const sourceFiles = project.getSourceFiles();
    const internalIds = new Set<string>(sourceFiles.map((sf) => toId(root, sf.getFilePath())));

    const files: Record<string, FileRecord> = {};
    for (const sf of sourceFiles) {
      files[toId(root, sf.getFilePath())] = extractFileRecord(sf, root, internalIds);
    }

    // headSha is irrelevant for a one-shot batch extract; graphFromState only
    // reads the per-file records.
    return graphFromState(root, { headSha: '', files });
  }
}
