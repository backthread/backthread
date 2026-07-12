// Shared Ruby framework-adapter core — the analogue of framework/python/analyze.ts.
// The reusable setup every Ruby adapter runs first: parse each in-scope Ruby file
// ONCE (classes + calls pre-collected, no re-parse), expose the Zeitwerk
// constant<->file resolver, and read the repo's declared gems. All install-free +
// deterministic (pure syntactic Prism parse; never executes repo code).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildConstantIndex, resolveConstant } from '../../graph/ruby-zeitwerk.js';
import {
  collectCalls,
  collectClasses,
  getRubyParser,
  parseRubyTree,
  type RubyClass,
} from './ruby-ast.js';
import type { CallNode, Node } from '@ruby/prism';
import type { FrameworkContext } from '../types.js';

/** A Ruby source file (module or script). */
export function isRubyFile(language: string): boolean {
  return language === 'rb';
}

/** Is `fileId` within the adapter's matched root (rootPath '' = whole repo)? */
export function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

/**
 * The Zeitwerk constant-name -> file-id map (+ the autoload roots) the framework
 * adapters share — the cross-module resolver a Rails/ActiveRecord/Sidekiq adapter
 * uses to turn a referenced constant (a model, a controller, a job) into the file
 * that defines it. Wraps the extractor's buildConstantIndex so both the import
 * graph and the framework layer resolve constants identically.
 */
export function buildConstantBindings(fileIds: readonly string[]): {
  index: Map<string, string>;
  roots: string[];
} {
  return buildConstantIndex(fileIds);
}

/** One in-scope Ruby file: its AST root + pre-collected classes and calls. */
export interface ParsedRubyFile {
  node: Node;
  classes: RubyClass[];
  calls: CallNode[];
}

/** The parsed in-scope Ruby surface an adapter analyzes. */
export interface RubyScope {
  /** In-scope Ruby file ids (from the graph, post-noise-filter). */
  rbFiles: string[];
  /** The resolution id set (all in-scope Ruby files). */
  internalIds: ReadonlySet<string>;
  /** Zeitwerk constant-name -> file-id index. */
  constIndex: ReadonlyMap<string, string>;
  /** Inferred autoload roots. */
  roots: readonly string[];
  /** fileId -> parsed AST + collected classes/calls (unparseable files omitted). */
  parsed: Map<string, ParsedRubyFile>;
  /** Resolve a constant reference to its defining file, honoring lexical nesting. */
  resolve(ref: string, nesting?: readonly string[]): string | undefined;
}

/**
 * Parse every in-scope Ruby file once and pre-collect its classes + calls — the
 * common first step of every Ruby framework adapter's analysis. Async ONLY because
 * the Prism parser loads its WASI module once up front; each file is then parsed
 * synchronously. Reads source server-side (never-store-source); a file that can't
 * be read/parsed is skipped.
 */
export async function parseRubyScope(ctx: FrameworkContext): Promise<RubyScope> {
  const { repoDir, rootPath, graph } = ctx;
  const rbFiles = graph.files
    .filter((f) => isRubyFile(f.language) && inScope(f.id, rootPath))
    .map((f) => f.id);
  const internalIds = new Set(rbFiles);
  const { index, roots } = buildConstantIndex(rbFiles);

  const parsed = new Map<string, ParsedRubyFile>();
  const parse = await getRubyParser();
  for (const id of rbFiles) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, id), 'utf8');
    } catch {
      continue;
    }
    const node = parseRubyTree(parse, text);
    if (!node) continue;
    parsed.set(id, { node, classes: collectClasses(node), calls: collectCalls(node) });
  }

  return {
    rbFiles,
    internalIds,
    constIndex: index,
    roots,
    parsed,
    resolve: (ref, nesting = []) => resolveConstant(ref, nesting, index),
  };
}
