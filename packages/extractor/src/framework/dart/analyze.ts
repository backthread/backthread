// Shared Dart framework-adapter core — the analogue of framework/elixir/analyze.ts.
// The reusable setup every Dart adapter runs first: scan each in-scope Dart file ONCE
// (directives, class declarations, annotations, top-level functions pre-collected),
// and expose the class-name → file-id resolver the FL2/FL3/FL4 syntheticEdges hooks
// use to turn a referenced type (a widget, a Bloc, a schema) into the file that
// defines it. All install-free + deterministic (the hand-rolled comment-aware
// scanner; never executes repo code). Synchronous — like Elixir, no parser to load.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classDeclarations,
  annotationNames,
  topLevelFunctionNames,
  type DartClass,
} from './dart-ast.js';
import { scanDartDirectives, type DartDirectives } from '../../graph/dart-scan.js';
import { readPubDeps } from '../../graph/dart-manifest.js';
import type { FrameworkContext } from '../types.js';

export { readPubDeps };

/** A Dart source file. */
export function isDartFile(language: string): boolean {
  return language === 'dart';
}

/** Is `fileId` within the adapter's matched root (rootPath '' = whole repo)? */
export function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

/**
 * The class-name → file-id resolver the framework adapters share — the cross-module
 * registry that turns a referenced type (`BlocBuilder<Counter>` → `Counter`) into the
 * file defining it. Every class/mixin/enum/extension a file declares maps to that
 * file; first (sorted-id) definition wins a duplicate, mirroring the import
 * extractor's registry so both resolve identically.
 */
export function buildDartBindings(fileTexts: ReadonlyMap<string, string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const id of [...fileTexts.keys()].sort()) {
    for (const decl of classDeclarations(fileTexts.get(id) ?? '')) {
      if (decl.name && !index.has(decl.name)) index.set(decl.name, id);
    }
  }
  return index;
}

/** One in-scope Dart file, fully pre-scanned. */
export interface ParsedDartFile {
  text: string;
  directives: DartDirectives;
  classes: DartClass[];
  annotations: string[];
  functions: string[];
}

/** The parsed in-scope Dart surface an adapter analyzes. */
export interface DartScope {
  /** In-scope Dart file ids (from the graph, post-noise-filter). */
  dartFiles: string[];
  /** The resolution id set (all in-scope Dart files). */
  internalIds: ReadonlySet<string>;
  /** class-name → file-id index. */
  classIndex: ReadonlyMap<string, string>;
  /** fileId → its pre-scanned surface (unreadable files omitted). */
  parsed: Map<string, ParsedDartFile>;
  /** Resolve a class name to its defining file id. */
  resolve(className: string): string | undefined;
}

/**
 * Scan every in-scope Dart file once and pre-collect its surface — the common first
 * step of every Dart framework adapter's analysis. Reads source server-side
 * (never-store-source); a file that can't be read is skipped.
 */
export function parseDartScope(ctx: FrameworkContext): DartScope {
  const { repoDir, rootPath, graph } = ctx;
  const dartFiles = graph.files
    .filter((f) => isDartFile(f.language) && inScope(f.id, rootPath))
    .map((f) => f.id);
  const internalIds = new Set(dartFiles);

  const texts = new Map<string, string>();
  for (const id of dartFiles) {
    try {
      texts.set(id, readFileSync(join(repoDir, id), 'utf8'));
    } catch {
      // unreadable — skip (omitted from the parsed map).
    }
  }

  const classIndex = buildDartBindings(texts);
  const parsed = new Map<string, ParsedDartFile>();
  for (const [id, text] of texts) {
    parsed.set(id, {
      text,
      directives: scanDartDirectives(text),
      classes: classDeclarations(text),
      annotations: annotationNames(text),
      functions: topLevelFunctionNames(text),
    });
  }

  return {
    dartFiles,
    internalIds,
    classIndex,
    parsed,
    resolve: (name) => classIndex.get(name),
  };
}
