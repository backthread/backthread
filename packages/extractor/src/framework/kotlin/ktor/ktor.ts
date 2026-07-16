// The Ktor FrameworkAdapter (web) — a Kotlin server-web adapter on the shared Kotlin
// framework-analysis layer. Net-new; detects against the `io.ktor` Gradle dep group.
//
// Ktor DECLARES its HTTP surface as a `routing { get("/x") { … } }` DSL inside
// `fun Application.module()` / `fun Application.configureRouting()` extension functions,
// which we read STATICALLY (install-free, never-store-source) via the hand-rolled Kotlin
// scanner (no WASM, never executes repo code). Two hooks:
//
//   * detect()        — the `io.ktor` dependency group. PURE scorer.
//   * roleTags        — a file that declares an `Application`/`Route`/`Routing` extension
//                       function (`fun Application.module()`, `fun Route.userRoutes()`) OR
//                       contains a `routing { … }` / `route(...)` DSL block is a request
//                       entry → gateway (role 'route'). METADATA onto the LOCKED
//                       MODULE_KINDS; the module's `kind` is unchanged.
//   * syntheticEdges  — THE ROUTE-COMPOSITION SPINE: a module/route file's invoked
//                       top-level functions (`module() { configureRouting(); userRoutes() }`)
//                       resolved to the file that DEFINES them → a `calls` edge. This is
//                       wiring the import graph never names as a verb — Ktor route setup is
//                       EXTENSION-function calls (`Application.configureRouting()`), not
//                       imports, so the plain import backbone misses it. Resolved through a
//                       function-name → file index (AMBIGUOUS names dropped; accuracy over
//                       recall). Inline `get("/x") { … }` handlers are lambdas with no
//                       separate file, so they yield no edge (a documented degrade).
//
// Everything deterministic. KNOWN degrades (documented): an inline route handler is a
// lambda (no edge); a same-named top-level function in two files is ambiguous → dropped;
// a route DSL reached only through a local `val` is not followed.

import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readGradleDeps, readGradleDepsDeep } from '../../../graph/kotlin-manifest.js';
import { parseKotlinScope, type KotlinScope, type ParsedKotlinFile } from '../analyze.js';
import { sourceLines } from '../kotlin-ast.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  RoleTag,
} from '../../types.js';
import type { ModuleKind } from '../../../types.js';

// ---------------------------------------------------------------------------
// Detection.

/** Does a dependency-group set declare Ktor (`io.ktor.*`)? */
function depsHaveKtor(deps: ReadonlySet<string>): boolean {
  for (const g of deps) if (g === 'io.ktor' || g.startsWith('io.ktor.')) return true;
  return false;
}

export function gatherKtorSignal(baseDir: string): boolean {
  return depsHaveKtor(readGradleDeps(baseDir)) || depsHaveKtor(readGradleDepsDeep(baseDir));
}

/** Decide Ktor from the signal. Returns null → generic-Kotlin fallthrough. */
export function scoreKtor(hasKtor: boolean, rootPath = ''): DetectMatch | null {
  if (!hasKtor) return null;
  return { adapter: 'ktor', confidence: clampConfidence(0.85), rootPath, metadata: { signals: { ktor: true } } };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. A routing/module file is a request entry →
// gateway. METADATA; the module's kind is unchanged.
const ROLE = 'route';
const ROLE_KIND: ModuleKind = 'gateway';
const ROLE_PRIORITY = 7;

// The Ktor DSL markers that make a file a route/gateway. A `routing {`/`route(` block, or
// an `Application`/`Route`/`Routing` extension function (the app module / a route module).
const ROUTING_DSL_RE = /\brouting\s*\{|\broute\s*\(/;
const APP_RECEIVERS = new Set(['Application', 'Route', 'Routing']);

// ---------------------------------------------------------------------------
// Analysis.

interface KtorAnalysis {
  edges: FrameworkEdge[];
  roles: Map<string, RoleTag>;
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, KtorAnalysis>();

/** Is this file a Ktor route/module gateway (declares an app-extension fun OR routing DSL)? */
function isRouteFile(parsed: ParsedKotlinFile): boolean {
  if (parsed.funs.some((f) => f.receiver !== undefined && APP_RECEIVERS.has(f.receiver))) return true;
  // Test the comment/string-stripped source so a `routing {` inside a comment or a string
  // literal never false-tags a file as a gateway.
  return sourceLines(parsed.text).some((l) => ROUTING_DSL_RE.test(l));
}

/**
 * Build the top-level-function-name → file index (INCLUDING extension functions, keyed by
 * their simple name) used to resolve route-composition calls. A name defined in TWO files
 * is AMBIGUOUS and dropped (accuracy over recall).
 */
function buildFunctionIndex(scope: KotlinScope): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const [id, parsed] of scope.parsed) {
    for (const f of parsed.funs) {
      (candidates.get(f.name) ?? candidates.set(f.name, new Set()).get(f.name)!).add(id);
    }
  }
  const index = new Map<string, string>();
  for (const [name, files] of candidates) if (files.size === 1) index.set(name, [...files][0]);
  return index;
}

function analyzeKtor(ctx: FrameworkContext): KtorAnalysis {
  const scope = parseKotlinScope(ctx);
  const funIndex = buildFunctionIndex(scope);

  const roles = new Map<string, RoleTag>();
  const edges = new Map<string, FrameworkEdge>();
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const key = `${from}→${to}`;
    if (!edges.has(key)) {
      edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'ktor', relation: 'route' } });
    }
  };

  for (const [id, parsed] of scope.parsed) {
    if (!isRouteFile(parsed)) continue;
    roles.set(id, { role: ROLE, kind: ROLE_KIND, priority: ROLE_PRIORITY, metadata: { framework: 'ktor' } });
    // Route composition: each invoked top-level function resolved to its defining file.
    for (const name of new Set(parsed.callNames)) {
      const target = funIndex.get(name);
      if (target && target !== id) addEdge(id, target);
    }
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(`  [ktor] ${roles.size} route/gateway file(s) · ${sortedEdges.length} route-composition edge(s)`);
  }
  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): KtorAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeKtor(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const ktorAdapter: FrameworkAdapter = {
  name: 'ktor',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreKtor(gatherKtorSignal(base), rootPath);
  },

  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  scansSourcePath(path: string): boolean {
    return path.endsWith('.kt');
  },
};
