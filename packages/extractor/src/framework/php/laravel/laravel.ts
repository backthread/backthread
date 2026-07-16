// The Laravel FrameworkAdapter (web) — the first PHP framework adapter, driven by
// the shared PHP analysis layer (framework/php). Laravel declares its request
// surface by CONVENTION (app/Http/Controllers, routes/*.php), which we read
// STATICALLY (install-free, never-store-source — parse server-side, persist only
// the derived roles/edges) via php-parser.
//
//   * detect()       — the `laravel/framework` package.
//   * roleTags       — Laravel class conventions onto the LOCKED MODULE_KINDS:
//                      controllers -> gateway, console commands -> job, events +
//                      listeners -> service (role only). METADATA; the module's
//                      `kind` is finer in RoleTag.role, never a new kind. NO Blade
//                      -> frontend (templates are excluded from the graph).
//   * syntheticEdges — the ROUTE SPINE: routes/web.php + routes/api.php -> the
//                      controller each route maps to (kind 'calls'). This is the
//                      wiring the import graph can't fully see (a route references
//                      its controller through `Route::get('/x', [C::class, 'm'])`,
//                      `Route::resource`, or a legacy string, inside grouped/prefixed
//                      closures). The controller reference resolves through the route
//                      file's own `use` imports -> PSR-4.
//
// Directory-primary grouping needs no prior. Unresolvable route targets DEGRADE +
// LOG (no silent caps); closures map to no controller (no edge).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readComposerDeps } from '../../../graph/php-manifest.js';
import { normalizeFqn } from '../../../graph/php-psr4.js';
import { parsePhpScope, type PhpScope, type ParsedPhpFile } from '../analyze.js';
import {
  arrayItems,
  callArgs,
  classConstRef,
  identifierName,
  isClosureNode,
  nameText,
  stringValue,
  type PhpClass,
} from '../php-ast.js';
import type { Node } from 'php-parser';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  RoleTag,
} from '../../types.js';
import type { ModuleKind } from '../../../types.js';

// A loose php-parser node view (kind + arbitrary fields).
type AnyNode = Node & Record<string, unknown>;
function asNode(v: unknown): AnyNode | undefined {
  return v && typeof v === 'object' && typeof (v as { kind?: unknown }).kind === 'string'
    ? (v as AnyNode)
    : undefined;
}

// ---------------------------------------------------------------------------
// Detection (fs → deps; PURE scorer). Never reads source content.

export interface LaravelSignals {
  hasLaravel: boolean; // laravel/framework — the authoritative signal
}

export function gatherLaravelSignals(baseDir: string): LaravelSignals {
  const deps = readComposerDeps(baseDir);
  return { hasLaravel: deps.has('laravel/framework') };
}

export function scoreLaravel(s: LaravelSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasLaravel) return null;
  return { adapter: 'laravel', confidence: clampConfidence(0.9), rootPath, metadata: { framework: 'laravel' } };
}

const NESTED_SKIP_DIRS = new Set(['vendor', 'var', 'cache', 'storage', 'node_modules', 'app', 'src', 'config', 'public', 'tests']);

/** Immediate subdirs (depth 1) holding a composer.json — a nested PHP backend. */
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
// Roles → locked MODULE_KINDS.

export type LaravelRole = 'controller' | 'command' | 'event' | 'listener';

const ROLE_KIND: Record<LaravelRole, ModuleKind> = {
  controller: 'gateway',
  command: 'job',
  event: 'service',
  listener: 'service',
};

const ROLE_PRIORITY: Record<LaravelRole, number> = {
  controller: 8,
  command: 6,
  event: 3,
  listener: 3,
};

function inApp(fileId: string, sub: string): boolean {
  return new RegExp(`(^|/)app/${sub}/`).test(fileId);
}

/** A file's Laravel role from its path (+ an extends check for commands). Laravel's
 *  directory convention IS the reliable role signal (every class under
 *  app/Http/Controllers is a controller regardless of inheritance). */
function laravelRole(fileId: string, classes: readonly PhpClass[]): LaravelRole | undefined {
  if (inApp(fileId, 'Http/Controllers')) return 'controller';
  if (inApp(fileId, 'Console/Commands') && classes.some((c) => c.extends && c.extends.endsWith('Command'))) {
    return 'command';
  }
  if (inApp(fileId, 'Events')) return 'event';
  if (inApp(fileId, 'Listeners')) return 'listener';
  return undefined;
}

// ---------------------------------------------------------------------------
// Route spine — routes/*.php → controllers.

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match']);
const RESOURCE_METHODS = new Set(['resource', 'apiResource', 'resources', 'apiResources']);

function lastSeg(name: string): string {
  const i = name.lastIndexOf('\\');
  return i >= 0 ? name.slice(i + 1) : name;
}

function isRouteFile(fileId: string): boolean {
  return /(^|\/)routes\/(web|api)\.php$/.test(fileId);
}

interface ChainStep {
  name: string;
  call: AnyNode;
}

/** Flatten a `Route::a()->b()->c()` method chain into ordered steps (innermost
 *  first). Returns undefined when the chain isn't rooted on the Route facade. */
function flattenRouteChain(call: AnyNode): ChainStep[] | undefined {
  const steps: ChainStep[] = [];
  let node: AnyNode | undefined = call;
  let onRoute = false;
  while (node && node.kind === 'call') {
    const what = asNode(node.what);
    if (!what) break;
    if (what.kind === 'staticlookup') {
      const method = identifierName(what.offset);
      if (method) steps.push({ name: method, call: node });
      onRoute = lastSeg(nameText(what.what) ?? '') === 'Route';
      node = undefined;
      break;
    }
    if (what.kind === 'propertylookup' || what.kind === 'nullsafepropertylookup') {
      const method = identifierName(what.offset);
      if (method) steps.push({ name: method, call: node });
      node = asNode(what.what);
      continue;
    }
    break;
  }
  if (!onRoute) return undefined;
  steps.reverse();
  return steps;
}

/** The statements inside a closure passed to `->group(...)`. */
function closureStatements(node: AnyNode): AnyNode[] {
  const body = asNode(node.body);
  if (body && Array.isArray(body.children)) {
    return (body.children as unknown[]).map((s) => asNode(s)).filter((s): s is AnyNode => !!s);
  }
  return [];
}

/** The controller reference an action argument maps to, or undefined (closure / no
 *  target). `legacy` marks a string form we resolve best-effort (degrade+log). */
interface ActionRef {
  ref: string;
  legacy: boolean;
}
function actionRef(arg: AnyNode | undefined, controllerCtx: string | undefined): ActionRef | undefined {
  if (!arg) return undefined;
  // [C::class, 'method'] — the tuple form.
  if (arg.kind === 'array') {
    const first = arrayItems(arg)[0];
    const c = classConstRef(first);
    return c ? { ref: c, legacy: false } : undefined;
  }
  // C::class — a single-action / __invoke controller.
  const cc = classConstRef(arg);
  if (cc) return { ref: cc, legacy: false };
  // A string action: 'Ctrl@method' (legacy) or a bare 'method' under a controller().
  const s = stringValue(arg);
  if (s !== undefined) {
    if (s.includes('@')) return { ref: s.split('@')[0], legacy: true };
    if (controllerCtx) return { ref: controllerCtx, legacy: false };
  }
  return undefined; // closure / dynamic — no edge
}

// ---------------------------------------------------------------------------
// Analysis (parse once; roles + edges).

interface LaravelAnalysis {
  roles: Map<string, RoleTag>;
  edges: FrameworkEdge[];
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<LaravelAnalysis>>();

async function analyzeLaravel(ctx: FrameworkContext): Promise<LaravelAnalysis> {
  const scope: PhpScope = await parsePhpScope(ctx);

  // Roles — the highest-priority Laravel role per file.
  const roles = new Map<string, RoleTag>();
  for (const [fileId, parsed] of scope.parsed) {
    const role = laravelRole(fileId, parsed.classes);
    if (!role) continue;
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'laravel' },
    });
  }

  // Route spine — each routes/{web,api}.php → the controllers its routes map to.
  const edges = new Map<string, FrameworkEdge>();
  const unresolved = new Set<string>();
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const key = `${from}→${to}`;
    if (!edges.has(key)) {
      edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'laravel', relation: 'route' } });
    }
  };

  for (const [fileId, parsed] of scope.parsed) {
    if (!isRouteFile(fileId)) continue;
    const resolveController = (a: ActionRef): void => {
      const to = a.legacy
        ? a.ref.includes('\\')
          ? scope.resolve(normalizeFqn(a.ref))
          : scope.resolve(`App\\Http\\Controllers\\${a.ref}`)
        : scope.resolveRef(a.ref, parsed.useMap, parsed.namespace);
      if (to) addEdge(fileId, to);
      else unresolved.add(a.ref);
    };
    walkRoutes(topStatements(parsed), undefined, (arg, ctx2) => {
      const a = actionRef(arg, ctx2);
      if (a) resolveController(a);
    });
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(`  [laravel] ${roles.size} role(s) · ${sortedEdges.length} route edge(s)`);
  }
  if (unresolved.size > 0) {
    console.log(
      `  [laravel] degraded: ${unresolved.size} route target(s) unresolved: ${[...unresolved].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`,
    );
  }
  return { roles, edges: sortedEdges };
}

/** The top-level statement nodes of a parsed route file (unwrapping namespaces). */
function topStatements(parsed: ParsedPhpFile): AnyNode[] {
  const out: AnyNode[] = [];
  const collect = (n: AnyNode | undefined): void => {
    if (!n) return;
    if (n.kind === 'namespace' && Array.isArray(n.children)) {
      for (const c of n.children) collect(asNode(c));
    } else out.push(n);
  };
  const root = asNode(parsed.node) as AnyNode;
  for (const c of (Array.isArray(root.children) ? root.children : []) as unknown[]) collect(asNode(c));
  return out;
}

/**
 * Walk route-registering statements, emitting each route's action argument with
 * the controller context in force. Handles `Route::<verb>(path, action)`,
 * `Route::resource(name, C::class)`, `Route::controller(C::class)->group(fn)`
 * (sets the context for the group), and nested `->group(fn)` / `Route::prefix(…)
 * ->group(fn)` (recurses). A route mapped to a closure yields no action.
 */
function walkRoutes(
  statements: readonly AnyNode[],
  controllerCtx: string | undefined,
  emit: (action: AnyNode | undefined, ctx: string | undefined) => void,
): void {
  for (const stmt of statements) {
    const expr = stmt.kind === 'expressionstatement' ? asNode(stmt.expression) : stmt;
    if (!expr || expr.kind !== 'call') continue;
    const steps = flattenRouteChain(expr);
    if (!steps) continue;

    // A `controller(C::class)` step sets the controller for the whole chain/group.
    let ctx = controllerCtx;
    for (const step of steps) {
      if (step.name === 'controller') {
        const c = classConstRef(callArgs(step.call)[0]);
        if (c) ctx = c;
      }
    }

    for (const step of steps) {
      const args = callArgs(step.call);
      if (HTTP_VERBS.has(step.name)) {
        emit(args[args.length - 1], ctx); // action = last positional arg
      } else if (RESOURCE_METHODS.has(step.name)) {
        emit(args[1], ctx); // resource(name, controller)
      } else if (step.name === 'group') {
        const closure = args.find((a) => isClosureNode(a));
        if (closure) walkRoutes(closureStatements(closure), ctx, emit);
      }
    }
  }
}

function getAnalysis(ctx: FrameworkContext): Promise<LaravelAnalysis> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeLaravel(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const laravelAdapter: FrameworkAdapter = {
  name: 'laravel',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreLaravel(gatherLaravelSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowComposerSubdirs(base)) {
        const m = scoreLaravel(gatherLaravelSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // routes/*.php → controller (kind 'calls'). File-id endpoints; the step resolves
  // to modules, drops self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return (await getAnalysis(ctx)).edges;
  },

  // Laravel class conventions → roles on the locked MODULE_KINDS. METADATA only.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return (await getAnalysis(ctx)).roles;
  },

  // The hooks READ SOURCE (PHP). Declare the paths the diff-driven hosted walk must
  // treat as framework-relevant. Never-store-source holds.
  scansSourcePath(path: string): boolean {
    return path.endsWith('.php');
  },
};
