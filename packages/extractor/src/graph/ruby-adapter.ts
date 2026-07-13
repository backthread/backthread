// Ruby structural extractor — the Prism-driven GraphExtractor for Ruby repos.
//
// Mirrors the ts-morph (TS) and Pyright (Python) adapters: emit FileRecords, hand
// them to the shared graphFromState assembler, and let everything downstream
// (Louvain, subsystem/domain grouping, the whole enrich stage) consume the
// identical NormalizedGraph unchanged.
//
// INSTALL-FREE + PURE-STATIC by construction — Prism (@ruby/prism) is the official
// Ruby parser compiled to WASM (pure JS + a WASI module); it never executes repo
// code (no `ruby` subprocess, no gem install, no bundler), so it runs identically
// local + in the destroy-on-exit container.
//
// The import backbone has two sources:
//   * Zeitwerk autoloading (the Rails/gem default) — a constant REFERENCE resolves
//     to the file that defines it via the file<->constant convention (ruby-zeitwerk).
//     This carries the graph: Rails app code references `User`, not `require`s it.
//   * require / require_relative — an explicit first-party edge when the target is
//     an in-repo file, else an external `ext:<gem>` node (stdlib names dropped).
//
// No CALL edges in v1 (dynamic dispatch makes them weak; import edges alone give a
// legible Map — the same import-first stance the Python adapter shipped with). A
// file Prism can't parse degrades to a node with no edges (never sinks the extract).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadPrism,
  CallNode,
  ClassNode,
  ConstantPathNode,
  ConstantReadNode,
  ModuleNode,
  StringNode,
} from '@ruby/prism';
import type { Node } from '@ruby/prism';
import type { GraphExtractor, NormalizedGraph } from './types.js';
import { graphFromState, type FileRecord } from './file-graph.js';
import { listSourceFiles } from './language.js';
import { buildConstantIndex, joinRelative, resolveConstant } from './ruby-zeitwerk.js';
import { readInflections } from './ruby-inflect.js';
import { RUBY_STDLIB } from './ruby-stdlib.js';

// The Prism WASM parser is loaded once per process and reused for every file +
// every repo (loadPrism instantiates the WASI module — do it lazily + once).
let prismParse: ReturnType<typeof loadPrism> | undefined;
function getPrism(): ReturnType<typeof loadPrism> {
  return (prismParse ??= loadPrism());
}

/** The line-of-code count for one source file (a size/centrality signal). */
function locOf(absPath: string): number {
  try {
    const text = readFileSync(absPath, 'utf8');
    if (text.length === 0) return 0;
    return text.split('\n').length;
  } catch {
    return 0;
  }
}

function emptyRecord(loc: number): FileRecord {
  return { loc, language: 'rb', imports: [], externals: [], calls: [], reexports: [] };
}

/** The dotted constant name a ConstantRead/ConstantPath node denotes
 *  (`User`, `Payment::Charge`), or undefined for a non-constant / anonymous path. */
function constantFullName(node: Node | null): string | undefined {
  if (!node) return undefined;
  if (node instanceof ConstantReadNode) return node.name;
  if (node instanceof ConstantPathNode) {
    const child = node.name; // string | null (null for a dynamic path part)
    if (!child) return undefined;
    if (!node.parent) return child; // `::Foo` — top-level anchored
    const parent = constantFullName(node.parent);
    return parent ? `${parent}::${child}` : child;
  }
  return undefined;
}

interface CollectedRefs {
  /** Constant references + the lexical module/class nesting they appear in. */
  refs: Array<{ name: string; nesting: string[] }>;
  /** require / require_relative string literals. */
  requires: Array<{ kind: 'require' | 'require_relative'; path: string }>;
}

/**
 * Walk one file's AST, collecting constant references (with their lexical nesting,
 * for Ruby's scope-aware resolution) and require/require_relative literals. A
 * module/class's OWN name path is NOT a reference (it's a definition); its
 * superclass and body ARE. A constant path is recorded whole (not descended into).
 */
function collectFileRefs(rootNode: Node): CollectedRefs {
  const refs: CollectedRefs['refs'] = [];
  const requires: CollectedRefs['requires'] = [];

  const visit = (node: Node | null, nesting: string[]): void => {
    if (!node) return;

    if (node instanceof ModuleNode || node instanceof ClassNode) {
      const defName = constantFullName(node.constantPath);
      if (node instanceof ClassNode && node.superclass) visit(node.superclass, nesting);
      const inner = defName ? [...nesting, ...defName.split('::')] : nesting;
      visit(node.body, inner);
      return;
    }

    if (node instanceof ConstantReadNode || node instanceof ConstantPathNode) {
      const name = constantFullName(node);
      if (name) refs.push({ name, nesting: [...nesting] });
      return; // the path's internal parts are part of THIS reference — don't recurse
    }

    if (node instanceof CallNode) {
      if (!node.receiver && (node.name === 'require' || node.name === 'require_relative')) {
        const arg = node.arguments_?.arguments_?.[0];
        if (arg instanceof StringNode) {
          const val = arg.unescaped?.value;
          if (val) requires.push({ kind: node.name, path: val });
        }
      }
      for (const child of node.compactChildNodes()) visit(child, nesting);
      return;
    }

    for (const child of node.compactChildNodes()) visit(child, nesting);
  };

  visit(rootNode, []);
  return { refs, requires };
}

/** Resolve `require_relative 'x'` against the requiring file's dir -> in-repo id. */
function resolveRequireRelative(
  fromId: string,
  relPath: string,
  fileset: ReadonlySet<string>,
): string | undefined {
  const fromDir = fromId.includes('/') ? fromId.slice(0, fromId.lastIndexOf('/')) : '';
  const joined = joinRelative(fromDir, relPath);
  for (const cand of [`${joined}.rb`, joined]) if (fileset.has(cand)) return cand;
  return undefined;
}

/** Resolve `require 'my_gem/foo'` to an in-repo file via the autoload roots (each
 *  is on the effective $LOAD_PATH), or undefined when it's a third-party gem. */
function resolveRequireFirstParty(
  name: string,
  roots: readonly string[],
  fileset: ReadonlySet<string>,
): string | undefined {
  for (const root of roots) {
    const cand = `${root}/${name}.rb`;
    if (fileset.has(cand)) return cand;
  }
  const bare = `${name}.rb`;
  return fileset.has(bare) ? bare : undefined;
}

export class RubyExtractor implements GraphExtractor {
  readonly language = 'ruby';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    const fileIds = listSourceFiles(root, 'ruby');
    if (fileIds.length === 0) return graphFromState(root, { headSha: '', files: {} });

    const fileset = new Set(fileIds);
    // Acronym-aware constant index — with the repo's `inflect.acronym` rules a
    // referenced `ActivityPub::TagManager` resolves to activitypub/tag_manager.rb.
    const inflections = readInflections(root, fileIds);
    const { index: constIndex, roots } = buildConstantIndex(fileIds, inflections);
    const parse = await getPrism();

    const files: Record<string, FileRecord> = {};
    for (const id of fileIds) {
      const abs = `${root}/${id}`;
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        files[id] = emptyRecord(0);
        continue;
      }

      let collected: CollectedRefs;
      try {
        collected = collectFileRefs(parse(text).value);
      } catch {
        files[id] = emptyRecord(locOf(abs)); // Prism failed on this file — node only
        continue;
      }

      const importWeights = new Map<string, number>();
      const externalWeights = new Map<string, { specifier: string; weight: number }>();
      const addImport = (to: string): void => {
        if (to === id) return; // no self-edges
        importWeights.set(to, (importWeights.get(to) ?? 0) + 1);
      };

      // (1) Zeitwerk constant references -> first-party edges.
      for (const ref of collected.refs) {
        const target = resolveConstant(ref.name, ref.nesting, constIndex);
        if (target) addImport(target);
      }

      // (2) require / require_relative.
      for (const req of collected.requires) {
        if (req.kind === 'require_relative') {
          const t = resolveRequireRelative(id, req.path, fileset);
          if (t) addImport(t);
          continue;
        }
        const fp = resolveRequireFirstParty(req.path, roots, fileset);
        if (fp) {
          addImport(fp);
          continue;
        }
        // Third-party gem -> external node (top-level require segment; stdlib dropped).
        const top = req.path.split('/')[0];
        if (top && top !== '.' && top !== '..' && !RUBY_STDLIB.has(top.toLowerCase())) {
          const key = `ext:${top}`;
          const ex = externalWeights.get(key);
          if (ex) ex.weight += 1;
          else externalWeights.set(key, { specifier: top, weight: 1 });
        }
      }

      files[id] = {
        loc: locOf(abs),
        language: 'rb',
        imports: [...importWeights].map(([to, weight]) => ({ to, weight })),
        externals: [...externalWeights].map(([extId, v]) => ({
          id: extId,
          specifier: v.specifier,
          weight: v.weight,
        })),
        calls: [],
        reexports: [],
      };
    }

    return graphFromState(root, { headSha: '', files });
  }
}
