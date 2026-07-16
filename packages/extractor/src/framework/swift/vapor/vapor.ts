// The Vapor FrameworkAdapter (server WEB, thin) — the Swift server-side sibling of
// the Vapor route surface, on the shared Swift framework-analysis layer. Net-new;
// detects against the SPM `vapor` dependency (Vapor IS a manifest dep, unlike the
// Apple UI frameworks). Fluent MODELS are the data adapter's job (SW3); this adapter
// owns only the ROUTE surface — controllers + the route spine.
//
//   * roleTags        — a `RouteCollection` conformer → `gateway` (role 'controller';
//                       a Vapor controller is an edge request-entry, the one place
//                       `gateway` is reserved for on the Swift side). The route-wiring
//                       file (a `routes.swift`/`configure.swift` that mounts
//                       collections or declares routes) → `gateway` (role 'router').
//   * syntheticEdges  — THE ROUTE SPINE: `app.register(collection: X)` mounts a
//                       controller, resolved to a router-file → controller-file
//                       `calls` edge. Handles BOTH the direct form
//                       (`register(collection: TodoController())`) and the idiomatic
//                       var-bound form (`let c = TodoController(); register(collection: c)`)
//                       by resolving local `let/var = Controller()` bindings first.
//
// A controller's own `boot(routes:)` routes (`routes.get(use: index)`) target methods
// of the SAME controller — self-edges, no cross-file wiring — so the register spine is
// the meaningful edge. Deterministic; unresolvable mounts DEGRADE + LOG.

import { openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { parseSwiftScope, readSwiftDeps, type ParsedSwiftFile } from '../analyze.js';
import { scanImports, stripCommentsAndStrings } from '../swift-ast.js';
import { SWIFT_EXCLUDE_DIRS, SWIFT_EXCLUDE_SUFFIXES } from '../../../graph/file-graph.js';
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
// Detection — the SPM `vapor` dependency (+ a nested-package fallback scan).

const DETECT_FILE_CAP = 400;
const DETECT_SKIP = new Set<string>([...SWIFT_EXCLUDE_DIRS]);

function isXcodeContainer(name: string): boolean {
  return SWIFT_EXCLUDE_SUFFIXES.some((s) => name.endsWith(s));
}
function readHead(path: string, maxBytes = 4096): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Does any in-scope Swift file `import Vapor`? A bounded source fallback for a repo
 *  that pulls Vapor transitively without a root `vapor` dep line. */
function anyImportsVapor(base: string): boolean {
  let found = false;
  let scanned = 0;
  const walk = (dir: string): void => {
    if (found || scanned >= DETECT_FILE_CAP) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found || scanned >= DETECT_FILE_CAP) return;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || DETECT_SKIP.has(e.name) || isXcodeContainer(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.swift') && e.name !== 'Package.swift') {
        scanned++;
        if (scanImports(readHead(join(dir, e.name))).includes('Vapor')) found = true;
      }
    }
  };
  walk(base);
  return found;
}

export function scoreVapor(hasVapor: boolean, rootPath = ''): DetectMatch | null {
  if (!hasVapor) return null;
  return { adapter: 'vapor', confidence: clampConfidence(0.85), rootPath, metadata: { signals: { vapor: true } } };
}

// ---------------------------------------------------------------------------
// Roles → the LOCKED MODULE_KINDS. A Vapor controller / router is a request entry →
// `gateway` (the one Swift role that earns gateway — Apple UI is `frontend`).
export type VaporRole = 'controller' | 'router';
const ROLE_PRIORITY: Record<VaporRole, number> = { controller: 7, router: 6 };
const ROLE_KIND: Record<VaporRole, ModuleKind> = { controller: 'gateway', router: 'gateway' };

// A route-DSL call scoped to the `app` / `routes` receiver (`app.get(…)`,
// `routes.post(…)`, `app.grouped(…)`) — the signal that a NON-controller file is a
// route-wiring file. Scoping to app/routes is LOAD-BEARING: a bare `.delete(` /
// `.get(` matches a Fluent MIGRATION's `database.schema("x").delete()` (a schema drop),
// which is data, not routing — so an unscoped route-DSL regex mis-tags every migration
// as a router. A grouped-builder chain still matches via its opening `app.grouped(…)`.
const ROUTE_DSL_RE = /\b(?:app|routes)\.(?:get|post|put|patch|delete|on|grouped|group|webSocket)\s*\(/;
const REGISTER_RE = /\bregister\s*\(\s*collection\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/g;
// `let x = SomeController()` — a local binding from a lowercase var to its type.
const CONTROLLER_BINDING_RE = /\b(?:let|var)\s+([a-z_][A-Za-z0-9_]*)\s*=\s*([A-Z][A-Za-z0-9_]*)\s*\(/g;

function isRouteCollection(parsed: ParsedSwiftFile): boolean {
  return parsed.decls.some((d) => d.kind !== 'extension' && d.inherits.includes('RouteCollection'));
}

// ---------------------------------------------------------------------------
// Analysis.

interface VaporAnalysis {
  edges: FrameworkEdge[];
  roles: Map<string, RoleTag>;
}
interface VaporDiag {
  unresolved: Set<string>;
}
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, VaporAnalysis>();

function addEdge(edges: Map<string, FrameworkEdge>, from: string, to: string): void {
  if (from === to) return;
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'vapor', relation: 'mounts' } });
  }
}

function analyzeVapor(ctx: FrameworkContext): VaporAnalysis {
  const scope = parseSwiftScope(ctx);
  const diag: VaporDiag = { unresolved: new Set() };

  // Pass 1 — roles.
  const roleByFile = new Map<string, VaporRole>();
  for (const [id, parsed] of scope.parsed) {
    if (isRouteCollection(parsed)) {
      roleByFile.set(id, 'controller');
      continue;
    }
    const stripped = stripCommentsAndStrings(parsed.text);
    // A route-wiring file: mounts a collection or declares routes, but is not a
    // controller itself (a functional `routes.swift` / the `configure.swift` wiring).
    if (/\bregister\s*\(\s*collection\s*:/.test(stripped) || ROUTE_DSL_RE.test(stripped)) {
      roleByFile.set(id, 'router');
    }
  }

  // Pass 2 — the route spine: `register(collection: X)` → controller file.
  const edges = new Map<string, FrameworkEdge>();
  for (const [id, parsed] of scope.parsed) {
    const stripped = stripCommentsAndStrings(parsed.text);
    if (!/\bregister\s*\(\s*collection\s*:/.test(stripped)) continue;
    // Local `let x = SomeController()` bindings (the arg is often a var, not the type).
    const bindings = new Map<string, string>();
    for (const m of stripped.matchAll(CONTROLLER_BINDING_RE)) bindings.set(m[1], m[2]);
    for (const m of stripped.matchAll(REGISTER_RE)) {
      const arg = m[1];
      const typeName = /^[A-Z]/.test(arg) ? arg : bindings.get(arg);
      if (!typeName) {
        diag.unresolved.add(`${id}: register(collection: ${arg})`);
        continue;
      }
      const target = scope.resolve(typeName);
      if (target) addEdge(edges, id, target);
      else diag.unresolved.add(`${id}: register(collection: ${typeName})`);
    }
  }

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, { role, kind: ROLE_KIND[role], priority: ROLE_PRIORITY[role], metadata: { framework: 'vapor' } });
  }
  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  const controllers = [...roleByFile.values()].filter((r) => r === 'controller').length;
  if (roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [vapor] ${controllers} controller(s) · ${roleByFile.size - controllers} router(s) · ${sortedEdges.length} route-mount edge(s)`,
    );
  }
  if (diag.unresolved.size > 0) {
    console.log(
      `  [vapor] degraded: ${diag.unresolved.size} unresolvable collection mount(s): ` +
        `${[...diag.unresolved].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`,
    );
  }

  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): VaporAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeVapor(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const vaporAdapter: FrameworkAdapter = {
  name: 'vapor',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const hasVapor = readSwiftDeps(base).has('vapor') || anyImportsVapor(base);
    return scoreVapor(hasVapor, rootPath);
  },

  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  scansSourcePath(path: string): boolean {
    return path.endsWith('.swift');
  },
};

export { isRouteCollection };
