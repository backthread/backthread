// The Go GORM FrameworkAdapter (DATA) — the Go data-layer sibling of python-orm / ecto /
// kotlin-orm / java-jpa. Named `go-gorm`, on the shared DIR-GRANULAR Go framework layer.
//
// GORM DECLARES its model with EMBEDDED `gorm.Model` + struct-tag `gorm:"…"` metadata, read
// STATICALLY (install-free, never-store-source) from the Go source. Three hooks:
//
//   * detect()        — the gorm.io/gorm (or github.com/jinzhu/gorm) dep, content-gated on
//                       a `gorm.Model` embed / `gorm:` struct tag actually appearing.
//   * roleTags        — a package declaring GORM model structs (embedding gorm.Model or
//                       carrying a `gorm:` tag) → the LOCKED `service` kind (data-model CODE
//                       you wrote — NEVER the infra `datastore` kind; the ORM precedent). NO
//                       `datastore` node / `stores-in` edge.
//   * syntheticEdges  — THE ASSOCIATION SPINE: a model struct field whose type is ANOTHER
//                       model (has-many `[]Order`, belongs-to `User`, has-one `*Profile`)
//                       resolved to its package dir → a `calls` edge. Because a Go package is
//                       ONE graph node, an association between two models in the SAME package
//                       is inside that node (no edge); only a CROSS-PACKAGE model reference
//                       yields an edge. The intra-package associations are logged as a
//                       dir-granular degrade.
//   * groupingPrior   — a directory holding ≥2 model files → a data subsystem ('Data Model'
//                       for a models-ish dir, else the domain-dir name).
//
// Deterministic. KNOWN degrades (logged): a `gorm:"foreignKey:…"` column-only relation with
// no typed field names no model → no edge; a field type that is a project-local non-model
// struct still edges (accuracy over precision — it IS a cross-package struct reference).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readGoDeps } from '../../../graph/go-manifest.js';
import { listSourceFiles } from '../../../graph/language.js';
import { stripComments } from '../../../graph/go-scan.js';
import { parseGoScope, scanStructFieldTypes, type GoFile } from '../analyze.js';
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

const GORM_MODULE_PREFIXES = ['gorm.io/gorm', 'github.com/jinzhu/gorm'];
// A GORM MODEL indicator: an embedded `gorm.Model`, or a `gorm:` struct tag. The tag lives
// in a backtick raw string (which stripComments blanks), so this is matched on RAW source.
const GORM_MODEL_RE = /\bgorm\.Model\b|gorm:/;
const DETECT_FILE_CAP = 500;

function depsHaveGorm(deps: ReadonlySet<string>): boolean {
  for (const m of deps) for (const p of GORM_MODULE_PREFIXES) if (m === p || m.startsWith(p)) return true;
  return false;
}

export function gatherGormSignal(repoDir: string): boolean {
  if (!depsHaveGorm(readGoDeps(repoDir))) return false;
  // Content-gate: a gorm dep alone (e.g. only the DB-setup package) isn't a data model.
  let scanned = 0;
  for (const fid of listSourceFiles(repoDir, 'go')) {
    if (scanned++ >= DETECT_FILE_CAP) break;
    let text = '';
    try {
      text = readFileSync(join(repoDir, fid), 'utf8');
    } catch {
      continue;
    }
    if (GORM_MODEL_RE.test(text)) return true;
  }
  return false;
}

export function scoreGorm(hasGorm: boolean, rootPath = ''): DetectMatch | null {
  if (!hasGorm) return null;
  return { adapter: 'go-gorm', confidence: clampConfidence(0.8), rootPath, metadata: { signals: { gorm: true } } };
}

// ---------------------------------------------------------------------------
// Model + association detection.
const ROLE_KIND: ModuleKind = 'service';
const MODEL_PRIORITY = 5;

/** A file that declares a GORM model (raw-source, for the backtick `gorm:` tag). */
function isModelFile(f: GoFile): boolean {
  return GORM_MODEL_RE.test(f.text);
}

// ---------------------------------------------------------------------------
// Grouping — deterministic, collision-free ids (mirrors the other ORM adapters).

function slugify(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function humanize(s: string): string {
  const words = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.length === 0 ? s : words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function dirBase(dir: string): string {
  if (dir === '' || dir === '.') return 'root';
  const i = dir.lastIndexOf('/');
  return i >= 0 ? dir.slice(i + 1) : dir;
}
const MODELS_DIR_NAMES = new Set(['models', 'model', 'entities', 'entity', 'domain', 'schema', 'schemas', 'orm', 'db', 'data', 'store', 'stores']);

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

/** One data subsystem per directory holding ≥2 model files. */
function buildGroups(modelFilesByDir: Map<string, string[]>): FrameworkGroup[] {
  const seeds: GroupSeed[] = [];
  for (const [dir, files] of modelFilesByDir) {
    if (files.length < 2) continue;
    const modelsDir = MODELS_DIR_NAMES.has(dirBase(dir).toLowerCase());
    seeds.push({ dir, label: modelsDir ? 'Data Model' : humanize(dirBase(dir)), fileIds: files });
  }
  return assignGroups(seeds);
}

// ---------------------------------------------------------------------------
// Analysis.

interface GormAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[];
  roles: Map<string, RoleTag>;
}
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, GormAnalysis>();

function analyzeGorm(ctx: FrameworkContext): GormAnalysis {
  const scope = parseGoScope(ctx);

  const roles = new Map<string, RoleTag>();
  const modelFilesByDir = new Map<string, string[]>();
  for (const f of scope.files) {
    if (!isModelFile(f)) continue;
    (modelFilesByDir.get(f.dir) ?? modelFilesByDir.set(f.dir, []).get(f.dir)!).push(f.fileId);
    if (!roles.has(f.dir)) roles.set(f.dir, { role: 'model', kind: ROLE_KIND, priority: MODEL_PRIORITY, metadata: { framework: 'go-gorm' } });
  }

  // Association edges: a model field whose type resolves to a model in ANOTHER package dir.
  const edges = new Map<string, FrameworkEdge>();
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const key = `${from}→${to}`;
    if (!edges.has(key)) edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'go-gorm', relation: 'association' } });
  };
  let intraPackage = 0;
  for (const f of scope.files) {
    if (!isModelFile(f)) continue;
    for (const typeRef of scanStructFieldTypes(stripComments(f.text))) {
      let targetDir: string | undefined;
      const dot = typeRef.indexOf('.');
      if (dot >= 0) targetDir = scope.resolvePackageRef(typeRef.slice(0, dot), f); // qualified pkg.Type
      else targetDir = scope.typeToDir.get(typeRef); // same-repo struct type
      if (!targetDir) continue;
      if (targetDir === f.dir) intraPackage++;
      else addEdge(f.dir, targetDir);
    }
  }

  const groups = buildGroups(modelFilesByDir);
  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(`  [go-gorm] ${roles.size} model package(s) · ${groups.length} data group(s) · ${sortedEdges.length} cross-package association edge(s)`);
  }
  if (intraPackage > 0) console.log(`  [go-gorm] ${intraPackage} intra-package association(s) inside a package node (dir-granular — no edge)`);

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): GormAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeGorm(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const goGormAdapter: FrameworkAdapter = {
  name: 'go-gorm',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreGorm(gatherGormSignal(base), rootPath);
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
    return path.endsWith('.go');
  },
};
