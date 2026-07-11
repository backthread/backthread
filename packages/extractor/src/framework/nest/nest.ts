// (Slice 2) — the NestJS FrameworkAdapter. DETECTION.
// the @Module grouping prior + DI graph + role tags.
//
// DETECTION: decides "is this a NestJS app?" from package.json deps +
// config-file existence — never source content (never-store-source).
//
// CONTRIBUTION: NestJS is the cleanest adapter — it DECLARES its
// architecture. Every `@Module({...})` is an authoritative subsystem boundary
// (controllers + providers + exports), constructor parameters ARE the dependency
// graph, and the stereotype decorators (@Controller / @Injectable / @Resolver,
// CanActivate / NestInterceptor / PipeTransform) ARE the roles. We read this
// STATICALLY via ts-morph (install-free; never-store-source — read server-side,
// persist only the derived groups/edges/roles) and contribute in the graph
// FILE-ID space; the generic contribute-step resolves to MODULE ids.
//
//   * groupingPrior  — one FrameworkGroup per @Module (its controller/provider/
//                      export files). The contribute-step makes each its own
//                      subsystem, AUTHORITATIVE over directory + workspace-package
//                      grouping (the headline value: @Module == subsystem).
//   * syntheticEdges — the DI graph (kind 'calls' only): constructor-injected
//                      provider ← consumer, and @Module `imports` wiring.
//   * roleTags       — Controller/Resolver → gateway; Service/Guard/Interceptor/
//                      Pipe/Module → service. METADATA, never a new Module-kind.
//
// Unresolved custom providers / injection tokens (useFactory / useValue / string
// @Inject tokens) DEGRADE + LOG — no silent caps.
//
// Detection signals (manifest + config existence only):
//   * dep:    `@nestjs/core`        — the authoritative signal
//   * config: nest-cli.json         — Nest CLI, Nest-specific
//
// scoreNest is PURE; the adapter gathers the fs signals and calls it.

import {
  SyntaxKind,
  type ArrayLiteralExpression,
  type CallExpression,
  type ClassDeclaration,
  type Decorator,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyAssignment,
  type SourceFile,
  type TypeReferenceNode,
} from 'ts-morph';
import {
  addAllSourceFiles,
  buildExtractionProject,
  toId,
} from '../../graph/ts-morph-adapter.js';
import { SOURCE_EXTENSIONS } from '../../graph/file-graph.js';
import { clampConfidence, existsAny, readDeps, resolveBase } from '../detect-util.js';
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

/** The deterministic NestJS signal set read from a repo (or workspace package). */
export interface NestSignals {
  hasNestCoreDep: boolean; // @nestjs/core
  hasNestCliJson: boolean; // nest-cli.json
}

/** Gather the signal set for a single root dir (fs only). */
export function gatherNestSignals(baseDir: string): NestSignals {
  const deps = readDeps(baseDir);
  return {
    hasNestCoreDep: '@nestjs/core' in deps,
    hasNestCliJson: existsAny(baseDir, ['nest-cli.json']),
  };
}

/**
 * Decide NestJS from the signal set. Returns a DetectMatch, or null when no
 * signal fires (generic-TS fallthrough intact).
 *
 * Both signals are SUFFICIENT on their own (each is Nest-specific): the
 * `@nestjs/core` dep, or a nest-cli.json file.
 */
export function scoreNest(s: NestSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasNestCoreDep && !s.hasNestCliJson) return null;

  let confidence = 0;
  if (s.hasNestCoreDep) confidence += 0.6;
  if (s.hasNestCliJson) confidence += 0.4;

  return {
    adapter: 'nest',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: {
        nestCoreDep: s.hasNestCoreDep,
        nestCliJson: s.hasNestCliJson,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// the @Module / DI / role extraction.
//
// Role vocabulary, each mapped onto a LOCKED Module-kind (roles are metadata,
// NEVER a new Module-kind):
//   * controller — @Controller (HTTP request entry)            → gateway
//   * resolver   — @Resolver  (GraphQL request entry)          → gateway
//   * guard      — @Injectable implements CanActivate          → service
//   * interceptor— @Injectable implements NestInterceptor      → service
//   * pipe       — @Injectable implements PipeTransform        → service
//   * service    — @Injectable provider (own business logic)   → service
//   * module     — @Module (the wiring container itself)       → service
//
// controller/resolver → `gateway` (request entry). Everything else is own-code
// compute/wiring → `service`. The @Module container has no dedicated kind in the
// locked enum; it's own-code wiring, so → `service` (only `role` is rendered).
export type NestRole =
  | 'controller'
  | 'resolver'
  | 'guard'
  | 'interceptor'
  | 'pipe'
  | 'service'
  | 'module';

// Collapse priority when one FILE carries several role signals (rare — Nest is
// one-class-per-file) AND, downstream, when several files of different roles land
// in ONE module after clustering (the contribute-step keeps the highest). Request
// entries outrank cross-cutting providers outrank plain services outrank wiring.
const ROLE_PRIORITY: Record<NestRole, number> = {
  controller: 7,
  resolver: 6,
  guard: 5,
  interceptor: 4,
  pipe: 3,
  service: 2,
  module: 1,
};
const ROLE_KIND: Record<NestRole, ModuleKind> = {
  controller: 'gateway',
  resolver: 'gateway',
  guard: 'service',
  interceptor: 'service',
  pipe: 'service',
  service: 'service',
  module: 'service',
};

// The Nest stereotype decorators whose class participates in DI (its constructor
// is the dependency graph). @Catch (exception filters) also injects.
const NEST_STEREOTYPES = new Set(['Controller', 'Injectable', 'Resolver', 'Catch']);
// Implemented-interface → cross-cutting role (the way Nest distinguishes a guard /
// interceptor / pipe from a plain @Injectable service — they're all @Injectable).
const INTERFACE_ROLE: Record<string, NestRole> = {
  CanActivate: 'guard',
  NestInterceptor: 'interceptor',
  PipeTransform: 'pipe',
};

const SOURCE_EXT_SET = new Set<string>(SOURCE_EXTENSIONS);

interface NestModuleDecl {
  fileId: string; // the file declaring the @Module class
  baseSlug: string; // the bare class-name slug, pre-dedup (assignGroupIds finalizes id)
  id: string; // deterministic group id (slug; namespaced by the contribute-step)
  label: string; // humanized @Module name (drives the subsystem label)
  controllerFiles: string[];
  providerFiles: string[];
  exportFiles: string[];
  importFiles: string[]; // resolved @Module `imports` (other modules) — for edges
}

interface NestDiag {
  unresolvedProviders: Set<string>; // providers/exports we couldn't map to a file
  dynamicProviders: number; // useFactory/useValue/useExisting/spread provider forms
  unresolvedImports: Set<string>; // @Module imports we couldn't map (often externals)
  unresolvedInjections: Set<string>; // @Inject(token) we couldn't resolve to a class
}

interface NestAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx (same clone.dir, different tree) gets a fresh analysis — no cross-tree
// staleness. Mirrors the RN / node adapters.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, NestAnalysis>();

// ---------------------------------------------------------------------------
// Static resolution helpers (install-free, deterministic).

// localImportedName → resolved repo-relative file id, for one source file. Only
// INTERNAL imports resolve (getModuleSpecifierSourceFile is null for a bare
// external specifier install-free).
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

// ts-morph exposes getExpression() on many concrete node types but not the base
// Node; we reach it only after a getKind() gate, so a guarded optional-call is
// both safe and avoids a forest of per-kind casts.
function innerExpression(node: Node): Node | undefined {
  return (node as unknown as { getExpression?: () => Node | undefined }).getExpression?.();
}

// The leftmost identifier of a property-access / qualified-name chain (`a.b.c` →
// `a`). Undefined when the chain doesn't root in a plain identifier.
function rootIdentifier(node: Node, depth = 0): string | undefined {
  if (depth > 16) return undefined;
  const k = node.getKind();
  if (k === SyntaxKind.Identifier) return node.getText();
  if (k === SyntaxKind.PropertyAccessExpression || k === SyntaxKind.QualifiedName) {
    const left = (node as unknown as { getExpression?: () => Node; getLeft?: () => Node });
    const next = left.getExpression?.() ?? left.getLeft?.();
    return next ? rootIdentifier(next, depth + 1) : undefined;
  }
  return undefined;
}

// A decorator's name (`@Module(...)` → 'Module'); '' if it can't be read.
function decoratorName(d: Decorator): string {
  try {
    return d.getName();
  } catch {
    return '';
  }
}

// Resolve a class REFERENCE expression (in a @Module array, or a useClass) to its
// declaring file id, or null when it can't be statically resolved.
//   * Identifier        → imported file; a locally-declared class → self
//   * PropertyAccess    → root identifier's file (`Ns.Foo`)
//   * CallExpression    → the callee's class (`XModule.forRoot()`)
//   * as/paren/non-null → unwrap
function resolveClassRef(
  expr: Node,
  imports: Map<string, string>,
  selfFileId: string,
  localClasses: ReadonlySet<string>,
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
      return inner ? resolveClassRef(inner, imports, selfFileId, localClasses, depth + 1) : null;
    }
    case SyntaxKind.Identifier: {
      const t = expr.getText();
      return imports.get(t) ?? (localClasses.has(t) ? selfFileId : null);
    }
    case SyntaxKind.PropertyAccessExpression: {
      const root = rootIdentifier(expr);
      return root ? (imports.get(root) ?? (localClasses.has(root) ? selfFileId : null)) : null;
    }
    case SyntaxKind.CallExpression:
      return resolveClassRef(
        (expr as CallExpression).getExpression(),
        imports,
        selfFileId,
        localClasses,
        depth + 1,
      );
    default:
      return null;
  }
}

// Resolve a single `providers: [...]` element to a file id, or null.
//   * a bare class reference                       → resolveClassRef
//   * `{ provide, useClass: Foo }`                 → resolve `useClass`
//   * `{ provide, useFactory|useValue|useExisting}`→ DEGRADE (no class file) + log
//   * spread / anything else                        → DEGRADE + log
function resolveProviderEntry(
  el: Node,
  imports: Map<string, string>,
  selfFileId: string,
  localClasses: ReadonlySet<string>,
  diag: NestDiag,
): string | null {
  let node = el;
  // Unwrap as/paren/non-null so `Foo as Provider` still resolves.
  for (let i = 0; i < 8; i++) {
    const k = node.getKind();
    if (
      k === SyntaxKind.ParenthesizedExpression ||
      k === SyntaxKind.AsExpression ||
      k === SyntaxKind.SatisfiesExpression ||
      k === SyntaxKind.NonNullExpression ||
      k === SyntaxKind.TypeAssertionExpression
    ) {
      const inner = innerExpression(node);
      if (!inner) break;
      node = inner;
    } else {
      break;
    }
  }

  if (node.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const obj = node as ObjectLiteralExpression;
    const useClass = obj.getProperty('useClass');
    if (useClass && useClass.getKind() === SyntaxKind.PropertyAssignment) {
      const init = (useClass as PropertyAssignment).getInitializer();
      const file = init ? resolveClassRef(init, imports, selfFileId, localClasses) : null;
      if (file) return file;
    }
    // useFactory / useValue / useExisting / unresolved useClass: a custom
    // provider with no statically-knowable class file. Degrade + log the token.
    diag.dynamicProviders++;
    const provide = obj.getProperty('provide');
    if (provide && provide.getKind() === SyntaxKind.PropertyAssignment) {
      const v = (provide as PropertyAssignment).getInitializer();
      if (v) diag.unresolvedProviders.add(v.getText().slice(0, 60));
    }
    return null;
  }
  if (node.getKind() === SyntaxKind.SpreadElement) {
    diag.dynamicProviders++;
    return null;
  }

  const file = resolveClassRef(node, imports, selfFileId, localClasses);
  if (!file) diag.unresolvedProviders.add(node.getText().slice(0, 60));
  return file;
}

// Read an array-literal @Module property (`controllers` / `providers` / `imports`
// / `exports`) → resolved file ids. `mode` selects the per-element resolver.
function readArrayProp(
  obj: ObjectLiteralExpression,
  key: string,
  mode: 'class' | 'provider' | 'import',
  imports: Map<string, string>,
  selfFileId: string,
  localClasses: ReadonlySet<string>,
  diag: NestDiag,
): string[] {
  const prop = obj.getProperty(key);
  if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) return [];
  const init = (prop as PropertyAssignment).getInitializer();
  if (!init || init.getKind() !== SyntaxKind.ArrayLiteralExpression) return [];
  const out: string[] = [];
  for (const el of (init as ArrayLiteralExpression).getElements()) {
    if (mode === 'provider') {
      const f = resolveProviderEntry(el, imports, selfFileId, localClasses, diag);
      if (f) out.push(f);
      continue;
    }
    const f = resolveClassRef(el, imports, selfFileId, localClasses);
    if (f) out.push(f);
    else if (mode === 'import') diag.unresolvedImports.add(el.getText().slice(0, 60));
    // `exports` re-export providers/tokens; an unresolved one is benign (it's a
    // token, already covered by `providers`) — resolve silently, no diag.
  }
  return out;
}

// The role a class declares, from its decorators + implemented interfaces.
function roleOfClass(cls: ClassDeclaration, decoNames: string[]): NestRole | undefined {
  if (decoNames.includes('Controller')) return 'controller';
  if (decoNames.includes('Resolver')) return 'resolver';
  if (decoNames.includes('Module')) return 'module';
  if (decoNames.includes('Injectable') || decoNames.includes('Catch')) {
    for (const impl of cls.getImplements()) {
      const name = rootIdentifier(impl.getExpression());
      if (name && INTERFACE_ROLE[name]) return INTERFACE_ROLE[name];
    }
    return 'service';
  }
  return undefined;
}

// The root identifier of a constructor parameter's TYPE (`private u: UsersService`
// → 'UsersService'; `r: Repository<User>` → 'Repository'). Undefined for a
// primitive / inline / union type with no leading type reference.
function paramTypeName(param: ParameterDeclaration): string | undefined {
  const tn = param.getTypeNode();
  if (!tn || tn.getKind() !== SyntaxKind.TypeReference) return undefined;
  return rootIdentifier((tn as TypeReferenceNode).getTypeName());
}

// Keep the highest-priority candidate role per file (deterministic, lexical
// tiebreak) — mirrors the RN/node addRole + the contribute-step's module collapse.
function addRole(map: Map<string, NestRole>, fileId: string, role: NestRole): void {
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
  relation: string,
): void {
  if (from === to) return; // intra-file DI collapses; the step drops self-edges too
  const key = `${from}→${to}`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'nest', relation } });
  }
}

function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

// Deterministic slug for a group id (camelCase → kebab, drop non-alnum).
function slugify(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Humanize a @Module class name into a subsystem label: drop the trailing
// `Module`, split camelCase, title-case (`UsersModule` → 'Users', 'AppModule' →
// 'App'). Falls back to the class name when stripping leaves nothing.
function humanizeModuleName(className: string): string {
  const base = className.replace(/Module$/, '') || className;
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return className;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// The first directory segment of a file id (for group-id collision disambiguation).
function dirSegment(fileId: string): string {
  const slash = fileId.indexOf('/');
  return slash > 0 ? slugify(fileId.slice(0, slash)) : 'root';
}

function uniqueSorted(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

// ---------------------------------------------------------------------------
// The full analysis.

function analyzeNest(ctx: FrameworkContext): NestAnalysis {
  const { repoDir, rootPath } = ctx;
  const project = buildExtractionProject(repoDir);
  addAllSourceFiles(project, repoDir);

  const fileById = new Map<string, SourceFile>();
  for (const sf of project.getSourceFiles()) fileById.set(toId(repoDir, sf.getFilePath()), sf);

  // Pre-pass: per-file import maps + locally-declared class names (so a class
  // referenced without an import — co-located — still resolves to its file).
  const importMaps = new Map<string, Map<string, string>>();
  const localClasses = new Map<string, Set<string>>();
  for (const [fileId, sf] of fileById) {
    if (!inScope(fileId, rootPath)) continue;
    importMaps.set(fileId, buildImportNameMap(sf, repoDir));
    const names = new Set<string>();
    for (const c of sf.getClasses()) {
      const n = c.getName();
      if (n) names.add(n);
    }
    localClasses.set(fileId, names);
  }

  const roleByFile = new Map<string, NestRole>();
  const edges = new Map<string, FrameworkEdge>();
  const moduleDecls: NestModuleDecl[] = [];
  const diag: NestDiag = {
    unresolvedProviders: new Set(),
    dynamicProviders: 0,
    unresolvedImports: new Set(),
    unresolvedInjections: new Set(),
  };

  for (const [fileId, sf] of fileById) {
    if (!inScope(fileId, rootPath)) continue;
    const imports = importMaps.get(fileId)!;
    const locals = localClasses.get(fileId)!;

    for (const cls of sf.getClasses()) {
      const decoNames = cls.getDecorators().map(decoratorName);

      // Role from the class's own decorators/interfaces.
      const role = roleOfClass(cls, decoNames);
      if (role) addRole(roleByFile, fileId, role);

      // @Module → a grouping prior + authoritative roles + import edges.
      if (decoNames.includes('Module')) {
        const decl = parseModule(cls, fileId, imports, locals, diag);
        if (decl) {
          moduleDecls.push(decl);
          // The @Module declaration is AUTHORITATIVE about controller vs provider,
          // even for plain (un-decorated) classes — tag them by membership. A
          // stronger decorator-derived role (guard/interceptor/pipe) still wins
          // by priority via addRole.
          for (const f of decl.controllerFiles) addRole(roleByFile, f, 'controller');
          for (const f of decl.providerFiles) addRole(roleByFile, f, 'service');
          // Module-import wiring → calls edges (this module file → imported module).
          for (const imp of decl.importFiles) addEdge(edges, fileId, imp, 'module-import');
        }
      }

      // DI graph: a Nest-managed class's constructor params are its dependencies.
      if (decoNames.some((d) => NEST_STEREOTYPES.has(d))) {
        collectConstructorEdges(cls, fileId, imports, locals, edges, diag);
      }
    }
  }

  // Assign final, collision-free group ids ORDER-INDEPENDENTLY: two
  // @Module classes can share a name across files, and the dedup must not depend
  // on ts-morph's getSourceFiles() iteration order (it would yield a different id
  // set run-to-run, breaking the grouping-stability invariant). Done as a separate
  // pass over the decls sorted by fileId.
  assignGroupIds(moduleDecls);

  // Build the grouping prior. fileIds = the @Module file + its controllers,
  // providers, exports (NOT its imports — those belong to the imported modules'
  // own groups). Sorted for snapshot stability.
  const groups: FrameworkGroup[] = moduleDecls
    .map((m) => ({
      id: m.id,
      label: m.label,
      fileIds: uniqueSorted([m.fileId, ...m.controllerFiles, ...m.providerFiles, ...m.exportFiles]),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'nest' },
    });
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  // Positive signal for validation.
  if (groups.length > 0 || roleByFile.size > 0) {
    console.log(
      `  [nest] ${moduleDecls.length} @Module(s) → ${groups.length} group(s) · ${roleByFile.size} role(s) · ${sortedEdges.length} DI edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  if (
    diag.unresolvedProviders.size > 0 ||
    diag.dynamicProviders > 0 ||
    diag.unresolvedImports.size > 0 ||
    diag.unresolvedInjections.size > 0
  ) {
    const parts: string[] = [];
    if (diag.dynamicProviders > 0) parts.push(`${diag.dynamicProviders} custom provider(s) (useFactory/useValue/useExisting)`);
    if (diag.unresolvedProviders.size > 0) {
      parts.push(`${diag.unresolvedProviders.size} unresolvable provider/token(s): ${[...diag.unresolvedProviders].sort().join(', ')}`);
    }
    if (diag.unresolvedInjections.size > 0) {
      parts.push(`${diag.unresolvedInjections.size} unresolvable @Inject token(s): ${[...diag.unresolvedInjections].sort().join(', ')}`);
    }
    if (diag.unresolvedImports.size > 0) {
      parts.push(`${diag.unresolvedImports.size} unresolvable/external module import(s): ${[...diag.unresolvedImports].sort().join(', ')}`);
    }
    console.log(`  [nest] degraded: ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

// Parse a `@Module({...})` class into its grouping declaration.
function parseModule(
  cls: ClassDeclaration,
  fileId: string,
  imports: Map<string, string>,
  localClasses: ReadonlySet<string>,
  diag: NestDiag,
): NestModuleDecl | null {
  const className = cls.getName() ?? '';
  const deco = cls.getDecorators().find((d) => decoratorName(d) === 'Module');
  if (!deco) return null;
  const arg = deco.getArguments()[0];

  let controllerFiles: string[] = [];
  let providerFiles: string[] = [];
  let exportFiles: string[] = [];
  let importFiles: string[] = [];
  if (arg && arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const obj = arg as ObjectLiteralExpression;
    controllerFiles = readArrayProp(obj, 'controllers', 'class', imports, fileId, localClasses, diag);
    providerFiles = readArrayProp(obj, 'providers', 'provider', imports, fileId, localClasses, diag);
    exportFiles = readArrayProp(obj, 'exports', 'class', imports, fileId, localClasses, diag);
    importFiles = readArrayProp(obj, 'imports', 'import', imports, fileId, localClasses, diag);
  }

  // The bare id slug from the class name (or the file basename if anonymous).
  // The final, de-collided id is assigned later by assignGroupIds (order-
  // independent) — NEVER an index here, so it is stable across snapshots.
  const base = className || (fileId.split('/').pop() ?? 'module').replace(/\.[^.]+$/, '');
  const baseSlug = slugify(base) || 'module';

  return {
    fileId,
    baseSlug,
    id: baseSlug, // provisional; finalized by assignGroupIds
    label: className ? humanizeModuleName(className) : humanizeModuleName(base),
    controllerFiles,
    providerFiles,
    exportFiles,
    importFiles,
  };
}

// Assign each @Module its final, collision-free group id ORDER-INDEPENDENTLY
//. Duplicate @Module class names (→ same `baseSlug`) are disambiguated
// deterministically: process the decls by ascending fileId so the SMALLEST fileId
// wins the bare slug, and later collisions take a `-<dirSegment>` then `-<n>`
// suffix. Because the order is the (stable) fileId order — not ts-morph's
// getSourceFiles() iteration order — the id set is identical run-to-run.
function assignGroupIds(decls: NestModuleDecl[]): void {
  const taken = new Set<string>();
  const byFileId = [...decls].sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
  for (const decl of byFileId) {
    let id = decl.baseSlug;
    if (taken.has(id)) id = `${decl.baseSlug}-${dirSegment(decl.fileId)}`;
    let n = 2;
    while (taken.has(id)) id = `${decl.baseSlug}-${n++}`;
    taken.add(id);
    decl.id = id;
  }
}

// Emit DI edges from a Nest-managed class's constructor: consumer file → each
// injected provider's file (kind 'calls'). Resolves the param TYPE (the usual
// `constructor(private x: FooService)`), and an `@Inject(Token)` decorator —
// falling back to the param type so `@Inject(forwardRef(() => X)) x: X` still
// resolves. A token that resolves to nothing (string token / useFactory-only
// provider) DEGRADES + logs.
function collectConstructorEdges(
  cls: ClassDeclaration,
  fileId: string,
  imports: Map<string, string>,
  localClasses: ReadonlySet<string>,
  edges: Map<string, FrameworkEdge>,
  diag: NestDiag,
): void {
  const ctor = cls.getConstructors()[0];
  if (!ctor) return;
  for (const param of ctor.getParameters()) {
    const inject = param.getDecorators().find((d) => decoratorName(d) === 'Inject');
    if (inject) {
      let file: string | null = null;
      const tokenArg = inject.getArguments()[0];
      if (tokenArg && tokenArg.getKind() === SyntaxKind.Identifier) {
        file = resolveClassRef(tokenArg, imports, fileId, localClasses);
      }
      if (!file) {
        const typeName = paramTypeName(param);
        if (typeName) file = imports.get(typeName) ?? (localClasses.has(typeName) ? fileId : null);
      }
      if (file) addEdge(edges, fileId, file, 'di');
      else diag.unresolvedInjections.add((tokenArg?.getText() ?? '<inject>').slice(0, 60));
      continue;
    }
    const typeName = paramTypeName(param);
    if (!typeName) continue;
    // A plain type injection: only emit when the type resolves to an INTERNAL
    // class file. An external (`ConfigService`) / primitive type stays off-graph
    // — that's correct, not a dropped capability, so no diag here.
    const file = imports.get(typeName) ?? (localClasses.has(typeName) ? fileId : null);
    if (file) addEdge(edges, fileId, file, 'di');
  }
}

function getAnalysis(ctx: FrameworkContext): NestAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeNest(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const nestAdapter: FrameworkAdapter = {
  name: 'nest',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreNest(gatherNestSignals(base), rootPath);
  },

  // one grouping prior per @Module (controllers + providers + exports).
  // The contribute-step makes each its own subsystem, AUTHORITATIVE over directory
  // + workspace-package grouping. No classificationsNeeded: unresolved providers /
  // tokens degrade + log inside the analysis (they're not LLM-classifiable into a
  // class file), so the deferred-classification channel stays empty.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // the DI graph (file-id space; the step resolves to modules, drops
  // self-edges, dedupes, 8-verb-validates). kind 'calls' only.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // Controller/Resolver → gateway; Service/Guard/Interceptor/Pipe/
  // Module → service. METADATA; the module's `kind` is unchanged.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE (decorators, constructors), so declare the source paths
  // the diff-driven hosted walk must treat as framework-relevant. Never-store-
  // source holds: read server-side, persist only the derived groups/edges/roles.
  scansSourcePath(path: string): boolean {
    const ext = path.split('.').pop();
    return ext !== undefined && SOURCE_EXT_SET.has(ext);
  },
};
