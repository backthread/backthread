// The ORM FrameworkAdapter (data) — the PHP sibling of the python-orm / Ruby
// ActiveRecord adapters. ONE adapter surfaces the entity layer for BOTH PHP ORMs:
//   * Eloquent (Laravel) — a class `extends Model` (+ family); associations are
//     `$this->hasMany(Post::class)` method-body calls.
//   * Doctrine — a class marked `#[ORM\Entity]` / `@ORM\Entity`; associations are
//     `#[ORM\ManyToOne(targetEntity: Category::class)]` (attribute) or
//     `@ORM\ManyToOne(targetEntity="Category")` (docblock) on a property.
// It co-fires with the Laravel / Symfony web adapter on a full app, and runs alone
// on a data-only service. Driven by the shared PHP analysis layer (php-parser,
// install-free, never executes repo code).
//
//   * detect()       — Eloquent (laravel/framework | illuminate/database) or
//                      Doctrine (doctrine/orm).
//   * roleTags       — an Eloquent model → role 'model', a Doctrine entity → role
//                      'entity', BOTH on the LOCKED `service` kind (metadata; NOT
//                      an infra `datastore` — the python-orm/ActiveRecord precedent).
//   * syntheticEdges — an association between two entities in DIFFERENT files → a
//                      'calls' edge between the two entity MODULES (a structural data
//                      relationship; 'calls' is the neutral 8-verb verb — matches
//                      python-orm/ActiveRecord). Intra-file associations collapse.
//   * groupingPrior  — a models/entities dir (or a cluster of ≥2 entity files) → a
//                      'Data Model' subsystem.
//
// NO datastore node + NO `stores-in` edge (the storage engine is an infra concern).
// Unresolvable association targets DEGRADE + LOG (no silent caps).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readComposerDeps } from '../../../graph/php-manifest.js';
import { normalizeFqn } from '../../../graph/php-psr4.js';
import { parsePhpScope, type PhpScope } from '../analyze.js';
import {
  attrNamedArg,
  callArgs,
  classConstRef,
  collectCalls,
  collectProperties,
  stringValue,
  thisMethodCall,
  type PhpAttribute,
  type PhpClass,
} from '../php-ast.js';
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

export interface OrmSignals {
  hasEloquent: boolean; // laravel/framework | illuminate/database
  hasDoctrine: boolean; // doctrine/orm
}

export function gatherOrmSignals(baseDir: string): OrmSignals {
  const deps = readComposerDeps(baseDir);
  return {
    hasEloquent: deps.has('laravel/framework') || deps.has('illuminate/database'),
    hasDoctrine: deps.has('doctrine/orm'),
  };
}

export function scoreOrm(s: OrmSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasEloquent && !s.hasDoctrine) return null;
  const orms = [s.hasEloquent && 'eloquent', s.hasDoctrine && 'doctrine'].filter(Boolean);
  return { adapter: 'php-orm', confidence: clampConfidence(0.85), rootPath, metadata: { framework: 'php-orm', orms } };
}

const NESTED_SKIP_DIRS = new Set(['vendor', 'var', 'cache', 'storage', 'node_modules', 'src', 'app', 'config', 'public', 'tests']);

function shallowComposerSubdirs(base: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
    if (existsSync(join(base, e.name, 'composer.json'))) out.push(e.name);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Roles → locked MODULE_KINDS (service, NOT infra datastore).

type EntityKind = 'model' | 'entity';
const ROLE_KIND: ModuleKind = 'service';
const ROLE_PRIORITY = 2;

function lastSeg(name: string): string {
  const i = name.lastIndexOf('\\');
  return i >= 0 ? name.slice(i + 1) : name;
}

// Eloquent base classes a model extends. `User` extends Authenticatable (which
// extends Model), so it's included; Pivot / MorphPivot are association tables.
const ELOQUENT_BASES = new Set(['Model', 'Authenticatable', 'Pivot', 'MorphPivot']);
// Eloquent relation methods whose FIRST argument is the related model class.
const ELOQUENT_RELATIONS = new Set([
  'hasMany', 'hasOne', 'belongsTo', 'belongsToMany',
  'morphMany', 'morphOne', 'morphToMany', 'hasManyThrough', 'hasOneThrough',
]);
// Doctrine association attribute/annotation names (each carries a targetEntity).
const DOCTRINE_RELATIONS = new Set(['ManyToOne', 'OneToMany', 'OneToOne', 'ManyToMany']);
const DOCTRINE_ENTITY_ANNOTATION_RE = /@(?:[A-Za-z_]\w*\\)*Entity\b/;

/** Is this class an Eloquent model? An Eloquent base is the strongest signal; else
 *  a class carrying ≥1 relation method call (covers a renamed base). */
function isEloquentModel(cls: PhpClass, relationCount: number): boolean {
  if (cls.kind !== 'class') return false;
  if (cls.extends && ELOQUENT_BASES.has(lastSeg(cls.extends))) return true;
  return relationCount > 0;
}

/** Is this class a Doctrine entity? A `#[ORM\Entity]` attribute or a `@ORM\Entity`
 *  docblock annotation. */
function isDoctrineEntity(cls: PhpClass): boolean {
  if (cls.kind !== 'class') return false;
  if (cls.attributes.some((a) => lastSeg(a.name) === 'Entity')) return true;
  return !!cls.doc && DOCTRINE_ENTITY_ANNOTATION_RE.test(cls.doc);
}

/** The Eloquent relation targets a model declares (`$this->hasMany(Post::class)` →
 *  the reference `Post`; `belongsToMany('App\Models\Role')` → the FQN string). */
function eloquentRelationTargets(cls: PhpClass): string[] {
  const out: string[] = [];
  for (const call of collectCalls(cls.body)) {
    const method = thisMethodCall(call);
    if (!method || !ELOQUENT_RELATIONS.has(method)) continue;
    const arg = callArgs(call)[0];
    const cc = classConstRef(arg);
    if (cc) out.push(cc);
    else {
      const s = stringValue(arg);
      if (s) out.push(s);
    }
  }
  return out;
}

/** Extract a targetEntity from a Doctrine attribute (`targetEntity: X::class` /
 *  `targetEntity: 'X'`), or a property's type hint as the modern-Doctrine fallback. */
function doctrineAttrTarget(attr: PhpAttribute, typeName: string | undefined): string | undefined {
  const val = attrNamedArg(attr, 'targetEntity');
  if (val) return classConstRef(val) ?? stringValue(val);
  return typeName; // `#[ORM\ManyToOne] private ?Category $c` — inferred from the type
}

// `@ORM\ManyToOne(targetEntity="X")` / `targetEntity=X::class` in a docblock.
const DOCTRINE_ASSOC_DOC_RE = new RegExp(
  `@(?:[A-Za-z_]\\w*\\\\)*(?:${[...DOCTRINE_RELATIONS].join('|')})\\b[^)]*?targetEntity\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([\\w\\\\]+)::class)`,
  'g',
);

/** The Doctrine association targets an entity declares (attribute + docblock). */
function doctrineRelationTargets(cls: PhpClass): string[] {
  const out: string[] = [];
  for (const prop of collectProperties(cls.body)) {
    for (const attr of prop.attributes) {
      if (!DOCTRINE_RELATIONS.has(lastSeg(attr.name))) continue;
      const t = doctrineAttrTarget(attr, prop.typeName);
      if (t) out.push(t);
    }
    if (prop.doc) {
      for (const m of prop.doc.matchAll(DOCTRINE_ASSOC_DOC_RE)) {
        const t = m[1] ?? m[2] ?? m[3];
        if (t) out.push(t);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data-Model grouping (mirrors python-orm / ActiveRecord).

const ENTITY_DIR_NAMES = new Set(['models', 'model', 'entities', 'entity', 'domain']);

function slugify(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function humanize(s: string): string {
  const words = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || s;
}
function dirOf(fileId: string): string {
  const i = fileId.lastIndexOf('/');
  return i >= 0 ? fileId.slice(0, i) : '';
}
function dirBase(dir: string): string {
  const i = dir.lastIndexOf('/');
  return i >= 0 ? dir.slice(i + 1) : dir;
}

function buildGroups(entityFiles: readonly string[]): FrameworkGroup[] {
  const byDir = new Map<string, string[]>();
  for (const f of entityFiles) (byDir.get(dirOf(f)) ?? byDir.set(dirOf(f), []).get(dirOf(f))!).push(f);
  const taken = new Set<string>();
  const groups: FrameworkGroup[] = [];
  for (const dir of [...byDir.keys()].sort()) {
    const files = byDir.get(dir)!;
    const entityDir = ENTITY_DIR_NAMES.has(dirBase(dir).toLowerCase());
    if (!entityDir && files.length < 2) continue;
    const label = entityDir ? 'Data Model' : humanize(dirBase(dir));
    let id = slugify(label) || 'data-model';
    let n = 2;
    while (taken.has(id)) id = `${slugify(label) || 'data-model'}-${n++}`;
    taken.add(id);
    groups.push({ id, label, fileIds: [...files].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Analysis.

interface OrmAnalysis {
  roles: Map<string, RoleTag>;
  edges: FrameworkEdge[];
  groups: FrameworkGroup[];
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<OrmAnalysis>>();

async function analyzeOrm(ctx: FrameworkContext): Promise<OrmAnalysis> {
  const scope: PhpScope = await parsePhpScope(ctx);
  const signals = gatherOrmSignals(join(ctx.repoDir, ctx.rootPath));

  // Pass 1 — find model/entity classes; index name → file; collect their targets.
  const entityFiles = new Set<string>();
  const classToFile = new Map<string, string>(); // entity FQN → file
  const roleByFile = new Map<string, EntityKind>(); // 'entity' wins if a file has both
  const targetsByFile = new Map<string, { cls: PhpClass; targets: string[] }[]>();
  for (const [fileId, parsed] of scope.parsed) {
    for (const cls of parsed.classes) {
      let kind: EntityKind | undefined;
      let targets: string[] = [];
      if (signals.hasEloquent) {
        const rels = eloquentRelationTargets(cls);
        if (isEloquentModel(cls, rels.length)) {
          kind = 'model';
          targets = rels;
        }
      }
      if (!kind && signals.hasDoctrine && isDoctrineEntity(cls)) {
        kind = 'entity';
        targets = doctrineRelationTargets(cls);
      }
      if (!kind) continue;
      entityFiles.add(fileId);
      if (kind === 'entity' || !roleByFile.has(fileId)) roleByFile.set(fileId, kind);
      if (!classToFile.has(cls.fqn)) classToFile.set(cls.fqn, fileId);
      (targetsByFile.get(fileId) ?? targetsByFile.set(fileId, []).get(fileId)!).push({ cls, targets });
    }
  }

  // Pass 2 — associations → edges between entity modules.
  const edges = new Map<string, FrameworkEdge>();
  const unresolved = new Set<string>();
  for (const [fileId, entries] of targetsByFile) {
    for (const { cls, targets } of entries) {
      for (const target of targets) {
        const fqn = target.includes('\\')
          ? normalizeFqn(target)
          : undefined;
        const to = fqn
          ? scope.resolve(fqn) ?? classToFile.get(fqn)
          : scope.resolveRef(target, scope.parsed.get(fileId)!.useMap, cls.namespace);
        if (to && entityFiles.has(to) && to !== fileId) {
          const key = `${fileId}→${to}`;
          if (!edges.has(key)) {
            edges.set(key, { source: fileId, target: to, kind: 'calls', metadata: { framework: 'php-orm', relation: 'association' } });
          }
        } else if (!to || !entityFiles.has(to)) {
          if (to === undefined) unresolved.add(`${cls.simpleName} → ${target}`);
        }
      }
    }
  }

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, { role, kind: ROLE_KIND, priority: ROLE_PRIORITY, metadata: { framework: 'php-orm' } });
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );
  const groups = buildGroups([...entityFiles]);

  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(`  [php-orm] ${roles.size} entity module(s) · ${groups.length} data-model group(s) · ${sortedEdges.length} association edge(s)`);
  }
  if (unresolved.size > 0) {
    console.log(`  [php-orm] degraded: ${unresolved.size} unresolvable association(s): ${[...unresolved].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`);
  }
  return { roles, edges: sortedEdges, groups };
}

function getAnalysis(ctx: FrameworkContext): Promise<OrmAnalysis> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeOrm(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const ormAdapter: FrameworkAdapter = {
  name: 'php-orm',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreOrm(gatherOrmSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowComposerSubdirs(base)) {
        const m = scoreOrm(gatherOrmSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: (await getAnalysis(ctx)).groups };
  },

  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return (await getAnalysis(ctx)).edges;
  },

  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return (await getAnalysis(ctx)).roles;
  },

  scansSourcePath(path: string): boolean {
    return path.endsWith('.php');
  },
};
