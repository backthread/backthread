// (Slice 1) — the FastAPI FrameworkAdapter. The FIRST Python framework
// adapter, and the first adapter driven by Pyright's parser instead of ts-morph.
// Net-new (not an adaptation of the JS adapters); detects against pyproject.toml /
// requirements*.txt, not package.json.
//
// FastAPI declares its request surface structurally, which we read STATICALLY
// (install-free, never-store-source — parse server-side, persist only the derived
// groups/edges/roles) via a pure syntactic Pyright parse (scripts/…/py-ast.ts):
//
//   * detect()        — the `fastapi` dependency.
//   * groupingPrior   — one FrameworkGroup per APIRouter that declares routes, so a
//                       flat `app/api/routes/` folder splits into per-domain
//                       subsystems (Users / Items / Login) instead of one "routes"
//                       box. Same mechanism the RN navigator prior uses (/728):
//                       the contribute-step makes each group its own subsystem,
//                       authoritative over the directory heuristic.
//   * syntheticEdges  — the framework wiring the import graph doesn't name as verbs:
//                       `include_router` mounting (kind 'calls') and `add_api_route`
//                       endpoint binding (kind 'calls').
//   * roleTags        — FastAPI app / APIRouter / route handler → `gateway`.
//                       METADATA onto the LOCKED MODULE_KINDS enum; never a new
//                       kind (the module's `kind` is unchanged — only `role` is
//                       rendered).
//
// Unresolvable include_router targets DEGRADE + LOG — no silent caps.
//
// Celery is a SEPARATE, standalone adapter (, framework/celery/) that fires
// on any celery repo — the task roles + enqueue/canvas/beat edges it used to emit
// from here were extracted so a non-FastAPI celery worker gets them too,
// and so a FastAPI + Celery repo isn't double-emitted (both adapters co-apply).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readPythonDeps } from '../../graph/python-manifest.js';
import { inferSourceRoots } from '../../graph/python-adapter.js';
import { buildImportBindings, inScope, isPythonFile } from '../python/analyze.js';
import {
  callCallee,
  collectNodes,
  firstListString,
  keywordArg,
  memberChain,
  nameValue,
  parsePython,
  positionalArgs,
  stringValue,
  PN,
  type CollectedNodes,
} from '../python/py-ast.js';
import type {
  CallNode,
  DecoratorNode,
  ExpressionNode,
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
// Detection (fs → deps; PURE scorer). Never reads source content.

/** The deterministic FastAPI signal set (dependency names only). */
export interface FastApiSignals {
  hasFastApi: boolean; // fastapi — the authoritative signal
  hasUvicorn: boolean; // uvicorn — the FastAPI/ASGI server (supporting)
}

/** Gather the signal set for a single root dir (reads manifests only). */
export function gatherFastApiSignals(baseDir: string): FastApiSignals {
  const deps = readPythonDeps(baseDir);
  return {
    hasFastApi: deps.has('fastapi'),
    hasUvicorn: deps.has('uvicorn'),
  };
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
 * Immediate subdirs (depth 1) that contain a Python manifest — the shallow search
 * for a nested FastAPI backend (`backend/` | `server/` | `api/`). Sorted, so the
 * first-match pick is deterministic; skips dot-dirs + non-source dirs to stay cheap.
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
 * Decide FastAPI from the signal set. `fastapi` is REQUIRED (starlette alone is
 * not FastAPI — don't claim it); uvicorn raises confidence. Returns null →
 * generic-Python fallthrough, byte-for-byte unchanged.
 */
export function scoreFastApi(s: FastApiSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasFastApi) return null;
  let confidence = 0.8;
  if (s.hasUvicorn) confidence += 0.1;
  return {
    adapter: 'fastapi',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: { fastapi: s.hasFastApi, uvicorn: s.hasUvicorn },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind`
// is unchanged. app / router / route-handler are all request entries → gateway.
export type FastApiRole = 'app' | 'router' | 'route-handler';

// Collapse priority when one FILE carries several roles, AND downstream when
// several files of different roles land in one module. app (the FastAPI entry)
// outranks a concrete route-handler file (a leaf router that DECLARES routes)
// outranks a pure mounting router (an aggregator with no own routes). A leaf
// router is both `router` + `route-handler`, and reads as `route-handler` (where
// requests are actually served) — the more informative label; the bare aggregator
// stays `router`.
const ROLE_PRIORITY: Record<FastApiRole, number> = {
  app: 8,
  'route-handler': 7,
  router: 6,
};
const ROLE_KIND: Record<FastApiRole, ModuleKind> = {
  app: 'gateway',
  router: 'gateway',
  'route-handler': 'gateway',
};

// The APIRouter/app methods whose decorated function is a route handler.
const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'trace',
  'api_route',
  'websocket',
]);

// ---------------------------------------------------------------------------
// Analysis.

interface RouterMeta {
  tag?: string; // first `tags=[…]` entry
  prefix?: string; // `prefix="…"`
}

interface FastApiAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface FastApiDiag {
  unresolvedMounts: Set<string>; // include_router / add_api_route args we couldn't map
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx gets a fresh analysis — no cross-tree staleness. Mirrors nest / RN.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, FastApiAnalysis>();

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

function baseName(fileId: string): string {
  const last = fileId.split('/').pop() ?? fileId;
  return last.replace(/\.[^.]+$/, '');
}

function dirSegment(fileId: string): string {
  const slash = fileId.indexOf('/');
  return slash > 0 ? slugify(fileId.slice(0, slash)) : 'root';
}

// Keep the highest-priority candidate role per file (deterministic, lexical
// tiebreak) — mirrors the nest/RN addRole + the contribute-step's module collapse.
function addRole(map: Map<string, FastApiRole>, fileId: string, role: FastApiRole): void {
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
  if (from === to) return; // intra-file mounting collapses; the step drops self-edges too
  const key = `${from}→${to}:${kind}`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind, metadata: { framework: 'fastapi', relation } });
  }
}

// The constructor name of an `x = Ctor(...)` assignment RHS (last chain segment,
// so both `FastAPI(...)` and `fastapi.FastAPI(...)` read as 'FastAPI'), or undefined.
function assignedCtorName(rhs: ExpressionNode): string | undefined {
  if ((rhs as ParseNode).nodeType !== PN.Call) return undefined;
  const callee = callCallee(rhs as CallNode);
  if (!callee) return undefined;
  return callee.path.length ? callee.path[callee.path.length - 1] : callee.root;
}

function readRouterMeta(call: CallNode): RouterMeta {
  return {
    tag: firstListString(keywordArg(call, 'tags')),
    prefix: stringValue(keywordArg(call, 'prefix')),
  };
}

// A decorator's callee chain (`@router.get(...)` → root 'router', path ['get'];
// `@shared_task` → root 'shared_task', path []). The decorator expr is either a
// call (with args) or a bare name/attribute.
function decoratorChain(deco: DecoratorNode): { root: string; path: string[] } | undefined {
  const expr = deco.d.expr;
  if ((expr as ParseNode).nodeType === PN.Call) return callCallee(expr as CallNode);
  return memberChain(expr);
}

// Resolve an include_router / add_api_route target expression to a file id via the
// file's import bindings: `users.router` → root 'users' → its module file;
// `router` → the imported symbol's file. Undefined when the root isn't imported.
function resolveMountTarget(
  expr: ExpressionNode | undefined,
  binds: ReadonlyMap<string, string>,
): string | undefined {
  const chain = expr ? memberChain(expr) : undefined;
  if (!chain) return undefined;
  return binds.get(chain.root);
}


// Deterministic, collision-free group id per router ( discipline): named by
// its first tag, else its prefix, else its variable name, else the file basename.
// Sorted by fileId so the SMALLEST fileId wins a bare slug; collisions take a
// `-<dirSegment>` then `-<n>` suffix. Order is the stable fileId order, so the id
// set is identical run-to-run (the snapshot grouping-stability invariant).
interface RouterGroupSeed {
  fileId: string;
  baseSlug: string;
  label: string;
}

function routerGroupName(meta: RouterMeta, varName: string, fileId: string): string {
  if (meta.tag) return meta.tag;
  if (meta.prefix) {
    const p = meta.prefix.replace(/^\/+|\/+$/g, '');
    if (p) return p;
  }
  if (varName && varName !== 'router') return varName;
  return baseName(fileId);
}

function assignRouterGroups(seeds: RouterGroupSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const byFileId = [...seeds].sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of byFileId) {
    let id = seed.baseSlug;
    if (taken.has(id)) id = `${seed.baseSlug}-${dirSegment(seed.fileId)}`;
    let n = 2;
    while (taken.has(id)) id = `${seed.baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label: seed.label, fileIds: [seed.fileId] });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function analyzeFastApi(ctx: FrameworkContext): FastApiAnalysis {
  const { repoDir, rootPath, graph } = ctx;

  const pyFiles = graph.files
    .filter((f) => isPythonFile(f.language) && inScope(f.id, rootPath))
    .map((f) => f.id);
  const internalIds = new Set(pyFiles);
  // inferred source roots so a nested backend (`backend/app/`) resolves
  // its own imports (include_router targets, etc.) in a polyglot repo.
  const roots = inferSourceRoots(internalIds);

  // Parse every in-scope Python file once; build per-file import bindings.
  const parsed = new Map<string, CollectedNodes>();
  const bindings = new Map<string, Map<string, string>>();
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
    parsed.set(id, nodes);
    bindings.set(id, buildImportBindings(id, nodes.imports, internalIds, roots));
  }

  // Pass 1 — per-file app / router object variables (file-scoped, which matches
  // how these module-level singletons are used).
  const appVarsByFile = new Map<string, Set<string>>();
  const routerVarsByFile = new Map<string, Map<string, RouterMeta>>();
  for (const [id, nodes] of parsed) {
    const appVars = new Set<string>();
    const routerVars = new Map<string, RouterMeta>();
    for (const a of nodes.assignments) {
      const target = nameValue(a.d.leftExpr);
      if (!target) continue;
      const ctor = assignedCtorName(a.d.rightExpr);
      if (ctor === 'FastAPI') appVars.add(target);
      else if (ctor === 'APIRouter') routerVars.set(target, readRouterMeta(a.d.rightExpr as CallNode));
    }
    appVarsByFile.set(id, appVars);
    routerVarsByFile.set(id, routerVars);
  }

  // Pass 2 — roles, edges, grouping seeds.
  const roleByFile = new Map<string, FastApiRole>();
  const edges = new Map<string, FrameworkEdge>();
  const groupSeeds: RouterGroupSeed[] = [];
  const diag: FastApiDiag = { unresolvedMounts: new Set() };

  for (const [id, nodes] of parsed) {
    const appVars = appVarsByFile.get(id)!;
    const routerVars = routerVarsByFile.get(id)!;
    const binds = bindings.get(id)!;
    const routersWithRoutes = new Set<string>();

    // Route decorators.
    for (const fn of nodes.functions) {
      for (const deco of fn.d.decorators) {
        const chain = decoratorChain(deco);
        if (!chain) continue;
        // @<router|app>.<httpmethod>(...) → a route handler.
        if (chain.path.length === 1 && HTTP_METHODS.has(chain.path[0])) {
          if (routerVars.has(chain.root)) routersWithRoutes.add(chain.root);
          if (routerVars.has(chain.root) || appVars.has(chain.root)) addRole(roleByFile, id, 'route-handler');
        }
      }
    }

    // App / router object files are gateways (even a pure aggregator router with
    // no own routes — it mounts sub-routers).
    if (appVars.size > 0) addRole(roleByFile, id, 'app');
    if (routerVars.size > 0) addRole(roleByFile, id, 'router');

    // Grouping seed: each router that DECLARES routes becomes its own subsystem
    // (a pure aggregator with no routes stays in directory grouping — it's the
    // routing spine, not a domain).
    for (const rv of routersWithRoutes) {
      const meta = routerVars.get(rv)!;
      const name = routerGroupName(meta, rv, id);
      groupSeeds.push({ fileId: id, baseSlug: slugify(name) || 'router', label: humanize(name) || name });
    }

    // Mounting edges.
    for (const call of nodes.calls) {
      const callee = callCallee(call);
      if (!callee || callee.path.length !== 1) continue; // want `obj.method(...)`
      const method = callee.path[0];
      const obj = callee.root;

      if (method === 'include_router' && (routerVars.has(obj) || appVars.has(obj))) {
        const target = resolveMountTarget(positionalArgs(call)[0], binds);
        if (target) addEdge(edges, id, target, 'calls', 'include-router');
        else diag.unresolvedMounts.add(`${id}: ${obj}.include_router(…)`);
      } else if (
        (method === 'add_api_route' || method === 'add_websocket_route') &&
        (routerVars.has(obj) || appVars.has(obj))
      ) {
        // endpoint is the 2nd positional arg or `endpoint=`.
        const endpoint = keywordArg(call, 'endpoint') ?? positionalArgs(call)[1];
        const target = resolveMountTarget(endpoint, binds);
        if (target) addEdge(edges, id, target, 'calls', 'route-handler');
        else diag.unresolvedMounts.add(`${id}: ${obj}.${method}(…)`);
      }
    }
  }

  const groups = assignRouterGroups(groupSeeds);

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'fastapi' },
    });
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );

  // Positive signal for validation (mirrors nest's log line).
  if (groups.length > 0 || roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [fastapi] ${roleByFile.size} role(s) · ${groups.length} router group(s) · ${sortedEdges.length} edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  if (diag.unresolvedMounts.size > 0) {
    const detail = `${diag.unresolvedMounts.size} unresolvable mount(s): ${[...diag.unresolvedMounts].sort().slice(0, 10).join(' · ')}`;
    console.log(`  [fastapi] degraded: ${detail} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): FastApiAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeFastApi(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// the backend API surface the cross-language linker matches frontend
// URLs against. A focused re-parse (the linker has no FrameworkContext): each
// APIRouter file + its literal prefix(es), plus the FastAPI app file(s) (the
// coarse fallback target). Install-free, deterministic, never executes repo code.

export interface FastApiRouteSurface {
  /** APIRouter files + their literal `prefix=` values (may be empty for a router with none). */
  routers: Array<{ fileId: string; prefixes: string[] }>;
  /** FastAPI() app files — the gateway entry the linker falls back to. */
  appFiles: string[];
}

export function collectFastApiRouteSurface(
  repoDir: string,
  pyFileIds: readonly string[],
): FastApiRouteSurface {
  const routers: Array<{ fileId: string; prefixes: string[] }> = [];
  const appFiles: string[] = [];
  for (const id of pyFileIds) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, id), 'utf8');
    } catch {
      continue;
    }
    const tree = parsePython(text);
    if (!tree) continue;
    const nodes = collectNodes(tree);
    const prefixes: string[] = [];
    let isApp = false;
    for (const a of nodes.assignments) {
      if (!nameValue(a.d.leftExpr)) continue;
      const ctor = assignedCtorName(a.d.rightExpr);
      if (ctor === 'FastAPI') isApp = true;
      else if (ctor === 'APIRouter') {
        const meta = readRouterMeta(a.d.rightExpr as CallNode);
        if (meta.prefix) prefixes.push(meta.prefix);
      }
    }
    if (isApp) appFiles.push(id);
    // A file that defines an APIRouter is part of the surface even with no prefix.
    if (nodes.assignments.some((a) => assignedCtorName(a.d.rightExpr) === 'APIRouter')) {
      routers.push({ fileId: id, prefixes: [...new Set(prefixes)].sort() });
    }
  }
  routers.sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
  appFiles.sort();
  return { routers, appFiles };
}

// ---------------------------------------------------------------------------
// The adapter.

export const fastApiAdapter: FrameworkAdapter = {
  name: 'fastapi',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (backward-compatible: a repo whose pyproject is at root
    // reports rootPath '').
    const rootMatch = scoreFastApi(gatherFastApiSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // the FastAPI backend often lives one dir down (a `backend/` |
    // `server/` | `api/` package in a frontend+backend monorepo), so a root-only
    // scan misses it and the polyglot backend gets no roles/grouping. Shallow-scan
    // immediate subdirs for a fastapi manifest and scope the adapter to it. Only
    // when NOT already scoped to a workspace package (that's the  path).
    if (!ctx.packageDir) {
      for (const sub of shallowManifestSubdirs(base)) {
        const m = scoreFastApi(gatherFastApiSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // One grouping prior per route-declaring APIRouter → its own subsystem,
  // authoritative over directory grouping (the RN/nest mechanism). Fully
  // deterministic (tag/prefix/name-derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // include_router / add_api_route mounting (kind 'calls'). File-id endpoints;
  // the step resolves to modules, drops self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // app / router / route-handler → gateway. METADATA; the module's `kind` is
  // unchanged.
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
