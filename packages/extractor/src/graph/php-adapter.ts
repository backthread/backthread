// PHP structural extractor — the php-parser-driven GraphExtractor for PHP repos.
//
// Mirrors the ts-morph (TS), Pyright (Python), Prism (Ruby), and hand-rolled
// (Elixir) adapters: emit FileRecords, hand them to the shared graphFromState
// assembler, and let everything downstream (Louvain, subsystem/domain grouping,
// the whole enrich stage) consume the identical NormalizedGraph unchanged.
//
// INSTALL-FREE + PURE-STATIC by construction — php-parser (npm, pure-JS, zero
// runtime deps) builds a real AST from source text; it never executes repo code
// (no `php` subprocess, no `composer install`), so it runs identically local + in
// the destroy-on-exit container. Loaded LAZILY (this module is dynamically
// imported by extract.ts only for a PHP repo), so a TS/Python/Ruby/Elixir ingest
// never module-loads php-parser.
//
// The import backbone is the `use` statement, resolved via Composer's autoload map
// (the Zeitwerk analogue): PHP requires an explicit `use` to reference any class
// in another namespace, so `use` statements are COMPLETE for the architecturally
// load-bearing cross-boundary edges. Resolution tries each autoload strategy in
// turn — PSR-4 (the convention) → PSR-0 (the legacy convention) → a declared-class
// index (the classmap-equivalent, built by parsing every file's declared classes;
// it also recovers a first-party class that simply isn't at its PSR-4-conventional
// path). See graph/php-psr4.ts. Three reference sources feed it:
//   * `use` / grouped-`use` — resolve the imported FQN to its file (first-party
//     import edge) or to a vendor node (`ext:<TopSegment>`); the require analogue.
//   * class `extends` / `implements` + trait `use` (inside a class body) —
//     resolve the referenced class to a FIRST-PARTY file (recovers same-namespace
//     inheritance a `use` wouldn't carry); the constant-reference analogue.
//   * `require` / `include` string literals — a first-party file edge when the
//     literal resolves in-repo (most are `__DIR__ . '…'` expressions — skipped).
//
// Same-namespace no-`use` references are an accepted degrade (same PSR-4 dir →
// same subsystem anyway). No CALL edges in v1 (dynamic dispatch makes them weak;
// import edges alone give a legible Map — the import-first stance every prior
// language shipped with). A file php-parser can't parse degrades to a node with
// no edges (never sinks the extract).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PhpParser from 'php-parser';
import type { Program, Node } from 'php-parser';
import type { GraphExtractor, NormalizedGraph } from './types.js';
import { phpExternalIdFor } from './types.js';
import { graphFromState, type FileRecord } from './file-graph.js';
import { listSourceFiles } from './language.js';
import { readComposerJson } from './php-manifest.js';
import {
  parsePsr4Map,
  parsePsr0Map,
  resolveAutoload,
  normalizeFqn,
  type Psr4Entry,
  type Psr0Entry,
} from './php-psr4.js';
import { PHP_GLOBALS } from './php-stdlib.js';

// php-parser ships its Engine as a CommonJS default export, but its bundled
// types.d.ts omits the module export, so the default import isn't seen as
// constructable — cast once, here (the runtime value IS the Engine constructor).
type PhpEngine = { parseCode(buffer: string, filename: string): Program };
type PhpEngineCtor = new (options: unknown) => PhpEngine;
const Engine = PhpParser as unknown as PhpEngineCtor;

// One parser per process, reused for every file + repo. PHP 8.3 target so modern
// syntax (attributes, enums, readonly, first-class callables) parses; suppressErrors
// keeps a partially-invalid file from throwing (best-effort AST, degrade-not-throw).
let engine: PhpEngine | undefined;
function getEngine(): PhpEngine {
  return (engine ??= new Engine({
    parser: { extractDoc: false, suppressErrors: true, version: 803 },
    ast: { withPositions: false },
  }));
}

/** The line-of-code count for one source file (a size/centrality signal). */
function locOf(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

function emptyRecord(loc: number): FileRecord {
  return { loc, language: 'php', imports: [], externals: [], calls: [], reexports: [] };
}

// ---------------------------------------------------------------------------
// Reference collection.

interface UseRef {
  /** The imported fully-qualified name (no leading separator), e.g. App\Models\User. */
  fqn: string;
}

interface CollectedRefs {
  /** The file's namespace (`` for the global namespace). First one wins. */
  namespace: string;
  /** alias (or trailing segment) → imported FQN — the file's `use` scope. */
  useMap: Map<string, string>;
  /** Imported FQNs — the require analogue (first-party import OR vendor external). */
  uses: UseRef[];
  /** Class-reference names as WRITTEN (extends/implements/trait use) to resolve. */
  classRefs: string[];
  /** `require`/`include` string literals to resolve as relative first-party paths. */
  includes: string[];
  /** FQNs of the class/interface/trait/enum this file DECLARES (namespace-aware) —
   *  fed into the repo-wide declared-class→file index (the classmap analogue). */
  declaredClasses: string[];
}

/** The trailing segment of a `\`-separated FQN (`App\Models\User` → `User`). */
function lastSegment(fqn: string): string {
  const i = fqn.lastIndexOf('\\');
  return i >= 0 ? fqn.slice(i + 1) : fqn;
}

/** A `Name` node's written text (`.name`), or undefined for a non-name node. */
function nameText(node: unknown): string | undefined {
  if (node && typeof node === 'object') {
    const n = node as { kind?: string; name?: unknown };
    if ((n.kind === 'name' || n.kind === 'classreference') && typeof n.name === 'string') return n.name;
  }
  return undefined;
}

/** A declaration node's simple name (`class UserController` → `UserController`).
 *  php-parser gives `.name` as an `identifier` node or a bare string. */
function declName(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as { name?: unknown };
  if (typeof n.name === 'string') return n.name;
  const id = n.name as { kind?: string; name?: unknown } | undefined;
  if (id && id.kind === 'identifier' && typeof id.name === 'string') return id.name;
  return undefined;
}

/**
 * Walk one file's AST, collecting its namespace, `use` scope, class references,
 * and require/include literals. A `use` with `type: 'function' | 'const'` imports
 * a function/constant (not a class), so it's excluded from the class backbone.
 */
function collectFileRefs(program: Program): CollectedRefs {
  const out: CollectedRefs = {
    namespace: '',
    useMap: new Map(),
    uses: [],
    classRefs: [],
    includes: [],
    declaredClasses: [],
  };
  let namespaceSet = false;

  const addUse = (fqnRaw: string, alias: string | undefined, type: string | null): void => {
    if (type === 'function' || type === 'const') return; // not a class import
    const fqn = normalizeFqn(fqnRaw);
    if (!fqn) return;
    out.uses.push({ fqn });
    out.useMap.set(alias ?? lastSegment(fqn), fqn);
  };

  // ns is the enclosing namespace of the node (`` for the global namespace) — carried
  // so a declared class gets its true FQN even in a multi-namespace file.
  const visit = (node: Node | null | undefined, ns: string): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Node & Record<string, unknown>;
    switch (n.kind) {
      case 'namespace': {
        const inner = typeof n.name === 'string' ? normalizeFqn(n.name) : ns;
        if (!namespaceSet && typeof n.name === 'string') {
          out.namespace = inner;
          namespaceSet = true;
        }
        for (const child of (n.children as Node[]) ?? []) visit(child, inner);
        return;
      }
      case 'usegroup': {
        const groupPrefix = typeof n.name === 'string' && n.name ? `${normalizeFqn(n.name)}\\` : '';
        // The function/const marker of a `use function …` / `use const …` lives on
        // the GROUP node (item.type is null); read it here so those imports aren't
        // mistaken for class imports.
        const groupType = typeof n.type === 'string' ? n.type : null;
        const items = Array.isArray(n.items) ? n.items : [];
        for (const raw of items) {
          const it = raw as Record<string, unknown>;
          if (it.kind !== 'useitem' || typeof it.name !== 'string') continue;
          const aliasNode = it.alias as { name?: string } | null | undefined;
          const alias = aliasNode && typeof aliasNode.name === 'string' ? aliasNode.name : undefined;
          addUse(`${groupPrefix}${it.name}`, alias, ((it.type as string | null) ?? null) ?? groupType);
        }
        return; // items handled; don't descend
      }
      case 'class':
      case 'interface':
      case 'trait':
      case 'enum': {
        const simple = declName(n);
        if (simple) out.declaredClasses.push(ns ? `${ns}\\${simple}` : simple);
        if (n.kind === 'class') {
          const ext = nameText(n.extends);
          if (ext) out.classRefs.push(ext);
          for (const impl of (n.implements as unknown[]) ?? []) {
            const t = nameText(impl);
            if (t) out.classRefs.push(t);
          }
        } else if (n.kind === 'interface') {
          for (const ext of (n.extends as unknown[]) ?? []) {
            const t = nameText(ext);
            if (t) out.classRefs.push(t);
          }
        }
        break; // descend into the body for trait use + nested defs (same ns)
      }
      case 'traituse': {
        for (const tr of (n.traits as unknown[]) ?? []) {
          const t = nameText(tr);
          if (t) out.classRefs.push(t);
        }
        return;
      }
      case 'include': {
        const target = n.target as Record<string, unknown> | undefined;
        if (target && target.kind === 'string' && typeof target.value === 'string') {
          out.includes.push(target.value);
        }
        return;
      }
    }
    for (const [key, value] of Object.entries(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child as Node, ns);
      } else if (value && typeof value === 'object' && 'kind' in (value as object)) {
        visit(value as Node, ns);
      }
    }
  };

  visit(program, '');
  return out;
}

/** Resolve a written class-reference name to its fully-qualified name, honoring
 *  the file's `use` scope + current namespace (PHP's name-resolution rules). */
function resolveRefToFqn(raw: string, useMap: ReadonlyMap<string, string>, currentNs: string): string {
  if (raw.startsWith('\\')) return normalizeFqn(raw); // absolute — already fully qualified
  const clean = normalizeFqn(raw);
  const segs = clean.split('\\');
  const first = segs[0];
  const mapped = useMap.get(first);
  if (mapped) return segs.length === 1 ? mapped : `${mapped}\\${segs.slice(1).join('\\')}`;
  return currentNs ? `${currentNs}\\${clean}` : clean;
}

/** Resolve a `require '…'` / `include '…'` relative literal against the requiring
 *  file's dir to an in-repo file id, or undefined (absolute / unresolvable). */
function resolveIncludeLiteral(fromId: string, rel: string, fileset: ReadonlySet<string>): string | undefined {
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return undefined; // absolute — can't map
  const fromDir = fromId.includes('/') ? fromId.slice(0, fromId.lastIndexOf('/')) : '';
  const segs = fromDir ? fromDir.split('/') : [];
  for (const s of rel.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') segs.pop();
    else segs.push(s);
  }
  const joined = segs.join('/');
  return fileset.has(joined) ? joined : undefined;
}

export class PhpExtractor implements GraphExtractor {
  readonly language = 'php';

  async extract(repoDir: string): Promise<NormalizedGraph> {
    const root = resolve(repoDir);
    const fileIds = listSourceFiles(root, 'php');
    if (fileIds.length === 0) return graphFromState(root, { headSha: '', files: {} });

    const fileset = new Set(fileIds);
    const composer = readComposerJson(root);
    const psr4: Psr4Entry[] = parsePsr4Map(composer);
    const psr0: Psr0Entry[] = parsePsr0Map(composer);
    const engineInstance = getEngine();

    // Pass 1 — parse each file once; collect its refs + LOC, and index every class
    // it declares (FQN → file). The index is the classmap-equivalent + the "class not
    // at its PSR-4 path" fallback the autoload resolver consults after PSR-4/PSR-0.
    // First declaration in sorted-id order wins (deterministic; fileIds is sorted).
    const refsByFile = new Map<string, CollectedRefs>();
    const locByFile = new Map<string, number>();
    const classToFile = new Map<string, string>();
    for (const id of fileIds) {
      let text: string;
      try {
        text = readFileSync(`${root}/${id}`, 'utf8');
      } catch {
        locByFile.set(id, 0);
        continue;
      }
      locByFile.set(id, locOf(text));
      let refs: CollectedRefs;
      try {
        refs = collectFileRefs(engineInstance.parseCode(text, id));
      } catch {
        continue; // php-parser failed on this file — node only (no refs, no declared classes)
      }
      refsByFile.set(id, refs);
      for (const fqn of refs.declaredClasses) {
        if (!classToFile.has(fqn)) classToFile.set(fqn, id);
      }
    }

    // Pass 2 — resolve each file's references to edges, now that the whole-repo
    // class index exists. A file with no refs (unreadable/unparseable) degrades to
    // an edgeless node (never sinks the extract).
    const files: Record<string, FileRecord> = {};
    for (const id of fileIds) {
      const refs = refsByFile.get(id);
      if (!refs) {
        files[id] = emptyRecord(locByFile.get(id) ?? 0);
        continue;
      }

      const importWeights = new Map<string, number>();
      const externalWeights = new Map<string, { specifier: string; weight: number }>();
      const addImport = (to: string): void => {
        if (to === id) return; // no self-edges
        importWeights.set(to, (importWeights.get(to) ?? 0) + 1);
      };
      const addExternal = (fqn: string): void => {
        // A single-segment FQN that is a PHP global (Exception, DateTime, PDO, …)
        // is the language runtime, not a package — drop it (no noise node).
        if (!fqn.includes('\\') && PHP_GLOBALS.has(fqn.toLowerCase())) return;
        const { id: extId, specifier } = phpExternalIdFor(fqn);
        const ex = externalWeights.get(extId);
        if (ex) ex.weight += 1;
        else externalWeights.set(extId, { specifier, weight: 1 });
      };

      // (1) `use` imports — first-party edge (PSR-4 → PSR-0 → class index) or vendor
      // external (the require analogue).
      for (const u of refs.uses) {
        const target = resolveAutoload(u.fqn, psr4, psr0, fileset, classToFile);
        if (target) addImport(target);
        else addExternal(u.fqn);
      }

      // (2) extends / implements / trait use — FIRST-PARTY class edges only (recovers
      // same-namespace inheritance; a cross-namespace class is already covered by its
      // `use`, so a non-first-party ref here is dropped, never a second external).
      for (const raw of refs.classRefs) {
        const fqn = resolveRefToFqn(raw, refs.useMap, refs.namespace);
        const target = resolveAutoload(fqn, psr4, psr0, fileset, classToFile);
        if (target) addImport(target);
      }

      // (3) require / include relative literals — first-party edge when resolvable.
      for (const rel of refs.includes) {
        const target = resolveIncludeLiteral(id, rel, fileset);
        if (target) addImport(target);
      }

      files[id] = {
        loc: locByFile.get(id) ?? 0,
        language: 'php',
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
