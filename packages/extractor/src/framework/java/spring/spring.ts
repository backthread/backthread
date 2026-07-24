// The Spring FrameworkAdapter (web + async) for JAVA — the Java sibling of the Kotlin
// `spring` adapter, on the shared Java framework-analysis layer. Named `java-spring` (not
// `spring`) so it never REPLACES the Kotlin `spring` adapter on a Java+Gradle repo where
// both fleets register (the registry is idempotent on name); each tags only its own
// language's files.
//
// Spring DECLARES its web + async surface with stereotype ANNOTATIONS + Spring-Data
// repository interfaces, read STATICALLY (install-free, never-store-source) from the
// hand-rolled Java scanner. Two hooks:
//
//   * detect()        — the `org.springframework(.boot)` dependency group (pom.xml groupId
//                       or Gradle coordinate). PURE scorer.
//   * roleTags        — @RestController/@Controller (or a request-mapping — the route spine)
//                       → gateway; @KafkaListener/@RabbitListener/@Scheduled → job (async
//                       work); @Service → service; @Component → service; @Repository or a
//                       Spring-Data repository base (extends JpaRepository/CrudRepository/…)
//                       → service. METADATA onto the LOCKED MODULE_KINDS; the kind is never
//                       a new one. (JPA @Entity + associations are the java-jpa adapter's
//                       concern.)
//   * syntheticEdges  — a controller → the COLLABORATOR types it imports (a name ending
//                       Service/Repository/Client/… ) → a `calls` edge, surfacing the
//                       request-handling flow as a verb. Resolved through the FQN registry;
//                       a non-first-party import is dropped.
//
// Deterministic. KNOWN degrades: a controller whose collaborator type carries no
// conventional suffix isn't edged (accuracy over recall). Spring has no central route file
// (each @RequestMapping lives on its controller), so there is no separate router→controller
// spine — the controller carrying the mapping IS the gateway.

import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readJavaDeps } from '../../../graph/java-manifest.js';
import { parseJavaScope, type ParsedJavaFile } from '../analyze.js';
import { scanAnnotations } from '../java-ast.js';
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
  for (const g of deps) if (g === 'org.springframework' || g.startsWith('org.springframework')) return true;
  return false;
}

export function gatherSpringSignal(baseDir: string): boolean {
  return depsHaveSpring(readJavaDeps(baseDir));
}

export function scoreSpring(hasSpring: boolean, rootPath = ''): DetectMatch | null {
  if (!hasSpring) return null;
  return { adapter: 'java-spring', confidence: clampConfidence(0.85), rootPath, metadata: { signals: { spring: true } } };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS.
export type SpringRole = 'controller' | 'job' | 'service' | 'component' | 'repository';

const ROLE_PRIORITY: Record<SpringRole, number> = { controller: 7, job: 6, service: 5, component: 4, repository: 3 };
const ROLE_KIND: Record<SpringRole, ModuleKind> = {
  controller: 'gateway',
  job: 'job',
  service: 'service',
  component: 'service',
  repository: 'service',
};

const CONTROLLER_STEREOTYPES = new Set(['RestController', 'Controller', 'ControllerAdvice', 'RestControllerAdvice']);
const MAPPING_ANNOTATIONS = new Set([
  'RequestMapping',
  'GetMapping',
  'PostMapping',
  'PutMapping',
  'DeleteMapping',
  'PatchMapping',
]);
// Async-work annotations — a class carrying any is a background/event worker (job).
const JOB_ANNOTATIONS = new Set(['KafkaListener', 'RabbitListener', 'Scheduled', 'JmsListener', 'EventListener']);
// Spring-Data repository base interfaces (extends/implements) → a data-access module.
const REPOSITORY_BASES = new Set([
  'Repository',
  'CrudRepository',
  'JpaRepository',
  'PagingAndSortingRepository',
  'MongoRepository',
  'R2dbcRepository',
  'ReactiveCrudRepository',
  'JpaSpecificationExecutor',
]);

/** The Spring role a file's annotations + supertypes imply, or undefined. Priority-ordered. */
export function springRole(annotations: ReadonlySet<string>, supertypes: readonly string[]): SpringRole | undefined {
  for (const a of annotations) if (CONTROLLER_STEREOTYPES.has(a)) return 'controller';
  for (const a of annotations) if (MAPPING_ANNOTATIONS.has(a)) return 'controller';
  for (const a of annotations) if (JOB_ANNOTATIONS.has(a)) return 'job';
  if (annotations.has('Service')) return 'service';
  if (annotations.has('Component')) return 'component';
  if (annotations.has('Repository')) return 'repository';
  if (supertypes.some((s) => REPOSITORY_BASES.has(s))) return 'repository';
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
  const scope = parseJavaScope(ctx);

  const roleByFile = new Map<string, SpringRole>();
  for (const [id, parsed] of scope.parsed) {
    const anns = new Set(scanAnnotations(parsed.text));
    const supertypes = parsed.types.flatMap((t) => t.supertypes);
    const role = springRole(anns, supertypes);
    if (role) roleByFile.set(id, role);
  }

  // Controller → collaborator (Service/Repository/…) `calls` edges.
  const edges = new Map<string, FrameworkEdge>();
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const key = `${from}→${to}`;
    if (!edges.has(key)) {
      edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'java-spring', relation: 'handles' } });
    }
  };
  for (const [id, role] of roleByFile) {
    if (role !== 'controller') continue;
    const parsed = scope.parsed.get(id) as ParsedJavaFile;
    for (const imp of parsed.imports) {
      if (imp.wildcard || imp.static) continue;
      const simple = imp.fqn.slice(imp.fqn.lastIndexOf('.') + 1);
      if (!COLLABORATOR_SUFFIX_RE.test(simple)) continue;
      const target = scope.resolveTypeRef(simple, parsed);
      if (target && scope.internalIds.has(target)) addEdge(id, target);
    }
  }

  const roles = new Map<string, RoleTag>();
  for (const [id, role] of roleByFile) {
    roles.set(id, { role, kind: ROLE_KIND[role], priority: ROLE_PRIORITY[role], metadata: { framework: 'java-spring' } });
  }
  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (roleByFile.size > 0 || sortedEdges.length > 0) {
    const counts = new Map<SpringRole, number>();
    for (const r of roleByFile.values()) counts.set(r, (counts.get(r) ?? 0) + 1);
    const summary = [...counts].sort().map(([r, n]) => `${n} ${r}`).join(', ');
    console.log(`  [java-spring] ${roleByFile.size} role(s) [${summary}] · ${sortedEdges.length} handles edge(s)`);
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

export const javaSpringAdapter: FrameworkAdapter = {
  name: 'java-spring',

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
    return path.endsWith('.java');
  },
};
