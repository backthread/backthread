// Shared Swift framework-adapter core — the analogue of framework/elixir/analyze.ts.
// The reusable setup every Swift adapter runs first: scan each in-scope Swift file
// ONCE (declarations, imports, properties pre-collected), and expose the
// type-name → file-id resolver (the cross-file registry that turns a referenced type
// — a model, a view, a controller — into the file that declares it). All install-free
// + deterministic (the hand-rolled syntactic scanner; never executes repo code).
// Synchronous — unlike the Ruby/Python layers there is no parser to load.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  typeDeclarations,
  properties,
  scanImports,
  type SwiftTypeDecl,
  type SwiftProperty,
} from './swift-ast.js';
import { readSwiftDeps, readSwiftTargets, type SwiftTarget } from '../../graph/swift-manifest.js';
import type { FrameworkContext } from '../types.js';

export { readSwiftDeps, readSwiftTargets };

/** A Swift source file (the one extension the scanner parses). */
export function isSwiftFile(language: string): boolean {
  return language === 'swift';
}

/** Is `fileId` within the adapter's matched root (rootPath '' = whole repo)? */
export function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

/**
 * The type-name → file-id resolver the framework adapters share — the cross-file
 * registry that turns a referenced type into its declaring file. Built from PRIMARY
 * declarations only (extensions extend a type declared elsewhere, so they are not
 * declarers); a name declared in ≥2 DIFFERENT files is AMBIGUOUS → omitted (accuracy
 * over recall, mirroring the import extractor's registry so both resolve identically).
 */
export function buildSwiftBindings(fileTexts: ReadonlyMap<string, string>): Map<string, string> {
  const declFiles = new Map<string, Set<string>>();
  for (const id of [...fileTexts.keys()].sort()) {
    for (const decl of typeDeclarations(fileTexts.get(id) ?? '')) {
      if (decl.kind === 'extension') continue;
      (declFiles.get(decl.name) ?? declFiles.set(decl.name, new Set()).get(decl.name)!).add(id);
    }
  }
  const index = new Map<string, string>();
  for (const [name, set] of declFiles) if (set.size === 1) index.set(name, [...set][0]);
  return index;
}

/** One in-scope Swift file, fully pre-scanned. */
export interface ParsedSwiftFile {
  text: string;
  decls: SwiftTypeDecl[];
  imports: string[];
  properties: SwiftProperty[];
}

/** The parsed in-scope Swift surface an adapter analyzes. */
export interface SwiftScope {
  /** In-scope Swift file ids (from the graph, post-noise-filter). */
  swiftFiles: string[];
  /** The resolution id set (all in-scope Swift files). */
  internalIds: ReadonlySet<string>;
  /** type-name → file-id index (unique primary declarations only). */
  typeIndex: ReadonlyMap<string, string>;
  /** fileId → its pre-scanned surface (unreadable files omitted). */
  parsed: Map<string, ParsedSwiftFile>;
  /** Resolve a type name to its declaring file id. */
  resolve(typeName: string): string | undefined;
}

/**
 * Scan every in-scope Swift file once and pre-collect its surface — the common first
 * step of every Swift framework adapter's analysis. Reads source server-side
 * (never-store-source); a file that can't be read is skipped.
 */
export function parseSwiftScope(ctx: FrameworkContext): SwiftScope {
  const { repoDir, rootPath, graph } = ctx;
  const swiftFiles = graph.files
    .filter((f) => isSwiftFile(f.language) && inScope(f.id, rootPath))
    .map((f) => f.id);
  const internalIds = new Set(swiftFiles);

  const texts = new Map<string, string>();
  for (const id of swiftFiles) {
    try {
      texts.set(id, readFileSync(join(repoDir, id), 'utf8'));
    } catch {
      // unreadable — skip (omitted from the parsed map).
    }
  }

  const typeIndex = buildSwiftBindings(texts);
  const parsed = new Map<string, ParsedSwiftFile>();
  for (const [id, text] of texts) {
    parsed.set(id, {
      text,
      decls: typeDeclarations(text),
      imports: scanImports(text),
      properties: properties(text),
    });
  }

  return {
    swiftFiles,
    internalIds,
    typeIndex,
    parsed,
    resolve: (name) => typeIndex.get(name),
  };
}

/** SwiftPM target = subsystem grouping helper: map file ids to their target dir. */
export function targetDirPrefix(target: SwiftTarget): string {
  return target.dir;
}
