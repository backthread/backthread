// The Spring Boot FrameworkAdapter (web) — a Kotlin server-web adapter on the shared
// Kotlin framework-analysis layer, CO-REGISTERED with Ktor. Net-new; detects against the
// `org.springframework.boot` (or `org.springframework`) Gradle dep group.
//
// Spring DECLARES its web surface with stereotype ANNOTATIONS, which we read STATICALLY
// (install-free, never-store-source) via the hand-rolled Kotlin scanner (no WASM, never
// executes repo code). Two hooks:
//
//   * detect()        — the `org.springframework.boot` / `org.springframework` dependency
//                       group. PURE scorer.
//   * roleTags        — a class annotated @RestController / @Controller (or carrying a
//                       @RequestMapping / @GetMapping / … request-mapping — the route
//                       spine) → gateway; @Service → service; @Repository → service. Read
//                       from the file's annotations (class + method level). METADATA onto
//                       the LOCKED MODULE_KINDS; the module's kind is unchanged. (Spring
//                       DATA repository interfaces that extend JpaRepository/CrudRepository
//                       are the DATA adapter's concern, not this one.)
//   * syntheticEdges  — a controller → the COLLABORATOR types it imports (a name ending
//                       Service/Repository/Client/Facade/…) → a `calls` edge, surfacing the
//                       request-handling flow as a verb. Resolved through the FQN registry;
//                       a non-first-party import is dropped.
//
// Everything deterministic. KNOWN degrades (documented): a mixed Java+Kotlin Spring repo
// yields the Kotlin half only (the extractor sees `.kt`); a collaborator whose type name
// doesn't carry a conventional suffix isn't edged (accuracy over recall — avoids linking a
// controller to every DTO/entity it imports).

import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readGradleDeps, readGradleDepsDeep } from '../../../graph/kotlin-manifest.js';
import { parseKotlinScope, type ParsedKotlinFile } from '../analyze.js';
import { scanAnnotations } from '../kotlin-ast.js';
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

function depsHaveSpring(deps: ReadonlySet<string>): boolean {
  for (const g of deps) if (g === 'org.springframework.boot' || g.startsWith('org.springframework')) return true;
  return false;
}

export function gatherSpringSignal(baseDir: string): boolean {
  return depsHaveSpring(readGradleDeps(baseDir)) || depsHaveSpring(readGradleDepsDeep(baseDir));
}

export function scoreSpring(hasSpring: boolean, rootPath = ''): DetectMatch | null {
  if (!hasSpring) return null;
  return { adapter: 'spring', confidence: clampConfidence(0.85), rootPath, metadata: { signals: { spring: true } } };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS.
export type SpringRole = 'controller' | 'service' | 'repository';

const ROLE_PRIORITY: Record<SpringRole, number> = { controller: 7, service: 5, repository: 4 };
const ROLE_KIND: Record<SpringRole, ModuleKind> = {
  controller: 'gateway',
  service: 'service',
  repository: 'service',
};

const STEREOTYPE_CONTROLLER = new Set(['RestController', 'Controller', 'ControllerAdvice', 'RestControllerAdvice']);
// The request-mapping method annotations — a class carrying any is a controller even if the
// stereotype is on a base class (the route spine).
const MAPPING_ANNOTATIONS = new Set([
  'RequestMapping',
  'GetMapping',
  'PostMapping',
  'PutMapping',
  'DeleteMapping',
  'PatchMapping',
]);

/** The Spring role a file's annotation set implies, or undefined. Priority-ordered. */
export function roleFromAnnotations(annotations: ReadonlySet<string>): SpringRole | undefined {
  for (const a of annotations) if (STEREOTYPE_CONTROLLER.has(a)) return 'controller';
  for (const a of annotations) if (MAPPING_ANNOTATIONS.has(a)) return 'controller';
  if (annotations.has('Service')) return 'service';
  if (annotations.has('Repository')) return 'repository';
  return undefined;
}

// Conventional collaborator-type name suffixes a controller `calls`.
const COLLABORATOR_SUFFIX_RE = /(Service|Repository|Repo|Dao|Client|Facade|Manager|Gateway|Provider)$/;

// ---------------------------------------------------------------------------
// Analysis.

interface SpringAnalysis {
  edges: FrameworkEdge[];
  roles: Map<string, RoleTag>;
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, SpringAnalysis>();

function analyzeSpring(ctx: FrameworkContext): SpringAnalysis {
  const scope = parseKotlinScope(ctx);

  const roleByFile = new Map<string, SpringRole>();
  const annotationsByFile = new Map<string, Set<string>>();
  for (const [id, parsed] of scope.parsed) {
    const anns = new Set(scanAnnotations(parsed.text));
    annotationsByFile.set(id, anns);
    const role = roleFromAnnotations(anns);
    if (role) roleByFile.set(id, role);
  }

  // Controller → collaborator (Service/Repository/…) `calls` edges.
  const edges = new Map<string, FrameworkEdge>();
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const key = `${from}→${to}`;
    if (!edges.has(key)) {
      edges.set(key, {
        source: from,
        target: to,
        kind: 'calls',
        metadata: { framework: 'spring', relation: 'handles' },
      });
    }
  };
  for (const [id, role] of roleByFile) {
    if (role !== 'controller') continue;
    const parsed = scope.parsed.get(id) as ParsedKotlinFile;
    for (const imp of parsed.imports) {
      if (imp.wildcard) continue;
      const simple = imp.fqn.slice(imp.fqn.lastIndexOf('.') + 1);
      if (!COLLABORATOR_SUFFIX_RE.test(simple)) continue;
      const target = scope.resolveTypeRef(simple, parsed);
      if (target && scope.internalIds.has(target)) addEdge(id, target);
    }
  }

  const roles = new Map<string, RoleTag>();
  for (const [id, role] of roleByFile) {
    roles.set(id, { role, kind: ROLE_KIND[role], priority: ROLE_PRIORITY[role], metadata: { framework: 'spring' } });
  }
  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (roleByFile.size > 0 || sortedEdges.length > 0) {
    const counts = new Map<SpringRole, number>();
    for (const r of roleByFile.values()) counts.set(r, (counts.get(r) ?? 0) + 1);
    const summary = [...counts].sort().map(([r, n]) => `${n} ${r}`).join(', ');
    console.log(`  [spring] ${roleByFile.size} role(s) [${summary}] · ${sortedEdges.length} handles edge(s)`);
  }
  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): SpringAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeSpring(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const springAdapter: FrameworkAdapter = {
  name: 'spring',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreSpring(gatherSpringSignal(base), rootPath);
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
