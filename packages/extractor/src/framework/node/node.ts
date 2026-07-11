// (Slice 2) — the Node backend FrameworkAdapter.
// the request-spine contribution hooks (roleTags + syntheticEdges).
//
// DETECTION: decides "is this a Node HTTP-server backend, and on which
// framework?" from package.json deps — never source content (never-store-source).
// These libs ship no canonical config file, so detection is dep-only.
//
// CONTRIBUTION (, founder-scoped 2026-06-26 — LIGHTWEIGHT): renders the
// request spine as ROLE TAGS on EXISTING files + request-flow `calls` EDGES —
// NO synthetic route nodes. The route's method+path is METADATA on the handler
// module, never a standalone node. We statically read source via ts-morph
// (install-free; never-store-source — read server-side, persist only the derived
// edges/roles) and contribute in the graph FILE-ID space; the generic
// contribute-step resolves to MODULE ids, drops self-edges, dedupes + 8-verb-
// validates.
//
// GROUPING (the deferred  grouping, now that 's shared
// mechanism exists): a `groupingPrior` groups the request spine by ROUTE PREFIX /
// ROUTER MOUNT. A router mounted at `/admin` (`app.use('/admin', adminRouter)`,
// Hono `app.route('/api', subApp)`) and the routes it serves form one subsystem;
// direct routes group by their path's distinguishing prefix segment (a leading
// `api`/version noise segment is skipped, so `/api/users` + `/api/orders` →
// `users` / `orders`). Each prefix → one deterministic `node:<slug>` subsystem
// (slug derived from the prefix, NEVER a Louvain/array index — the snapshot-
// stability invariant), over the controller + route-handler + one-hop service-
// tail files under it. The entrypoint (server root) is NEVER swept into a route
// group (it spans every prefix). Dynamic/unresolvable mounts + ungroupable routes
// DEGRADE + LOG (no silent caps). classificationsNeeded stays absent — grouping is
// fully deterministic, no LLM touch. The contribute-step (, untouched here)
// resolves the FILE-id groups to MODULE ids and overrides each claimed module's
// subsystem, AUTHORITATIVE over directory + workspace-package grouping.
//
// Detection signals (manifest only):
//   * dep: one (or more) of `express` · `fastify` · `koa` · `hono`
//
// The matched framework(s) are recorded in metadata. scoreNode is PURE.

import { posix } from 'node:path';
import {
  SyntaxKind,
  type ArrayLiteralExpression,
  type CallExpression,
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
import { clampConfidence, readDeps, resolveBase } from '../detect-util.js';
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

// Priority order = the deterministic primary pick when a repo carries more than
// one (rare). Not a quality ranking — just a stable tiebreak so `variant` is
// reproducible. Express first (most common), then fastify/koa/hono.
const NODE_FRAMEWORKS = ['express', 'fastify', 'koa', 'hono'] as const;
export type NodeFramework = (typeof NODE_FRAMEWORKS)[number];

/** The deterministic Node-backend signal set: which server framework deps are present. */
export interface NodeSignals {
  /** Matched server-framework deps, in NODE_FRAMEWORKS priority order. */
  frameworks: NodeFramework[];
}

/** Gather the signal set for a single root dir (fs only). */
export function gatherNodeSignals(baseDir: string): NodeSignals {
  const deps = readDeps(baseDir);
  return { frameworks: NODE_FRAMEWORKS.filter((f) => f in deps) };
}

/**
 * Decide Node-backend from the signal set. Returns a DetectMatch, or null when
 * no server-framework dep is present (generic-TS fallthrough intact).
 *
 * Each server-framework dep is SUFFICIENT (authoritative). A single dep scores
 * the base confidence; co-present frameworks (a repo mounting more than one)
 * nudge it up — there's no config file to corroborate, so deps are the whole
 * rubric. `variant` is the priority-primary framework; `frameworks` lists all.
 */
export function scoreNode(s: NodeSignals, rootPath = ''): DetectMatch | null {
  if (s.frameworks.length === 0) return null;

  const confidence = clampConfidence(0.6 + 0.1 * (s.frameworks.length - 1));
  return {
    adapter: 'node',
    confidence,
    rootPath,
    metadata: {
      variant: s.frameworks[0],
      frameworks: s.frameworks,
    },
  };
}

// ---------------------------------------------------------------------------
// the request-spine extraction (roles + edges).
//
// LIGHTWEIGHT role vocabulary, each mapped onto a LOCKED Module-kind (the
// discipline holds: roles are metadata, NEVER a new Module-kind):
//   * entrypoint    — the file that boots the server (`express()` / `new Koa()` /
//                     `fastify()` / `new Hono()` or `.listen(…)`)        → gateway
//   * route-handler — the terminal handler of a route registration       → gateway
//   * controller    — a router module (`express.Router()` / a mounted Hono
//                     sub-app) — the request-grouping container          → gateway
//   * middleware    — a function in an `app.use(…)` chain or a route's
//                     non-terminal handler slot                          → gateway
//   * service       — own business logic a handler directly calls        → service
//
// MIDDLEWARE → `gateway` (documented choice): middleware sits ON the request
// spine — it's a cross-cutting part of the request-handling gateway tier, not
// own-business compute (which is `service`). It must be a value from the locked
// MODULE_KINDS enum, so the choice is gateway vs service; the request-spine
// reading makes gateway correct. (Only `role` is rendered; the module keeps the
// classifier's `kind` — the role's `kind` is carried for a future classifier.)
export type NodeRole = 'entrypoint' | 'route-handler' | 'controller' | 'middleware' | 'service';

const ROLE_PRIORITY: Record<NodeRole, number> = {
  entrypoint: 5, // the server root — unique, structural
  'route-handler': 4, // handles a concrete request
  controller: 3, // a router/grouping container
  middleware: 2, // cross-cutting request step
  service: 1, // leaf business logic
};
const ROLE_KIND: Record<NodeRole, ModuleKind> = {
  entrypoint: 'gateway',
  'route-handler': 'gateway',
  controller: 'gateway',
  middleware: 'gateway',
  service: 'service',
};

// HTTP verb methods Express / @koa/router / Hono / Fastify all expose as
// `app.METHOD(path, …)`. `all` matches every verb. `app.set`/`app.get('cfg')`
// (Express config) are disambiguated by the ≥2-arg + string-path + callable-arg
// rule — a 1-arg `app.get('title')` config read is never a route.
const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'all',
]);
// Fastify route-options object hook keys → middleware (the non-terminal request
// steps). `handler` (terminal) is pulled separately.
const FASTIFY_HOOK_KEYS = ['preHandler', 'onRequest', 'preValidation', 'preParsing', 'onError'];
// App-factory identifiers / classes whose construction marks the server entry.
const FACTORY_CALL_IDENTS = new Set(['express', 'fastify', 'Fastify']);
const FACTORY_NEW_IDENTS = new Set(['Koa', 'Hono', 'Fastify']);
// Router-class constructors (`new Router()` — Koa's @koa/router / express.Router
// used as a class) → a controller (router-grouping module), not an entrypoint.
const CONTROLLER_NEW_IDENTS = new Set(['Router']);

const SOURCE_EXT_SET = new Set<string>(SOURCE_EXTENSIONS);

// A method+path label that rides as METADATA on the handler module (NOT a node).
interface RouteLabel {
  method: string; // uppercase verb, or 'ALL'
  path: string;
}

interface NodeAnalysis {
  /** Request-flow edges, file-id endpoints, kind 'calls'. */
  edges: FrameworkEdge[];
  /** fileId → RoleTag (one per file; multi-match collapsed by ROLE_PRIORITY). */
  roles: Map<string, RoleTag>;
  /** route-prefix / router-mount grouping priors (file-id space). */
  groups: FrameworkGroup[];
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so syntheticEdges +
// roleTags share one parse, while the merge walk's per-checkpoint ctx (same
// clone.dir, different tree) gets a fresh analysis — no cross-tree staleness.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, NodeAnalysis>();

// ---------------------------------------------------------------------------
// Static resolution helpers (install-free, deterministic).

// localImportedName → resolved repo-relative file id, for one source file. Only
// INTERNAL imports resolve (getModuleSpecifierSourceFile is null for a bare
// external specifier install-free) — so a name absent from this map is either a
// local definition or an external import, which the callers disambiguate.
function buildImportNameMap(sf: SourceFile, repoDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const decl of sf.getImportDeclarations()) {
    const resolved = decl.getModuleSpecifierSourceFile();
    if (!resolved) continue;
    const fileId = toId(repoDir, resolved.getFilePath());
    const def = decl.getDefaultImport();
    if (def) map.set(def.getText(), fileId);
    const ns = decl.getNamespaceImport();
    if (ns) map.set(ns.getText(), fileId);
    for (const ni of decl.getNamedImports()) {
      map.set((ni.getAliasNode() ?? ni.getNameNode()).getText(), fileId);
    }
  }
  return map;
}

// Deterministic relative-specifier resolver over the known source-file id set —
// `require('./x')` / `import('./x')` → matching file id, or undefined. Tries the
// path, then each source extension, then an index file, in the FIXED
// SOURCE_EXTENSIONS order so the pick is snapshot-stable.
function makeSpecifierResolver(
  idSet: ReadonlySet<string>,
): (fromFileId: string, spec: string) => string | undefined {
  return (fromFileId, spec) => {
    if (!spec.startsWith('.')) return undefined;
    const slash = fromFileId.lastIndexOf('/');
    const dir = slash >= 0 ? fromFileId.slice(0, slash) : '';
    const base = posix.join(dir, spec);
    if (idSet.has(base)) return base;
    for (const ext of SOURCE_EXTENSIONS) {
      const cand = `${base}.${ext}`;
      if (idSet.has(cand)) return cand;
    }
    for (const ext of SOURCE_EXTENSIONS) {
      const cand = `${base}/index.${ext}`;
      if (idSet.has(cand)) return cand;
    }
    return undefined;
  };
}

// ts-morph exposes getExpression()/getLiteralValue() on many concrete node types
// but not on the base Node; we reach them only after a getKind() gate, so a
// guarded optional-call is both safe and avoids a forest of per-kind casts.
function innerExpression(node: Node): Node | undefined {
  return (node as unknown as { getExpression?: () => Node | undefined }).getExpression?.();
}
function literalValue(node: Node): string | undefined {
  return (node as unknown as { getLiteralValue?: () => string }).getLiteralValue?.();
}

// Statically resolve a string from an expression node — a string literal or an
// `as`/paren/non-null-wrapped literal (the RUNTIME value). Truly computed (a
// template with substitutions, a binary concat, a variable) → undefined.
function staticString(node: Node, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  switch (node.getKind()) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return literalValue(node);
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.TypeAssertionExpression: {
      const inner = innerExpression(node);
      return inner ? staticString(inner, depth + 1) : undefined;
    }
    default:
      return undefined;
  }
}

// The leftmost identifier of a property-access chain (`a.b.c` → `a`). Undefined
// when the chain doesn't root in a plain identifier.
function rootIdentifier(node: Node, depth = 0): string | undefined {
  if (depth > 16) return undefined;
  if (node.getKind() === SyntaxKind.Identifier) return node.getText();
  if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
    return rootIdentifier((node as PropertyAccessExpression).getExpression(), depth + 1);
  }
  return undefined;
}

// Is this expression a callable suitable for a handler/middleware slot? (Used to
// decide whether a route arg participates in the handler chain at all.)
function isCallableArg(node: Node): boolean {
  switch (node.getKind()) {
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.Identifier:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.CallExpression:
      return true;
    default:
      return false;
  }
}

// Resolve a handler/middleware expression to its file id.
//   * inline arrow/function           → the registering file (self)
//   * imported identifier             → the imported file; a bare local id → self
//   * `ctrl.method` / `barrel.fn`     → the root identifier's file (imported) or self
//   * `require('./x')` / `import('./x')` → the resolved specifier
//   * a factory call `mw()`           → INTERNAL import → its file; external/local → null
// Returns a file id, or null when it can't be statically resolved (caller LOGS).
function resolveHandlerFile(
  expr: Node,
  imports: Map<string, string>,
  selfFileId: string,
  resolveSpecifier: (spec: string) => string | undefined,
  depth = 0,
): string | null {
  if (depth > 8) return null;
  switch (expr.getKind()) {
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.TypeAssertionExpression: {
      const inner = innerExpression(expr);
      return inner ? resolveHandlerFile(inner, imports, selfFileId, resolveSpecifier, depth + 1) : null;
    }
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.FunctionExpression:
      return selfFileId; // inline handler → defined in the registering file
    case SyntaxKind.Identifier:
      // imported → its file; an unmapped bare id is a local definition → self.
      return imports.get(expr.getText()) ?? selfFileId;
    case SyntaxKind.PropertyAccessExpression: {
      const base = (expr as PropertyAccessExpression).getExpression();
      if (base.getKind() === SyntaxKind.CallExpression) {
        // `require('./x').named` / `import('./x').named`
        return resolveHandlerFile(base, imports, selfFileId, resolveSpecifier, depth + 1);
      }
      const root = rootIdentifier(expr);
      return root ? (imports.get(root) ?? selfFileId) : null;
    }
    case SyntaxKind.CallExpression: {
      const call = expr as CallExpression;
      const callee = call.getExpression();
      const isRequire = callee.getKind() === SyntaxKind.Identifier && callee.getText() === 'require';
      const isImport = callee.getKind() === SyntaxKind.ImportKeyword || callee.getText() === 'import';
      if (isRequire || isImport) {
        const arg = call.getArguments()[0];
        if (!arg || arg.getKind() !== SyntaxKind.StringLiteral) return null;
        return resolveSpecifier((arg as StringLiteral).getLiteralValue()) ?? null;
      }
      // A factory call like `cors()` / `makeAuth()`: only an INTERNAL imported
      // factory resolves (→ its file); an external (`cors`) or local factory is
      // not in the import map → null (logged, not silently attributed to self).
      const root = rootIdentifier(callee);
      return root ? (imports.get(root) ?? null) : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pure-ish per-file scanning. Endpoints are repo-relative posix FILE ids.

function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

// Accumulators threaded through the analysis. Roles + route labels are per-FILE;
// the contribute-step collapses to per-module afterward.
interface Acc {
  roleByFile: Map<string, NodeRole>;
  routesByFile: Map<string, RouteLabel[]>;
  edges: Map<string, FrameworkEdge>; // key `from→to` (kind always 'calls')
  // Files mounted as a sub-router (`app.route('/p', sub)`). A mounted app
  // instance is a controller by definition — even when constructed exactly like
  // the root app (`new Hono()`), which would otherwise read as `entrypoint`. We
  // override these to `controller` after scanning (the root app is never mounted).
  mountTargets: Set<string>;
  // grouping accumulators (file-id space; consumed after pass 2).
  // One per route registration: the registering controller file, the resolved
  // terminal handler file, and the static path(s) — the grouping key source.
  routeRegs: { controller: string; handler: string; paths: string[] }[];
  // Candidate router mounts: a static MOUNT PATH + the resolved target file
  // (`app.use('/admin', router)`, Hono `app.route('/api', subApp)`). Filtered to
  // controller targets in the grouping phase; the path propagates the prefix.
  mounts: { parent: string; child: string; mountPath: string }[];
  // One-hop request tail (pass 2): a handler file → the service file it calls.
  // The service joins its caller's route group(s).
  serviceTail: { handler: string; service: string }[];
  diag: {
    dynamicPaths: number; // route registrations whose path isn't a static string
    unresolvedHandlers: Set<string>; // `METHOD path` whose handler couldn't resolve
    unsupported: number; // route forms we can't statically read (chained, spread, …)
    dynamicMounts: number; // `app.use(computedPath, router)` — non-static mount path
  };
}

// Keep the highest-priority candidate role per file (deterministic, lexical
// tiebreak) — mirrors RN's addRole + the contribute-step's module-level collapse.
function addRole(acc: Acc, fileId: string, role: NodeRole): void {
  const cur = acc.roleByFile.get(fileId);
  if (
    cur === undefined ||
    ROLE_PRIORITY[role] > ROLE_PRIORITY[cur] ||
    (ROLE_PRIORITY[role] === ROLE_PRIORITY[cur] && role < cur)
  ) {
    acc.roleByFile.set(fileId, role);
  }
}

function addRouteLabel(acc: Acc, fileId: string, label: RouteLabel): void {
  let list = acc.routesByFile.get(fileId);
  if (!list) {
    list = [];
    acc.routesByFile.set(fileId, list);
  }
  if (!list.some((r) => r.method === label.method && r.path === label.path)) list.push(label);
}

function addEdge(acc: Acc, from: string, to: string, metadata: Record<string, unknown>): void {
  const key = `${from}→${to}`;
  if (!acc.edges.has(key)) acc.edges.set(key, { source: from, target: to, kind: 'calls', metadata });
}

// Resolve the route path(s): a static string, or an array of static strings
// (Express `app.get(['/a','/b'], …)`). Empty array ⇒ dynamic.
function resolvePaths(arg: Node): string[] | null {
  const s = staticString(arg);
  if (s !== undefined) return [s];
  if (arg.getKind() === SyntaxKind.ArrayLiteralExpression) {
    const out: string[] = [];
    for (const el of (arg as ArrayLiteralExpression).getElements()) {
      const v = staticString(el);
      if (v === undefined) return null; // any dynamic element ⇒ degrade the whole reg
      out.push(v);
    }
    return out.length ? out : null;
  }
  return null;
}

// Process one route registration's handler chain (the args AFTER the path):
// resolve the terminal handler + the middleware chain, emit edges from the
// registering file, and tag roles + route labels. Handles positional handlers,
// handler arrays, and a Fastify options object (`{ handler, preHandler, … }`).
function processHandlerChain(
  args: Node[],
  selfFileId: string,
  labels: RouteLabel[],
  imports: Map<string, string>,
  resolveSpecifier: (spec: string) => string | undefined,
  acc: Acc,
): void {
  const callables: Node[] = []; // positional handler/middleware expressions, in order
  let optsHandler: Node | undefined; // a Fastify opts-object `handler`
  const optsMiddleware: Node[] = []; // Fastify opts-object hooks

  for (const arg of args) {
    if (arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
      const obj = arg as ObjectLiteralExpression;
      const h = obj.getProperty('handler');
      if (h && h.getKind() === SyntaxKind.PropertyAssignment) {
        const v = (h as PropertyAssignment).getInitializer();
        if (v) optsHandler = v;
      }
      for (const key of FASTIFY_HOOK_KEYS) {
        const p = obj.getProperty(key);
        if (!p || p.getKind() !== SyntaxKind.PropertyAssignment) continue;
        const v = (p as PropertyAssignment).getInitializer();
        if (!v) continue;
        if (v.getKind() === SyntaxKind.ArrayLiteralExpression) {
          for (const el of (v as ArrayLiteralExpression).getElements()) {
            if (isCallableArg(el)) optsMiddleware.push(el);
          }
        } else if (isCallableArg(v)) {
          optsMiddleware.push(v);
        }
      }
      continue;
    }
    if (arg.getKind() === SyntaxKind.ArrayLiteralExpression) {
      for (const el of (arg as ArrayLiteralExpression).getElements()) {
        if (isCallableArg(el)) callables.push(el);
      }
      continue;
    }
    if (isCallableArg(arg)) callables.push(arg);
  }

  // Terminal handler: a Fastify opts `handler` wins; else the last positional.
  let terminal: Node | undefined;
  let middleware: Node[];
  if (optsHandler) {
    terminal = optsHandler;
    middleware = [...callables, ...optsMiddleware];
  } else if (callables.length) {
    terminal = callables[callables.length - 1];
    middleware = [...callables.slice(0, -1), ...optsMiddleware];
  } else {
    terminal = undefined;
    middleware = optsMiddleware;
  }

  if (!terminal) {
    for (const l of labels) acc.diag.unresolvedHandlers.add(`${l.method} ${l.path}`);
  } else {
    const tFile = resolveHandlerFile(terminal, imports, selfFileId, resolveSpecifier);
    if (tFile === null) {
      for (const l of labels) acc.diag.unresolvedHandlers.add(`${l.method} ${l.path}`);
    } else {
      addEdge(acc, selfFileId, tFile, { framework: 'node', relation: 'route' });
      addRole(acc, tFile, 'route-handler');
      for (const l of labels) addRouteLabel(acc, tFile, l);
      // record the registration for route-prefix grouping. The path(s)
      // (deduped) + the registering controller's mount prefix yield the subsystem.
      const paths = [...new Set(labels.map((l) => l.path))];
      if (paths.length) acc.routeRegs.push({ controller: selfFileId, handler: tFile, paths });
    }
  }

  for (const mw of middleware) {
    const mFile = resolveHandlerFile(mw, imports, selfFileId, resolveSpecifier);
    if (mFile === null) continue; // an external middleware factory — not on-graph
    addEdge(acc, selfFileId, mFile, { framework: 'node', relation: 'middleware' });
    addRole(acc, mFile, 'middleware');
  }
}

// Scan one source file for the request spine.
function scanFile(
  sf: SourceFile,
  selfFileId: string,
  imports: Map<string, string>,
  resolveSpecifier: (spec: string) => string | undefined,
  acc: Acc,
): void {
  // Entrypoint: `new Koa()` / `new Hono()` (and `new Fastify()`).
  // Controller: `new Router()` (Koa @koa/router used as a class).
  for (const ne of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const cls = ne.getExpression().getText();
    if (FACTORY_NEW_IDENTS.has(cls)) addRole(acc, selfFileId, 'entrypoint');
    else if (CONTROLLER_NEW_IDENTS.has(cls)) addRole(acc, selfFileId, 'controller');
  }

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();

    // Entrypoint: `express()` / `fastify()` app factories.
    if (callee.getKind() === SyntaxKind.Identifier && FACTORY_CALL_IDENTS.has(callee.getText())) {
      addRole(acc, selfFileId, 'entrypoint');
    }

    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const method = (callee as PropertyAccessExpression).getName();
    const args = call.getArguments();

    // Entrypoint: `….listen(port)` server bootstrap. Matched on the method name
    // alone (any receiver) ON PURPOSE: the common `import app from './app';
    // app.listen(3000)` index file has NO app-factory of its own, so requiring a
    // co-located factory would miss that legitimate entrypoint. The cost is a
    // rare over-tag (a non-server `.listen()` — an EventEmitter, a net.Server),
    // which is low-risk inside an already-detected Node-backend repo.
    if (method === 'listen') {
      addRole(acc, selfFileId, 'entrypoint');
      continue;
    }

    // Controller: `express.Router()` / `Router()` router-module creator.
    if (method === 'Router') {
      addRole(acc, selfFileId, 'controller');
      continue;
    }

    // Mount: Hono `app.route('/prefix', subApp)` — arg0 string path, arg1 a
    // sub-app identifier ⇒ the mounted file is a controller. (Fastify
    // `app.route({…})` is the object form, handled below.)
    if (method === 'route') {
      if (args.length >= 2 && staticString(args[0]) !== undefined && isCallableArg(args[1])) {
        const tFile = resolveHandlerFile(args[1], imports, selfFileId, resolveSpecifier);
        if (tFile !== null) {
          addEdge(acc, selfFileId, tFile, { framework: 'node', relation: 'mount' });
          addRole(acc, tFile, 'controller');
          acc.mountTargets.add(tFile); // override entrypoint→controller post-scan
          // the mount path prefixes the sub-app's routes.
          acc.mounts.push({ parent: selfFileId, child: tFile, mountPath: staticString(args[0])! });
        }
        continue;
      }
      // Fastify `app.route({ method, url, handler, … })`.
      if (args.length >= 1 && args[0].getKind() === SyntaxKind.ObjectLiteralExpression) {
        scanFastifyRouteObject(args[0] as ObjectLiteralExpression, selfFileId, imports, resolveSpecifier, acc);
        continue;
      }
      // Express chained `app.route('/x').get(h)` and friends — can't read the
      // verb statically off the chain. Degrade + count (no silent drop).
      acc.diag.unsupported++;
      continue;
    }

    // `app.use(…)` middleware chain (and path-mounted middleware/routers).
    if (method === 'use') {
      let rest = args;
      let mountPath: string | undefined;
      if (rest.length && staticString(rest[0]) !== undefined) {
        mountPath = staticString(rest[0]); // static mount path → prefixes the target
        rest = rest.slice(1);
      } else if (
        // `app.use(computedPath, router)`: a non-static, non-callable,
        // non-object first arg followed by a handler is a DYNAMIC mount path we
        // can't resolve to a prefix. Degrade + log (no silent drop).
        args.length >= 2 &&
        !isCallableArg(args[0]) &&
        args[0].getKind() !== SyntaxKind.ObjectLiteralExpression &&
        args.slice(1).some(isCallableArg)
      ) {
        acc.diag.dynamicMounts++;
      }
      for (const a of rest) {
        if (!isCallableArg(a)) continue;
        const mFile = resolveHandlerFile(a, imports, selfFileId, resolveSpecifier);
        if (mFile === null) continue;
        addEdge(acc, selfFileId, mFile, { framework: 'node', relation: 'use' });
        // Path-mounted routers become controllers via the express.Router() pass;
        // here we tag middleware and let the role-priority collapse keep the
        // stronger controller role if both fire.
        addRole(acc, mFile, 'middleware');
        // a static-path `use` is a candidate router mount; the grouping
        // phase keeps only the ones whose target turned out to be a controller.
        if (mountPath !== undefined) acc.mounts.push({ parent: selfFileId, child: mFile, mountPath });
      }
      continue;
    }

    // Hono `app.on('GET', '/x', …)` / `app.on(['GET','POST'], '/x', …)`.
    if (method === 'on') {
      if (args.length < 2) continue;
      const methods = resolveOnMethods(args[0]);
      const paths = resolvePaths(args[1]);
      if (!methods) {
        acc.diag.dynamicPaths++; // dynamic method spec — treat like a dynamic reg
        continue;
      }
      if (!paths) {
        acc.diag.dynamicPaths++;
        continue;
      }
      const labels: RouteLabel[] = [];
      for (const m of methods) for (const p of paths) labels.push({ method: m, path: p });
      processHandlerChain(args.slice(2), selfFileId, labels, imports, resolveSpecifier, acc);
      continue;
    }

    // `app.METHOD(path, …handlers)` route registrations.
    if (HTTP_METHODS.has(method)) {
      // The ≥2-arg + callable-handler rule rejects Express config reads
      // (`app.get('title')`). A registration needs a path + ≥1 handler.
      if (args.length < 2) continue;
      if (!args.slice(1).some(isCallableArg) && !args.slice(1).some((a) => a.getKind() === SyntaxKind.ObjectLiteralExpression)) {
        continue;
      }
      const paths = resolvePaths(args[0]);
      if (!paths) {
        acc.diag.dynamicPaths++;
        continue;
      }
      const verb = method.toUpperCase();
      const labels = paths.map((p) => ({ method: verb, path: p }));
      processHandlerChain(args.slice(1), selfFileId, labels, imports, resolveSpecifier, acc);
      continue;
    }
  }
}

// Fastify `app.route({ method, url|path, handler, preHandler, … })`.
function scanFastifyRouteObject(
  obj: ObjectLiteralExpression,
  selfFileId: string,
  imports: Map<string, string>,
  resolveSpecifier: (spec: string) => string | undefined,
  acc: Acc,
): void {
  const urlProp = obj.getProperty('url') ?? obj.getProperty('path');
  const urlInit =
    urlProp && urlProp.getKind() === SyntaxKind.PropertyAssignment
      ? (urlProp as PropertyAssignment).getInitializer()
      : undefined;
  const paths = urlInit ? resolvePaths(urlInit) : null;
  if (!paths) {
    acc.diag.dynamicPaths++;
    return;
  }

  const methods = resolveRouteObjectMethods(obj);
  const labels: RouteLabel[] = [];
  for (const m of methods) for (const p of paths) labels.push({ method: m, path: p });

  // Reuse the chain processor by handing it the object itself (it pulls
  // `handler` + the hook keys out of the options object).
  processHandlerChain([obj], selfFileId, labels, imports, resolveSpecifier, acc);
}

// `method` of a Fastify route object: a static string, an array of static
// strings, or — if unreadable — 'ALL' (so the route still registers a label).
function resolveRouteObjectMethods(obj: ObjectLiteralExpression): string[] {
  const p = obj.getProperty('method');
  if (!p || p.getKind() !== SyntaxKind.PropertyAssignment) return ['ALL'];
  const init = (p as PropertyAssignment).getInitializer();
  if (!init) return ['ALL'];
  const single = staticString(init);
  if (single !== undefined) return [single.toUpperCase()];
  if (init.getKind() === SyntaxKind.ArrayLiteralExpression) {
    const out: string[] = [];
    for (const el of (init as ArrayLiteralExpression).getElements()) {
      const v = staticString(el);
      if (v !== undefined) out.push(v.toUpperCase());
    }
    if (out.length) return out;
  }
  return ['ALL'];
}

// Hono `app.on(method, …)` first arg → method list (a string or string array),
// or null when computed.
function resolveOnMethods(arg: Node): string[] | null {
  const single = staticString(arg);
  if (single !== undefined) return [single.toUpperCase()];
  if (arg.getKind() === SyntaxKind.ArrayLiteralExpression) {
    const out: string[] = [];
    for (const el of (arg as ArrayLiteralExpression).getElements()) {
      const v = staticString(el);
      if (v === undefined) return null;
      out.push(v.toUpperCase());
    }
    return out.length ? out : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// route-prefix / router-mount grouping (deterministic, no LLM).

// Deterministic slug for a group id / path segment (camelCase → kebab, drop
// non-alnum). Mirrors the Nest adapter's slug discipline (a private copy — the
// carve-out keeps each adapter self-contained).
function slugify(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Humanize a slug into a subsystem label (`users` → 'Users', `user-profiles` →
// 'User Profiles'). Falls back to the slug when it has no word characters.
function humanizeSlug(slug: string): string {
  const words = slug.split('-').filter(Boolean);
  if (words.length === 0) return slug;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// A LITERAL path segment (not a route param / wildcard / regex). Express,
// Fastify and Hono params start with `:`; wildcards are `*`; some forms use
// `{…}` / `(…)`. Only plain literal segments carry a grouping signal.
function isStaticSegment(seg: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(seg);
}

// Leading "noise" segments that carry no grouping signal — a shared `/api`
// prefix, or an API version (`/v1`, `/v2`). Stripping them turns `/api/users` +
// `/api/orders` into the distinguishing `users` / `orders` subsystems.
//
// DELIBERATELY NARROW: only the `api` + version vocabulary, never a domain-ish
// word (a literal `/rest/...` or `/admin/...` is kept as the group key, because
// it could genuinely be the feature name). This is the "minimal noise" half of a
// GLOBAL-per-path strip — it is NOT sibling-relative, so an app whose routes ALL
// sit under one shared NON-noise prefix (`/admin/users`, `/admin/orders`)
// intentionally collapses to a single `admin` subsystem rather than splitting on
// the next segment. That matches the mount example (`app.use('/admin', router)`
// → `admin`); recovering sibling-relative splits would need cross-route analysis
// we deliberately skip here.
const NOISE_SEGMENTS = new Set(['api']);
function isNoiseSegment(seg: string): boolean {
  const s = seg.toLowerCase();
  return NOISE_SEGMENTS.has(s) || /^v\d+$/.test(s);
}

// The grouping slug for a full route path: the first DISTINGUISHING static
// segment (leading noise segments skipped while a non-noise one remains).
// Undefined when the path has no static segment at all (e.g. `/` or `/:id`) —
// such a route is ungroupable (degrade + log at the call site).
function prefixSlug(fullPath: string): string | undefined {
  const statics = fullPath.split('/').filter((s) => s.length > 0 && isStaticSegment(s));
  if (statics.length === 0) return undefined;
  let i = 0;
  while (i < statics.length - 1 && isNoiseSegment(statics[i])) i++;
  return slugify(statics[i]) || undefined;
}

// Join a mount prefix with a (mount or route) path into one normalized posix
// path. `joinPath('', '/users')` → '/users'; `joinPath('/api/users', '/:id')`
// → '/api/users/:id'; empty result → '/'.
function joinPath(a: string, b: string): string {
  const segs = [...a.split('/'), ...b.split('/')].filter((s) => s.length > 0);
  return '/' + segs.join('/');
}

// Resolve each mounted controller's MOUNT PREFIX from the mount graph, seeded by
// the entrypoints (the server root is mounted at ''). Only mounts whose CHILD is
// a controller (a real sub-router) propagate a prefix. The fixpoint keeps the
// lexicographically-smallest prefix reachable from an entrypoint — ORDER-
// INDEPENDENT, so the result is deterministic regardless of scan order. A
// controller mounted at several distinct prefixes is reported in `multiMounted`
// (logged; smallest kept). A controller never reached from an entrypoint stays
// absent → the caller falls back to '' (its routes group by their own path).
function resolveMountPrefixes(
  entrypoints: ReadonlySet<string>,
  controllers: ReadonlySet<string>,
  mounts: { parent: string; child: string; mountPath: string }[],
): { prefixByFile: Map<string, string>; multiMounted: Set<string> } {
  const prefixByFile = new Map<string, string>();
  for (const e of [...entrypoints].sort()) prefixByFile.set(e, '');

  const ctrlMounts = mounts
    .filter((m) => controllers.has(m.child))
    .sort((a, b) =>
      a.parent < b.parent
        ? -1
        : a.parent > b.parent
          ? 1
          : a.child < b.child
            ? -1
            : a.child > b.child
              ? 1
              : a.mountPath < b.mountPath
                ? -1
                : a.mountPath > b.mountPath
                  ? 1
                  : 0,
    );

  const cap = controllers.size + ctrlMounts.length + 2; // bounds any mount cycle
  for (let round = 0; round < cap; round++) {
    let changed = false;
    for (const m of ctrlMounts) {
      const pPrefix = prefixByFile.get(m.parent);
      if (pPrefix === undefined) continue;
      const cand = joinPath(pPrefix, m.mountPath);
      const cur = prefixByFile.get(m.child);
      if (cur === undefined || cand < cur) {
        prefixByFile.set(m.child, cand);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Multi-mount detection (logging only): a child resolvable to ≥2 distinct
  // candidate prefixes (the smallest already won above).
  const candsByChild = new Map<string, Set<string>>();
  for (const m of ctrlMounts) {
    const pPrefix = prefixByFile.get(m.parent);
    if (pPrefix === undefined) continue;
    const cand = joinPath(pPrefix, m.mountPath);
    let set = candsByChild.get(m.child);
    if (!set) {
      set = new Set();
      candsByChild.set(m.child, set);
    }
    set.add(cand);
  }
  const multiMounted = new Set<string>();
  for (const [child, set] of candsByChild) if (set.size > 1) multiMounted.add(child);

  return { prefixByFile, multiMounted };
}

// Build the route-prefix grouping priors from the accumulated registrations +
// mounts + service tail. PURE over `acc.roleByFile` (final, post pass-2). The
// entrypoint is never grouped (it spans every prefix). Returns sorted, stable
// groups + the degrade counts for logging.
function buildRouteGroups(acc: Acc): {
  groups: FrameworkGroup[];
  multiMounted: Set<string>;
  ungroupable: number;
} {
  const entrypoints = new Set<string>();
  const controllers = new Set<string>();
  for (const [f, role] of acc.roleByFile) {
    if (role === 'entrypoint') entrypoints.add(f);
    else if (role === 'controller') controllers.add(f);
  }

  const { prefixByFile, multiMounted } = resolveMountPrefixes(entrypoints, controllers, acc.mounts);

  const groupBySlug = new Map<string, { label: string; files: Set<string> }>();
  const slugsByFile = new Map<string, Set<string>>();
  // Never group the server root: it serves every prefix, so forcing it into one
  // route subsystem would be wrong. It keeps its directory/own subsystem.
  const addToGroup = (slug: string, fileId: string): void => {
    if (acc.roleByFile.get(fileId) === 'entrypoint') return;
    let g = groupBySlug.get(slug);
    if (!g) {
      g = { label: humanizeSlug(slug), files: new Set() };
      groupBySlug.set(slug, g);
    }
    g.files.add(fileId);
    let s = slugsByFile.get(fileId);
    if (!s) {
      s = new Set();
      slugsByFile.set(fileId, s);
    }
    s.add(slug);
  };

  let ungroupable = 0;
  for (const reg of acc.routeRegs) {
    const ctrlPrefix = prefixByFile.get(reg.controller) ?? '';
    const ctrlIsRouter = acc.roleByFile.get(reg.controller) === 'controller';
    const slugs = new Set<string>();
    for (const p of reg.paths) {
      const slug = prefixSlug(joinPath(ctrlPrefix, p));
      if (!slug) {
        ungroupable++;
        continue;
      }
      slugs.add(slug);
    }
    for (const slug of slugs) {
      addToGroup(slug, reg.handler);
      // A sub-router (controller) belongs to its own prefix's subsystem; an
      // entrypoint registering an inline route is excluded by addToGroup.
      if (ctrlIsRouter) addToGroup(slug, reg.controller);
    }
  }

  // A mounted controller with no direct routes of its own (it only re-mounts
  // deeper) still belongs to its mount prefix's subsystem.
  for (const c of controllers) {
    const pre = prefixByFile.get(c);
    if (pre === undefined || pre === '') continue;
    const slug = prefixSlug(pre);
    if (slug) addToGroup(slug, c);
  }

  // The one-hop service tail joins the route group(s) of the handler that calls
  // it (a shared service claimed by several groups is arbitrated by the
  // contribute-step's majority-claim rule).
  for (const st of acc.serviceTail) {
    const callerSlugs = slugsByFile.get(st.handler);
    if (!callerSlugs) continue;
    for (const slug of callerSlugs) addToGroup(slug, st.service);
  }

  const groups: FrameworkGroup[] = [...groupBySlug.entries()]
    .map(([id, g]) => ({ id, label: g.label, fileIds: [...g.files].sort() }))
    .filter((g) => g.fileIds.length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { groups, multiMounted, ungroupable };
}

// ---------------------------------------------------------------------------
// The full analysis.

function analyzeNode(ctx: FrameworkContext): NodeAnalysis {
  const { repoDir, rootPath, graph } = ctx;
  const project = buildExtractionProject(repoDir);
  addAllSourceFiles(project, repoDir);

  const fileById = new Map<string, SourceFile>();
  for (const sf of project.getSourceFiles()) fileById.set(toId(repoDir, sf.getFilePath()), sf);
  const idSet = new Set(fileById.keys());
  const resolveSpecifier = makeSpecifierResolver(idSet);

  const acc: Acc = {
    roleByFile: new Map(),
    routesByFile: new Map(),
    edges: new Map(),
    mountTargets: new Set(),
    routeRegs: [],
    mounts: [],
    serviceTail: [],
    diag: { dynamicPaths: 0, unresolvedHandlers: new Set(), unsupported: 0, dynamicMounts: 0 },
  };

  // Pass 1 — roles + route/middleware/mount edges from the registration sites.
  for (const [fileId, sf] of fileById) {
    if (!inScope(fileId, rootPath)) continue;
    const imports = buildImportNameMap(sf, repoDir);
    scanFile(sf, fileId, imports, (spec) => resolveSpecifier(fileId, spec), acc);
  }

  // A mounted app instance is a controller, even when constructed like the root
  // app (`new Hono()` → `entrypoint`). The root app is never a mount target, so
  // this override only ever demotes a sub-app — never the real entrypoint.
  for (const f of acc.mountTargets) acc.roleByFile.set(f, 'controller');

  // Pass 2 — handler → service tail. A service is an INTERNAL file a request
  // handler (route-handler / controller) directly CALLS (a structural `call`
  // edge — NOT a mere import) per the graph, that isn't itself a request-spine
  // role. The edge is already structural (deduped downstream); re-emitting it
  // carries the spine + drives the `service` role. One hop only — the immediate
  // tail. We gate on `call` (not `import`) so the spec's "handler → service
  // CALLS" is honored precisely: a real call (`svc.foo()`) always emits a `call`
  // edge, while a type-only / constant import emits only an `import` edge — so
  // this loses no real tail but never mislabels a pure type/constant dep as a
  // service.
  const handlerFiles = new Set<string>();
  for (const [fileId, role] of acc.roleByFile) {
    if (role === 'route-handler' || role === 'controller') handlerFiles.add(fileId);
  }
  if (handlerFiles.size > 0) {
    for (const e of graph.edges) {
      if (e.external) continue;
      if (e.kind !== 'call') continue; // CALLS only — not type/constant imports
      if (e.from === e.to) continue;
      if (!handlerFiles.has(e.from)) continue;
      if (!inScope(e.to, rootPath)) continue;
      const targetRole = acc.roleByFile.get(e.to);
      // Skip request-spine targets (don't relabel an entry/handler/mw/controller
      // a service); an as-yet-unroled internal target is the service tail.
      if (
        targetRole === 'entrypoint' ||
        targetRole === 'route-handler' ||
        targetRole === 'controller' ||
        targetRole === 'middleware'
      ) {
        continue;
      }
      addEdge(acc, e.from, e.to, { framework: 'node', relation: 'service' });
      addRole(acc, e.to, 'service');
      // the service tail; the service joins its caller's route group(s).
      acc.serviceTail.push({ handler: e.from, service: e.to });
    }
  }

  // Build the per-file role tags, folding accumulated route labels onto the
  // WINNING role's metadata (so a route served inline by the entrypoint still
  // carries its method+path label even though `entrypoint` outranks
  // `route-handler`). Route labels sorted for snapshot stability.
  //
  // NOTE (per-MODULE collapse): these are per-FILE tags. When several handler
  // files land in ONE module, the contribute-step keeps a single RoleTag per
  // module (highest priority, lexical tiebreak), so only the winning file's
  // `routes` metadata survives at module granularity — the per-module route
  // table is best-effort, not exhaustive. That's an accepted limitation of the
  // LIGHTWEIGHT slice (route labels are metadata, not nodes); a richer per-module
  // route aggregation would belong with the deferred grouping work.
  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of acc.roleByFile) {
    const tag: RoleTag = { role, kind: ROLE_KIND[role], priority: ROLE_PRIORITY[role] };
    const routes = acc.routesByFile.get(fileId);
    const meta: Record<string, unknown> = { framework: 'node' };
    if (routes && routes.length) {
      meta.routes = [...routes].sort((a, b) =>
        a.method < b.method ? -1 : a.method > b.method ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
    }
    tag.metadata = meta;
    roles.set(fileId, tag);
  }

  // Deterministic edge ordering — module-id resolution + dedupe downstream rely
  // on a stable input order; sort by endpoints.
  const edges = [...acc.edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  // the route-prefix / router-mount grouping priors.
  const { groups, multiMounted, ungroupable } = buildRouteGroups(acc);

  // Positive signal for validation.
  if (acc.roleByFile.size > 0 || edges.length > 0) {
    console.log(
      `  [node] request spine: ${edges.length} edge(s) · ${acc.roleByFile.size} role(s) across the request flow`,
    );
  }
  if (groups.length > 0) {
    console.log(
      `  [node] grouping: ${groups.length} route-prefix subsystem(s) [${groups.map((g) => g.id).join(', ')}]`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  if (acc.diag.dynamicPaths > 0 || acc.diag.unresolvedHandlers.size > 0 || acc.diag.unsupported > 0) {
    const parts: string[] = [];
    if (acc.diag.dynamicPaths > 0) parts.push(`${acc.diag.dynamicPaths} dynamic/computed route path(s)`);
    if (acc.diag.unresolvedHandlers.size > 0) {
      parts.push(
        `${acc.diag.unresolvedHandlers.size} route(s) with an unresolvable handler: ${[...acc.diag.unresolvedHandlers].sort().join(', ')}`,
      );
    }
    if (acc.diag.unsupported > 0) parts.push(`${acc.diag.unsupported} unsupported route form(s)`);
    console.log(`  [node] skipped ${parts.join(' · ')} (logged, not silently dropped)`);
  }
  // No silent caps (locked): log grouping degradations too.
  if (ungroupable > 0 || acc.diag.dynamicMounts > 0 || multiMounted.size > 0) {
    const parts: string[] = [];
    if (ungroupable > 0) parts.push(`${ungroupable} route(s) with no static prefix (ungrouped)`);
    if (acc.diag.dynamicMounts > 0) parts.push(`${acc.diag.dynamicMounts} dynamic/computed mount path(s)`);
    if (multiMounted.size > 0) {
      parts.push(`${multiMounted.size} controller(s) mounted at multiple prefixes (kept lexically-smallest)`);
    }
    console.log(`  [node] grouping skipped ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  return { edges, roles, groups };
}

function getAnalysis(ctx: FrameworkContext): NodeAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeNode(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const nodeAdapter: FrameworkAdapter = {
  name: 'node',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreNode(gatherNodeSignals(base), rootPath);
  },

  // the route-prefix / router-mount grouping prior (file-id space; the
  // contribute-step resolves to modules + overrides their subsystem, AUTHORITATIVE
  // over directory + workspace-package grouping). Deterministic `node:<slug>` ids
  // (prefix-derived, never an index). No classificationsNeeded — grouping is
  // fully deterministic; ungroupable routes / dynamic mounts degrade + log inside
  // the analysis, so the deferred-classification channel stays empty.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // the request spine as roles + edges (file-id space; the
  // contribution step resolves to modules, drops self-edges, dedupes,
  // 8-verb-validates). kind 'calls' only.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE (route registrations, app.use chains, handler bodies),
  // so declare the source paths the diff-driven hosted walk must treat as
  // framework-relevant. Never-store-source holds: read server-side, persist only
  // the derived edges/roles.
  scansSourcePath(path: string): boolean {
    const ext = path.split('.').pop();
    return ext !== undefined && SOURCE_EXT_SET.has(ext);
  },
};
