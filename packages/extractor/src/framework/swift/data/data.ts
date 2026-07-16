// The Swift DATA adapter — one adapter covering the three structurally-identical
// Swift persistence layers (SwiftData, CoreData, Vapor Fluent), the way the Elixir
// Ecto adapter is the data sibling of Phoenix. Built on the shared Swift
// framework-analysis layer (framework/swift/{analyze,swift-ast}.ts).
//
// A model is your data-model CODE — `service` altitude — NOT the infra `datastore`
// kind (that's the DB box the InfraAdapters emit from config). This adapter emits
// NO datastore node and NO `stores-in` edge — the python-orm / Ecto precedent: role
// → service, associations → `calls`, models-dir → a Data-Model subsystem.
//
// SwiftData/CoreData are Apple frameworks (not manifest deps) and Fluent models are
// recognized by a `: Model` conformance, so `detect()` reads SOURCE (a bounded scan)
// + the manifest (the `fluent` dep) + a `.xcdatamodeld` existence check. Everything
// is parsed STATICALLY via the hand-rolled scanner (install-free, never executes repo
// code). parseSwiftScope pre-scans once; the three hooks share it:
//
//   * roleTags        — a SwiftData `@Model` class, a CoreData `NSManagedObject`
//                       subclass, or a Fluent `: Model` (+ an `import Fluent`) →
//                       role 'model', kind `service`.
//   * syntheticEdges  — the ASSOCIATION spine: a relationship property
//                       (SwiftData `@Relationship`, CoreData `@NSManaged`, Fluent
//                       `@Parent`/`@OptionalParent`/`@Children`/`@Siblings`) whose
//                       TYPE resolves to another model file → a model→model `calls`
//                       edge (a data relationship the import graph sees only as a
//                       structural reference; here it's the 'calls' verb, mirroring
//                       python-orm/Ecto — 'reads'/'writes' would imply a runtime flow
//                       a schema relationship doesn't express).
//   * groupingPrior   — a directory holding ≥2 model files → a data subsystem
//                       ('Data Model' for a models-ish dir, else the domain-dir name).
//                       Additive to the UI adapter by registration order (ui→vapor→
//                       data), so it claims only the model dirs the UI/Vapor priors
//                       didn't.
//
// Unresolvable association targets DEGRADE + LOG (no silent caps). Deterministic.

import { clampConfidence, resolveBase } from '../../detect-util.js';
import { parseSwiftScope, readSwiftDeps, type ParsedSwiftFile, type SwiftScope } from '../analyze.js';
import { scanImports } from '../swift-ast.js';
import { scanSwiftSourceHeads } from '../source-scan.js';
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
// Detection — a bounded source scan (SwiftData/CoreData/Fluent) + manifest + a
// `.xcdatamodeld` existence check.

const DETECT_FILE_CAP = 600;
const FLUENT_DEPS = new Set(['fluent', 'fluent-kit', 'fluentkit']);

export interface DataSignals {
  hasSwiftData: boolean;
  hasCoreData: boolean;
  hasFluent: boolean;
}

/**
 * Scan up to DETECT_FILE_CAP `.swift` files under `base` for data-framework imports
 * and check for a `.xcdatamodeld` bundle along the way (CoreData). Reads only file
 * heads (imports live at the top). Never throws.
 */
export function detectDataSignals(base: string, deps: Set<string>): DataSignals {
  let hasSwiftData = false;
  let hasCoreData = false;
  let hasFluent = [...deps].some((d) => FLUENT_DEPS.has(d));
  scanSwiftSourceHeads(
    base,
    (entry, readFileHead) => {
      if (entry.kind === 'dir') {
        if (entry.name.endsWith('.xcdatamodeld')) hasCoreData = true; // the CoreData model bundle
      } else {
        for (const mod of scanImports(readFileHead())) {
          if (mod === 'SwiftData') hasSwiftData = true;
          else if (mod === 'CoreData') hasCoreData = true;
          else if (mod === 'Fluent' || mod === 'FluentKit') hasFluent = true;
        }
      }
      // All found → early-exit. Safe (output-neutral) because the signals are
      // monotonic: once true they never flip, so stopping the scan early cannot
      // change the returned booleans.
      return hasSwiftData && hasCoreData && hasFluent;
    },
    DETECT_FILE_CAP,
  );
  return { hasSwiftData, hasCoreData, hasFluent };
}

export function scoreData(s: DataSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasSwiftData && !s.hasCoreData && !s.hasFluent) return null;
  const variants: string[] = [];
  if (s.hasSwiftData) variants.push('swiftdata');
  if (s.hasCoreData) variants.push('coredata');
  if (s.hasFluent) variants.push('fluent');
  return {
    adapter: 'swift-data',
    confidence: clampConfidence(0.82),
    rootPath,
    metadata: { variant: variants.join('+'), signals: { ...s } },
  };
}

// ---------------------------------------------------------------------------
// Role → the LOCKED `service` kind (data-model CODE, never the infra datastore).
export type DataRole = 'model';
const ROLE_KIND: Record<DataRole, ModuleKind> = { model: 'service' };

// The relationship property-wrapper attributes that name an associated model TYPE.
// SwiftData: @Relationship. CoreData: @NSManaged (a typed relationship property).
// Fluent: @Parent/@OptionalParent/@Children/@Siblings/@OptionalChild.
const ASSOC_ATTRS = new Set<string>([
  'Relationship',
  'NSManaged',
  'Parent',
  'OptionalParent',
  'Children',
  'OptionalChild',
  'Siblings',
]);
// The EXPLICIT relationship wrappers (everything but @NSManaged) ALWAYS name a model,
// so an unresolvable target is a real degrade to LOG. @NSManaged is mixed (it also
// wraps scalar attributes whose types resolve to nothing legitimately), so it stays
// silent.
const EXPLICIT_ASSOC_ATTRS = new Set<string>(
  [...ASSOC_ATTRS].filter((a) => a !== 'NSManaged'),
);

// Fluent-model disambiguation: a `: Model` conformance is only a Fluent model when
// the file imports a Fluent module (SwiftData uses the `@Model` ATTRIBUTE, not a
// `: Model` conformance, so the two never collide).
const FLUENT_IMPORTS = new Set(['Fluent', 'FluentKit']);

// ---------------------------------------------------------------------------
// Helpers.

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
const MODELS_DIR_NAMES = new Set([
  'models', 'model', 'entities', 'entity', 'schema', 'schemas', 'orm', 'db', 'database',
]);

/** Is a parsed file a data model? (SwiftData @Model / CoreData NSManagedObject /
 *  Fluent : Model + a Fluent import). */
function isModelFile(parsed: ParsedSwiftFile): boolean {
  const importsFluent = parsed.imports.some((m) => FLUENT_IMPORTS.has(m));
  for (const decl of parsed.decls) {
    if (decl.kind === 'extension') continue;
    if (decl.attributes.includes('Model')) return true; // SwiftData @Model
    if (decl.inherits.includes('NSManagedObject')) return true; // CoreData
    if (decl.inherits.includes('Model') && importsFluent) return true; // Fluent
  }
  return false;
}

// ---------------------------------------------------------------------------
// Grouping — a directory of ≥2 models → a data subsystem.

interface GroupSeed {
  dir: string;
  baseSlug: string;
  label: string;
  fileIds: string[];
}
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
    groups.push({ id, label: seed.label, fileIds: [...new Set(seed.fileIds)].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function buildGroups(modelFiles: readonly string[]): FrameworkGroup[] {
  const byDir = new Map<string, string[]>();
  for (const f of modelFiles) (byDir.get(dirOf(f)) ?? byDir.set(dirOf(f), []).get(dirOf(f))!).push(f);
  const seeds: GroupSeed[] = [];
  for (const [dir, files] of byDir) {
    if (files.length < 2) continue;
    const modelsDir = MODELS_DIR_NAMES.has(dirBase(dir).toLowerCase());
    const label = modelsDir ? 'Data Model' : humanize(dirBase(dir));
    seeds.push({ dir, baseSlug: slugify(label) || 'data-model', label, fileIds: files });
  }
  return assignGroups(seeds);
}

// ---------------------------------------------------------------------------
// Analysis.

interface DataAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[];
  roles: Map<string, RoleTag>;
}
interface DataDiag {
  unresolved: Set<string>;
}
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, DataAnalysis>();

function addEdge(edges: Map<string, FrameworkEdge>, from: string, to: string, relation: string): void {
  if (from === to) return; // a self-referential association collapses; step drops self-edges too
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'swift-data', relation } });
  }
}

function analyzeData(ctx: FrameworkContext): DataAnalysis {
  const scope: SwiftScope = parseSwiftScope(ctx);
  const diag: DataDiag = { unresolved: new Set() };

  // Pass 1 — classify model files.
  const modelFiles = new Set<string>();
  for (const [id, parsed] of scope.parsed) if (isModelFile(parsed)) modelFiles.add(id);

  // Pass 2 — the association spine: relationship-wrapper properties → target model.
  const edges = new Map<string, FrameworkEdge>();
  for (const id of modelFiles) {
    const parsed = scope.parsed.get(id);
    if (!parsed) continue;
    for (const prop of parsed.properties) {
      const attr = prop.attributes.find((a) => ASSOC_ATTRS.has(a));
      if (!attr || !prop.type) continue;
      const target = scope.resolve(prop.type);
      if (target === undefined) {
        // A scalar (@NSManaged var name: String) resolves to nothing — legitimately
        // silent. But an EXPLICIT relationship wrapper always names a model, so an
        // unresolvable target (an ambiguous name, or a type outside the repo) is a
        // real degrade → log it (no silent caps).
        if (EXPLICIT_ASSOC_ATTRS.has(attr)) diag.unresolved.add(`${id}: @${attr} → ${prop.type}`);
        continue;
      }
      if (!modelFiles.has(target)) continue; // only model→model edges
      addEdge(edges, id, target, attr);
    }
  }

  // Pass 3 — grouping.
  const groups = buildGroups([...modelFiles]);

  const roles = new Map<string, RoleTag>();
  for (const id of modelFiles) {
    roles.set(id, { role: 'model', kind: ROLE_KIND.model, priority: 3, metadata: { framework: 'swift-data' } });
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (modelFiles.size > 0 || sortedEdges.length > 0 || groups.length > 0) {
    console.log(
      `  [swift-data] ${modelFiles.size} model(s) · ${groups.length} data group(s) · ${sortedEdges.length} association edge(s)`,
    );
  }
  if (diag.unresolved.size > 0) {
    console.log(
      `  [swift-data] degraded: ${diag.unresolved.size} unresolvable association target(s): ` +
        `${[...diag.unresolved].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`,
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

export const swiftDataAdapter: FrameworkAdapter = {
  name: 'swift-data',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreData(detectDataSignals(base, readSwiftDeps(base)), rootPath);
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
    return path.endsWith('.swift');
  },
};

export { isModelFile };
