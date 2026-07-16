// The Flutter local-data FrameworkAdapter (DATA) — the Dart sibling of the Ecto /
// python-orm data adapters, built on the shared Dart framework-analysis layer. Net-new;
// detects against pubspec (the drift/isar/floor deps), NOT package.json. Covers the
// three structural local-DB libraries in one adapter.
//
//   * detect()        — any of `drift`, `isar`, `floor`.
//   * roleTags        — a persisted entity → the LOCKED `service` kind (data-model CODE
//                       you wrote, NOT the infra `datastore` kind — the Ecto 'schema' /
//                       python-orm 'model' precedent; there is NO datastore node and NO
//                       `stores-in` edge). Drift `@DriftDatabase` → 'database', `extends
//                       Table` → 'table'; Isar `@collection` → 'collection'; Floor
//                       `@Database` → 'database', `@Entity` → 'entity'. `@freezed` DTOs
//                       + raw `sqflite` are DELIBERATELY NOT tagged (model-file noise /
//                       no structural convention → sqflite stays an `ext:` node).
//                       METADATA onto the LOCKED enum; the module's `kind` is unchanged.
//   * syntheticEdges  — THE ASSOCIATION SPINE (best-effort): a Drift column's
//                       `.references(OtherTable, #col)` FK → a `calls` edge table-file →
//                       referenced-table-file (the neutral 8-verb verb, mirroring Ecto's
//                       stance — a data relationship, not a runtime flow).
//   * groupingPrior   — a directory holding ≥2 entity files → a data subsystem
//                       ('Data Model' for a models-ish dir, else the domain dir name),
//                       authoritative over the directory heuristic. Additive to the
//                       workspace partition (per-package).
//
// Unresolvable references DEGRADE + LOG — no silent caps. Everything is deterministic.
//
// KNOWN best-effort degrades (documented, accepted): `extends Table` assumes Drift (the
// adapter only fires on a drift-dep repo, so the Flutter `Table` widget doesn't
// collide); a computed/aliased reference target is not resolved; Freezed value objects
// are untagged.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readPubDeps, readPubDepsDeep } from '../../../graph/dart-manifest.js';
import { parseDartScope, type ParsedDartFile } from '../analyze.js';
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
import { scanDriftReferences } from './data-scan.js';

// ---------------------------------------------------------------------------
// Detection (pubspec → deps; PURE scorer). Never reads source content.

export interface DataSignals {
  hasDrift: boolean;
  hasIsar: boolean;
  hasFloor: boolean;
}

function dataSignalsFromDeps(deps: Set<string>): DataSignals {
  return {
    hasDrift: deps.has('drift') || deps.has('moor'), // moor = drift's former name
    hasIsar: deps.has('isar'),
    hasFloor: deps.has('floor'),
  };
}

export function gatherDataSignals(baseDir: string): DataSignals {
  return dataSignalsFromDeps(readPubDeps(baseDir));
}

const NESTED_SKIP_DIRS = new Set([
  'node_modules',
  '.dart_tool',
  'build',
  'ios',
  'android',
  '.pub-cache',
  '.symlinks',
  '.fvm',
  'dist',
  'out',
]);

function shallowPubspecSubdirs(base: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
    if (existsSync(join(base, e.name, 'pubspec.yaml'))) out.push(e.name);
  }
  return out.sort();
}

export function scoreData(s: DataSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasDrift && !s.hasIsar && !s.hasFloor) return null;
  const n = [s.hasDrift, s.hasIsar, s.hasFloor].filter(Boolean).length;
  return {
    adapter: 'flutter-data',
    confidence: clampConfidence(0.8 + 0.03 * (n - 1)),
    rootPath,
    metadata: { signals: { drift: s.hasDrift, isar: s.hasIsar, floor: s.hasFloor } },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → the LOCKED `service` kind. A local-DB entity/database is
// data-model CODE — service altitude (NEVER the infra `datastore` kind: this adapter
// emits NO datastore node + NO `stores-in` edge, the locked global correction).
export type DataRole = 'database' | 'table' | 'collection' | 'entity';

const ROLE_KIND: ModuleKind = 'service';
// database (the aggregate) outranks a single entity when one file is both.
const ROLE_PRIORITY: Record<DataRole, number> = {
  database: 4,
  table: 3,
  collection: 3,
  entity: 3,
};

// Annotation name (lower-cased) → role. Drift `@DriftDatabase` + Floor `@Database` →
// database; Floor `@Entity` → entity; Isar `@collection`/`@Collection` → collection.
const ANNOTATION_ROLE: Record<string, DataRole> = {
  driftdatabase: 'database',
  database: 'database',
  entity: 'entity',
  collection: 'collection',
};
// The Drift table base class (a table is `extends Table`, no annotation).
const DRIFT_TABLE_SUPERCLASS = 'Table';
// Freezed value objects are model-file NOISE — never tagged as data (nor grouped).
const FREEZED_ANNOTATION = 'freezed';

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

// Directory basenames that name a generic data-model home → 'Data Model'.
const MODELS_DIR_NAMES = new Set([
  'models', 'model', 'entities', 'entity', 'schemas', 'schema', 'db', 'database', 'data', 'tables', 'collections',
]);

// ---------------------------------------------------------------------------
// Analysis.

interface DataAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>;
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, DataAnalysis>();

/** The data role of a file (from its annotations / a Drift `extends Table`), or undefined. */
function fileDataRole(parsed: ParsedDartFile): DataRole | undefined {
  const annos = new Set(parsed.annotations.map((a) => a.toLowerCase()));
  // A pure Freezed DTO with no data annotation is noise — skip it.
  let best: DataRole | undefined;
  const consider = (role: DataRole): void => {
    if (best === undefined || ROLE_PRIORITY[role] > ROLE_PRIORITY[best]) best = role;
  };
  for (const [anno, role] of Object.entries(ANNOTATION_ROLE)) {
    if (annos.has(anno)) consider(role);
  }
  for (const c of parsed.classes) {
    if (c.kind === 'class' && c.superclass === DRIFT_TABLE_SUPERCLASS) consider('table');
  }
  // A file that is ONLY `@freezed` (no data annotation, no Drift table) → not data.
  if (best === undefined && annos.has(FREEZED_ANNOTATION)) return undefined;
  return best;
}

function addEdge(edges: Map<string, FrameworkEdge>, from: string, to: string, relation: string): void {
  if (from === to) return; // a self-referential FK → no edge
  const key = `${from}→${to}`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'flutter-data', relation } });
  }
}

// Group entity files into a data subsystem: one per DIRECTORY holding ≥2 entity files.
// A models-ish dir → 'Data Model'; else its humanized domain-dir name. A lone entity is
// LEFT to directory grouping. Mirrors ecto/python-orm buildGroups. Deterministic ids.
function buildGroups(entityFiles: readonly string[]): FrameworkGroup[] {
  const byDir = new Map<string, string[]>();
  for (const f of entityFiles) {
    const dir = dirOf(f);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(f);
  }
  const taken = new Set<string>();
  const seeds = [...byDir.entries()]
    .filter(([, files]) => files.length >= 2)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const [dir, files] of seeds) {
    const modelsDir = MODELS_DIR_NAMES.has(dirBase(dir).toLowerCase());
    const label = modelsDir ? 'Data Model' : humanize(dirBase(dir));
    const baseSlug = slugify(label) || 'data-model';
    let id = baseSlug;
    if (taken.has(id)) id = `${baseSlug}-${slugify(dirBase(dir)) || 'dir'}`;
    let n = 2;
    while (taken.has(id)) id = `${baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label, fileIds: [...files].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function analyzeData(ctx: FrameworkContext): DataAnalysis {
  const scope = parseDartScope(ctx);
  const unresolvedRefs = new Set<string>();

  // Pass 1 — roles + the entity class registry (class name → file).
  const roles = new Map<string, RoleTag>();
  const entityFiles: string[] = [];
  const byRole: Record<string, number> = {};
  for (const [fileId, parsed] of scope.parsed) {
    const role = fileDataRole(parsed);
    if (!role) continue;
    roles.set(fileId, { role, kind: ROLE_KIND, priority: ROLE_PRIORITY[role], metadata: { framework: 'flutter-data' } });
    byRole[role] = (byRole[role] ?? 0) + 1;
    // Databases are the aggregate, not a persisted row — group only entities/tables.
    if (role !== 'database') entityFiles.push(fileId);
  }

  // Pass 2 — the Drift association spine: `.references(OtherTable, …)` → 'calls' edge.
  const edges = new Map<string, FrameworkEdge>();
  for (const [fileId, parsed] of scope.parsed) {
    if (!roles.has(fileId)) continue; // only data files declare FKs
    for (const ref of scanDriftReferences(parsed.text)) {
      const target = scope.resolve(ref);
      if (target) addEdge(edges, fileId, target, 'references');
      else unresolvedRefs.add(`${fileId}: references ${ref}`);
    }
  }

  const groups = buildGroups(entityFiles);
  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (roles.size > 0 || sortedEdges.length > 0 || groups.length > 0) {
    console.log(
      `  [flutter-data] ${roles.size} entit(y/ies) [${Object.entries(byRole).map(([k, v]) => `${k}:${v}`).join(' ')}] · ${sortedEdges.length} reference edge(s) · ${groups.length} data group(s)`,
    );
  }
  if (unresolvedRefs.size > 0) {
    console.log(
      `  [flutter-data] degraded: ${unresolvedRefs.size} unresolvable reference(s): ${[...unresolvedRefs].sort().slice(0, 8).join(' · ')} (logged, not silently dropped)`,
    );
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): DataAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeData(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const dataAdapter: FrameworkAdapter = {
  name: 'flutter-data',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreData(gatherDataSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowPubspecSubdirs(base)) {
        const m = scoreData(gatherDataSignals(join(base, sub)), sub);
        if (m) return m;
      }
      const deep = scoreData(dataSignalsFromDeps(readPubDepsDeep(ctx.repoDir)), '');
      if (deep) return deep;
    }
    return null;
  },

  // A directory of ≥2 entities → a data subsystem. Deterministic → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // The Drift FK spine — `.references(T)` → the referenced table file (kind 'calls').
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // Drift/Isar/Floor entities → the LOCKED `service` kind (NO datastore node). METADATA.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  scansSourcePath(path: string): boolean {
    return path.endsWith('.dart');
  },
};
