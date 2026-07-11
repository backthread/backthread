// the Litestar FrameworkAdapter. Net-new adapter following the FastAPI
// template, reusing the shared Python core (py-ast +
// parsePythonScope). Litestar's request surface is shaped very much like FastAPI's
// (module-level handlers + routers + an app object), but with three structural
// differences this adapter accounts for:
//
//   * Route decorators are BARE imported functions (`from litestar import get`;
//     `@get("/")`), not methods on a router object (FastAPI's `@router.get`), so
//     handler detection keys off the decorator's imported-from-litestar identity.
//   * Controllers are CLASSES (`class UserController(Controller)`) whose methods
//     are the handlers — read via py-ast's shared class primitives (`classes` +
//     `classBaseChains`, established by the ORM entity pass ).
//   * Registration is by constructor list (`Litestar(route_handlers=[…])` /
//     `Router(route_handlers=[…])`) or `.register(…)`, and dependency injection is
//     layered (`dependencies={"x": Provide(fn)}` on the app / router / controller
//     / handler) — both wirings the import graph doesn't name as verbs.
//
// All read STATICALLY (install-free, never-store-source — a pure syntactic Pyright
// parse; never executes repo code), persisting only the derived groups/edges/roles:
//
//   * detect()        — the `litestar` dependency (a `litestar-*` plugin raises
//                       confidence); shallow nested scan for a `backend/`|`server/`
//                       package (mirrors FastAPI's ).
//   * groupingPrior   — one FrameworkGroup per Controller and per Router → its own
//                       subsystem, authoritative over directory grouping (the
//                       FastAPI router / Nest @Module mechanism): the contribute-
//                       step makes each group its own subsystem.
//   * syntheticEdges  — `Litestar(route_handlers=[…])` / `Router(route_handlers=[…])`
//                       mounting + `.register(…)` (kind 'calls'), and layered
//                       `Provide(fn)` DI → consumer→provider (kind 'calls'). File-id
//                       endpoints; same-file wiring collapses (it's the role, not
//                       an edge).
//   * roleTags        — Litestar app + Controller subclass + `@get`/`@post`/… route
//                       handlers → `gateway`; a DI provider function → `service`.
//                       METADATA onto the LOCKED MODULE_KINDS enum; never a new kind
//                       (only `role` renders).
//
// Unresolvable registration / Provide targets DEGRADE + LOG — no silent caps.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readPythonDeps } from '../../graph/python-manifest.js';
import { parsePythonScope } from '../python/analyze.js';
import {
  callCallee,
  classAttr,
  classAttrString,
  classBaseChains,
  firstListString,
  keywordArg,
  listItems,
  memberChain,
  nameValue,
  positionalArgs,
  stringValue,
  PN,
  type CollectedNodes,
} from '../python/py-ast.js';
import type {
  CallNode,
  DecoratorNode,
  ExpressionNode,
  ImportFromNode,
  ImportNode,
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

/** The deterministic Litestar signal set (dependency names only). */
export interface LitestarSignals {
  hasLitestar: boolean; // litestar — the authoritative signal
  hasLitestarPlugin: boolean; // any `litestar-*` plugin (litestar-saq, …) — a strong secondary
}

/** Gather the signal set for a single root dir (reads manifests only). */
export function gatherLitestarSignals(baseDir: string): LitestarSignals {
  const deps = readPythonDeps(baseDir);
  return {
    hasLitestar: deps.has('litestar'),
    // A `litestar-*` plugin is a strong secondary signal that this really is a
    // Litestar app (vs. `litestar` pulled in transitively). ASGI servers
    // (uvicorn/granian/hypercorn) are SHARED with FastAPI, so they're not a signal.
    hasLitestarPlugin: [...deps].some((d) => d.startsWith('litestar-')),
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
 * for a nested Litestar backend (`backend/` | `server/` | `api/`). Sorted, so the
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
 * Decide Litestar from the signal set. `litestar` is REQUIRED; a `litestar-*`
 * plugin raises confidence. Returns null → generic-Python fallthrough,
 * byte-for-byte unchanged.
 */
export function scoreLitestar(s: LitestarSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasLitestar) return null;
  let confidence = 0.8;
  if (s.hasLitestarPlugin) confidence += 0.1;
  return {
    adapter: 'litestar',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: { litestar: s.hasLitestar, litestarPlugin: s.hasLitestarPlugin },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind`
// is unchanged. app / Controller / route-handler are all request entries →
// gateway; a DI provider is a plain own-code dependency callable → service.
export type LitestarRole = 'app' | 'controller' | 'route-handler' | 'provider';

// Collapse priority when one FILE carries several roles, AND downstream when
// several files of different roles land in one module. app (the Litestar entry)
// outranks a Controller (a class that declares a domain's handlers) outranks a
// bare function-based route-handler; a DI provider is the lowest (a service, not
// a request entry). A file defining a Controller reads as `controller` even if it
// also holds a loose provider fn — the more informative request-surface label.
const ROLE_PRIORITY: Record<LitestarRole, number> = {
  app: 8,
  controller: 7,
  'route-handler': 6,
  provider: 5,
};
const ROLE_KIND: Record<LitestarRole, ModuleKind> = {
  app: 'gateway',
  controller: 'gateway',
  'route-handler': 'gateway',
  provider: 'service',
};

// Litestar HTTP/websocket handler decorators (imported from `litestar` /
// `litestar.handlers`), used bare: `@get("/")`, `@route(...)`, `@websocket(...)`.
const HANDLER_DECORATORS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'route',
  'websocket',
  'asgi',
]);

// ---------------------------------------------------------------------------
// Analysis.

interface RouterMeta {
  path?: string; // `path="…"`
  call: CallNode; // the Router(…) ctor call (for route_handlers resolution)
}

interface ControllerMeta {
  className: string;
  tag?: string; // the first `tags = ["…"]` entry — the OpenAPI group (human) label
  path?: string; // the class-body `path = "…"` attribute
}

interface LitestarAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface LitestarDiag {
  unresolvedMounts: Set<string>; // route_handlers / .register targets we couldn't map
  unresolvedProviders: Set<string>; // Provide(...) callables we couldn't map
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx gets a fresh analysis — no cross-tree staleness. Mirrors fastapi / flask / nest.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, LitestarAnalysis>();

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

// Generic URL prefix segments that aren't a domain name (a leading `/api`,
// `/v1`, …). Skipped only on a MULTI-segment path, so a bare `path="/api"`
// (where 'api' IS the name) is preserved.
const GENERIC_PATH_SEGMENTS = new Set(['api']);
const isVersionSegment = (s: string): boolean => /^v\d+$/.test(s);

// A URL path → a clean domain-name segment (`/api/tags/{id}` → 'tags',
// `/api` → 'api', `/` → undefined). Drops empty + parameter segments; on a
// multi-segment path also skips a leading generic/version prefix, so the domain
// segment wins over a common `/api` mount prefix.
function pathName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const segs = path.split('/').filter((s) => s && !s.startsWith('{') && !s.startsWith(':'));
  if (segs.length === 0) return undefined;
  if (segs.length === 1) return segs[0];
  const meaningful = segs.find((s) => !GENERIC_PATH_SEGMENTS.has(s) && !isVersionSegment(s));
  return meaningful ?? segs[segs.length - 1];
}

// Keep the highest-priority candidate role per file (deterministic, lexical
// tiebreak) — mirrors the fastapi/flask/nest addRole + the contribute-step collapse.
function addRole(map: Map<string, LitestarRole>, fileId: string, role: LitestarRole): void {
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
    edges.set(key, { source: from, target: to, kind, metadata: { framework: 'litestar', relation } });
  }
}

// ---------------------------------------------------------------------------
// Litestar-import identity. Route decorators / app / router / controller-base /
// Provide are all imported FROM `litestar` (`from litestar import get, Controller`;
// `from litestar.di import Provide`), so we resolve a dotted-name chain to its
// canonical litestar symbol via each file's litestar imports.

interface LitestarImports {
  // local name → the litestar symbol it binds (`from litestar import get as g` →
  // 'g' → 'get'; `from litestar.di import Provide` → 'Provide' → 'Provide').
  names: Map<string, string>;
  // local names bound to the litestar TOP package (`import litestar` → 'litestar';
  // `import litestar.di as di` → 'di'), so `litestar.get` / `di.Provide` resolve.
  moduleAliases: Set<string>;
}

// A dotted-name chain's canonical litestar symbol, or undefined (`get` via
// `from litestar import get`; `litestar.Controller` via `import litestar`).
function litestarCanonical(
  chain: { root: string; path: string[] } | undefined,
  imports: LitestarImports,
): string | undefined {
  if (!chain) return undefined;
  if (chain.path.length === 0) return imports.names.get(chain.root);
  if (chain.path.length === 1 && imports.moduleAliases.has(chain.root)) return chain.path[0];
  return undefined;
}

function collectLitestarImports(nodes: CollectedNodes): LitestarImports {
  const names = new Map<string, string>();
  const moduleAliases = new Set<string>();
  for (const imp of nodes.imports) {
    if ((imp as ParseNode).nodeType === PN.ImportFrom) {
      const from = imp as ImportFromNode;
      if (from.d.module.d.leadingDots !== 0) continue; // relative import — not the litestar pkg
      const parts = from.d.module.d.nameParts.map((p) => p.d.value);
      if (parts[0] !== 'litestar') continue; // litestar / litestar.di / litestar.handlers …
      for (const spec of from.d.imports) {
        const imported = spec.d.name.d.value;
        const local = spec.d.alias ? spec.d.alias.d.value : imported;
        names.set(local, imported);
      }
    } else if ((imp as ParseNode).nodeType === PN.Import) {
      const node = imp as ImportNode;
      for (const entry of node.d.list) {
        const parts = entry.d.module.d.nameParts.map((p) => p.d.value);
        if (parts[0] !== 'litestar') continue;
        const local = entry.d.alias ? entry.d.alias.d.value : parts[0];
        moduleAliases.add(local);
      }
    }
  }
  return { names, moduleAliases };
}

// The ctor name of an `x = Ctor(...)` RHS, resolved to its canonical litestar
// symbol (`Litestar` / `Router`), or undefined if the RHS isn't a litestar ctor.
function litestarCtor(rhs: ExpressionNode, imports: LitestarImports): string | undefined {
  if ((rhs as ParseNode).nodeType !== PN.Call) return undefined;
  return litestarCanonical(callCallee(rhs as CallNode), imports);
}

// A decorator's callee chain (`@get(...)` → root 'get', path []; `@litestar.get(...)`
// → root 'litestar', path ['get']). The decorator expr is a call (route decorators
// are always called) or a bare name/attribute.
function decoratorChain(deco: DecoratorNode): { root: string; path: string[] } | undefined {
  const expr = deco.d.expr;
  if ((expr as ParseNode).nodeType === PN.Call) return callCallee(expr as CallNode);
  return memberChain(expr);
}

// Deterministic, collision-free group id per Controller/Router (
// discipline): sorted by fileId so the SMALLEST fileId wins a bare slug;
// collisions take a `-<dirSegment>` then `-<n>` suffix. Order is the stable fileId
// order, so the id set is identical run-to-run (the grouping-stability invariant).
interface UnitGroupSeed {
  fileId: string;
  baseSlug: string;
  label: string;
}

function assignUnitGroups(seeds: UnitGroupSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const byFileId = [...seeds].sort((a, b) =>
    a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : a.baseSlug < b.baseSlug ? -1 : a.baseSlug > b.baseSlug ? 1 : 0,
  );
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

function analyzeLitestar(ctx: FrameworkContext): LitestarAnalysis {
  const { parsed } = parsePythonScope(ctx);

  // Pass 1 — per-file litestar imports + app / router variables + Controller
  // classes (module-level singletons + class definitions, file-scoped).
  const importsByFile = new Map<string, LitestarImports>();
  const appVarsByFile = new Map<string, Set<string>>();
  const routerVarsByFile = new Map<string, Map<string, RouterMeta>>();
  const controllersByFile = new Map<string, ControllerMeta[]>();
  // Names DEFINED locally in a file (classes / functions / assignment targets), so
  // a same-file registration (`Litestar(route_handlers=[LocalController])`) resolves
  // to self (a dropped self-edge), not a false "unresolvable mount".
  const localNamesByFile = new Map<string, Set<string>>();

  for (const [id, file] of parsed) {
    const imports = collectLitestarImports(file.nodes);
    importsByFile.set(id, imports);

    const appVars = new Set<string>();
    const routerVars = new Map<string, RouterMeta>();
    const localNames = new Set<string>();

    for (const a of file.nodes.assignments) {
      const target = nameValue(a.d.leftExpr);
      if (target) localNames.add(target);
      if (!target) continue;
      const ctor = litestarCtor(a.d.rightExpr, imports);
      if (ctor === 'Litestar') appVars.add(target);
      else if (ctor === 'Router') {
        const call = a.d.rightExpr as CallNode;
        routerVars.set(target, { path: stringValue(keywordArg(call, 'path')), call });
      }
    }
    for (const fn of file.nodes.functions) {
      const fnName = nameValue(fn.d.name);
      if (fnName) localNames.add(fnName);
    }

    const controllers: ControllerMeta[] = [];
    for (const cls of file.nodes.classes) {
      const className = nameValue(cls.d.name);
      if (className) localNames.add(className);
      // A Controller subclass: any DIRECT base resolves to litestar `Controller`.
      const isController = classBaseChains(cls).some((b) => litestarCanonical(b, imports) === 'Controller');
      if (isController && className) {
        controllers.push({
          className,
          tag: firstListString(classAttr(cls, 'tags')),
          path: classAttrString(cls, 'path'),
        });
      }
    }

    appVarsByFile.set(id, appVars);
    routerVarsByFile.set(id, routerVars);
    controllersByFile.set(id, controllers);
    localNamesByFile.set(id, localNames);
  }

  // Pass 2 — roles, edges, grouping seeds.
  const roleByFile = new Map<string, LitestarRole>();
  const edges = new Map<string, FrameworkEdge>();
  const groupSeeds: UnitGroupSeed[] = [];
  const diag: LitestarDiag = { unresolvedMounts: new Set(), unresolvedProviders: new Set() };

  // Resolve a registration/provider reference's ROOT name → a file id: an import
  // binding (cross-file) else a same-file local definition (→ self). Undefined ⇒
  // an external/unknown target (degrade + log).
  const resolveRef = (root: string, thisFile: string, binds: ReadonlyMap<string, string>): string | undefined =>
    binds.get(root) ?? (localNamesByFile.get(thisFile)?.has(root) ? thisFile : undefined);

  for (const [id, file] of parsed) {
    const imports = importsByFile.get(id)!;
    const appVars = appVarsByFile.get(id)!;
    const routerVars = routerVarsByFile.get(id)!;
    const controllers = controllersByFile.get(id)!;
    const binds = file.bindings;

    // Function-based route handlers: a top-level/def with a litestar handler
    // decorator (`@get`, `@route`, …). Controller METHODS also match here, but
    // the Controller role (below) already covers their file.
    for (const fn of file.nodes.functions) {
      for (const deco of fn.d.decorators) {
        const canonical = litestarCanonical(decoratorChain(deco), imports);
        if (canonical && HANDLER_DECORATORS.has(canonical)) {
          addRole(roleByFile, id, 'route-handler');
          break;
        }
      }
    }

    // Litestar app file(s) → gateway (`app` role); Controller subclasses → gateway.
    if (appVars.size > 0) addRole(roleByFile, id, 'app');
    if (controllers.length > 0) addRole(roleByFile, id, 'controller');

    // Grouping seeds: each Controller + each Router is its own subsystem. Name a
    // Controller by its OpenAPI `tags=[…]` (the human group label — like FastAPI's
    // router tags), else its path's domain segment, else its class name.
    for (const c of controllers) {
      const name = c.tag || pathName(c.path) || c.className;
      groupSeeds.push({ fileId: id, baseSlug: slugify(name) || 'controller', label: humanize(name) || name });
    }
    for (const [varName, meta] of routerVars) {
      const name = pathName(meta.path) || (varName !== 'router' ? varName : '') || baseName(id);
      groupSeeds.push({ fileId: id, baseSlug: slugify(name) || 'router', label: humanize(name) || name });
    }

    // Registration edges from `route_handlers=[…]` on a Litestar()/Router() ctor.
    const registrationCalls: Array<{ call: CallNode; label: string }> = [];
    for (const [, meta] of routerVars) registrationCalls.push({ call: meta.call, label: 'Router' });
    // The Litestar() app ctor(s) — collected from assignments in pass 1 via appVars,
    // but the CALL node is here in nodes.calls; match by canonical ctor.
    for (const call of file.nodes.calls) {
      const canonical = litestarCanonical(callCallee(call), imports);
      if (canonical === 'Litestar') registrationCalls.push({ call, label: 'Litestar' });
    }
    for (const { call, label } of registrationCalls) {
      for (const item of listItems(keywordArg(call, 'route_handlers'))) {
        const root = memberChain(item)?.root;
        const target = root ? resolveRef(root, id, binds) : undefined;
        if (target) addEdge(edges, id, target, 'calls', 'route-handlers');
        else if (root) diag.unresolvedMounts.add(`${id}: ${label}(route_handlers=[…${root}…])`);
      }
    }

    // Registration edges from `.register(handler)` on an app/router var, and
    // layered DI edges from `Provide(fn)` (consumer→provider). Both scanned from
    // nodes.calls (recursive → also catches Provide inside a class-body
    // `dependencies={…}` dict).
    for (const call of file.nodes.calls) {
      const callee = callCallee(call);
      if (!callee) continue;

      if (callee.path.length === 1 && callee.path[0] === 'register' && (appVars.has(callee.root) || routerVars.has(callee.root))) {
        const root = memberChain(positionalArgs(call)[0])?.root;
        const target = root ? resolveRef(root, id, binds) : undefined;
        if (target) addEdge(edges, id, target, 'calls', 'register');
        else if (root) diag.unresolvedMounts.add(`${id}: ${callee.root}.register(${root})`);
        continue;
      }

      if (callee.path.length === 0 && litestarCanonical(callee, imports) === 'Provide') {
        const root = memberChain(positionalArgs(call)[0])?.root;
        const providerFile = root ? resolveRef(root, id, binds) : undefined;
        if (providerFile) {
          addRole(roleByFile, providerFile, 'provider');
          addEdge(edges, id, providerFile, 'calls', 'di-provider');
        } else if (root) {
          diag.unresolvedProviders.add(`${id}: Provide(${root})`);
        }
      }
    }
  }

  const groups = assignUnitGroups(groupSeeds);

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'litestar' },
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

  // Positive signal for validation (mirrors fastapi/flask/nest's log line).
  if (groups.length > 0 || roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [litestar] ${roleByFile.size} role(s) · ${groups.length} controller/router group(s) · ${sortedEdges.length} edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  if (diag.unresolvedMounts.size > 0 || diag.unresolvedProviders.size > 0) {
    const parts: string[] = [];
    if (diag.unresolvedMounts.size > 0) {
      parts.push(`${diag.unresolvedMounts.size} unresolvable mount(s): ${[...diag.unresolvedMounts].sort().slice(0, 10).join(' · ')}`);
    }
    if (diag.unresolvedProviders.size > 0) {
      parts.push(`${diag.unresolvedProviders.size} unresolvable provider(s): ${[...diag.unresolvedProviders].sort().slice(0, 10).join(' · ')}`);
    }
    console.log(`  [litestar] degraded: ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): LitestarAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeLitestar(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const litestarAdapter: FrameworkAdapter = {
  name: 'litestar',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose manifest is at root reports rootPath '').
    const rootMatch = scoreLitestar(gatherLitestarSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // A Litestar backend often lives one dir down (a `backend/` | `server/` |
    // `api/` package in a frontend+backend monorepo), so a root-only scan misses
    // it. Shallow-scan immediate subdirs for a litestar manifest and scope to it.
    // Only when NOT already scoped to a workspace package (the  path).
    if (!ctx.packageDir) {
      for (const sub of shallowManifestSubdirs(base)) {
        const m = scoreLitestar(gatherLitestarSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // One grouping prior per Controller / Router → its own subsystem, authoritative
  // over directory grouping (the fastapi/nest mechanism). Fully deterministic
  // (path/name-derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // route_handlers=[…] / .register(…) mounting + layered Provide(…) DI (kind
  // 'calls'). File-id endpoints; the step resolves to modules, drops self-edges,
  // dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // app / controller / route-handler → gateway; provider → service. METADATA; the
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
