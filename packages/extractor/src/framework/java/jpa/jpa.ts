// The JPA / Hibernate FrameworkAdapter (DATA) for JAVA — the Java data-layer sibling of the
// Kotlin `kotlin-orm` / Python `python-orm` / Elixir `ecto` adapters. Named `java-jpa`.
//
// JPA DECLARES its data model with annotations, read STATICALLY (install-free,
// never-store-source) from the hand-rolled Java scanner. Three hooks:
//
//   * detect()        — jakarta/javax.persistence · org.hibernate · org.springframework
//                       (data-jpa). Broad by design — the role is content-gated (a class
//                       must carry @Entity), so a false detect just no-ops.
//   * roleTags        — @Entity → the LOCKED `service` Module-kind (data-model CODE you
//                       wrote — NEVER the infra `datastore` kind; the python-orm / ecto /
//                       kotlin-orm precedent). NO `datastore` node / `stores-in` edge.
//   * syntheticEdges  — THE ASSOCIATION SPINE: @OneToMany/@ManyToOne/@OneToOne/@ManyToMany
//                       (the associated entity is the field's type — the element type of a
//                       collection, or an explicit `targetEntity = X.class`) → a `calls`
//                       edge entity-file → associated-file. A structural data relationship
//                       the import graph never names; `calls` is the neutral 8-verb verb
//                       (the ORM precedent — `reads`/`writes` would imply a runtime data
//                       flow a schema relationship doesn't express). Resolved via the FQN
//                       registry.
//   * groupingPrior   — a directory holding ≥2 @Entity files → a data subsystem ('Data
//                       Model' for a models-ish dir, else the domain-dir name), additive to
//                       the web adapters' grouping (registration order = data AFTER web).
//
// Deterministic. KNOWN degrades: an association whose field type is a project-local wrapper
// we can't resolve is dropped; a `targetEntity`-less association on a raw/erased type names
// no module → no edge (accuracy over recall).

import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readJavaDeps } from '../../../graph/java-manifest.js';
import { parseJavaScope } from '../analyze.js';
import { sourceLines } from '../java-ast.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  FrameworkGroup,
  FrameworkGroupingPrior,
  RoleTag,
} from '../../types.js';
import type { ModuleKind } from '../../../types.js';

// ---------------------------------------------------------------------------
// Detection.

const ORM_GROUP_PREFIXES = ['jakarta.persistence', 'javax.persistence', 'org.hibernate', 'org.springframework'];

function depsHaveJpa(deps: ReadonlySet<string>): boolean {
  for (const g of deps) {
    for (const p of ORM_GROUP_PREFIXES) if (g === p || g.startsWith(p + '.')) return true;
  }
  return false;
}

export function gatherJpaSignal(baseDir: string): boolean {
  return depsHaveJpa(readJavaDeps(baseDir));
}

export function scoreJpa(hasJpa: boolean, rootPath = ''): DetectMatch | null {
  if (!hasJpa) return null;
  return { adapter: 'java-jpa', confidence: clampConfidence(0.8), rootPath, metadata: { signals: { jpa: true } } };
}

// ---------------------------------------------------------------------------
// Role → the LOCKED `service` kind (data-model code, never the infra `datastore`).
const ROLE_KIND: ModuleKind = 'service';
const ENTITY_PRIORITY = 5;

// ---------------------------------------------------------------------------
// Association extraction.

const ASSOC_ANNOTATION_RE = /@(OneToMany|ManyToOne|OneToOne|ManyToMany)\b/;
// An explicit `targetEntity = Foo.class` inside the annotation.
const CLASS_REF_RE = /\b([A-Z][A-Za-z0-9_]*)\.class\b/g;
// Every PascalCase type token (`Set<Pet>` → [Set, Pet]; `Owner` → [Owner]).
const TYPE_TOKEN_RE = /[A-Z][A-Za-z0-9_]*/g;

/** The associated-entity type name from a field declaration — the INNERMOST (last
 *  PascalCase) type token of the field's type, so a collection `Set<Pet> pets` → Pet and a
 *  bare `Owner owner` → Owner. The (camelCase) field name is naturally excluded. */
function associatedTypeFromField(fieldDecl: string): string | undefined {
  const typePart = fieldDecl.split('=')[0]; // drop any initializer
  const tokens = [...typePart.matchAll(TYPE_TOKEN_RE)].map((m) => m[0]);
  return tokens.length ? tokens[tokens.length - 1] : undefined;
}

/**
 * The line span of an annotation starting at line `i`: from its line to the line closing
 * its balanced `(...)` (or just line `i` for a bare annotation). Bounded to 30 lines.
 */
function annotationSpan(lines: string[], i: number): { text: string; endLine: number } {
  const open = lines[i].indexOf('(');
  if (open < 0) return { text: lines[i], endLine: i };
  let depth = 0;
  for (let j = i; j < lines.length && j < i + 30; j++) {
    const from = j === i ? open : 0;
    for (let k = from; k < lines[j].length; k++) {
      if (lines[j][k] === '(') depth++;
      else if (lines[j][k] === ')') {
        depth--;
        if (depth === 0) return { text: lines.slice(i, j + 1).join('\n'), endLine: j };
      }
    }
  }
  return { text: lines.slice(i, Math.min(lines.length, i + 30)).join('\n'), endLine: Math.min(lines.length - 1, i + 29) };
}

/** The first field declaration at/after line `i` (skips intervening annotation + blank
 *  lines, e.g. a @JoinColumn between @ManyToOne and the field). The field decl runs to its
 *  `;`, possibly across lines. */
function fieldDeclAfter(lines: string[], i: number): string | undefined {
  for (let j = i; j < lines.length && j < i + 6; j++) {
    const t = lines[j].trim();
    // Skip blank + annotation lines (an @JoinColumn/@Column can sit between the association
    // annotation and the field). Java fields have no `val`/`var` keyword to key off, so this
    // skip must apply to EVERY line, not just j > i.
    if (t === '' || t.startsWith('@')) continue;
    // A field declaration ends with `;`; gather lines until it (bounded).
    let decl = lines[j];
    for (let k = j + 1; k < lines.length && k < j + 4 && !decl.includes(';'); k++) decl += ` ${lines[k]}`;
    // Reject an obvious non-field line (a method — has `(` before `;` without `=`).
    const beforeSemi = decl.split(';')[0];
    if (beforeSemi.includes('(') && !beforeSemi.includes('=')) return undefined;
    return decl;
  }
  return undefined;
}

/** The association targets a file declares: @OneToMany/@ManyToOne/… (field type or an
 *  explicit `targetEntity = X.class`). Each is a referenced TYPE name (resolved by the
 *  caller). Deterministic; never throws. */
export function scanAssociations(text: string): Array<{ typeName: string; relation: string }> {
  const lines = sourceLines(text);
  const out: Array<{ typeName: string; relation: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const assoc = lines[i].match(ASSOC_ANNOTATION_RE);
    if (!assoc) continue;
    const relation = assoc[1];
    const span = annotationSpan(lines, i);
    // An explicit targetEntity = X.class inside the annotation.
    for (const m of span.text.matchAll(CLASS_REF_RE)) out.push({ typeName: m[1], relation });
    // The field type after the annotation span.
    const field = fieldDeclAfter(lines, span.endLine + 1);
    if (field) {
      const t = associatedTypeFromField(field);
      if (t) out.push({ typeName: t, relation });
    }
    i = span.endLine;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grouping — deterministic, collision-free ids (mirrors kotlin-orm / ecto / python-orm).

function slugify(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function humanize(s: string): string {
  const words = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.length === 0 ? s : words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function dirOf(id: string): string {
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(0, i) : '';
}
function dirBase(dir: string): string {
  if (dir === '') return 'root';
  const i = dir.lastIndexOf('/');
  return i >= 0 ? dir.slice(i + 1) : dir;
}
const MODELS_DIR_NAMES = new Set([
  'models', 'model', 'entities', 'entity', 'domain', 'schema', 'schemas', 'orm', 'db', 'data', 'persistence',
]);

interface GroupSeed {
  dir: string;
  label: string;
  fileIds: string[];
}
function assignGroups(seeds: GroupSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const byDir = [...seeds].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of byDir) {
    const base = slugify(seed.label) || 'data-model';
    let id = base;
    if (taken.has(id)) id = `${base}-${slugify(dirBase(seed.dir)) || 'dir'}`;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    taken.add(id);
    groups.push({ id, label: seed.label, fileIds: [...new Set(seed.fileIds)].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One data subsystem per directory holding ≥2 @Entity files. */
function buildGroups(entityFiles: readonly string[]): FrameworkGroup[] {
  const byDir = new Map<string, string[]>();
  for (const f of entityFiles) (byDir.get(dirOf(f)) ?? byDir.set(dirOf(f), []).get(dirOf(f))!).push(f);
  const seeds: GroupSeed[] = [];
  for (const [dir, files] of byDir) {
    if (files.length < 2) continue;
    const modelsDir = MODELS_DIR_NAMES.has(dirBase(dir).toLowerCase());
    seeds.push({ dir, label: modelsDir ? 'Data Model' : humanize(dirBase(dir)), fileIds: files });
  }
  return assignGroups(seeds);
}

// ---------------------------------------------------------------------------
// Analysis.

interface JpaAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[];
  roles: Map<string, RoleTag>;
}
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, JpaAnalysis>();

function analyzeJpa(ctx: FrameworkContext): JpaAnalysis {
  const scope = parseJavaScope(ctx);

  const entityFiles: string[] = [];
  const roles = new Map<string, RoleTag>();
  for (const [id, parsed] of scope.parsed) {
    if (parsed.types.some((t) => t.annotations.includes('Entity'))) {
      entityFiles.push(id);
      roles.set(id, { role: 'entity', kind: ROLE_KIND, priority: ENTITY_PRIORITY, metadata: { framework: 'java-jpa' } });
    }
  }

  // The association spine — scan EVERY file (an association annotation is JPA-specific, so a
  // non-entity file yields none), resolve the referenced type to a file.
  const edges = new Map<string, FrameworkEdge>();
  const addEdge = (from: string, to: string, relation: string): void => {
    if (from === to) return;
    const key = `${from}→${to}`;
    if (!edges.has(key)) edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'java-jpa', relation } });
  };
  let dropped = 0;
  for (const [id, parsed] of scope.parsed) {
    for (const assoc of scanAssociations(parsed.text)) {
      const target = scope.resolveTypeRef(assoc.typeName, parsed);
      if (target && scope.internalIds.has(target)) addEdge(id, target, assoc.relation);
      else dropped++;
    }
  }

  const groups = buildGroups(entityFiles);
  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (entityFiles.length > 0 || sortedEdges.length > 0) {
    console.log(
      `  [java-jpa] ${entityFiles.length} entity(ies) · ${groups.length} data group(s) · ${sortedEdges.length} association edge(s)`,
    );
  }
  if (dropped > 0) console.log(`  [java-jpa] degraded: ${dropped} association target(s) unresolvable (logged)`);

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): JpaAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeJpa(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const javaJpaAdapter: FrameworkAdapter = {
  name: 'java-jpa',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreJpa(gatherJpaSignal(base), rootPath);
  },

  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  scansSourcePath(path: string): boolean {
    return path.endsWith('.java');
  },
};
