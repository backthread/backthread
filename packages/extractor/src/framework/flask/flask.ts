// the Flask FrameworkAdapter. Net-new adapter following the FastAPI
// template, reusing the shared Python core (py-ast +
// parsePythonScope). Flask has NO built-in ORM — SQLAlchemy is a separate
// adapter; this one is purely routes / blueprints / CLI.
//
// Flask declares its request surface with Blueprint objects + route decorators,
// which we read STATICALLY (install-free, never-store-source — a pure syntactic
// Pyright parse; never executes repo code), and persist only the derived
// groups/edges/roles:
//
//   * detect()        — the `flask` dependency (a flask-* extension raises
//                       confidence); shallow nested scan for a `backend/`|`server/`
//                       package (mirrors FastAPI's ).
//   * groupingPrior   — one FrameworkGroup per Blueprint (its defining file + the
//                       files that register routes / CLI commands to it), so a
//                       flat package splits into per-domain subsystems (Auth / Main
//                       / Api) instead of one folder box. Same mechanism the
//                       FastAPI router prior / Nest @Module prior use: the
//                       contribute-step makes each group its own subsystem,
//                       authoritative over the directory heuristic.
//   * syntheticEdges  — the wiring the import graph doesn't name as verbs:
//                       `app.register_blueprint(bp)` mounting (kind 'calls') and
//                       `add_url_rule(rule, endpoint, view_func=X)` where X is a
//                       cross-file view (kind 'calls'). Decorator routes
//                       (`@app.route`/`@bp.route`) are SAME-FILE → they're the
//                       ROLE, not an edge.
//   * roleTags        — Flask app / Blueprint object files + `@app.route`/
//                       `@bp.route` handlers → `gateway`; `@app.cli.command`/
//                       `@bp.cli.command` → `job`. METADATA onto the LOCKED
//                       MODULE_KINDS enum; never a new kind (only `role` renders).
//
// Unresolvable register_blueprint / add_url_rule targets DEGRADE + LOG — no
// silent caps.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readPythonDeps } from '../../graph/python-manifest.js';
import { parsePythonScope } from '../python/analyze.js';
import {
  callCallee,
  keywordArg,
  memberChain,
  nameValue,
  positionalArgs,
  stringValue,
  PN,
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

/** The deterministic Flask signal set (dependency names only). */
export interface FlaskSignals {
  hasFlask: boolean; // flask — the authoritative signal
  hasFlaskExtension: boolean; // any `flask-*` extension (flask-login, -sqlalchemy, …)
}

/** Gather the signal set for a single root dir (reads manifests only). */
export function gatherFlaskSignals(baseDir: string): FlaskSignals {
  const deps = readPythonDeps(baseDir);
  return {
    hasFlask: deps.has('flask'),
    // A flask-* extension is a strong secondary signal that this really is a
    // Flask app (vs. `flask` pulled in transitively for some CLI shim).
    hasFlaskExtension: [...deps].some((d) => d.startsWith('flask-')),
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
 * for a nested Flask backend (`backend/` | `server/` | `api/`). Sorted, so the
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
 * Decide Flask from the signal set. `flask` is REQUIRED; a `flask-*` extension
 * raises confidence. Returns null → generic-Python fallthrough, byte-for-byte
 * unchanged.
 */
export function scoreFlask(s: FlaskSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasFlask) return null;
  let confidence = 0.8;
  if (s.hasFlaskExtension) confidence += 0.1;
  return {
    adapter: 'flask',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: { flask: s.hasFlask, flaskExtension: s.hasFlaskExtension },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind`
// is unchanged. app / blueprint object files + route handlers are all request
// entries → gateway; a CLI command is schedule/command-triggered own-code → job.
export type FlaskRole = 'app' | 'route-handler' | 'blueprint' | 'cli-command';

// Collapse priority when one FILE carries several roles, AND downstream when
// several files of different roles land in one module. app (the Flask entry)
// outranks a concrete route-handler outranks a bare Blueprint object file (the
// definer that mounts routes declared elsewhere); a CLI command is distinct. A
// single-file blueprint that BOTH defines `bp` and decorates routes reads as
// `route-handler` (where requests are served) — the more informative label.
const ROLE_PRIORITY: Record<FlaskRole, number> = {
  app: 8,
  'route-handler': 7,
  blueprint: 6,
  'cli-command': 5,
};
const ROLE_KIND: Record<FlaskRole, ModuleKind> = {
  app: 'gateway',
  'route-handler': 'gateway',
  blueprint: 'gateway',
  'cli-command': 'job',
};

// The app/blueprint decorator methods whose decorated function is a route
// handler: the catch-all `@bp.route(...)` plus Flask 2.0's HTTP-method shortcuts.
// Flask only ships `get/post/put/delete/patch` as decorator shortcuts — HEAD /
// OPTIONS are served via `route(..., methods=[…])`, not their own decorators.
const ROUTE_METHODS = new Set(['route', 'get', 'post', 'put', 'patch', 'delete']);

// ---------------------------------------------------------------------------
// Analysis.

interface BlueprintMeta {
  name?: string; // the first positional string arg of Blueprint('name', …)
}

// One Blueprint definition: keyed by definer file + var name (a file may define
// more than one). The group accumulates its defining file + every file that
// registers a route / CLI command to it.
interface BlueprintSeed {
  key: string; // `${definerFileId}#${varName}` — stable per-blueprint identity
  definerFileId: string;
  varName: string;
  baseSlug: string; // pre-dedup id slug (assignBlueprintGroups finalizes the id)
  label: string; // humanized subsystem label
  fileIds: Set<string>; // definer + route/cli files registered to this blueprint
}

interface FlaskAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface FlaskDiag {
  unresolvedMounts: Set<string>; // register_blueprint args we couldn't map
  unresolvedViews: Set<string>; // add_url_rule view_func we couldn't map
  ambiguousBlueprints: Set<string>; // a route/cli decorator we couldn't attribute to one bp
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx gets a fresh analysis — no cross-tree staleness. Mirrors fastapi / nest.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, FlaskAnalysis>();

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

// The label source for a blueprint definer file — its basename, but a package
// blueprint lives in `<pkg>/__init__.py`, whose basename ('__init__') is useless,
// so fall back to the package dir name (`app/auth/__init__.py` → 'auth'). Generic
// definer basenames (`blueprint`/`bp`) get the same treatment.
function moduleLabelSource(fileId: string): string {
  const parts = fileId.split('/');
  const last = (parts[parts.length - 1] ?? fileId).replace(/\.[^.]+$/, '');
  if ((last === '__init__' || last === 'blueprint' || last === 'bp') && parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return last;
}

function dirSegment(fileId: string): string {
  const slash = fileId.indexOf('/');
  return slash > 0 ? slugify(fileId.slice(0, slash)) : 'root';
}

// Keep the highest-priority candidate role per file (deterministic, lexical
// tiebreak) — mirrors the fastapi/nest addRole + the contribute-step's collapse.
function addRole(map: Map<string, FlaskRole>, fileId: string, role: FlaskRole): void {
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
    edges.set(key, { source: from, target: to, kind, metadata: { framework: 'flask', relation } });
  }
}

// The constructor name of an `x = Ctor(...)` assignment RHS (last chain segment,
// so both `Flask(...)` and `flask.Flask(...)` read as 'Flask'), or undefined.
function assignedCtorName(rhs: ExpressionNode): string | undefined {
  if ((rhs as ParseNode).nodeType !== PN.Call) return undefined;
  const callee = callCallee(rhs as CallNode);
  if (!callee) return undefined;
  return callee.path.length ? callee.path[callee.path.length - 1] : callee.root;
}

// A decorator's callee chain (`@bp.route(...)` → root 'bp', path ['route'];
// `@app.cli.command(...)` → root 'app', path ['cli','command']). The decorator
// expr is a call (Flask decorators are always called); a bare decorator is skipped.
function decoratorChain(deco: DecoratorNode): { root: string; path: string[] } | undefined {
  const expr = deco.d.expr;
  if ((expr as ParseNode).nodeType === PN.Call) return callCallee(expr as CallNode);
  return memberChain(expr);
}

// Resolve a view_func expression to a file id: a bare `view_func=index` → its
// imported file; a `view_func=SomeView.as_view('x')` → the class's file (the
// callee's chain root); undefined when the root isn't imported.
function resolveViewTarget(
  expr: ExpressionNode | undefined,
  binds: ReadonlyMap<string, string>,
): string | undefined {
  if (!expr) return undefined;
  const chain =
    (expr as ParseNode).nodeType === PN.Call
      ? callCallee(expr as CallNode) // SomeView.as_view(...) → root 'SomeView'
      : memberChain(expr); // index / mod.index → root
  if (!chain) return undefined;
  return binds.get(chain.root);
}

// Blueprint group id: named by its registered Blueprint('name', …) string, else
// its var name (when not the generic `bp`/`blueprint`), else the definer's
// package name. Slug is de-collided by assignBlueprintGroups.
function blueprintGroupName(meta: BlueprintMeta, varName: string, definerFileId: string): string {
  if (meta.name) return meta.name;
  if (varName && varName !== 'bp' && varName !== 'blueprint') return varName;
  return moduleLabelSource(definerFileId);
}

// Assign each blueprint its final, collision-free group id ORDER-INDEPENDENTLY:
// process seeds by (definerFileId, varName) so the SMALLEST wins the bare slug,
// and later collisions take a `-<dirSegment>` then `-<n>` suffix. The order is
// stable (not an iteration index), so the id set is identical run-to-run — the
// snapshot grouping-stability invariant.
function assignBlueprintGroups(seeds: BlueprintSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const ordered = [...seeds].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of ordered) {
    let id = seed.baseSlug;
    if (taken.has(id)) id = `${seed.baseSlug}-${dirSegment(seed.definerFileId)}`;
    let n = 2;
    while (taken.has(id)) id = `${seed.baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label: seed.label, fileIds: [...seed.fileIds].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function analyzeFlask(ctx: FrameworkContext): FlaskAnalysis {
  const { parsed } = parsePythonScope(ctx);

  // Pass 1 — per-file Flask app + Blueprint object variables (file-scoped, which
  // matches how these module-level singletons are used).
  const appVarsByFile = new Map<string, Set<string>>();
  const blueprintVarsByFile = new Map<string, Map<string, BlueprintMeta>>();
  for (const [id, file] of parsed) {
    const appVars = new Set<string>();
    const blueprintVars = new Map<string, BlueprintMeta>();
    for (const a of file.nodes.assignments) {
      const target = nameValue(a.d.leftExpr);
      if (!target) continue;
      const ctor = assignedCtorName(a.d.rightExpr);
      if (ctor === 'Flask') appVars.add(target);
      else if (ctor === 'Blueprint') {
        const call = a.d.rightExpr as CallNode;
        blueprintVars.set(target, { name: stringValue(positionalArgs(call)[0]) });
      }
    }
    appVarsByFile.set(id, appVars);
    blueprintVarsByFile.set(id, blueprintVars);
  }

  // Files that construct a Flask() app — so an imported app (`from app import app`
  // + `@app.route` in a routes module) is recognized as an app route.
  const appDefinerFiles = new Set<string>();
  for (const [f, vars] of appVarsByFile) if (vars.size > 0) appDefinerFiles.add(f);

  // Blueprint definition seeds, keyed by definer file + var name. Every defined
  // Blueprint is its own subsystem (the definer file is the minimum membership).
  const seedsByKey = new Map<string, BlueprintSeed>();
  // definer fileId → its blueprints (for import-resolved decorator attribution).
  const blueprintsByDefiner = new Map<string, Array<{ varName: string; key: string }>>();
  for (const [id, blueprintVars] of blueprintVarsByFile) {
    for (const [varName, meta] of blueprintVars) {
      const key = `${id}#${varName}`;
      const name = blueprintGroupName(meta, varName, id);
      seedsByKey.set(key, {
        key,
        definerFileId: id,
        varName,
        baseSlug: slugify(name) || 'blueprint',
        label: humanize(name) || name,
        fileIds: new Set([id]),
      });
      const list = blueprintsByDefiner.get(id) ?? [];
      list.push({ varName, key });
      blueprintsByDefiner.set(id, list);
    }
  }

  const roleByFile = new Map<string, FlaskRole>();
  const edges = new Map<string, FrameworkEdge>();
  const diag: FlaskDiag = {
    unresolvedMounts: new Set(),
    unresolvedViews: new Set(),
    ambiguousBlueprints: new Set(),
  };

  // Classify a `@<root>.…` decorator's root: which Blueprint (by key) or the app,
  // resolving same-file vars first, then import bindings to a definer/app file.
  function classifyDecoratorRoot(
    thisFile: string,
    root: string,
    binds: ReadonlyMap<string, string>,
  ): { kind: 'blueprint'; key: string } | { kind: 'app' } | undefined {
    if (blueprintVarsByFile.get(thisFile)?.has(root)) {
      return { kind: 'blueprint', key: `${thisFile}#${root}` };
    }
    if (appVarsByFile.get(thisFile)?.has(root)) return { kind: 'app' };
    const target = binds.get(root);
    if (target) {
      const bps = blueprintsByDefiner.get(target);
      if (bps && bps.length > 0) {
        // Prefer the blueprint whose var name matches the imported local name
        // (`from app.auth import bp` → root 'bp'); else, if the definer holds
        // exactly one blueprint, it's unambiguous; else DEGRADE.
        const exact = bps.find((b) => b.varName === root);
        if (exact) return { kind: 'blueprint', key: exact.key };
        if (bps.length === 1) return { kind: 'blueprint', key: bps[0].key };
        diag.ambiguousBlueprints.add(`${thisFile}: @${root}.… (multiple blueprints in ${target})`);
        return undefined;
      }
      if (appDefinerFiles.has(target)) return { kind: 'app' };
    }
    return undefined;
  }

  for (const [id, file] of parsed) {
    const appVars = appVarsByFile.get(id)!;
    const blueprintVars = blueprintVarsByFile.get(id)!;
    const binds = file.bindings;

    // Route + CLI decorators.
    for (const fn of file.nodes.functions) {
      for (const deco of fn.d.decorators) {
        const chain = decoratorChain(deco);
        if (!chain) continue;
        const isRoute = chain.path.length === 1 && ROUTE_METHODS.has(chain.path[0]);
        // `@app.cli.command`/`@bp.cli.command` and the group form `@bp.cli.group`
        // both register own-code onto the app/blueprint CLI (a `job`, not a
        // request entry).
        const isCli =
          chain.path.length === 2 &&
          chain.path[0] === 'cli' &&
          (chain.path[1] === 'command' || chain.path[1] === 'group');
        if (!isRoute && !isCli) continue;
        const target = classifyDecoratorRoot(id, chain.root, binds);
        if (!target) continue; // not a recognizable Flask app/blueprint decorator
        addRole(roleByFile, id, isRoute ? 'route-handler' : 'cli-command');
        // A route/cli decorator registers this file to its blueprint's subsystem.
        if (target.kind === 'blueprint') seedsByKey.get(target.key)?.fileIds.add(id);
      }
    }

    // App / Blueprint object files are gateways even when their routes are
    // declared elsewhere (the definer that mounts them is still the entry object).
    if (appVars.size > 0) addRole(roleByFile, id, 'app');
    if (blueprintVars.size > 0) addRole(roleByFile, id, 'blueprint');

    // Mounting + view-binding edges.
    for (const call of file.nodes.calls) {
      const callee = callCallee(call);
      if (!callee || callee.path.length !== 1) continue; // want `obj.method(...)`
      const method = callee.path[0];
      const obj = callee.root;
      const objIsFlask = blueprintVars.has(obj) || appVars.has(obj);
      if (!objIsFlask) continue;

      if (method === 'register_blueprint') {
        // `app.register_blueprint(bp)` — the first positional is the blueprint.
        const arg = positionalArgs(call)[0];
        const argRoot = arg ? memberChain(arg)?.root : undefined;
        const target = argRoot
          ? blueprintVarsByFile.get(id)?.has(argRoot)
            ? id // same-file blueprint → self-edge (dropped by addEdge)
            : binds.get(argRoot)
          : undefined;
        if (target) addEdge(edges, id, target, 'calls', 'register-blueprint');
        else diag.unresolvedMounts.add(`${id}: ${obj}.register_blueprint(…)`);
      } else if (method === 'add_url_rule') {
        // view_func is the `view_func=` kwarg or the 3rd positional arg.
        const view = keywordArg(call, 'view_func') ?? positionalArgs(call)[2];
        const target = resolveViewTarget(view, binds);
        if (target) addEdge(edges, id, target, 'calls', 'add-url-rule');
        else if (view) diag.unresolvedViews.add(`${id}: ${obj}.add_url_rule(…)`);
      }
    }
  }

  const groups = assignBlueprintGroups([...seedsByKey.values()]);

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'flask' },
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

  // Positive signal for validation (mirrors fastapi/nest's log line).
  if (groups.length > 0 || roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [flask] ${roleByFile.size} role(s) · ${groups.length} blueprint group(s) · ${sortedEdges.length} edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  if (diag.unresolvedMounts.size > 0 || diag.unresolvedViews.size > 0 || diag.ambiguousBlueprints.size > 0) {
    const parts: string[] = [];
    if (diag.unresolvedMounts.size > 0) {
      parts.push(`${diag.unresolvedMounts.size} unresolvable mount(s): ${[...diag.unresolvedMounts].sort().slice(0, 10).join(' · ')}`);
    }
    if (diag.unresolvedViews.size > 0) {
      parts.push(`${diag.unresolvedViews.size} unresolvable view(s): ${[...diag.unresolvedViews].sort().slice(0, 10).join(' · ')}`);
    }
    if (diag.ambiguousBlueprints.size > 0) {
      parts.push(`${diag.ambiguousBlueprints.size} ambiguous blueprint attribution(s): ${[...diag.ambiguousBlueprints].sort().slice(0, 10).join(' · ')}`);
    }
    console.log(`  [flask] degraded: ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): FlaskAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeFlask(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const flaskAdapter: FrameworkAdapter = {
  name: 'flask',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose manifest is at root reports rootPath '').
    const rootMatch = scoreFlask(gatherFlaskSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // A Flask backend often lives one dir down (a `backend/` | `server/` | `api/`
    // package in a frontend+backend monorepo), so a root-only scan misses it.
    // Shallow-scan immediate subdirs for a flask manifest and scope to it. Only
    // when NOT already scoped to a workspace package (the  path).
    if (!ctx.packageDir) {
      for (const sub of shallowManifestSubdirs(base)) {
        const m = scoreFlask(gatherFlaskSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // One grouping prior per Blueprint → its own subsystem, authoritative over
  // directory grouping (the fastapi/nest mechanism). Fully deterministic
  // (name/var/package-derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // register_blueprint mounting + add_url_rule view binding (kind 'calls').
  // File-id endpoints; the step resolves to modules, drops self-edges, dedupes,
  // 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // app / route-handler / blueprint → gateway; cli-command → job. METADATA; the
  // module's `kind` is unchanged.
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
