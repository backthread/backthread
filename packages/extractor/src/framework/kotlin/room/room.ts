// The Kotlin ORM FrameworkAdapter (DATA) — the Kotlin data-layer sibling of the Python
// `python-orm` / Elixir `ecto` adapters. ONE adapter covering the three Kotlin ORMs:
// Android **Room**, **JPA** / Spring-Data, and JetBrains **Exposed**. Net-new; on the
// shared Kotlin framework-analysis layer. Detects against the Gradle dep groups.
//
// Each ORM DECLARES its data model structurally, which we read STATICALLY (install-free,
// never-store-source) via the hand-rolled Kotlin scanner (no WASM, never executes repo
// code). Three hooks:
//
//   * detect()        — androidx.room (Room) · jakarta/javax.persistence · org.hibernate ·
//                       org.springframework(.boot/.data) (JPA/Spring-Data) · org.jetbrains
//                       .exposed (Exposed). Broad by design — the roles are content-gated
//                       (a class must actually carry @Entity/@Dao/… or extend a Table /
//                       Spring-Data base), so a false-positive detect just no-ops.
//   * roleTags        — Room @Entity/@Dao/@Database · JPA @Entity · a Spring-Data
//                       repository (extends CrudRepository/JpaRepository/…) · an Exposed
//                       `object X : Table()`/`IntIdTable()` → ALL onto the LOCKED `service`
//                       Module-kind (data-model / data-access CODE you wrote — NEVER the
//                       infra `datastore` kind; the python-orm / ecto precedent). The
//                       Room-vs-JPA @Entity flavor is recorded as metadata only. METADATA;
//                       the module's `kind` is unchanged, NEVER a new kind, and NO
//                       `datastore` node / `stores-in` edge is emitted.
//   * syntheticEdges  — THE ASSOCIATION SPINE: JPA @OneToMany/@ManyToOne/@OneToOne/
//                       @ManyToMany (the associated entity is the field's type — the
//                       generic arg for a collection), Room @Relation/@ForeignKey
//                       (`entity = X::class`), and Exposed `reference("col", OtherTable)`
//                       → a `calls` edge entity/table-file → associated-file. A structural
//                       data relationship the import graph never names as a verb; 'calls'
//                       is the neutral 8-verb verb (the python-orm/ecto stance — 'reads'/
//                       'writes' would imply a runtime data flow a schema relationship
//                       doesn't express). Resolved through the FQN registry.
//   * groupingPrior   — a directory holding ≥2 entity/table files → a data subsystem
//                       ('Data Model' for a models-ish dir, else the domain-dir name),
//                       additive to the web adapters' grouping (registration order = data
//                       AFTER web).
//
// Everything deterministic. KNOWN degrades (documented): a `through:`-style / name-only
// association with no explicit target type names no module → no edge; an association whose
// field type is a project-local wrapper we can't resolve is dropped; a computed Exposed
// `reference(col, tableExpr)` (non-literal table) is not followed.

import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readGradleDeps, readGradleDepsDeep } from '../../../graph/kotlin-manifest.js';
import { parseKotlinScope, type ParsedKotlinFile } from '../analyze.js';
import { sourceLines } from '../kotlin-ast.js';
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

const ORM_GROUP_PREFIXES = [
  'androidx.room',
  'jakarta.persistence',
  'javax.persistence',
  'org.hibernate',
  'org.springframework', // spring-boot (data-jpa) / spring-data — broad, content-gated
  'org.jetbrains.exposed',
];

function depsHaveOrm(deps: ReadonlySet<string>): boolean {
  for (const g of deps) {
    for (const p of ORM_GROUP_PREFIXES) if (g === p || g.startsWith(p + '.')) return true;
  }
  return false;
}

export function gatherOrmSignal(baseDir: string): boolean {
  return depsHaveOrm(readGradleDeps(baseDir)) || depsHaveOrm(readGradleDepsDeep(baseDir));
}

export function scoreOrm(hasOrm: boolean, rootPath = ''): DetectMatch | null {
  if (!hasOrm) return null;
  return { adapter: 'kotlin-orm', confidence: clampConfidence(0.8), rootPath, metadata: { signals: { orm: true } } };
}

// ---------------------------------------------------------------------------
// Role vocabulary → the LOCKED `service` kind (data-model / data-access code, never the
// infra `datastore`).
export type OrmRole = 'entity' | 'dao' | 'database' | 'repository' | 'table';

const ROLE_PRIORITY: Record<OrmRole, number> = { entity: 5, table: 5, dao: 4, database: 3, repository: 2 };
const ROLE_KIND: ModuleKind = 'service';

// Room/JPA annotations that mark a class's role.
const ROOM_ROLE_ANNOTATION: Record<string, OrmRole> = { Dao: 'dao', Database: 'database' };
// Spring-Data repository base interfaces.
const REPOSITORY_BASES = new Set([
  'Repository',
  'CrudRepository',
  'JpaRepository',
  'PagingAndSortingRepository',
  'ReactiveCrudRepository',
  'CoroutineCrudRepository',
  'MongoRepository',
  'R2dbcRepository',
  'JpaSpecificationExecutor',
]);
// Exposed table base classes/objects.
const TABLE_BASES = new Set(['Table', 'IntIdTable', 'LongIdTable', 'UUIDTable', 'IdTable', 'CompositeIdTable']);

// The association annotations naming another entity.
const ASSOC_ANNOTATION_RE = /@(OneToMany|ManyToOne|OneToOne|ManyToMany|Relation)\b/;
const FOREIGN_KEY_RE = /@ForeignKey\b|\bForeignKey\s*\(/;
const CLASS_REF_RE = /\b([A-Z][A-Za-z0-9_]*)::class/g;
// A property declaration whose type names the associated entity. The type is captured up
// to an `=` initializer (`var pets: MutableSet<Pet> = HashSet()` → `MutableSet<Pet> `),
// so the initializer's type (`HashSet`) is never mistaken for the associated entity.
const PROPERTY_RE = /\b(?:val|var)\s+\w+\s*:\s*([^=]+)/;
// Every PascalCase type token in a type expression (`MutableSet<Pet>` → [MutableSet, Pet]).
const TYPE_TOKEN_RE = /[A-Z][A-Za-z0-9_]*/g;
// Exposed `reference("col", OtherTable)` / `optReference(...)` — the referenced table (the
// 2nd positional arg). The scanner runs on comment/STRING-stripped source, so the `"col"`
// first arg is blanked to spaces — match up to the first comma (`[^,)]*`) rather than
// expecting the quotes, then capture the PascalCase table token.
const EXPOSED_REF_RE = /\b(?:opt)?[rR]eference\s*\(\s*[^,)]*,\s*([A-Z][A-Za-z0-9_]*)/g;

// ---------------------------------------------------------------------------
// String / name helpers.

function slugify(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  'models', 'model', 'entities', 'entity', 'schema', 'schemas', 'orm', 'db', 'database', 'tables', 'data',
]);

// ---------------------------------------------------------------------------
// Association extraction.

/** The associated-entity type name from a property line (last PascalCase token of its type). */
function associatedTypeFromProperty(typeExpr: string): string | undefined {
  const tokens = [...typeExpr.matchAll(TYPE_TOKEN_RE)].map((m) => m[0]);
  // The associated entity is the INNERMOST type — the last PascalCase token (a collection
  // `MutableSet<Pet>` → Pet; a bare `Owner?` → Owner). A leading collection type
  // (MutableSet/List/Set/…) is thus skipped in favor of its element.
  return tokens.length ? tokens[tokens.length - 1] : undefined;
}

/**
 * The association targets a file declares: JPA @OneToMany/@ManyToOne/… (the field type),
 * Room @Relation/@ForeignKey (`entity = X::class`), Exposed `reference("c", Other)`. Each is
 * a referenced TYPE name (resolved by the caller). Deterministic; never throws.
 */
export function scanAssociations(text: string): Array<{ typeName: string; relation: string }> {
  const lines = sourceLines(text);
  const out: Array<{ typeName: string; relation: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // JPA / Room association annotation. The annotation may span MULTIPLE lines (a Room
    // `@Relation(... associateBy = Junction(value = X::class ...) ...)`), so gather its full
    // balanced-paren span: capture any explicit `X::class` in the span (the JPA `entity =`
    // / the Room Junction cross-ref) AND the property type AFTER the span.
    const assoc = line.match(ASSOC_ANNOTATION_RE);
    if (assoc) {
      const relation = assoc[1];
      const span = annotationSpan(lines, i);
      for (const m of span.text.matchAll(CLASS_REF_RE)) out.push({ typeName: m[1], relation });
      const type = fieldTypeAfter(lines, span.endLine + 1);
      if (type) {
        const t = associatedTypeFromProperty(type);
        if (t) out.push({ typeName: t, relation });
      }
      i = span.endLine;
      continue;
    }

    // Room @ForeignKey(entity = X::class) — anywhere (often inside an @Entity(foreignKeys=…)).
    if (FOREIGN_KEY_RE.test(line)) {
      for (const m of line.matchAll(CLASS_REF_RE)) out.push({ typeName: m[1], relation: 'foreign-key' });
    }

    // Exposed reference("col", OtherTable).
    for (const m of line.matchAll(EXPOSED_REF_RE)) out.push({ typeName: m[1], relation: 'reference' });
  }
  return out;
}

/**
 * The line span of an annotation starting at line `i`: from its line to the line that
 * closes its balanced `(...)` argument list (or just line `i` for a bare annotation with
 * no parens). Bounded to 30 lines. Returns the span text + its last line index.
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

/** The type of the first `val`/`var` property declaration at/after `i` (skips intervening
 *  annotation + blank lines, e.g. a @JoinColumn between @ManyToOne and the field). */
function fieldTypeAfter(lines: string[], i: number): string | undefined {
  for (let j = i; j < lines.length && j < i + 6; j++) {
    const t = lines[j].trim();
    if (j > i && (t === '' || t.startsWith('@'))) continue;
    const m = lines[j].match(PROPERTY_RE);
    if (m) return m[1];
    if (j > i && t !== '' && !t.startsWith('@')) return undefined; // a non-property code line → give up
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Role detection.

/** The ORM role a file's types imply, or undefined. Priority-ordered. */
export function ormRole(parsed: ParsedKotlinFile): { role: OrmRole; orm?: string } | undefined {
  // Class/type annotations + supertypes.
  for (const t of parsed.types) {
    // Room DAO / Database.
    for (const a of t.annotations) if (ROOM_ROLE_ANNOTATION[a]) return { role: ROOM_ROLE_ANNOTATION[a], orm: 'room' };
    // @Entity (Room or JPA) — disambiguate by import for metadata only.
    if (t.annotations.includes('Entity')) {
      const orm = entityOrm(parsed);
      return { role: 'entity', orm };
    }
    // Exposed table object.
    if (t.supertypes.some((s) => TABLE_BASES.has(s))) return { role: 'table', orm: 'exposed' };
    // Spring-Data repository.
    if (t.supertypes.some((s) => REPOSITORY_BASES.has(s))) return { role: 'repository', orm: 'spring-data' };
  }
  return undefined;
}

/** Which ORM an @Entity belongs to, from the file's imports (metadata only). */
function entityOrm(parsed: ParsedKotlinFile): string {
  for (const imp of parsed.imports) {
    if (imp.fqn.startsWith('androidx.room')) return 'room';
    if (imp.fqn.startsWith('jakarta.persistence') || imp.fqn.startsWith('javax.persistence')) return 'jpa';
  }
  return 'jpa';
}

// ---------------------------------------------------------------------------
// Grouping — deterministic, collision-free ids (mirrors ecto / python-orm).

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

/** One data subsystem per directory holding ≥2 entity/table files. */
function buildGroups(entityFiles: readonly string[]): FrameworkGroup[] {
  const byDir = new Map<string, string[]>();
  for (const f of entityFiles) (byDir.get(dirOf(f)) ?? byDir.set(dirOf(f), []).get(dirOf(f))!).push(f);
  const seeds: GroupSeed[] = [];
  for (const [dir, files] of byDir) {
    if (files.length < 2) continue;
    const modelsDir = MODELS_DIR_NAMES.has(dirBase(dir).toLowerCase());
    const label = modelsDir ? 'Data Model' : humanize(dirBase(dir));
    seeds.push({ dir, label, fileIds: files });
  }
  return assignGroups(seeds);
}

// ---------------------------------------------------------------------------
// Analysis.

interface OrmAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[];
  roles: Map<string, RoleTag>;
}
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, OrmAnalysis>();

function analyzeOrm(ctx: FrameworkContext): OrmAnalysis {
  const scope = parseKotlinScope(ctx);

  const roleByFile = new Map<string, { role: OrmRole; orm?: string }>();
  for (const [id, parsed] of scope.parsed) {
    const r = ormRole(parsed);
    if (r) roleByFile.set(id, r);
  }

  // The association spine — entity/table files' associations resolved to files.
  const edges = new Map<string, FrameworkEdge>();
  const addEdge = (from: string, to: string, relation: string): void => {
    if (from === to) return;
    const key = `${from}→${to}`;
    if (!edges.has(key)) {
      edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'kotlin-orm', relation } });
    }
  };
  // Scan associations on EVERY file, not just entity/table ones: a JPA @OneToMany/@ManyToOne
  // lives on the entity, but a Room @Relation lives on a separate query POJO (not an
  // @Entity), so scoping to tagged files would miss it. The association annotations are
  // ORM-specific, so a non-data file simply yields none.
  let dropped = 0;
  for (const [id, parsed] of scope.parsed) {
    for (const assoc of scanAssociations(parsed.text)) {
      const target = scope.resolveTypeRef(assoc.typeName, parsed);
      if (target && scope.internalIds.has(target)) addEdge(id, target, assoc.relation);
      else dropped++;
    }
  }

  const entityFiles = [...roleByFile].filter(([, v]) => v.role === 'entity' || v.role === 'table').map(([id]) => id);
  const groups = buildGroups(entityFiles);

  const roles = new Map<string, RoleTag>();
  for (const [id, info] of roleByFile) {
    const metadata: Record<string, unknown> = { framework: 'kotlin-orm' };
    if (info.orm) metadata.orm = info.orm;
    roles.set(id, { role: info.role, kind: ROLE_KIND, priority: ROLE_PRIORITY[info.role], metadata });
  }
  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (roleByFile.size > 0 || sortedEdges.length > 0) {
    const counts = new Map<OrmRole, number>();
    for (const v of roleByFile.values()) counts.set(v.role, (counts.get(v.role) ?? 0) + 1);
    const summary = [...counts].sort().map(([r, n]) => `${n} ${r}`).join(', ');
    console.log(
      `  [kotlin-orm] ${roleByFile.size} role(s) [${summary}] · ${groups.length} data group(s) · ${sortedEdges.length} association edge(s)`,
    );
  }
  if (dropped > 0) console.log(`  [kotlin-orm] degraded: ${dropped} association target(s) unresolvable (logged)`);

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): OrmAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeOrm(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const kotlinOrmAdapter: FrameworkAdapter = {
  name: 'kotlin-orm',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreOrm(gatherOrmSignal(base), rootPath);
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
    return path.endsWith('.kt');
  },
};
