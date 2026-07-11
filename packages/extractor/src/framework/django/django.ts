// the Django FrameworkAdapter. The densest Python adapter, built on the
// FastAPI reference and the shared Python core ( foundation:
// framework/python/{py-ast,analyze}.ts). Net-new; detects against pyproject.toml /
// requirements*.txt (the `django` dep) or a manage.py + settings module, NOT
// package.json.
//
// Django DECLARES its architecture structurally, which we read STATICALLY
// (install-free, never-store-source — parse server-side, persist only the derived
// groups/edges/roles) via a pure syntactic Pyright parse (../python/py-ast.ts):
//
//   * detect()        — the `django` dependency, or a `manage.py` + a settings
//                       module (django-rest-framework / django-ninja noted for
//                       the API passes). Shallow nested-backend detection too.
//   * groupingPrior   — THE HEADLINE: each Django app (a package dir with apps.py /
//                       models.py / an AppConfig) becomes its own subsystem, so a
//                       flat `apps/` folder splits into per-domain subsystems
//                       (Users / Orders / Catalog) — the strongest first-party
//                       signal Django gives. Same mechanism the Nest @Module / RN
//                       navigator priors use: the contribute-step makes each group
//                       its own subsystem, authoritative over the directory heuristic.
//   * syntheticEdges  — the wiring the import graph doesn't name as verbs:
//                       urls.py URLconf `path()`/`re_path()`/`url()` → the view it
//                       routes to + `include()` sub-URLconf mounting (kind 'calls');
//                       `models.Model` FK / OneToOne / ManyToMany → a data
//                       relationship between the two model modules (kind 'calls' —
//                       the safe locked verb for a FK); Django signals
//                       (`@receiver` / `signal.connect` / `signal.send`) →
//                       publishes/subscribes; DRF `router.register(prefix, ViewSet)`
//                       + Django Ninja `api.add_router(prefix, router)` mounting
//                       (kind 'calls').
//   * roleTags        — function/class-based views + DRF ViewSet + Ninja operations
//                       → `gateway`; a models module → `service` (role 'model');
//                       `management/commands/*.py` Command classes → `job`; an
//                       AppConfig → `service`. METADATA onto the LOCKED MODULE_KINDS
//                       enum; never a new kind (the module's `kind` is unchanged —
//                       only `role` is rendered).
//
// Unresolvable url views / includes / FK targets / router registrations / signals
// DEGRADE + LOG — no silent caps. Everything is deterministic (sorted outputs, ids
// derived from names/paths, lexical tiebreaks; run-twice is byte-identical) and
// never executes repo code (pure Pyright parse, no venv/subprocess/import).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readPythonDeps, requirementName } from '../../graph/python-manifest.js';
import { inferSourceRoots, syntacticResolve } from '../../graph/python-adapter.js';
import { buildImportBindings, inScope, isPythonFile } from '../python/analyze.js';
import {
  callCallee,
  collectNodes,
  keywordArg,
  memberChain,
  nameValue,
  parsePython,
  positionalArgs,
  stringValue,
  PN,
  type CollectedNodes,
} from '../python/py-ast.js';
import { ParseTreeWalker } from '@zzzen/pyright-internal/dist/analyzer/parseTreeWalker.js';
import type {
  AssignmentNode,
  CallNode,
  ClassNode,
  DecoratorNode,
  ExpressionNode,
  ModuleNode,
  ParseNode,
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
// Detection (fs → deps + config existence; PURE scorer). Never reads source.

/** The deterministic Django signal set (dependency names + file existence). */
export interface DjangoSignals {
  hasDjango: boolean; // django — the authoritative dep signal
  hasDrf: boolean; // djangorestframework — enables the DRF role/edge pass
  hasNinja: boolean; // django-ninja — enables the Ninja role/edge pass
  hasManagePy: boolean; // manage.py — the Django project launcher (dep-free signal)
  hasSettings: boolean; // a Django project module (settings / wsgi / asgi)
}

// Non-source dirs the nested + settings scans skip (cheap; can't hold a manifest).
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'venv',
  '.venv',
  '__pycache__',
  'site-packages',
  'migrations',
  'static',
  'templates',
  'media',
]);

/**
 * True if `dir` holds a Django project module: a settings module (settings.py /
 * settings/ package), or the WSGI/ASGI entrypoints `django-admin startproject`
 * generates next to it. Real projects name settings freely (`config/django/base.py`),
 * so the co-located `wsgi.py` / `asgi.py` are the reliable existence-only signal.
 */
function hasProjectModule(dir: string): boolean {
  return (
    existsSync(join(dir, 'settings.py')) ||
    existsSync(join(dir, 'settings', '__init__.py')) ||
    existsSync(join(dir, 'wsgi.py')) ||
    existsSync(join(dir, 'asgi.py'))
  );
}

/**
 * Does a Django project module exist at `base` or one directory down? The config
 * package (`config/` | `<project>/`) canonically holds it, so a shallow scan of
 * `base` + its immediate subdirs finds it without reading source.
 */
function findsProjectModule(base: string): boolean {
  if (hasProjectModule(base)) return true;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    if (hasProjectModule(join(base, e.name))) return true;
  }
  return false;
}

/**
 * Every declared dep name at `baseDir`, unioning `readPythonDeps` (pyproject +
 * root requirements*.txt) with a `requirements/` DIRECTORY (`base.txt` / `local.txt`
 * / `production.txt` — the common Django split that the root helper's
 * `requirements*.txt` glob misses). Membership only; deterministic; never source.
 */
function gatherDjangoDeps(baseDir: string): Set<string> {
  const deps = readPythonDeps(baseDir);
  let entries: string[];
  try {
    entries = readdirSync(join(baseDir, 'requirements'));
  } catch {
    return deps;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.txt')) continue;
    let text: string;
    try {
      text = readFileSync(join(baseDir, 'requirements', entry), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const n = requirementName(line);
      if (n) deps.add(n);
    }
  }
  return deps;
}

/** Gather the signal set for a single root dir (reads manifests + file existence). */
export function gatherDjangoSignals(baseDir: string): DjangoSignals {
  const deps = gatherDjangoDeps(baseDir);
  return {
    hasDjango: deps.has('django'),
    hasDrf: deps.has('djangorestframework'),
    hasNinja: deps.has('django-ninja'),
    hasManagePy: existsSync(join(baseDir, 'manage.py')),
    hasSettings: findsProjectModule(baseDir),
  };
}

/** True if `dir` holds a Python manifest OR the Django launcher — worth a scan. */
function hasDjangoScanTarget(dir: string): boolean {
  return (
    existsSync(join(dir, 'pyproject.toml')) ||
    existsSync(join(dir, 'setup.py')) ||
    existsSync(join(dir, 'setup.cfg')) ||
    existsSync(join(dir, 'requirements.txt')) ||
    existsSync(join(dir, 'manage.py'))
  );
}

/** Immediate subdirs (depth 1) worth a nested Django scan (sorted → deterministic). */
function shallowScanSubdirs(base: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    if (hasDjangoScanTarget(join(base, e.name))) out.push(e.name);
  }
  return out.sort();
}

/**
 * Decide Django from the signal set. `django` (dep) is the authoritative signal;
 * absent it, a `manage.py` + a settings module is Django-unique enough to claim at
 * lower confidence. DRF / Ninja only ride in metadata (they enable their passes,
 * they don't decide the stack). Returns null → generic-Python fallthrough,
 * byte-for-byte unchanged.
 */
export function scoreDjango(s: DjangoSignals, rootPath = ''): DetectMatch | null {
  let confidence = 0;
  if (s.hasDjango) {
    confidence = 0.85;
    if (s.hasManagePy) confidence += 0.05;
    if (s.hasDrf || s.hasNinja) confidence += 0.05;
  } else if (s.hasManagePy && s.hasSettings) {
    // No declared dep (vendored / undeclared django), but the launcher + settings
    // module are Django-specific — a real, lower-confidence match.
    confidence = 0.7;
  } else {
    return null;
  }
  return {
    adapter: 'django',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      drf: s.hasDrf,
      ninja: s.hasNinja,
      signals: {
        django: s.hasDjango,
        drf: s.hasDrf,
        ninja: s.hasNinja,
        managePy: s.hasManagePy,
        settings: s.hasSettings,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind`
// is unchanged. A view / viewset / Ninja op is a request entry → gateway; a
// models module is own-code data logic → service; a management Command is
// schedule/CLI-triggered own-code → job (the  role); an AppConfig is
// wiring → service.
export type DjangoRole = 'view' | 'command' | 'model' | 'app-config';

// Collapse priority when several files of different roles land in ONE module after
// clustering (the contribute-step keeps the highest). Request entries (views)
// outrank jobs outrank data modules outrank app wiring.
const ROLE_PRIORITY: Record<DjangoRole, number> = {
  view: 7,
  command: 6,
  model: 5,
  'app-config': 4,
};
const ROLE_KIND: Record<DjangoRole, ModuleKind> = {
  view: 'gateway',
  command: 'job',
  model: 'service',
  'app-config': 'service',
};

// URLconf entry callables (`path(route, view)` / `re_path(pat, view)` / legacy
// `url(pat, view)`), the sub-URLconf mount (`include(...)`), and the HTTP methods a
// Django-Ninja router/api exposes as decorators (`@router.get`, `@api.post`, …).
const URLCONF_FNS = new Set(['path', 're_path', 'url']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

// Constructor last-segments (`x = Ctor(...)`) that mark a first-party object:
//   DRF routers register viewsets; Ninja NinjaAPI/Router declare route surfaces;
//   a Signal() is a first-party pub/sub channel.
const DRF_ROUTER_CTORS = new Set(['DefaultRouter', 'SimpleRouter']);
const NINJA_CTORS = new Set(['NinjaAPI', 'Router']);
const SIGNAL_CTOR = 'Signal';

// Model field constructors whose FIRST arg is the related model (the relationship
// edge). `models.ForeignKey(Author)` / `OneToOneField('Profile')` / `ManyToManyField('app.Tag')`.
const RELATION_FIELDS: Record<string, string> = {
  ForeignKey: 'model-fk',
  OneToOneField: 'model-o2o',
  ManyToManyField: 'model-m2m',
};

// Base-class last-segments that identify a class stereotype (matched on the LAST
// chain segment, so `models.Model`, `Model`, and `django.db.models.Model` all read
// as 'Model'). Views are matched by the /(View|ViewSet)$/ naming convention, which
// covers APIView / ModelViewSet / ListView / custom *View bases + their subclasses.
const MODEL_BASES = new Set(['Model', 'AbstractUser', 'AbstractBaseUser']);
const COMMAND_BASES = new Set(['BaseCommand', 'AppCommand', 'LabelCommand']);
const APPCONFIG_BASE = 'AppConfig';
const VIEW_BASE_RE = /(?:View|ViewSet)$/;
// Function decorators that mark a plain function as a request entry (DRF's
// `@api_view([...])`).
const FN_VIEW_DECORATORS = new Set(['api_view']);

// ---------------------------------------------------------------------------
// Local class collection. The shared py-ast `collectNodes` gathers assignments /
// functions / calls / imports (recursive) but NOT class nodes — FastAPI didn't
// need them. Django's roles/grouping/edges hinge on class BASES (models.Model,
// AppConfig, BaseCommand, *ViewSet) + per-class body fields, so we collect
// ClassNodes with a small LOCAL walker (kept local so the shared py-ast surface is
// untouched — zero coupling with the parallel Python-adapter fan-out). Pyright's
// visitClass drives collection; the only pinned value we branch on is the
// StatementList node-type (47), for one-level class-body unwrapping.
const NODE_STATEMENT_LIST = 47;
const NODE_TUPLE = 52;

class ClassCollector extends ParseTreeWalker {
  readonly out: ClassNode[] = [];
  override visitClass(node: ClassNode): boolean {
    this.out.push(node);
    return true; // descend — nested classes matter (an inner Meta/AppConfig)
  }
}

function collectClasses(tree: ModuleNode): ClassNode[] {
  const c = new ClassCollector();
  c.walk(tree);
  return c.out;
}

/** A class's declared base-class chains (positional args only; kwargs like
 *  `metaclass=` are skipped). Each entry is the memberChain of a base expr. */
function classBases(cls: ClassNode): Array<{ root: string; last: string; dotted: boolean }> {
  const out: Array<{ root: string; last: string; dotted: boolean }> = [];
  for (const arg of cls.d.arguments) {
    if (arg.d.name) continue; // keyword arg (metaclass=…), not a base
    const chain = memberChain(arg.d.valueExpr);
    if (!chain) continue;
    const last = chain.path.length ? chain.path[chain.path.length - 1] : chain.root;
    out.push({ root: chain.root, last, dotted: chain.path.length > 0 });
  }
  return out;
}

/** A class's DIRECT body assignments (one level — model fields / AppConfig attrs),
 *  NOT method-body assignments. Simple statements are wrapped in a StatementList. */
function classBodyAssignments(cls: ClassNode): AssignmentNode[] {
  const out: AssignmentNode[] = [];
  for (const stmt of cls.d.suite.d.statements) {
    if ((stmt as ParseNode).nodeType !== NODE_STATEMENT_LIST) continue;
    for (const inner of (stmt as unknown as { d: { statements: ParseNode[] } }).d.statements) {
      if (inner.nodeType === PN.Assignment) out.push(inner as unknown as AssignmentNode);
    }
  }
  return out;
}

function className(cls: ClassNode): string {
  return cls.d.name.d.value;
}

// ---------------------------------------------------------------------------
// String / name helpers (mirror the FastAPI adapter's local set).

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

function baseName(fileOrDir: string): string {
  const last = fileOrDir.split('/').pop() ?? fileOrDir;
  return last.replace(/\.[^.]+$/, '');
}

function dirSegment(fileId: string): string {
  const slash = fileId.indexOf('/');
  return slash > 0 ? slugify(fileId.slice(0, slash)) : 'root';
}

function isViewsFile(fileId: string): boolean {
  // views.py, or any file under a `views/` package (`app/views/users.py`).
  const parts = fileId.split('/');
  if (baseName(fileId) === 'views') return true;
  return parts.slice(0, -1).includes('views');
}

// The constructor name of an `x = Ctor(...)` RHS (last chain segment), or undefined.
function assignedCtorLast(rhs: ExpressionNode): string | undefined {
  if ((rhs as ParseNode).nodeType !== PN.Call) return undefined;
  const callee = callCallee(rhs as CallNode);
  if (!callee) return undefined;
  return callee.path.length ? callee.path[callee.path.length - 1] : callee.root;
}

// A decorator's callee chain (`@router.get(...)` → root 'router', path ['get'];
// `@receiver(...)` → root 'receiver', path []; `@api_view([...])` → 'api_view').
function decoratorChain(deco: DecoratorNode): { root: string; path: string[] } | undefined {
  const expr = deco.d.expr;
  if ((expr as ParseNode).nodeType === PN.Call) return callCallee(expr as CallNode);
  return memberChain(expr);
}

// The Call node of a decorator, IF it is a call (`@receiver(sig, sender=X)`).
function decoratorCall(deco: DecoratorNode): CallNode | undefined {
  const expr = deco.d.expr;
  return (expr as ParseNode).nodeType === PN.Call ? (expr as CallNode) : undefined;
}

// The first item of a tuple expression, or undefined. Django's `include(('app.urls',
// 'namespace'))` app-namespacing form wraps the module in a 2-tuple; we route on
// its first element.
function firstTupleItem(expr: ExpressionNode | undefined): ExpressionNode | undefined {
  if (!expr || (expr as ParseNode).nodeType !== NODE_TUPLE) return undefined;
  return (expr as unknown as { d: { items: ExpressionNode[] } }).d.items[0];
}

// The root identifier of a reference expression: a Name / MemberAccess uses its
// chain root (`views.foo` → 'views'); a Call uses its callee root (`Foo.as_view()`
// → 'Foo', `include('x')` → 'include'). Undefined for anything else.
function refRoot(expr: ExpressionNode | undefined): string | undefined {
  if (!expr) return undefined;
  if ((expr as ParseNode).nodeType === PN.Call) return callCallee(expr as CallNode)?.root;
  return memberChain(expr)?.root;
}

// ---------------------------------------------------------------------------
// Analysis.

interface DjangoParsedFile {
  nodes: CollectedNodes;
  classes: ClassNode[];
  bindings: Map<string, string>;
}

interface DjangoAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface DjangoDiag {
  unresolvedViews: Set<string>; // url path()/register() view targets we couldn't map
  unresolvedIncludes: Set<string>; // include(...) targets we couldn't map
  unresolvedRelations: Set<string>; // FK/O2O/M2M targets we couldn't map
  ambiguousRelations: Set<string>; // string model names matching >1 file
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx gets a fresh analysis — no cross-tree staleness. Mirrors fastapi / nest / RN.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, DjangoAnalysis>();

function addRole(map: Map<string, DjangoRole>, fileId: string, role: DjangoRole): void {
  const cur = map.get(fileId);
  if (
    cur === undefined ||
    ROLE_PRIORITY[role] > ROLE_PRIORITY[cur] ||
    (ROLE_PRIORITY[role] === ROLE_PRIORITY[cur] && role < cur)
  ) {
    map.set(fileId, role);
  }
}

function addEdge(
  edges: Map<string, FrameworkEdge>,
  from: string,
  to: string,
  kind: FrameworkEdge['kind'],
  relation: string,
): void {
  if (from === to) return; // intra-file wiring collapses; the step drops self-edges too
  const key = `${from}→${to}:${kind}`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind, metadata: { framework: 'django', relation } });
  }
}

// Parse every in-scope Python file once, keeping the tree long enough to collect
// classes (which the shared parsePythonScope's CollectedNodes doesn't expose). We
// reuse the shared atomics (collectNodes / buildImportBindings / inferSourceRoots /
// isPythonFile / inScope) — same single-parse cost as parsePythonScope, plus classes.
function parseDjangoScope(ctx: FrameworkContext): {
  pyFiles: string[];
  internalIds: Set<string>;
  roots: readonly string[];
  parsed: Map<string, DjangoParsedFile>;
} {
  const { repoDir, rootPath, graph } = ctx;
  const pyFiles = graph.files
    .filter((f) => isPythonFile(f.language) && inScope(f.id, rootPath))
    .map((f) => f.id);
  const internalIds = new Set(pyFiles);
  const roots = inferSourceRoots(internalIds);
  const parsed = new Map<string, DjangoParsedFile>();
  for (const id of pyFiles) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, id), 'utf8');
    } catch {
      continue;
    }
    const tree = parsePython(text);
    if (!tree) continue;
    const nodes = collectNodes(tree);
    parsed.set(id, {
      nodes,
      classes: collectClasses(tree),
      bindings: buildImportBindings(id, nodes.imports, internalIds, roots),
    });
  }
  return { pyFiles, internalIds, roots, parsed };
}

// ── Model index + transitive model detection ──────────────────────────────
// A class is a MODEL if a base's last segment is a known Django model base
// (`Model` / `AbstractUser` / `AbstractBaseUser`), OR (transitively) a base
// resolves to another first-party class that is itself a model — so a project's
// own abstract base (`class Order(TimeStampedModel)`) is caught. Fixpoint over the
// class set; deterministic (order-independent).
interface ClassInfo {
  fileId: string;
  name: string;
  bases: Array<{ root: string; last: string; dotted: boolean }>;
  binds: ReadonlyMap<string, string>;
  localClasses: ReadonlySet<string>;
}

function classKey(fileId: string, name: string): string {
  return `${fileId}#${name}`;
}

// Resolve a base-class chain to the class key it refers to, or undefined.
//   * bare `Base`      → imported file (binds) / a local class in this file
//   * dotted `mod.Base`→ the module alias's file (binds[root]); class name = last
function resolveBaseClass(
  base: { root: string; last: string; dotted: boolean },
  info: ClassInfo,
): string | undefined {
  const targetFile = base.dotted
    ? info.binds.get(base.root)
    : (info.binds.get(base.root) ?? (info.localClasses.has(base.root) ? info.fileId : undefined));
  if (!targetFile) return undefined;
  return classKey(targetFile, base.last);
}

function computeModelClasses(classes: ClassInfo[]): Set<string> {
  const isModel = new Set<string>();
  // Seed: direct Django-model bases.
  for (const c of classes) {
    if (c.bases.some((b) => MODEL_BASES.has(b.last))) isModel.add(classKey(c.fileId, c.name));
  }
  // Fixpoint: a class whose base resolves to a known model class is a model too.
  let changed = true;
  let guard = 0;
  while (changed && guard++ < classes.length + 1) {
    changed = false;
    for (const c of classes) {
      const key = classKey(c.fileId, c.name);
      if (isModel.has(key)) continue;
      for (const b of c.bases) {
        const resolved = resolveBaseClass(b, c);
        if (resolved && isModel.has(resolved)) {
          isModel.add(key);
          changed = true;
          break;
        }
      }
    }
  }
  return isModel;
}

// ── Django-app grouping (the headline) ────────────────────────────────────
// An app dir is a package with a marker file (apps.py / models.py / models/). We
// group every in-scope py file under its DEEPEST app-dir ancestor. Ids are derived
// from the app basename with an order-independent dedup ( discipline).
interface AppSeed {
  dir: string; // the app directory (repo-relative)
  baseSlug: string;
  label: string;
}

function appMarkerDirs(pyFileSet: ReadonlySet<string>): Set<string> {
  const dirs = new Set<string>();
  for (const id of pyFileSet) {
    let appDir: string | undefined;
    if (id.endsWith('/apps.py')) appDir = id.slice(0, -'/apps.py'.length);
    else if (id.endsWith('/models.py')) appDir = id.slice(0, -'/models.py'.length);
    else if (id.endsWith('/models/__init__.py')) appDir = id.slice(0, -'/models/__init__.py'.length);
    if (appDir !== undefined && appDir !== '') dirs.add(appDir);
  }
  return dirs;
}

// The verbose_name declared on the app's AppConfig (a plain string literal), or
// undefined (gettext-lazy `_(...)` and non-literals fall back to the dir name).
function appConfigVerboseName(parsed: DjangoParsedFile | undefined): string | undefined {
  if (!parsed) return undefined;
  for (const cls of parsed.classes) {
    if (!classBases(cls).some((b) => b.last === APPCONFIG_BASE)) continue;
    for (const a of classBodyAssignments(cls)) {
      if (nameValue(a.d.leftExpr) !== 'verbose_name') continue;
      const v = stringValue(a.d.rightExpr);
      if (v && v.trim()) return v.trim();
    }
  }
  return undefined;
}

function assignAppGroupIds(seeds: AppSeed[], fileIdsByDir: Map<string, string[]>): FrameworkGroup[] {
  const taken = new Set<string>();
  const byDir = [...seeds].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of byDir) {
    let id = seed.baseSlug;
    if (taken.has(id)) id = `${seed.baseSlug}-${dirSegment(seed.dir)}`;
    let n = 2;
    while (taken.has(id)) id = `${seed.baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label: seed.label, fileIds: (fileIdsByDir.get(seed.dir) ?? []).slice().sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function buildAppGroups(
  pyFiles: string[],
  pyFileSet: ReadonlySet<string>,
  parsed: Map<string, DjangoParsedFile>,
): FrameworkGroup[] {
  const appDirs = [...appMarkerDirs(pyFileSet)].sort((a, b) => b.length - a.length); // deepest first
  if (appDirs.length === 0) return [];
  const fileIdsByDir = new Map<string, string[]>();
  for (const id of pyFiles) {
    const app = appDirs.find((d) => id === d || id.startsWith(`${d}/`));
    if (!app) continue;
    (fileIdsByDir.get(app) ?? fileIdsByDir.set(app, []).get(app)!).push(id);
  }
  const seeds: AppSeed[] = [];
  for (const dir of fileIdsByDir.keys()) {
    const verbose = appConfigVerboseName(parsed.get(`${dir}/apps.py`));
    const label = verbose ?? humanize(baseName(dir));
    seeds.push({ dir, baseSlug: slugify(baseName(dir)) || 'app', label });
  }
  return assignAppGroupIds(seeds, fileIdsByDir);
}

// ── The full analysis ─────────────────────────────────────────────────────

function analyzeDjango(ctx: FrameworkContext): DjangoAnalysis {
  const { parsed, internalIds, roots } = parseDjangoScope(ctx);
  const pyFiles = [...parsed.keys()];
  const pyFileSet = internalIds;

  const roleByFile = new Map<string, DjangoRole>();
  const edges = new Map<string, FrameworkEdge>();
  const diag: DjangoDiag = {
    unresolvedViews: new Set(),
    unresolvedIncludes: new Set(),
    unresolvedRelations: new Set(),
    ambiguousRelations: new Set(),
  };

  // Pass 1 — per-file object vars (DRF routers, Ninja apis, Signals) + a global
  // class index (for transitive model detection + string-FK resolution).
  const drfRouterVarsByFile = new Map<string, Set<string>>();
  const ninjaVarsByFile = new Map<string, Set<string>>();
  const signalVarsByFile = new Map<string, Set<string>>();
  const localClassNamesByFile = new Map<string, Set<string>>();
  const classInfos: ClassInfo[] = [];

  for (const [id, pf] of parsed) {
    const drfRouters = new Set<string>();
    const ninjas = new Set<string>();
    const signals = new Set<string>();
    for (const a of pf.nodes.assignments) {
      const target = nameValue(a.d.leftExpr);
      if (!target) continue;
      const ctor = assignedCtorLast(a.d.rightExpr);
      if (!ctor) continue;
      if (DRF_ROUTER_CTORS.has(ctor)) drfRouters.add(target);
      else if (NINJA_CTORS.has(ctor)) ninjas.add(target);
      else if (ctor === SIGNAL_CTOR) signals.add(target);
    }
    drfRouterVarsByFile.set(id, drfRouters);
    ninjaVarsByFile.set(id, ninjas);
    signalVarsByFile.set(id, signals);

    const localNames = new Set<string>();
    for (const cls of pf.classes) localNames.add(className(cls));
    localClassNamesByFile.set(id, localNames);
  }
  for (const [id, pf] of parsed) {
    const localNames = localClassNamesByFile.get(id)!;
    for (const cls of pf.classes) {
      classInfos.push({
        fileId: id,
        name: className(cls),
        bases: classBases(cls),
        binds: pf.bindings,
        localClasses: localNames,
      });
    }
  }

  const modelClasses = computeModelClasses(classInfos);
  // Model index: className → sorted files that define a model class of that name
  // (for string-target FK resolution: `ForeignKey('Author')`).
  const modelFilesByName = new Map<string, string[]>();
  const modelFiles = new Set<string>();
  for (const info of classInfos) {
    if (!modelClasses.has(classKey(info.fileId, info.name))) continue;
    modelFiles.add(info.fileId);
    const list = modelFilesByName.get(info.name) ?? [];
    if (!list.includes(info.fileId)) list.push(info.fileId);
    modelFilesByName.set(info.name, list.sort());
  }

  // Pass 2 — roles, edges.
  for (const [id, pf] of parsed) {
    const binds = pf.bindings;
    const localClasses = localClassNamesByFile.get(id)!;
    const drfRouters = drfRouterVarsByFile.get(id)!;
    const ninjas = ninjaVarsByFile.get(id)!;
    const localSignals = signalVarsByFile.get(id)!;

    // Resolve a view/router/model reference expr → target file (import binding, or
    // a co-located local class).
    const resolveRef = (expr: ExpressionNode | undefined): string | undefined => {
      const root = refRoot(expr);
      if (!root) return undefined;
      return binds.get(root) ?? (localClasses.has(root) ? id : undefined);
    };
    // Resolve a first-party Signal reference (imported or same-file) → its file.
    const resolveSignal = (expr: ExpressionNode | undefined): string | undefined => {
      const root = refRoot(expr);
      if (!root) return undefined;
      const viaImport = binds.get(root);
      if (viaImport && signalVarsByFile.get(viaImport)?.size) return viaImport;
      if (localSignals.has(root)) return id;
      return undefined;
    };

    // ── Roles from classes ──
    const fileHasFunctionOrClass = pf.nodes.functions.length > 0 || pf.classes.length > 0;
    if (modelFiles.has(id)) addRole(roleByFile, id, 'model');
    for (const cls of pf.classes) {
      const bases = classBases(cls);
      const lasts = bases.map((b) => b.last);
      if (lasts.some((l) => COMMAND_BASES.has(l))) addRole(roleByFile, id, 'command');
      if (lasts.some((l) => l === APPCONFIG_BASE)) addRole(roleByFile, id, 'app-config');
      // Class-based views + DRF ViewSets: base name ends with View/ViewSet.
      if (lasts.some((l) => VIEW_BASE_RE.test(l))) addRole(roleByFile, id, 'view');
    }

    // ── Roles from functions (Ninja ops / DRF @api_view) + views.py convention ──
    for (const fn of pf.nodes.functions) {
      for (const deco of fn.d.decorators) {
        const chain = decoratorChain(deco);
        if (!chain) continue;
        // @<ninjaApi|router>.<httpmethod>(...) → a Ninja route handler.
        if (chain.path.length === 1 && HTTP_METHODS.has(chain.path[0]) && ninjas.has(chain.root)) {
          addRole(roleByFile, id, 'view');
        }
        // @api_view([...]) → a DRF function-based view.
        if (chain.path.length === 0 && FN_VIEW_DECORATORS.has(chain.root)) {
          addRole(roleByFile, id, 'view');
        }
      }
    }
    // The Django convention: a views.py / views/ package module is the request
    // entry (gateway), even for plain function-based views the parser can't
    // fingerprint. Require some content to avoid tagging an empty file.
    if (isViewsFile(id) && fileHasFunctionOrClass) addRole(roleByFile, id, 'view');

    // ── Model relationship edges (FK / OneToOne / ManyToMany) ──
    for (const cls of pf.classes) {
      if (!modelClasses.has(classKey(id, className(cls)))) continue;
      for (const a of classBodyAssignments(cls)) {
        if (!nameValue(a.d.leftExpr)) continue; // a plain `field = …` assignment
        const rhs = a.d.rightExpr;
        if ((rhs as ParseNode).nodeType !== PN.Call) continue;
        const ctorLast = assignedCtorLast(rhs);
        if (!ctorLast || !(ctorLast in RELATION_FIELDS)) continue;
        const relation = RELATION_FIELDS[ctorLast];
        const call = rhs as CallNode;
        const targetArg = positionalArgs(call)[0] ?? keywordArg(call, 'to');
        const target = resolveRelationTarget(targetArg, id, binds, localClasses, modelFilesByName, diag);
        if (target) addEdge(edges, id, target, 'calls', relation);
        else if (targetArg) diag.unresolvedRelations.add(`${id}: ${ctorLast}(…)`);
      }
    }

    // ── URLconf + include() + DRF register + Ninja add_router edges ──
    for (const call of pf.nodes.calls) {
      const callee = callCallee(call);
      if (!callee) continue;

      // path(route, view) / re_path(pat, view) / url(pat, view) — a bare-name call.
      if (callee.path.length === 0 && URLCONF_FNS.has(callee.root)) {
        const viewArg = positionalArgs(call)[1] ?? keywordArg(call, 'view');
        // `include(...)` nested as the view is handled by the include scan below.
        if (viewArg && refRoot(viewArg) === 'include') continue;
        const target = resolveRef(viewArg);
        if (target) addEdge(edges, id, target, 'calls', 'url-route');
        else if (viewArg) diag.unresolvedViews.add(`${id}: ${callee.root}(…)`);
        continue;
      }

      // include('app.urls') / include(module) / include(('app.urls', 'ns')) — a
      // sub-URLconf mount. The tuple form (app-namespacing) wraps the module first.
      if (callee.path.length === 0 && callee.root === 'include') {
        const rawArg = positionalArgs(call)[0];
        const arg = firstTupleItem(rawArg) ?? rawArg;
        const str = arg ? stringValue(arg) : undefined;
        if (str) {
          const target = resolveDottedModule(str, id, internalIds, roots);
          if (target) addEdge(edges, id, target, 'calls', 'url-include');
          else diag.unresolvedIncludes.add(`${id}: include('${str}')`);
        } else {
          const target = resolveRef(arg);
          if (target) addEdge(edges, id, target, 'calls', 'url-include');
          else diag.unresolvedIncludes.add(`${id}: include(…)`);
        }
        continue;
      }

      if (callee.path.length !== 1) continue; // the remaining edges are `obj.method(...)`
      const method = callee.path[0];
      const obj = callee.root;

      // <drfRouter>.register(prefix, ViewSet, …) → routes to the viewset.
      if (method === 'register' && drfRouters.has(obj)) {
        const viewSetArg = positionalArgs(call)[1] ?? keywordArg(call, 'viewset');
        const target = resolveRef(viewSetArg);
        if (target) addEdge(edges, id, target, 'calls', 'drf-register');
        else if (viewSetArg) diag.unresolvedViews.add(`${id}: ${obj}.register(…)`);
        continue;
      }

      // <ninjaApi>.add_router(prefix, router) → mounts a sub-router.
      if (method === 'add_router' && ninjas.has(obj)) {
        const routerArg = positionalArgs(call)[1] ?? keywordArg(call, 'router');
        const target = resolveRef(routerArg);
        if (target) addEdge(edges, id, target, 'calls', 'ninja-add-router');
        else if (routerArg) diag.unresolvedViews.add(`${id}: ${obj}.add_router(…)`);
        continue;
      }

      // <signal>.send(...) / .send_robust(...) → publishes; .connect(...) → subscribes.
      if (method === 'send' || method === 'send_robust' || method === 'connect') {
        const sigFile = resolveSignal(memberBaseExpr(call));
        if (sigFile) {
          if (method === 'connect') addEdge(edges, id, sigFile, 'subscribes', 'signal-connect');
          else addEdge(edges, id, sigFile, 'publishes', 'signal-send');
        }
        continue;
      }
    }

    // ── @receiver(signal, sender=Model) decorators → pub/sub edges ──
    for (const fn of pf.nodes.functions) {
      for (const deco of fn.d.decorators) {
        const chain = decoratorChain(deco);
        if (!chain || chain.path.length !== 0 || chain.root !== 'receiver') continue;
        const call = decoratorCall(deco);
        if (!call) continue;
        // receiver subscribes to a first-party Signal.
        const sigTarget = resolveSignal(positionalArgs(call)[0] ?? keywordArg(call, 'signal'));
        if (sigTarget) addEdge(edges, id, sigTarget, 'subscribes', 'signal-receiver');
        // sender=Model → the model publishes its lifecycle event to this receiver.
        const senderArg = keywordArg(call, 'sender');
        const senderFile = resolveRef(senderArg);
        if (senderFile && modelFiles.has(senderFile)) {
          addEdge(edges, senderFile, id, 'publishes', 'signal-sender');
        }
      }
    }
  }

  const groups = buildAppGroups(pyFiles, pyFileSet, parsed);

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'django' },
    });
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source
      ? -1
      : a.source > b.source
        ? 1
        : a.target < b.target
          ? -1
          : a.target > b.target
            ? 1
            : a.kind < b.kind
              ? -1
              : a.kind > b.kind
                ? 1
                : 0,
  );

  // Positive signal for validation (mirrors fastapi/nest).
  if (groups.length > 0 || roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [django] ${groups.length} app group(s) · ${roleByFile.size} role(s) · ${sortedEdges.length} edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  const degraded: string[] = [];
  if (diag.unresolvedViews.size > 0)
    degraded.push(`${diag.unresolvedViews.size} unresolvable view(s): ${[...diag.unresolvedViews].sort().slice(0, 10).join(' · ')}`);
  if (diag.unresolvedIncludes.size > 0)
    degraded.push(`${diag.unresolvedIncludes.size} unresolvable include(s): ${[...diag.unresolvedIncludes].sort().slice(0, 10).join(' · ')}`);
  if (diag.unresolvedRelations.size > 0)
    degraded.push(`${diag.unresolvedRelations.size} unresolvable relation(s): ${[...diag.unresolvedRelations].sort().slice(0, 10).join(' · ')}`);
  if (diag.ambiguousRelations.size > 0)
    degraded.push(`${diag.ambiguousRelations.size} ambiguous string-model relation(s): ${[...diag.ambiguousRelations].sort().slice(0, 10).join(' · ')}`);
  if (degraded.length > 0) {
    console.log(`  [django] degraded: ${degraded.join(' · ')} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

// The base expression of an `obj.method(...)` call (the receiver `obj`) — used to
// resolve a `<signal>.send()` / `.connect()` receiver back to its Signal file.
function memberBaseExpr(call: CallNode): ExpressionNode | undefined {
  const leftExpr = call.d.leftExpr as ParseNode;
  if (leftExpr.nodeType !== PN.MemberAccess) return undefined;
  return (leftExpr as unknown as { d: { leftExpr: ExpressionNode } }).d.leftExpr;
}

// Resolve a `path`/`re_path` `include('dotted.module')` string to a first-party
// module file via the extractor's path-anchored resolver (`app.urls` → app/urls.py).
function resolveDottedModule(
  dotted: string,
  fromId: string,
  internalIds: ReadonlySet<string>,
  roots: readonly string[],
): string | undefined {
  const clean = dotted.trim();
  if (!clean || clean.includes('://')) return undefined;
  return syntacticResolve(clean, fromId, internalIds, roots);
}

// Resolve a model-relationship target (`ForeignKey(Author)` / `('Author')` /
// `('app.Author')` / `('self')`) to the model's file.
function resolveRelationTarget(
  arg: ExpressionNode | undefined,
  fromId: string,
  binds: ReadonlyMap<string, string>,
  localClasses: ReadonlySet<string>,
  modelFilesByName: ReadonlyMap<string, string[]>,
  diag: DjangoDiag,
): string | undefined {
  if (!arg) return undefined;
  // String target: 'self' | 'ModelName' | 'app_label.ModelName'.
  const str = stringValue(arg);
  if (str !== undefined) {
    if (str === 'self' || str === '') return undefined; // self-reference → no edge
    const modelName = str.includes('.') ? str.split('.').pop()! : str;
    const files = modelFilesByName.get(modelName);
    if (!files || files.length === 0) return undefined;
    if (files.length > 1) diag.ambiguousRelations.add(`'${str}'→${files.join(',')}`);
    return files[0]; // sorted → deterministic pick on ambiguity
  }
  // Class reference: `Author` (imported / local) or `pkg.Author`.
  const root = refRoot(arg);
  if (!root) return undefined;
  return binds.get(root) ?? (localClasses.has(root) ? fromId : undefined);
}

function getAnalysis(ctx: FrameworkContext): DjangoAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeDjango(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const djangoAdapter: FrameworkAdapter = {
  name: 'django',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose manifest/manage.py is at root → rootPath '').
    const rootMatch = scoreDjango(gatherDjangoSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // Nested backend (`backend/` | `server/` | `src/` Django package) — a shallow
    // scan of immediate subdirs, scoping the adapter to the first match. Only when
    // NOT already scoped to a workspace package (that's the per-package fan-out).
    if (!ctx.packageDir) {
      for (const sub of shallowScanSubdirs(base)) {
        const m = scoreDjango(gatherDjangoSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // One grouping prior per Django app → its own subsystem, authoritative over
  // directory grouping (the Nest/RN mechanism). Fully deterministic (path/name-
  // derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // URLconf / include / FK-O2O-M2M / DRF-register / Ninja-add-router / signals.
  // File-id endpoints; the step resolves to modules, drops self-edges, dedupes,
  // 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // view/viewset/ninja-op → gateway; model module → service; Command → job;
  // AppConfig → service. METADATA; the module's `kind` is unchanged.
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
