// Shared Elixir framework-adapter core — the analogue of framework/ruby/analyze.ts.
// The reusable setup every Elixir adapter runs first: scan each in-scope Elixir file
// ONCE (modules, use/directives, macro calls, attributes, defs pre-collected), and
// expose the module-name -> file-id resolver. All install-free + deterministic (the
// hand-rolled syntactic scanner; never executes repo code). Synchronous — unlike the
// Ruby layer there is no parser WASM to load.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  moduleNames,
  useDirectives,
  macroCalls,
  moduleAttributes,
  defCalls,
  scanDirectives,
  type ElixirUse,
  type ElixirMacroCall,
  type ElixirModuleAttribute,
  type ElixirDef,
  type ElixirDirective,
} from './elixir-ast.js';
import { readMixDeps } from '../../graph/elixir-manifest.js';
import type { FrameworkContext } from '../types.js';

export { readMixDeps };

const ELIXIR_LANGS = new Set(['ex', 'exs', 'eex', 'heex', 'leex']);

/** An Elixir source file (module, script, or template). */
export function isElixirFile(language: string): boolean {
  return ELIXIR_LANGS.has(language);
}

/** Is `fileId` within the adapter's matched root (rootPath '' = whole repo)? */
export function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

/**
 * The module-name -> file-id resolver the framework adapters share — the
 * cross-module registry that turns a referenced module (a schema, a controller, a
 * worker) into the file that defines it. First (sorted-id) definition wins a
 * duplicate, mirroring the import extractor's registry so both resolve identically.
 */
export function buildModuleBindings(fileTexts: ReadonlyMap<string, string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const id of [...fileTexts.keys()].sort()) {
    for (const mod of moduleNames(fileTexts.get(id) ?? '')) {
      if (!index.has(mod)) index.set(mod, id);
    }
  }
  return index;
}

/** One in-scope Elixir file, fully pre-scanned. */
export interface ParsedElixirFile {
  text: string;
  modules: string[];
  uses: ElixirUse[];
  directives: ElixirDirective[];
  macroCalls: ElixirMacroCall[];
  attributes: ElixirModuleAttribute[];
  defs: ElixirDef[];
}

/** The parsed in-scope Elixir surface an adapter analyzes. */
export interface ElixirScope {
  /** In-scope Elixir file ids (from the graph, post-noise-filter). */
  exFiles: string[];
  /** The resolution id set (all in-scope Elixir files). */
  internalIds: ReadonlySet<string>;
  /** module-name -> file-id index. */
  moduleIndex: ReadonlyMap<string, string>;
  /** fileId -> its pre-scanned surface (unreadable files omitted). */
  parsed: Map<string, ParsedElixirFile>;
  /** Resolve a module name to its defining file id. */
  resolve(moduleName: string): string | undefined;
}

/**
 * Scan every in-scope Elixir file once and pre-collect its surface — the common
 * first step of every Elixir framework adapter's analysis. Reads source
 * server-side (never-store-source); a file that can't be read is skipped.
 */
export function parseElixirScope(ctx: FrameworkContext): ElixirScope {
  const { repoDir, rootPath, graph } = ctx;
  const exFiles = graph.files
    .filter((f) => isElixirFile(f.language) && inScope(f.id, rootPath))
    .map((f) => f.id);
  const internalIds = new Set(exFiles);

  const texts = new Map<string, string>();
  for (const id of exFiles) {
    try {
      texts.set(id, readFileSync(join(repoDir, id), 'utf8'));
    } catch {
      // unreadable — skip (omitted from the parsed map).
    }
  }

  const moduleIndex = buildModuleBindings(texts);
  const parsed = new Map<string, ParsedElixirFile>();
  for (const [id, text] of texts) {
    parsed.set(id, {
      text,
      modules: moduleNames(text),
      uses: useDirectives(text),
      directives: scanDirectives(text),
      macroCalls: macroCalls(text),
      attributes: moduleAttributes(text),
      defs: defCalls(text),
    });
  }

  return {
    exFiles,
    internalIds,
    moduleIndex,
    parsed,
    resolve: (mod) => moduleIndex.get(mod),
  };
}
