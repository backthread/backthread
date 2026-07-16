// Shared PHP framework-adapter core — the analogue of framework/ruby/analyze.ts.
// The reusable setup every PHP adapter runs first: parse each in-scope PHP file
// ONCE (classes + calls + use-scope pre-collected, no re-parse), expose the
// PSR-4 FQN→file resolver, and read the repo's declared Composer packages. All
// install-free + deterministic (pure syntactic php-parser parse; never executes
// repo code).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readComposerJson } from '../../graph/php-manifest.js';
import {
  parsePsr4Map,
  parsePsr0Map,
  resolveAutoload,
  normalizeFqn,
  type Psr4Entry,
  type Psr0Entry,
} from '../../graph/php-psr4.js';
import {
  collectCalls,
  collectClasses,
  collectUseMap,
  getPhpEngine,
  parsePhpTree,
  resolveRefToFqn,
  type PhpClass,
} from './php-ast.js';
import type { Node, Program } from 'php-parser';
import type { FrameworkContext } from '../types.js';

/** A PHP source file. */
export function isPhpFile(language: string): boolean {
  return language === 'php';
}

/** Is `fileId` within the adapter's matched root (rootPath '' = whole repo)? */
export function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

/**
 * The autoload FQN→file resolver the framework adapters share — the cross-module
 * resolver a Laravel/Symfony/ORM/async adapter uses to turn a referenced class
 * (a controller, a model, a job) into the file that defines it. Wraps the
 * extractor's parsePsr4Map/parsePsr0Map + resolveAutoload so the import graph and
 * the framework layer resolve classes identically (PSR-4 → PSR-0; the declared-
 * class-index tier is layered on top in parsePhpScope, which resolves its own
 * classToFile first). PURE of parsing (path/map only) — mirrors Ruby's
 * buildConstantBindings.
 */
export function buildPhpBindings(
  repoDir: string,
  fileIds: readonly string[],
): {
  psr4: Psr4Entry[];
  psr0: Psr0Entry[];
  fileset: ReadonlySet<string>;
  resolve(fqn: string): string | undefined;
} {
  const composer = readComposerJson(repoDir);
  const psr4 = parsePsr4Map(composer);
  const psr0 = parsePsr0Map(composer);
  const fileset = new Set(fileIds);
  return { psr4, psr0, fileset, resolve: (fqn) => resolveAutoload(fqn, psr4, psr0, fileset) };
}

/** One in-scope PHP file: its Program root + pre-collected classes, calls, use-scope. */
export interface ParsedPhpFile {
  node: Program;
  classes: PhpClass[];
  calls: Node[];
  /** alias (or trailing segment) → imported FQN — the file's `use` scope. */
  useMap: Map<string, string>;
  /** The file's namespace (`` for the global namespace) — first class's, else ''. */
  namespace: string;
}

/** The parsed in-scope PHP surface an adapter analyzes. */
export interface PhpScope {
  /** In-scope PHP file ids (from the graph, post-noise-filter). */
  phpFiles: string[];
  /** The resolution id set (all in-scope PHP files). */
  internalIds: ReadonlySet<string>;
  /** The composer.json PSR-4 entries (longest-prefix-first). */
  psr4: Psr4Entry[];
  /** class FQN → defining file id (every declared class/interface/trait/enum). */
  classToFile: ReadonlyMap<string, string>;
  /** fileId → parsed Program + collected classes/calls/use-scope (unparseable omitted). */
  parsed: Map<string, ParsedPhpFile>;
  /** Resolve a class FQN to its defining file: the parsed class index first (most
   *  reliable — the real declaring file), then the PSR-4 map. */
  resolve(fqn: string): string | undefined;
  /** Resolve a WRITTEN reference (short/qualified) in a file's scope → file id. */
  resolveRef(raw: string, useMap: ReadonlyMap<string, string>, ns: string): string | undefined;
}

/**
 * Parse every in-scope PHP file once and pre-collect its classes + calls +
 * use-scope — the common first step of every PHP framework adapter's analysis.
 * Reads source server-side (never-store-source); a file that can't be read/parsed
 * is skipped. Synchronous parsing (php-parser is pure-JS, no async load), but the
 * signature is async to match the FrameworkAdapter hook contract + the other
 * language scopes.
 */
export async function parsePhpScope(ctx: FrameworkContext): Promise<PhpScope> {
  const { repoDir, rootPath, graph } = ctx;
  const phpFiles = graph.files
    .filter((f) => isPhpFile(f.language) && inScope(f.id, rootPath))
    .map((f) => f.id);
  const internalIds = new Set(phpFiles);
  const { psr4, resolve: autoloadResolve } = buildPhpBindings(repoDir, phpFiles);

  const engine = getPhpEngine();
  const parsed = new Map<string, ParsedPhpFile>();
  const classToFile = new Map<string, string>();
  for (const id of phpFiles) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, id), 'utf8');
    } catch {
      continue;
    }
    const node = parsePhpTree(engine, text);
    if (!node) continue;
    const classes = collectClasses(node);
    parsed.set(id, {
      node,
      classes,
      calls: collectCalls(node),
      useMap: collectUseMap(node),
      namespace: classes[0]?.namespace ?? '',
    });
    for (const c of classes) if (!classToFile.has(c.fqn)) classToFile.set(c.fqn, id);
  }

  const resolve = (fqn: string): string | undefined => {
    const clean = normalizeFqn(fqn);
    // The parsed declared-class index first (the ground truth — the real declaring
    // file), then the autoload map (PSR-4 → PSR-0).
    return classToFile.get(clean) ?? autoloadResolve(fqn);
  };

  return {
    phpFiles,
    internalIds,
    psr4,
    classToFile,
    parsed,
    resolve,
    resolveRef: (raw, useMap, ns) => resolve(resolveRefToFqn(raw, useMap, ns)),
  };
}
