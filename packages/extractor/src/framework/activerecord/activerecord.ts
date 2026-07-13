// The ActiveRecord FrameworkAdapter (data) — the Ruby sibling of the python-orm
// adapter. It surfaces the ActiveRecord ENTITY layer (models + their
// associations), framework-independently: it co-fires with the Rails adapter on a
// Rails app and runs alone on a plain ActiveRecord service. Driven by the shared
// Ruby analysis layer (Prism, install-free, never executes repo code).
//
//   * detect()       — a `rails` / `activerecord` gem.
//   * roleTags       — a class that IS an AR model → role 'model' on the LOCKED
//                      `service` kind (metadata; the module's kind is unchanged).
//   * syntheticEdges — a has_many / belongs_to / has_one / has_and_belongs_to_many
//                      between models in DIFFERENT files → a 'calls' edge between
//                      the two model MODULES (an association is a structural data
//                      relationship; 'calls' is the neutral 8-verb verb — matches
//                      python-orm). Intra-file associations collapse (self-edge).
//   * groupingPrior  — a `models/`-ish dir (or a cluster of ≥2 model files) → a
//                      'Data Model' subsystem (mirrors python-orm).
//
// Model detection: superclass is ApplicationRecord / ActiveRecord::Base, OR the
// class carries an AR DSL marker (has_many / belongs_to / validates / scope / enum)
// — the latter catches STI subclasses and renamed bases. Migrations (db/migrate,
// schema.rb) are historical schema snapshots, never indexed as models.
//
// Unresolvable association targets DEGRADE + LOG (no silent caps).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readRubyDeps } from '../../graph/ruby-manifest.js';
import { camelize } from '../../graph/ruby-zeitwerk.js';
import { parseRubyScope, type RubyScope } from '../ruby/analyze.js';
import {
  keywordArg,
  literalValue,
  positionalArgs,
  stringValue,
  symbolValue,
  type RubyClass,
} from '../ruby/ruby-ast.js';
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
// Detection.

export interface ActiveRecordSignals {
  hasActiveRecord: boolean; // rails or activerecord
}

export function gatherActiveRecordSignals(baseDir: string): ActiveRecordSignals {
  const deps = readRubyDeps(baseDir);
  return { hasActiveRecord: deps.has('rails') || deps.has('activerecord') };
}

export function scoreActiveRecord(s: ActiveRecordSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasActiveRecord) return null;
  return { adapter: 'activerecord', confidence: clampConfidence(0.85), rootPath, metadata: { framework: 'activerecord' } };
}

const NESTED_SKIP_DIRS = new Set(['node_modules', 'vendor', 'tmp', 'log', 'app', 'lib', 'config', 'db', 'spec', 'test']);

function shallowGemfileSubdirs(base: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
    if (existsSync(join(base, e.name, 'Gemfile'))) out.push(e.name);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Model detection + association reading.

const MODEL_ROLE = 'model';
const MODEL_KIND: ModuleKind = 'service';
const MODEL_PRIORITY = 2;

const AR_BASES = new Set(['ApplicationRecord', 'ActiveRecord::Base']);
const ASSOCIATION_CALLS = new Set(['has_many', 'belongs_to', 'has_one', 'has_and_belongs_to_many']);
// A body DSL that marks a class as an AR model even when its base was renamed / it
// is an STI subclass of another model.
const AR_MARKERS = new Set([...ASSOCIATION_CALLS, 'validates', 'scope', 'enum', 'validate', 'attribute']);

// Migrations + the schema dump are historical, not the live domain model.
const MIGRATION_PATH_RE = /(^|\/)(db\/migrate|db\/schema\.rb)/;

/** Is this class an ActiveRecord model? */
function isModel(cls: RubyClass): boolean {
  if (cls.kind !== 'class') return false;
  if (cls.superclass && AR_BASES.has(cls.superclass)) return true;
  return cls.bodyCalls.some((c) => AR_MARKERS.has(c.name));
}

function singularize(s: string): string {
  if (s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.endsWith('sses') || s.endsWith('ses') || s.endsWith('xes') || s.endsWith('ches') || s.endsWith('shes')) {
    return s.slice(0, -2);
  }
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

/** The target model class name of an association, or undefined. `class_name:`
 *  wins; else the symbol is camelized (singularized for the plural associations). */
function associationTarget(cls: RubyClass, call: RubyClass['bodyCalls'][number]): string | undefined {
  const override = stringValue(keywordArg(call, 'class_name'));
  if (override) return override;
  const sym = symbolValue(positionalArgs(call)[0]) ?? stringValue(positionalArgs(call)[0]);
  if (!sym) return undefined;
  const plural = call.name === 'has_many' || call.name === 'has_and_belongs_to_many';
  return camelize(plural ? singularize(sym) : sym);
}

// ---------------------------------------------------------------------------
// Analysis.

interface ActiveRecordAnalysis {
  roles: Map<string, RoleTag>;
  edges: FrameworkEdge[];
  groups: FrameworkGroup[];
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<ActiveRecordAnalysis>>();

const MODELS_DIR_NAMES = new Set(['models', 'model', 'entities', 'entity', 'domain']);

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

/** Group model files into 'Data Model' subsystem(s): one per models-ish dir or a
 *  cluster of ≥2 model files (mirrors python-orm). */
function buildGroups(modelFiles: readonly string[]): FrameworkGroup[] {
  const byDir = new Map<string, string[]>();
  for (const f of modelFiles) (byDir.get(dirOf(f)) ?? byDir.set(dirOf(f), []).get(dirOf(f))!).push(f);
  const taken = new Set<string>();
  const groups: FrameworkGroup[] = [];
  for (const dir of [...byDir.keys()].sort()) {
    const files = byDir.get(dir)!;
    const modelsDir = MODELS_DIR_NAMES.has(dirBase(dir).toLowerCase());
    if (!modelsDir && files.length < 2) continue;
    const label = modelsDir ? 'Data Model' : humanize(dirBase(dir));
    let id = slugify(label) || 'data-model';
    let n = 2;
    while (taken.has(id)) id = `${slugify(label) || 'data-model'}-${n++}`;
    taken.add(id);
    groups.push({ id, label, fileIds: [...files].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function analyzeActiveRecord(ctx: FrameworkContext): Promise<ActiveRecordAnalysis> {
  const scope: RubyScope = await parseRubyScope(ctx);

  // Pass 1 — find model classes (skip migrations); index name → file.
  const modelFiles = new Set<string>();
  const modelClassToFile = new Map<string, string>();
  const modelsByFile = new Map<string, RubyClass[]>();
  for (const [fileId, parsed] of scope.parsed) {
    if (MIGRATION_PATH_RE.test(fileId)) continue;
    const models = parsed.classes.filter(isModel);
    if (!models.length) continue;
    modelFiles.add(fileId);
    modelsByFile.set(fileId, models);
    for (const m of models) if (!modelClassToFile.has(m.name)) modelClassToFile.set(m.name, fileId);
  }

  // Pass 2 — associations → edges between model modules.
  const edges = new Map<string, FrameworkEdge>();
  const unresolved = new Set<string>();
  for (const [fileId, models] of modelsByFile) {
    for (const m of models) {
      for (const call of m.bodyCalls) {
        if (!ASSOCIATION_CALLS.has(call.name)) continue;
        const target = associationTarget(m, call);
        if (!target) continue;
        const to = scope.resolve(target, m.nesting) ?? modelClassToFile.get(target);
        if (to && to !== fileId) {
          const key = `${fileId}→${to}`;
          if (!edges.has(key)) {
            edges.set(key, { source: fileId, target: to, kind: 'calls', metadata: { framework: 'activerecord', relation: call.name } });
          }
        } else if (!to) {
          unresolved.add(`${m.name} → ${call.name} ${target}`);
        }
      }
    }
  }

  const roles = new Map<string, RoleTag>();
  for (const fileId of [...modelFiles].sort()) {
    roles.set(fileId, { role: MODEL_ROLE, kind: MODEL_KIND, priority: MODEL_PRIORITY, metadata: { framework: 'activerecord' } });
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );
  const groups = buildGroups([...modelFiles]);

  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(`  [activerecord] ${roles.size} model module(s) · ${groups.length} data-model group(s) · ${sortedEdges.length} association edge(s)`);
  }
  if (unresolved.size > 0) {
    console.log(`  [activerecord] degraded: ${unresolved.size} unresolvable association(s): ${[...unresolved].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`);
  }
  return { roles, edges: sortedEdges, groups };
}

function getAnalysis(ctx: FrameworkContext): Promise<ActiveRecordAnalysis> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeActiveRecord(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const activeRecordAdapter: FrameworkAdapter = {
  name: 'activerecord',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreActiveRecord(gatherActiveRecordSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowGemfileSubdirs(base)) {
        const m = scoreActiveRecord(gatherActiveRecordSignals(join(base, sub)), sub);
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
    return path.endsWith('.rb');
  },
};
