// the Python ORM entity FrameworkAdapter. The ORM *entity* surface,
// framework-independent: it works WITH or WITHOUT a web framework (co-fires with
// the FastAPI adapter on a FastAPI+SQLModel repo; runs alone on a plain
// SQLAlchemy service). Sibling of, NOT the same as, the TS `orm` adapter
// (Prisma/Drizzle/TypeORM/Mongoose) — this one reads Python via the shared
// pure-syntactic Pyright parse (scripts/ingest/framework/python/{py-ast,analyze}),
// install-free + never executes repo code.
//
//   * detect()        — a `sqlalchemy` / `sqlmodel` dependency (+ tortoise-orm /
//                       beanie / peewee widen the marker heuristic). PURE scorer.
//   * roleTags        — a module that DECLARES ORM entities → role 'model' on the
//                       LOCKED `service` Module-kind (roles are metadata; the
//                       module's `kind` is unchanged, and NEVER a new kind).
//   * syntheticEdges  — a `relationship()` / `Mapped["Other"]` / `ForeignKey(
//                       "other.id")` between entity classes in DIFFERENT modules
//                       → a 'calls' edge between the two model MODULES (a FK is a
//                       structural data relationship; 'calls' is the neutral
//                       8-verb verb — 'reads'/'writes' would imply runtime data
//                       flow a schema relationship doesn't express). File-id
//                       endpoints; intra-file relationships collapse (self-edge).
//   * groupingPrior   — a `models/`-ish directory (or a cluster of ≥2 entity
//                       files, or a lone `models.py`) → a 'Data Model' subsystem.
//
// DESIGN NOTE (, NO schema change): entities are surfaced via role-tags +
// relationship EDGES between the EXISTING model modules — NOT as new entity
// sub-nodes (that would be a domain-model change beyond this issue). The moat
// (the *why*) is unaffected; this only makes the data layer legible.
//
// Entity detection (marker-base-class heuristic, gated by the detected ORM so a
// bare `class X(Model)` in a non-ORM repo never matches):
//   * SQLAlchemy 2.0 — `class X(Base)` / a `DeclarativeBase` subclass carrying
//                      `Mapped[…]` / `mapped_column()` / `Column()` markers.
//   * SQLModel       — `class X(…, table=True)` (a non-table SQLModel is a schema,
//                      not a table — correctly excluded).
//   * Tortoise/Peewee— `class X(Model)`.  Beanie — `class X(Document)`.
//
// Unresolvable relationship / FK targets DEGRADE + LOG (no silent caps).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readPythonDeps } from '../../graph/python-manifest.js';
import { parsePythonScope } from '../python/analyze.js';
import {
  annotationChain,
  callCallee,
  classBaseChains,
  className,
  classKeywordArg,
  collectClassBody,
  isTrueConstant,
  keywordArg,
  nameValue,
  positionalArgs,
  stringValue,
  subscriptArgs,
  PN,
} from '../python/py-ast.js';
import type {
  CallNode,
  ClassNode,
  ExpressionNode,
  ParseNode,
  TypeAnnotationNode,
} from '@zzzen/pyright-internal/dist/parser/parseNodes.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  FrameworkGroup,
  FrameworkGroupingPrior,
  RoleTag,
} from '../types.js';
import type { ModuleKind } from '../../types.js';

// ---------------------------------------------------------------------------
// Detection (fs → deps; PURE scorer). Never reads source content.

/** Canonical ORM families this adapter recognizes (PEP 503 normalized dep names). */
export type PyOrm = 'sqlalchemy' | 'sqlmodel' | 'tortoise-orm' | 'beanie' | 'peewee';

// Canonical ordering — deterministic metadata order regardless of manifest order.
const ORM_ORDER: readonly PyOrm[] = ['sqlalchemy', 'sqlmodel', 'tortoise-orm', 'beanie', 'peewee'];

/** The deterministic Python-ORM signal set (declared dependency names only). */
export interface PyOrmSignals {
  /** Detected ORM families, in ORM_ORDER. */
  orms: PyOrm[];
}

/** Gather the signal set for a single root dir (reads manifests only). */
export function gatherPyOrmSignals(baseDir: string): PyOrmSignals {
  const deps = readPythonDeps(baseDir);
  return { orms: ORM_ORDER.filter((o) => deps.has(o)) };
}

// Non-source dirs the nested scan skips (cheap + can't hold a first-party manifest).
const NESTED_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'venv',
  '.venv',
  '__pycache__',
  'site-packages',
]);

/** True if `dir` holds a Python manifest worth scanning for deps. */
function hasPythonManifest(dir: string): boolean {
  return (
    existsSync(join(dir, 'pyproject.toml')) ||
    existsSync(join(dir, 'setup.py')) ||
    existsSync(join(dir, 'setup.cfg')) ||
    existsSync(join(dir, 'requirements.txt'))
  );
}

/**
 * Immediate subdirs (depth 1) that hold a Python manifest — the shallow search
 * for a nested backend (`backend/` | `server/` | `api/`) where the ORM commonly
 * lives in a frontend+backend monorepo. Sorted → deterministic first-match.
 */
function shallowManifestSubdirs(base: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
    if (hasPythonManifest(join(base, e.name))) out.push(e.name);
  }
  return out.sort();
}

/**
 * Decide Python-ORM usage from the signal set. Any recognized ORM dep is
 * sufficient; confidence rises when SQLAlchemy AND SQLModel are both declared
 * (the canonical modern stack). Returns null → generic-Python fallthrough,
 * byte-for-byte unchanged.
 */
export function scorePyOrm(s: PyOrmSignals, rootPath = ''): DetectMatch | null {
  if (s.orms.length === 0) return null;
  let confidence = 0.8;
  if (s.orms.includes('sqlalchemy') && s.orms.includes('sqlmodel')) confidence += 0.1;
  return {
    adapter: 'python-orm',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: { orms: s.orms, variant: s.orms.join('+') },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. A module that DECLARES ORM entities is a
// model/data-layer module → role 'model' on the LOCKED `service` kind (the same
// kind the TS `orm` adapter's 'repository' role maps onto — roles are metadata,
// NEVER a new Module-kind). Priority slots with the cross-adapter data-layer tier
// (below request-spine handlers, alongside the TS 'repository' role).
const MODEL_ROLE = 'model';
const MODEL_KIND: ModuleKind = 'service';
const MODEL_PRIORITY = 2;

// SQLAlchemy field/relationship marker calls (a class body carrying any of these
// is a mapped entity even when its base was renamed away from `Base`).
const SQLA_FIELD_MARKERS = new Set(['mapped_column', 'Column', 'relationship']);
// The SQLAlchemy 2.0 typed-attribute wrapper — `Mapped[…]`.
const MAPPED = 'Mapped';
// The relationship constructor call names — SQLAlchemy `relationship()` +
// SQLModel `Relationship()`.
const RELATIONSHIP_CALLS = new Set(['relationship', 'Relationship']);
// The foreign-key markers — SQLAlchemy `ForeignKey("t.col")` (bare or nested in
// mapped_column/Column) + SQLModel `Field(foreign_key="t.col")`.
const FOREIGN_KEY = 'ForeignKey';
const FIELD = 'Field';

// Directory / file basenames that name a data-model home.
const MODELS_DIR_NAMES = new Set([
  'models', 'model', 'entities', 'entity', 'schemas', 'schema', 'orm', 'db', 'database', 'domain', 'tables',
]);

// Alembic / migration files define HISTORICAL table snapshots, not the live
// domain model — never index them as entities (mirrors the TS `orm` adapter's
// MIGRATION_PATH_RE). Excluding them keeps edges pointing at the real model
// module and avoids mis-tagging a migration as a 'model'.
const MIGRATION_PATH_RE = /(^|\/)(migrations?|alembic|versions)(\/|$)/i;

// ---------------------------------------------------------------------------
// Analysis.

interface PyOrmAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface PyOrmDiag {
  /** relationship()/Mapped/FK targets we couldn't map to an entity module. */
  unresolvedTargets: Set<string>;
  /** entity class names defined in >1 module (kept the smallest fileId). */
  duplicateClasses: Set<string>;
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx gets a fresh analysis. Mirrors fastapi / nest / RN.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, PyOrmAnalysis>();

function chainLast(c: { root: string; path: string[] }): string {
  return c.path.length ? c.path[c.path.length - 1] : c.root;
}

function slugify(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function humanize(s: string): string {
  const words = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return s;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function dirOf(fileId: string): string {
  const i = fileId.lastIndexOf('/');
  return i >= 0 ? fileId.slice(0, i) : '';
}

function dirBase(dir: string): string {
  if (dir === '') return 'root';
  const i = dir.lastIndexOf('/');
  return i >= 0 ? dir.slice(i + 1) : dir;
}

function addEdge(
  edges: Map<string, FrameworkEdge>,
  from: string,
  to: string,
  relation: string,
): void {
  if (from === to) return; // intra-file relationship collapses; the step drops self-edges too
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, {
      source: from,
      target: to,
      kind: 'calls',
      metadata: { framework: 'python-orm', relation },
    });
  }
}

// A class body carries a SQLAlchemy mapping marker (a `mapped_column()`/`Column()`/
// `relationship()` call, or a `Mapped[…]` typed attribute) — the robust signal
// when the declarative base was renamed away from the literal `Base`.
function hasSqlaBodyMarker(body: ReturnType<typeof collectClassBody>): boolean {
  for (const call of body.calls) {
    const cc = callCallee(call);
    if (cc && SQLA_FIELD_MARKERS.has(chainLast(cc))) return true;
  }
  for (const ta of body.typeAnnotations) {
    const head = annotationChain(ta.d.annotation);
    if (head && chainLast(head) === MAPPED) return true;
  }
  return false;
}

// Is this class a mapped ORM entity? Gated by the detected ORM family so a
// coincidental `class X(Model)` in a repo that doesn't use Tortoise/Peewee never
// matches. `table=True` alone (SQLModel) is authoritative regardless of base.
function isEntityClass(
  cls: ClassNode,
  body: ReturnType<typeof collectClassBody>,
  detected: ReadonlySet<PyOrm>,
): boolean {
  const bases = classBaseChains(cls).map(chainLast);
  const hasBase = (n: string) => bases.includes(n);

  // SQLModel — the `table=True` keyword is the table marker (a base-schema
  // SQLModel without it is NOT a table). Independent of the exact base name so
  // `class Hero(HeroBase, table=True)` still matches.
  if (detected.has('sqlmodel') && isTrueConstant(classKeywordArg(cls, 'table'))) return true;

  // SQLAlchemy declarative — the conventional `Base` user-base, or (renamed base /
  // classic) any body mapping marker. A bare `class Base(DeclarativeBase): pass`
  // (no `Base` in its OWN bases, no markers) is correctly NOT an entity.
  if (detected.has('sqlalchemy') || detected.has('sqlmodel')) {
    if (hasBase('Base')) return true;
    if (hasSqlaBodyMarker(body)) return true;
  }

  // Tortoise / Peewee active-record base, Beanie ODM document.
  if ((detected.has('tortoise-orm') || detected.has('peewee')) && hasBase('Model')) return true;
  if (detected.has('beanie') && hasBase('Document')) return true;

  return false;
}

// The explicit `__tablename__ = "…"` of a class body, or undefined.
function explicitTableName(body: ReturnType<typeof collectClassBody>): string | undefined {
  for (const a of body.assignments) {
    if (nameValue(a.d.leftExpr) === '__tablename__') {
      const v = stringValue(a.d.rightExpr);
      if (v) return v;
    }
  }
  return undefined;
}

// Recursively collect the class-name-ish leaves of a subscript's argument
// expressions: string forward-refs (`"Address"`), bare names (`Address`), and the
// inner refs of nested subscripts (`list["Address"]`, `Optional["Address"]`).
// Non-entity leaves (`int`, `str`, `list`) are harmless — they simply don't
// resolve against the entity map, so no edge is drawn.
function collectRefLeaves(exprs: ExpressionNode[]): string[] {
  const out: string[] = [];
  for (const e of exprs) {
    const s = stringValue(e);
    if (s) {
      out.push(s);
      continue;
    }
    const n = nameValue(e);
    if (n) {
      out.push(n);
      continue;
    }
    if ((e as ParseNode).nodeType === PN.Index) out.push(...collectRefLeaves(subscriptArgs(e)));
  }
  return out;
}

interface RelTarget {
  kind: 'class' | 'table';
  name: string;
}

// Is `expr` a `relationship(...)` / `Relationship(...)` constructor call?
function isRelationshipCall(expr: ExpressionNode | undefined): expr is CallNode {
  if (!expr || (expr as ParseNode).nodeType !== PN.Call) return false;
  const cc = callCallee(expr as CallNode);
  return !!cc && RELATIONSHIP_CALLS.has(chainLast(cc));
}

// The relationship / FK targets an entity class body references — covering BOTH
// the SQLAlchemy 2.0 and the SQLModel spellings:
//   * `relationship("Other")` / `Relationship(...)` positional/`argument=` name.
//   * `attr: Mapped["Other"] = relationship()` / `attr: "Other" = Relationship()`
//     / `attr: list["Other"] = Relationship()` — refs from the LEFT annotation of
//     any attribute assigned a relationship call (SQLModel drops the `Mapped[…]`).
//   * bare `attr: Mapped["Other"]` typed relationships (gated on the `Mapped[…]`
//     head so scalar `Mapped[int]` never counts).
//   * `ForeignKey("other.id")` (bare or nested in mapped_column/Column) +
//     SQLModel `Field(foreign_key="other.id")` → the referenced TABLE.
function relationshipTargets(body: ReturnType<typeof collectClassBody>): RelTarget[] {
  const out: RelTarget[] = [];
  const pushTable = (s: string | undefined) => {
    const table = s?.split('.')[0];
    if (table) out.push({ kind: 'table', name: table });
  };

  // (1) calls — relationship/Relationship positional class ref; ForeignKey / Field
  //     foreign-key → the referenced table.
  for (const call of body.calls) {
    const cc = callCallee(call);
    if (!cc) continue;
    const m = chainLast(cc);
    if (RELATIONSHIP_CALLS.has(m)) {
      const arg = positionalArgs(call)[0] ?? keywordArg(call, 'argument');
      const nm = stringValue(arg) ?? nameValue(arg);
      if (nm) out.push({ kind: 'class', name: nm });
    } else if (m === FOREIGN_KEY) {
      pushTable(stringValue(positionalArgs(call)[0]));
    } else if (m === FIELD) {
      pushTable(stringValue(keywordArg(call, 'foreign_key')));
    }
  }

  // (2) `attr: <annotation> = relationship()/Relationship()` — the target class(es)
  //     from the LEFT annotation (handles SQLModel's plain `"Other"`/`list["Other"]`
  //     as well as SQLAlchemy's `Mapped["Other"]`).
  for (const a of body.assignments) {
    const left = a.d.leftExpr;
    if ((left as ParseNode).nodeType !== PN.TypeAnnotation) continue;
    if (!isRelationshipCall(a.d.rightExpr)) continue;
    for (const nm of collectRefLeaves([(left as TypeAnnotationNode).d.annotation])) {
      out.push({ kind: 'class', name: nm });
    }
  }

  // (3) bare `attr: Mapped["Other"]` (no assignment) — Mapped-gated so scalars skip.
  for (const ta of body.typeAnnotations) {
    const head = annotationChain(ta.d.annotation);
    if (!head || chainLast(head) !== MAPPED) continue;
    for (const nm of collectRefLeaves(subscriptArgs(ta.d.annotation))) {
      out.push({ kind: 'class', name: nm });
    }
  }
  return out;
}

// A parsed entity: its file, class name, and referenced relationship/FK targets.
interface EntityClass {
  fileId: string;
  name: string;
  targets: RelTarget[];
}

interface GroupSeed {
  dir: string;
  baseSlug: string;
  label: string;
  fileIds: string[];
}

// Deterministic, collision-free group ids ( discipline): sorted by dir, a
// bare slug goes to the first claimant; collisions take a `-<dirBase>` then `-<n>`
// suffix. Identical run-to-run (the snapshot grouping-stability invariant).
function assignGroups(seeds: GroupSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const byDir = [...seeds].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of byDir) {
    let id = seed.baseSlug;
    if (taken.has(id)) id = `${seed.baseSlug}-${slugify(dirBase(seed.dir)) || 'dir'}`;
    let n = 2;
    while (taken.has(id)) id = `${seed.baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label: seed.label, fileIds: [...seed.fileIds].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Group entity files into 'Data Model' subsystem(s): one per directory that is
// models-ish-named OR holds a cluster of ≥2 entity files. A single scattered
// `models.py` (e.g. a per-domain `incident/models.py`) is deliberately LEFT to
// directory grouping — grouping it here would fragment a per-domain layout into
// dozens of identical 'Data Model' boxes and override the more informative
// domain subsystem ( review).
function buildGroups(entityFiles: readonly string[]): FrameworkGroup[] {
  const byDir = new Map<string, string[]>();
  for (const f of entityFiles) {
    const dir = dirOf(f);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(f);
  }
  const seeds: GroupSeed[] = [];
  for (const [dir, files] of byDir) {
    const modelsDir = MODELS_DIR_NAMES.has(dirBase(dir).toLowerCase());
    const cluster = files.length >= 2;
    if (!(modelsDir || cluster)) continue;
    const label = modelsDir ? 'Data Model' : humanize(dirBase(dir));
    seeds.push({ dir, baseSlug: slugify(label) || 'data-model', label, fileIds: files });
  }
  return assignGroups(seeds);
}

function analyzePyOrm(ctx: FrameworkContext): PyOrmAnalysis {
  const detected = new Set<PyOrm>(((ctx.match.metadata?.orms as PyOrm[]) ?? []).filter(Boolean));
  if (detected.size === 0) return { groups: [], edges: [], roles: new Map() };

  const scope = parsePythonScope(ctx);
  const fileIds = [...scope.parsed.keys()].sort();

  const diag: PyOrmDiag = { unresolvedTargets: new Set(), duplicateClasses: new Set() };
  const entities: EntityClass[] = [];
  const entityFiles = new Set<string>();
  const classToFile = new Map<string, string>(); // className → module (first/smallest fileId wins)
  const tableToFile = new Map<string, string>(); // tablename → module (first wins)

  // Pass 1 — find entity classes; index them by class name + table name.
  for (const fileId of fileIds) {
    if (MIGRATION_PATH_RE.test(fileId)) continue; // historical snapshot, not the live model
    const parsed = scope.parsed.get(fileId);
    if (!parsed) continue;
    for (const cls of parsed.nodes.classes) {
      const name = className(cls);
      if (!name) continue;
      const body = collectClassBody(cls);
      if (!isEntityClass(cls, body, detected)) continue;

      entityFiles.add(fileId);
      entities.push({ fileId, name, targets: relationshipTargets(body) });

      if (classToFile.has(name)) diag.duplicateClasses.add(name);
      else classToFile.set(name, fileId);

      const tables = new Set<string>([name.toLowerCase()]);
      const explicit = explicitTableName(body);
      if (explicit) {
        tables.add(explicit);
        tables.add(explicit.toLowerCase());
      }
      for (const t of tables) if (!tableToFile.has(t)) tableToFile.set(t, fileId);
    }
  }

  // Pass 2 — resolve relationship / FK targets to entity modules → 'calls' edges.
  const edges = new Map<string, FrameworkEdge>();
  for (const ent of entities) {
    for (const t of ent.targets) {
      let to: string | undefined;
      if (t.kind === 'class') to = classToFile.get(t.name);
      else to = tableToFile.get(t.name) ?? tableToFile.get(t.name.toLowerCase());
      if (to) addEdge(edges, ent.fileId, to, t.kind === 'table' ? 'foreign-key' : 'relationship');
      else diag.unresolvedTargets.add(`${ent.fileId}: ${ent.name} → ${t.kind}:${t.name}`);
    }
  }

  // Roles — every entity module is a 'model' (service kind).
  const roles = new Map<string, RoleTag>();
  for (const fileId of [...entityFiles].sort()) {
    roles.set(fileId, {
      role: MODEL_ROLE,
      kind: MODEL_KIND,
      priority: MODEL_PRIORITY,
      metadata: { framework: 'python-orm' },
    });
  }

  const groups = buildGroups([...entityFiles]);

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  // Positive signal for validation (mirrors fastapi/nest's log line).
  if (roles.size > 0 || groups.length > 0 || sortedEdges.length > 0) {
    console.log(
      `  [python-orm] ${entityFiles.size} model module(s) · ${groups.length} data-model group(s) · ${sortedEdges.length} relationship edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  if (diag.unresolvedTargets.size > 0 || diag.duplicateClasses.size > 0) {
    const parts: string[] = [];
    if (diag.unresolvedTargets.size > 0) {
      parts.push(
        `${diag.unresolvedTargets.size} unresolvable target(s): ${[...diag.unresolvedTargets].sort().slice(0, 10).join(' · ')}`,
      );
    }
    if (diag.duplicateClasses.size > 0) {
      parts.push(`${diag.duplicateClasses.size} duplicate class name(s): ${[...diag.duplicateClasses].sort().join(', ')}`);
    }
    console.log(`  [python-orm] degraded: ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): PyOrmAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzePyOrm(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const pythonOrmAdapter: FrameworkAdapter = {
  name: 'python-orm',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose pyproject is at root reports rootPath '').
    const rootMatch = scorePyOrm(gatherPyOrmSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // Shallow-scan an immediate `backend/` | `server/` | `api/` package for a
    // nested ORM manifest (a frontend+backend monorepo) — only when not already
    // scoped to a workspace package (the per-package fan-out path).
    if (!ctx.packageDir) {
      for (const sub of shallowManifestSubdirs(base)) {
        const m = scorePyOrm(gatherPyOrmSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // A `models/`-ish directory / entity cluster → a 'Data Model' subsystem,
  // authoritative over directory grouping (the fastapi/nest mechanism). Fully
  // deterministic (path-derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // relationship() / Mapped["Other"] / ForeignKey("other.id") between entity
  // modules → 'calls' edges (file-id endpoints; the step resolves to modules,
  // drops self-edges, dedupes, 8-verb-validates).
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // Each ORM-entity module → role 'model' on the LOCKED `service` kind. METADATA;
  // the module's `kind` is unchanged.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE (Python). Declare the paths the diff-driven hosted walk
  // must treat as framework-relevant. Never-store-source holds: parse server-side,
  // persist only the derived groups/edges/roles.
  scansSourcePath(path: string): boolean {
    return path.endsWith('.py') || path.endsWith('.pyi');
  },
};
