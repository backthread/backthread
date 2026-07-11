// (Slice 2) — the ORM FrameworkAdapter. DETECTION (Slice 2).
// the LIGHTWEIGHT data-model contribution (founder-scoped 2026-06-26).
//
// DETECTION: decides "does this repo use a database ORM, and which
// one(s)?" from package.json deps + ORM config-file existence — never source
// content (never-store-source). scoreOrm is PURE.
//
// CONTRIBUTION (, founder-scoped 2026-06-26 — LIGHTWEIGHT, NOT a full
// ERD): the data layer is made a legible box WITHOUT synthesizing an
// entity-node-per-model graph (the framework seam has no new-node hook, and
// entity-relation edges don't fit the locked 8-verb taxonomy). Two channels:
//
//   1. ROLE TAGS (this adapter, via the generic contribute-step) — schema/model
//      definition modules → 'repository', query-call-site modules → 'data-access',
//      migration modules → 'migration'. Each maps onto the LOCKED `service`
//      Module-kind (roles are metadata, NEVER a new Module-kind).
//
//   2. DATASTORE ENRICHMENT + DATA-ACCESS EDGES (the assemble infra-join, NOT
//      here) — the parsed entity/table list enriches the EXISTING datastore node
//      (surfaced by the infra layer) and `reads`/`writes`/`stores-in` edges are
//      drawn from the querying modules to it. That lives in assemble.ts because
//      the edge endpoints are INFRA nodes (the datastore), which only exist after
//      the infra-join — not code modules the contribute-step can resolve. This
//      module EXPORTS the deterministic parse (`analyzeOrmDataModel`) that
//      assemble consumes; it draws no edges itself.
//
// `analyzeOrmDataModel` is the single source of truth for both channels:
//   * Prisma  — parse schema.prisma (declarative; entities = `model`/`view`),
//               plus `prisma.<model>.<method>()` query call sites.
//   * Drizzle — `pgTable`/`sqliteTable`/`mysqlTable` table defs (entity = the SQL
//               table name) + `db.select/insert/update/delete` / `db.query.X.find*`.
//   * TypeORM — `@Entity` classes (entity = decorator arg or class name) + repo
//               methods (find/findOne/save/… on a repository/manager receiver).
//   * Mongoose— `model('Name', …)` defs + query methods on a known model.
//   * Sequelize — DETECT-ONLY (parsing not implemented; logged, never silent).
//
// Detection signals (manifest + config existence only):
//   * deps:   prisma | @prisma/client | drizzle-orm | typeorm | mongoose | sequelize
//   * config: schema.prisma (root or prisma/) → Prisma · drizzle.config.* → Drizzle
//
// A repo can use several ORMs (a Prisma app migrating to Drizzle); they all ride
// in metadata and all run their matchers.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyAssignment,
  type SourceFile,
  type StringLiteral,
} from 'ts-morph';
import {
  addAllSourceFiles,
  buildExtractionProject,
  toId,
} from '../../graph/ts-morph-adapter.js';
import { SOURCE_EXTENSIONS } from '../../graph/file-graph.js';
import { clampConfidence, existsAny, isDir, readDeps, resolveBase } from '../detect-util.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  RoleTag,
} from '../types.js';
import type { ModuleKind } from '../../types.js';

export type OrmName = 'prisma' | 'drizzle' | 'typeorm' | 'mongoose' | 'sequelize';

// Canonical ordering — deterministic `variant`/metadata order regardless of
// package.json key order or which signal fired.
const ORM_ORDER: readonly OrmName[] = ['prisma', 'drizzle', 'typeorm', 'mongoose', 'sequelize'];

// npm dep name → canonical ORM. Prisma ships as two packages (the CLI `prisma`
// and the runtime `@prisma/client`); either maps to one canonical 'prisma'.
const ORM_DEPS: Record<string, OrmName> = {
  prisma: 'prisma',
  '@prisma/client': 'prisma',
  'drizzle-orm': 'drizzle',
  typeorm: 'typeorm',
  mongoose: 'mongoose',
  sequelize: 'sequelize',
};

const PRISMA_SCHEMA_NAMES = ['schema.prisma', 'prisma/schema.prisma'];
const DRIZZLE_CONFIG_NAMES = [
  'drizzle.config.ts',
  'drizzle.config.js',
  'drizzle.config.mjs',
  'drizzle.config.cjs',
  'drizzle.config.json',
];

/** The deterministic ORM signal set read from a repo (or workspace package). */
export interface OrmSignals {
  /** Canonical ORMs inferred from deps, in ORM_ORDER (deduped). */
  depOrms: OrmName[];
  hasPrismaSchema: boolean; // schema.prisma | prisma/schema.prisma
  hasDrizzleConfig: boolean; // drizzle.config.{ts,js,mjs,cjs,json}
}

/** Gather the signal set for a single root dir (fs only). */
export function gatherOrmSignals(baseDir: string): OrmSignals {
  const deps = readDeps(baseDir);
  const found = new Set<OrmName>();
  for (const [dep, orm] of Object.entries(ORM_DEPS)) if (dep in deps) found.add(orm);
  return {
    depOrms: ORM_ORDER.filter((o) => found.has(o)),
    hasPrismaSchema: existsAny(baseDir, PRISMA_SCHEMA_NAMES),
    hasDrizzleConfig: existsAny(baseDir, DRIZZLE_CONFIG_NAMES),
  };
}

/**
 * Decide ORM usage from the signal set. Returns a DetectMatch, or null when no
 * ORM signal fires (generic-TS fallthrough intact).
 *
 * An ORM dep is SUFFICIENT (authoritative). A config file alone is ALSO
 * sufficient — a `schema.prisma` / `drizzle.config.*` is ORM-specific — and
 * implies its ORM even without the dep declared (config-only scores lower). The
 * final `orms` set is the union of dep- and config-derived ORMs.
 */
export function scoreOrm(s: OrmSignals, rootPath = ''): DetectMatch | null {
  const set = new Set<OrmName>(s.depOrms);
  if (s.hasPrismaSchema) set.add('prisma');
  if (s.hasDrizzleConfig) set.add('drizzle');
  if (set.size === 0) return null;

  let confidence = 0;
  if (s.depOrms.length > 0) confidence += 0.6 + 0.1 * (s.depOrms.length - 1);
  if (s.hasPrismaSchema) confidence += s.depOrms.includes('prisma') ? 0.2 : 0.4;
  if (s.hasDrizzleConfig) confidence += s.depOrms.includes('drizzle') ? 0.2 : 0.4;

  const orms = ORM_ORDER.filter((o) => set.has(o));
  return {
    adapter: 'orm',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      variant: orms.join('+'),
      orms,
      signals: {
        depOrms: s.depOrms,
        prismaSchema: s.hasPrismaSchema,
        drizzleConfig: s.hasDrizzleConfig,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// the LIGHTWEIGHT data-model extraction (parse + query call sites).
//
// Roles, each mapped onto the LOCKED `service` Module-kind (the discipline holds:
// roles are metadata, NEVER a new Module-kind):
//   * data-access — a module with ORM query call sites (reads/writes the DB).
//   * repository  — a module that DECLARES the ORM models/tables (Drizzle table
//                   defs / TypeORM @Entity / Mongoose schemas). Prisma's schema
//                   lives in schema.prisma (not a TS module) → no repository role.
//   * migration   — a module under a migrations/ directory.
// Priorities slot into the shared cross-adapter collapse scale used by the
// contribute-step (node.ts: entrypoint 5 … service 1): data-access outranks the
// node `service`/`middleware` tags so a DB-querying service surfaces as the more
// specific data-access role, but stays below request-spine handlers/controllers.
export type OrmRole = 'data-access' | 'repository' | 'migration';
const ROLE_PRIORITY: Record<OrmRole, number> = {
  'data-access': 3,
  repository: 2,
  migration: 1,
};
const ROLE_KIND: ModuleKind = 'service';

// Per-ORM query-method vocabularies. Generic names (find/create/update/delete/
// count/save/remove) are gated (model accessor / drizzle-client / repository-ish
// receiver / known model) to suppress the obvious false positives (Array.find,
// Map.delete, …). Distinctive names (findMany/upsert/findOneBy/…) match ungated.
const PRISMA_READ = new Set([
  'findMany', 'findUnique', 'findFirst', 'findUniqueOrThrow', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy',
]);
const PRISMA_WRITE = new Set([
  'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany',
]);
// Distinctive ⇒ no model-accessor gate needed.
const PRISMA_DISTINCTIVE = new Set([
  'findMany', 'findUnique', 'findFirst', 'findUniqueOrThrow', 'findFirstOrThrow', 'aggregate', 'groupBy',
  'createMany', 'createManyAndReturn', 'updateMany', 'updateManyAndReturn', 'upsert', 'deleteMany',
]);

const DRIZZLE_READ = new Set(['select', 'selectDistinct', '$count']);
const DRIZZLE_WRITE = new Set(['insert', 'update', 'delete']);
const DRIZZLE_FIND = new Set(['findMany', 'findFirst']); // under `<db>.query.<table>.`

const TYPEORM_READ = new Set([
  'find', 'findOne', 'findBy', 'findOneBy', 'findAndCount', 'findAndCountBy', 'findOneOrFail', 'findOneByOrFail',
  'findByIds', 'count', 'countBy', 'exist', 'exists', 'existsBy', 'getMany', 'getOne', 'getRawMany', 'getRawOne',
]);
const TYPEORM_WRITE = new Set([
  'save', 'insert', 'update', 'delete', 'remove', 'softDelete', 'softRemove', 'restore', 'recover', 'upsert', 'increment', 'decrement',
]);
const TYPEORM_DISTINCTIVE = new Set([
  'findBy', 'findOneBy', 'findAndCount', 'findAndCountBy', 'findOneOrFail', 'findOneByOrFail', 'findByIds',
  'countBy', 'existsBy', 'softDelete', 'softRemove', 'upsert', 'getMany', 'getOne', 'getRawMany', 'getRawOne',
]);
const TYPEORM_RECV_RE = /repo|repository|manager|datasource/i;

const MONGOOSE_READ = new Set([
  'find', 'findOne', 'findById', 'countDocuments', 'estimatedDocumentCount', 'aggregate', 'exists', 'distinct',
]);
const MONGOOSE_WRITE = new Set([
  'create', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findByIdAndUpdate', 'findOneAndDelete', 'findByIdAndDelete', 'findByIdAndRemove',
  'findOneAndReplace', 'save', 'bulkWrite',
]);

// Drizzle table-factory identifiers (used unaliased in the overwhelming common
// case; an aliased import is the rare miss we log rather than chase install-free).
const DRIZZLE_TABLE_FACTORIES = new Set([
  'pgTable', 'sqliteTable', 'mysqlTable',
  'pgView', 'mysqlView', 'sqliteView', 'pgMaterializedView',
]);
// Conventional drizzle client identifier names, added so an imported `db`
// (the common `import { db } from './db'`) still gates query sites even when its
// `drizzle(...)` assignment lives in another file. Only consulted when Drizzle
// is detected, so the collision surface is an already-Drizzle repo.
const DRIZZLE_CONVENTIONAL_CLIENTS = ['db', 'database'];

const MIGRATION_PATH_RE = /(^|\/)migrations?(\/|$)/i;
const SOURCE_EXT_SET = new Set<string>(SOURCE_EXTENSIONS);

/** One module's data-access footprint against the datastore. */
export interface OrmAccess {
  reads: boolean;
  writes: boolean;
}

/**
 * The deterministic data-model view of a repo. File ids are repo-relative posix
 * (the graph file-id space); assemble resolves them to MODULE ids via
 * fileModuleMap and the role-tag hook does the same via the contribute-step.
 */
export interface OrmDataModel {
  /** Detected ORMs (ORM_ORDER). Empty ⇒ no ORM ⇒ everything else empty. */
  orms: OrmName[];
  /** Sorted, deduped table/model/entity names (the datastore inventory). */
  entities: string[];
  /** fileId → query footprint (reads/writes). The data-access modules. */
  dataAccess: Map<string, OrmAccess>;
  /** fileIds that DECLARE models/tables (→ 'repository' role + `stores-in`). */
  schemaFiles: Set<string>;
  /** fileIds under a migrations/ dir (→ 'migration' role). */
  migrationFiles: Set<string>;
  /** fileId → collapsed RoleTag (highest-priority role on that file). */
  roles: Map<string, RoleTag>;
  diagnostics: {
    /** Detected ORMs we don't parse (sequelize) — logged, never silently dropped. */
    unparsedOrms: OrmName[];
  };
}

const EMPTY_MODEL: OrmDataModel = {
  orms: [],
  entities: [],
  dataAccess: new Map(),
  schemaFiles: new Set(),
  migrationFiles: new Set(),
  roles: new Map(),
  diagnostics: { unparsedOrms: [] },
};

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function staticString(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  const k = node.getKind();
  if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return (node as StringLiteral).getLiteralText();
  }
  return undefined;
}

// Leftmost identifier of a receiver chain (`a.b.c` → `a`, `this.x` → 'this').
function rootIdent(node: Node, depth = 0): string | undefined {
  if (depth > 24) return undefined;
  const k = node.getKind();
  if (k === SyntaxKind.Identifier) return node.getText();
  if (k === SyntaxKind.ThisKeyword) return 'this';
  if (k === SyntaxKind.PropertyAccessExpression) {
    return rootIdent((node as PropertyAccessExpression).getExpression(), depth + 1);
  }
  if (k === SyntaxKind.CallExpression) {
    return rootIdent((node as CallExpression).getExpression(), depth + 1);
  }
  if (
    k === SyntaxKind.NonNullExpression ||
    k === SyntaxKind.ParenthesizedExpression ||
    k === SyntaxKind.AsExpression ||
    k === SyntaxKind.SatisfiesExpression
  ) {
    const inner = (node as unknown as { getExpression?: () => Node | undefined }).getExpression?.();
    return inner ? rootIdent(inner, depth + 1) : undefined;
  }
  return undefined;
}

// The immediate receiver's leaf name (for the TypeORM repository-ish gate +
// the Mongoose known-model gate): an identifier's text, or a property access's
// trailing name (`this.userRepository` → 'userRepository').
function receiverLeafName(recv: Node, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  const k = recv.getKind();
  if (k === SyntaxKind.Identifier) return recv.getText();
  if (k === SyntaxKind.PropertyAccessExpression) return (recv as PropertyAccessExpression).getName();
  // Data-mapper chains — `getRepository(User).find()` /
  // `dataSource.getRepository(User).find()` — put a CallExpression in the
  // receiver slot; use its callee's leaf name so the repository-ish gate
  // (TYPEORM_RECV_RE) still recognizes `getRepository`.
  if (k === SyntaxKind.CallExpression) {
    return receiverLeafName((recv as CallExpression).getExpression(), depth + 1);
  }
  return undefined;
}

function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

// A query-call candidate, captured cheaply in the single AST pass; classified
// AFTER the global def/client/model sets are known.
interface Candidate {
  fileId: string;
  method: string;
  receiverIsPropAccess: boolean;
  modelAccessor?: string; // immediate receiver's name when it's a property access
  recvRoot?: string; // leftmost identifier of the receiver chain
  recvLeaf?: string; // immediate receiver leaf name (typeorm/mongoose gate)
  drizzleQueryDot: boolean; // `<x>.query.<table>.<method>` shape
}

// ---------------------------------------------------------------------------
// Prisma schema parsing (file-based — schema.prisma is declarative, not TS).

function readFileSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

// Resolve the prisma schema file(s): the single-file `schema.prisma` /
// `prisma/schema.prisma`, plus the multi-file `prisma/schema/*.prisma` layout.
function prismaSchemaFiles(repoDir: string): string[] {
  const out: string[] = [];
  for (const rel of PRISMA_SCHEMA_NAMES) {
    const abs = join(repoDir, rel);
    if (readFileSafe(abs) !== undefined) out.push(abs);
  }
  const multiDir = join(repoDir, 'prisma', 'schema');
  if (isDir(repoDir, 'prisma/schema')) {
    try {
      for (const name of readdirSync(multiDir).sort()) {
        if (name.endsWith('.prisma')) out.push(join(multiDir, name));
      }
    } catch {
      /* ignore — best-effort */
    }
  }
  return out;
}

const PRISMA_MODEL_RE = /^\s*(?:model|view)\s+([A-Za-z_]\w*)\s*\{/gm;

// Parse model/view names out of the prisma schema(s). Views are queryable, so
// they count as entities + accessors. Returns entity names + the client
// accessors (lowercase-first) the generic prisma method gate consults.
function parsePrismaSchema(repoDir: string): { entities: string[]; accessors: Set<string> } {
  const entities = new Set<string>();
  const accessors = new Set<string>();
  for (const abs of prismaSchemaFiles(repoDir)) {
    const src = readFileSafe(abs);
    if (!src) continue;
    PRISMA_MODEL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PRISMA_MODEL_RE.exec(src)) !== null) {
      entities.add(m[1]);
      accessors.add(lowerFirst(m[1]).toLowerCase());
    }
  }
  return { entities: [...entities], accessors };
}

// ---------------------------------------------------------------------------
// The full analysis (one ts-morph project build + one descendant pass per file).

/**
 * Parse the data model for a repo. Deterministic, install-free, source-reading
 * (never-store-source: read server-side, persist only the derived entities/
 * edges/roles). `rootPath` scopes a workspace package ('' = repo root).
 *
 * Unmemoized + pure-w.r.t.-fs: callers (assemble.ts; the roleTags hook) own
 * their own memoization so this stays a plain function of (repoDir, tree).
 */
export function analyzeOrmDataModel(repoDir: string, rootPath = ''): OrmDataModel {
  const signals = gatherOrmSignals(repoDir);
  const match = scoreOrm(signals, rootPath);
  if (!match) return EMPTY_MODEL;
  const orms = new Set<OrmName>((match.metadata!.orms as OrmName[]) ?? []);
  if (orms.size === 0) return EMPTY_MODEL;

  const entities = new Set<string>();
  const schemaFiles = new Set<string>();
  const migrationFiles = new Set<string>();
  const drizzleClients = new Set<string>();
  const mongooseModels = new Set<string>();
  const dataAccess = new Map<string, OrmAccess>();
  const candidates: Candidate[] = [];

  // Prisma: entities + client accessors come from the declarative schema file.
  const prisma = orms.has('prisma') ? parsePrismaSchema(repoDir) : { entities: [], accessors: new Set<string>() };
  for (const e of prisma.entities) entities.add(e);
  const prismaAccessors = prisma.accessors;

  // The union of method names worth capturing — pre-filters the candidate list
  // so we never store a descriptor for an irrelevant call.
  const relevantMethods = new Set<string>();
  const add = (s: Set<string>) => s.forEach((m) => relevantMethods.add(m));
  if (orms.has('prisma')) {
    add(PRISMA_READ); add(PRISMA_WRITE);
    relevantMethods.add('$queryRaw'); relevantMethods.add('$queryRawUnsafe');
    relevantMethods.add('$executeRaw'); relevantMethods.add('$executeRawUnsafe');
  }
  if (orms.has('drizzle')) { add(DRIZZLE_READ); add(DRIZZLE_WRITE); add(DRIZZLE_FIND); }
  if (orms.has('typeorm')) { add(TYPEORM_READ); add(TYPEORM_WRITE); }
  if (orms.has('mongoose')) { add(MONGOOSE_READ); add(MONGOOSE_WRITE); }

  const project = buildExtractionProject(repoDir);
  addAllSourceFiles(project, repoDir);

  // PASS 1 — defs + clients/models + migration paths + query-call candidates.
  for (const sf of project.getSourceFiles()) {
    const fileId = toId(repoDir, sf.getFilePath());
    if (!inScope(fileId, rootPath)) continue;
    if (MIGRATION_PATH_RE.test(fileId)) migrationFiles.add(fileId);

    if (orms.has('typeorm')) collectTypeormEntities(sf, fileId, entities, schemaFiles);

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const calleeKind = callee.getKind();

      // Drizzle table factories: `pgTable('users', {...})`.
      if (
        orms.has('drizzle') &&
        calleeKind === SyntaxKind.Identifier &&
        DRIZZLE_TABLE_FACTORIES.has(callee.getText())
      ) {
        const name = staticString(call.getArguments()[0]);
        const varName = call.getParentIfKind(SyntaxKind.VariableDeclaration)?.getName();
        const entity = name ?? varName;
        if (entity) entities.add(entity);
        schemaFiles.add(fileId);
        continue;
      }

      // Drizzle client: `const db = drizzle(...)`.
      if (
        orms.has('drizzle') &&
        calleeKind === SyntaxKind.Identifier &&
        callee.getText() === 'drizzle'
      ) {
        const varName = call.getParentIfKind(SyntaxKind.VariableDeclaration)?.getName();
        if (varName) drizzleClients.add(varName);
        continue;
      }

      // Mongoose model defs: `mongoose.model('User', …)` / `model('User', …)`.
      if (orms.has('mongoose')) {
        const isModelCall =
          (calleeKind === SyntaxKind.PropertyAccessExpression &&
            (callee as PropertyAccessExpression).getName() === 'model') ||
          (calleeKind === SyntaxKind.Identifier && callee.getText() === 'model');
        if (isModelCall) {
          const name = staticString(call.getArguments()[0]);
          const varName = call.getParentIfKind(SyntaxKind.VariableDeclaration)?.getName();
          if (name) { entities.add(name); mongooseModels.add(name); }
          if (varName) mongooseModels.add(varName);
          schemaFiles.add(fileId);
          continue;
        }
      }

      // Query-call candidate (property-access method calls only — bare calls have
      // no receiver to attribute). Pre-filtered by the relevant-method union.
      if (calleeKind !== SyntaxKind.PropertyAccessExpression) continue;
      const pa = callee as PropertyAccessExpression;
      const method = pa.getName();
      if (!relevantMethods.has(method)) continue;
      const recv = pa.getExpression();
      const receiverIsPropAccess = recv.getKind() === SyntaxKind.PropertyAccessExpression;
      candidates.push({
        fileId,
        method,
        receiverIsPropAccess,
        modelAccessor: receiverIsPropAccess ? (recv as PropertyAccessExpression).getName() : undefined,
        recvRoot: rootIdent(recv),
        recvLeaf: receiverLeafName(recv),
        drizzleQueryDot: isDrizzleQueryDot(recv),
      });
    }
  }

  // Mongoose: `new Schema({...})` files are schema definitions too (the model()
  // call may live elsewhere). Cheap second targeted scan, mongoose-only.
  if (orms.has('mongoose')) {
    for (const sf of project.getSourceFiles()) {
      const fileId = toId(repoDir, sf.getFilePath());
      if (!inScope(fileId, rootPath)) continue;
      for (const ne of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        if (ne.getExpression().getText() === 'Schema') { schemaFiles.add(fileId); break; }
      }
    }
  }

  if (orms.has('drizzle')) for (const c of DRIZZLE_CONVENTIONAL_CLIENTS) drizzleClients.add(c);

  // CLASSIFY — now the global gating sets are known.
  for (const c of candidates) {
    const verb = classify(c, orms, { prismaAccessors, drizzleClients, mongooseModels });
    if (!verb) continue;
    const cur = dataAccess.get(c.fileId) ?? { reads: false, writes: false };
    if (verb === 'reads') cur.reads = true;
    else cur.writes = true;
    dataAccess.set(c.fileId, cur);
  }

  // ROLES — collapse per file by priority (data-access > repository > migration).
  const roles = new Map<string, RoleTag>();
  const setRole = (fileId: string, role: OrmRole) => {
    const cur = roles.get(fileId);
    const incoming: RoleTag = {
      role,
      kind: ROLE_KIND,
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'orm' },
    };
    if (!cur || ROLE_PRIORITY[role] > (cur.priority ?? 0)) roles.set(fileId, incoming);
  };
  for (const f of migrationFiles) setRole(f, 'migration');
  for (const f of schemaFiles) setRole(f, 'repository');
  for (const f of dataAccess.keys()) setRole(f, 'data-access');

  const unparsedOrms = ORM_ORDER.filter((o) => orms.has(o) && o === 'sequelize');

  return {
    orms: ORM_ORDER.filter((o) => orms.has(o)),
    entities: [...entities].sort(),
    dataAccess,
    schemaFiles,
    migrationFiles,
    roles,
    diagnostics: { unparsedOrms },
  };
}

// `<db>.query.<table>.<method>` — the drizzle relational-query shape. `recv` is
// the receiver of the terminal `.findMany()`/`.findFirst()` call (`db.query.x`).
function isDrizzleQueryDot(recv: Node): boolean {
  if (recv.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  const mid = (recv as PropertyAccessExpression).getExpression(); // `db.query`
  if (mid.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  return (mid as PropertyAccessExpression).getName() === 'query';
}

// TypeORM @Entity classes → entity name (decorator arg or class name) + the file
// is a schema/model definition.
function collectTypeormEntities(
  sf: SourceFile,
  fileId: string,
  entities: Set<string>,
  schemaFiles: Set<string>,
): void {
  for (const cls of sf.getClasses() as ClassDeclaration[]) {
    let isEntity = false;
    let named: string | undefined;
    for (const dec of cls.getDecorators()) {
      if (dec.getName() !== 'Entity') continue;
      isEntity = true;
      const arg = dec.getArguments()[0];
      // `@Entity('users')` (string) or `@Entity({ name: 'users' })` (options).
      named = staticString(arg) ?? entityNameFromOptions(arg);
    }
    if (!isEntity) continue;
    const name = named ?? cls.getName();
    if (name) entities.add(name);
    schemaFiles.add(fileId);
  }
}

// Read the table name from a `@Entity({ name: 'users' })` options object, or
// undefined when the arg isn't an object / has no static `name`.
function entityNameFromOptions(arg: Node | undefined): string | undefined {
  if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) return undefined;
  const prop = (arg as ObjectLiteralExpression).getProperty('name');
  if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) return undefined;
  return staticString((prop as PropertyAssignment).getInitializer());
}

// Decide a candidate's data-access verb, or null. Returns the FIRST ORM that
// claims it (prisma → drizzle → typeorm → mongoose); no method is a read in one
// ORM and a write in another, so order only affects gating, never read-vs-write.
function classify(
  c: Candidate,
  orms: ReadonlySet<OrmName>,
  gates: { prismaAccessors: ReadonlySet<string>; drizzleClients: ReadonlySet<string>; mongooseModels: ReadonlySet<string> },
): 'reads' | 'writes' | null {
  // Prisma — `client.<model>.<method>()` (a 3-level property-access call).
  if (orms.has('prisma')) {
    if (c.method === '$queryRaw' || c.method === '$queryRawUnsafe') return 'reads';
    if (c.method === '$executeRaw' || c.method === '$executeRawUnsafe') return 'writes';
    if (c.receiverIsPropAccess) {
      const gated =
        (c.modelAccessor && gates.prismaAccessors.has(c.modelAccessor.toLowerCase())) || PRISMA_DISTINCTIVE.has(c.method);
      if (gated) {
        if (PRISMA_READ.has(c.method)) return 'reads';
        if (PRISMA_WRITE.has(c.method)) return 'writes';
      }
    }
  }
  // Drizzle — gated on a known client (or the `.query.` namespace).
  if (orms.has('drizzle')) {
    const onClient = c.recvRoot !== undefined && gates.drizzleClients.has(c.recvRoot);
    if (c.drizzleQueryDot && DRIZZLE_FIND.has(c.method) && onClient) return 'reads';
    if (onClient) {
      if (DRIZZLE_READ.has(c.method)) return 'reads';
      if (DRIZZLE_WRITE.has(c.method)) return 'writes';
    }
  }
  // TypeORM — distinctive methods ungated; generic ones need a repo/manager-ish
  // receiver (suppresses Array.find, etc.).
  if (orms.has('typeorm')) {
    const repoish = c.recvLeaf !== undefined && TYPEORM_RECV_RE.test(c.recvLeaf);
    if (TYPEORM_READ.has(c.method) && (TYPEORM_DISTINCTIVE.has(c.method) || repoish)) return 'reads';
    if (TYPEORM_WRITE.has(c.method) && (TYPEORM_DISTINCTIVE.has(c.method) || repoish)) return 'writes';
  }
  // Mongoose — gated on a known model receiver (precise; may under-detect).
  if (orms.has('mongoose')) {
    if (c.recvLeaf !== undefined && gates.mongooseModels.has(c.recvLeaf)) {
      if (MONGOOSE_READ.has(c.method)) return 'reads';
      if (MONGOOSE_WRITE.has(c.method)) return 'writes';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The adapter. detect() + the roleTags hook. The datastore
// enrichment + data-access edges are an INFRA-JOIN concern (assemble.ts) — they
// are NOT a syntheticEdges contribution, because their target is the datastore
// INFRA node, which the contribute-step's code-module resolver can't reach.

const ROLE_CACHE = new WeakMap<FrameworkContext, Map<string, RoleTag>>();

export const ormAdapter: FrameworkAdapter = {
  name: 'orm',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreOrm(gatherOrmSignals(base), rootPath);
  },

  // schema/data-access/migration ROLE tags on existing code modules.
  // File-id space; the generic contribute-step resolves to module ids + collapses
  // to one role per module. (syntheticEdges stays ABSENT: the data-access edges go
  // to the datastore infra node, drawn in the assemble infra-join, not here.)
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    let roles = ROLE_CACHE.get(ctx);
    if (!roles) {
      roles = analyzeOrmDataModel(ctx.repoDir, ctx.rootPath).roles;
      ROLE_CACHE.set(ctx, roles);
    }
    return roles;
  },

  // The role pass reads SOURCE (model defs, query call sites) + the prisma schema,
  // so the diff-driven hosted walk must re-run it on a relevant source/schema
  // change. Never-store-source holds: read server-side, persist only roles/edges.
  scansSourcePath(path: string): boolean {
    if (path.endsWith('.prisma')) return true;
    const ext = path.split('.').pop();
    return ext !== undefined && SOURCE_EXT_SET.has(ext);
  },
};
