// the Strawberry + Graphene GraphQL FrameworkAdapter. A Python
// framework adapter following the FastAPI/Flask template (/997), reusing
// the shared Python core (py-ast + parsePythonScope). Strawberry is the
// modern default and the priority here; Graphene is a solid best-effort.
//
// GraphQL declares its request surface as CLASSES — a `@strawberry.type` /
// `graphene.ObjectType` root (Query / Mutation / Subscription) whose resolver
// methods are the actual query/mutation entry points, plus plain object types
// (User / Post / …). We read this STATICALLY (install-free, never-store-source —
// a pure syntactic Pyright parse; never executes repo code) and persist only the
// derived groups/edges/roles:
//
//   * detect()        — the `strawberry-graphql` and/or `graphene` dependency;
//                       shallow nested scan for a `backend/`|`server/`|`api/`
//                       package (mirrors FastAPI's ).
//   * roleTags        — a Query/Mutation/Subscription ROOT (a `@strawberry.type`
//                       or `graphene.ObjectType` used as a schema root, or named
//                       by the GraphQL convention) + its field-resolver methods →
//                       `gateway` (the GraphQL request entry); every other
//                       object/input/interface type → `service` (role
//                       'graphql-type'). METADATA onto the LOCKED MODULE_KINDS
//                       enum; never a new kind (only `role` renders).
//   * syntheticEdges  — the wiring the import graph doesn't name as verbs
//                       (kind 'calls' throughout): a resolver → the type it
//                       returns ('resolver-returns'); a graphene field decl → its
//                       type ('field-type'); a root field → its cross-file
//                       resolver function via `resolver=` ('field-resolver'); a
//                       `Schema(query=…, mutation=…)` construction → each root
//                       type file ('schema-root').
//   * groupingPrior   — files under a dedicated GraphQL directory
//                       (`graphql/`|`gql/`|`schema/`) that carry a GraphQL role
//                       → one subsystem (the schema layer), authoritative over
//                       the directory heuristic. Deterministic → no
//                       classificationsNeeded. Skipped when there is no dedicated
//                       GraphQL dir (degrades to directory grouping).
//
// Unresolvable schema roots / return types / cross-file resolvers DEGRADE + LOG —
// no silent caps.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readPythonDeps } from '../../graph/python-manifest.js';
import { parsePythonScope, type ParsedPythonFile } from '../python/analyze.js';
import {
  callCallee,
  classBaseChains,
  className,
  classDirectAssignments,
  classDirectFunctions,
  keywordArg,
  memberChain,
  positionalArgs,
  stringValue,
  PN,
} from '../python/py-ast.js';
import type {
  CallNode,
  ClassNode,
  DecoratorNode,
  ExpressionNode,
  FunctionNode,
  ImportFromNode,
  ImportNode,
  IndexNode,
  BinaryOperationNode,
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

/** The deterministic GraphQL signal set (dependency names only). */
export interface GraphqlSignals {
  hasStrawberry: boolean; // strawberry-graphql — the modern default
  hasGraphene: boolean; // graphene (or a graphene-* integration)
}

/** Gather the signal set for a single root dir (reads manifests only). */
export function gatherGraphqlSignals(baseDir: string): GraphqlSignals {
  const deps = readPythonDeps(baseDir);
  return {
    hasStrawberry: deps.has('strawberry-graphql'),
    // `graphene`, or a `graphene-django` / `graphene-sqlalchemy` integration
    // (which pulls graphene in): either means a Graphene schema is present.
    hasGraphene: deps.has('graphene') || [...deps].some((d) => d.startsWith('graphene-')),
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
 * for a nested GraphQL backend (`backend/` | `server/` | `api/`). Sorted, so the
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
 * Decide a GraphQL stack from the signal set. Either `strawberry-graphql` or
 * `graphene` is sufficient; strawberry (the modern default) scores marginally
 * higher. Returns null → generic-Python fallthrough, byte-for-byte unchanged.
 */
export function scoreGraphql(s: GraphqlSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasStrawberry && !s.hasGraphene) return null;
  const confidence = s.hasStrawberry ? 0.85 : 0.8;
  return {
    adapter: 'graphql',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      strawberry: s.hasStrawberry,
      graphene: s.hasGraphene,
      signals: { strawberry: s.hasStrawberry, graphene: s.hasGraphene },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind`
// is unchanged. A Query/Mutation/Subscription root (and its field resolvers) is a
// GraphQL request entry → gateway; a plain object/input/interface type is own-code
// data shape → service.
export type GraphqlRole =
  | 'graphql-query'
  | 'graphql-mutation'
  | 'graphql-subscription'
  | 'graphql-resolver'
  | 'graphql-schema'
  | 'graphql-type';

// Collapse priority when one FILE carries several roles, AND downstream when
// several files of different roles land in one module. A query root outranks a
// mutation outranks a subscription (all root request entries) outranks a
// standalone resolver-function file outranks a schema-assembly file outranks a
// plain data type. All but 'graphql-type' are GraphQL request entries → gateway.
const ROLE_PRIORITY: Record<GraphqlRole, number> = {
  'graphql-query': 8,
  'graphql-mutation': 7,
  'graphql-subscription': 6,
  'graphql-resolver': 5,
  'graphql-schema': 4,
  'graphql-type': 3,
};
const ROLE_KIND: Record<GraphqlRole, ModuleKind> = {
  'graphql-query': 'gateway',
  'graphql-mutation': 'gateway',
  'graphql-subscription': 'gateway',
  'graphql-resolver': 'gateway',
  'graphql-schema': 'gateway',
  'graphql-type': 'service',
};

type GqlSlot = 'query' | 'mutation' | 'subscription';
const SLOT_ROLE: Record<GqlSlot, GraphqlRole> = {
  query: 'graphql-query',
  mutation: 'graphql-mutation',
  subscription: 'graphql-subscription',
};
// The GraphQL root type names, by convention (a schema requires exactly these
// three operation roots; strawberry/graphene root classes are near-universally
// named this) — the fallback signal when a Schema(...) construction can't be
// resolved to the class.
const ROOT_NAMES = new Map<string, GqlSlot>([
  ['Query', 'query'],
  ['Mutation', 'mutation'],
  ['Subscription', 'subscription'],
]);

// The strawberry module roots recognized as first-party GraphQL decorators. The
// official Django integration `strawberry_django` re-exports `type`/`field`/
// `mutation` (a large fraction of real strawberry apps use it), so treat its
// aliases the same as `strawberry`'s.
const STRAWBERRY_MODULE_ROOTS = ['strawberry', 'strawberry_django'];

// Strawberry class decorators: `@strawberry.type` (rootable object type) vs
// `@strawberry.input` / `@strawberry.interface` (always a plain type).
const STRAWBERRY_TYPE_DECOS = new Set(['type']);
const STRAWBERRY_PLAIN_DECOS = new Set(['input', 'interface']);
// Strawberry field-resolver method decorators.
const STRAWBERRY_FIELD_DECOS = new Set(['field', 'mutation', 'subscription']);

// Graphene base classes (by leaf name; gated on graphene being detected). The
// integration ObjectType variants (graphene-django's `DjangoObjectType`,
// graphene-sqlalchemy's `SQLAlchemyObjectType`, graphene-mongo's
// `MongoengineObjectType`) are the norm in real graphene apps, so treat them as
// object types too.
const GRAPHENE_OBJECT_BASES = new Set([
  'ObjectType',
  'DjangoObjectType',
  'SQLAlchemyObjectType',
  'MongoengineObjectType',
]);
const GRAPHENE_ROOT_BASE_SLOT = new Map<string, GqlSlot>([
  // A `graphene.Mutation` / `graphene.Subscription` subclass IS an individual
  // request entry (a mutation/subscription field resolver) → a gateway root.
  ['Mutation', 'mutation'],
  ['Subscription', 'subscription'],
]);
const GRAPHENE_PLAIN_BASES = new Set(['InputObjectType', 'Interface']);
// Graphene field constructors whose FIRST positional arg is the field's type.
const GRAPHENE_FIELD_CTORS = new Set(['Field', 'List', 'NonNull']);
// Graphene resolver method: `resolve_<field>` or a Mutation's `mutate`.
function isGrapheneResolverName(name: string): boolean {
  return name.startsWith('resolve_') || name === 'mutate';
}

// GraphQL-dedicated directory segments that anchor the schema subsystem.
const GRAPHQL_DIR_SEGMENTS = new Set(['graphql', 'gql', 'schema']);

// ---------------------------------------------------------------------------
// Analysis.

interface GraphqlAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface GraphqlDiag {
  unresolvedSchemaRoots: Set<string>; // Schema(query=…) refs we couldn't map to a file
  unresolvedReturns: Set<string>; // resolver return types we couldn't map (external/dynamic)
  unresolvedResolvers: Set<string>; // resolver=… / field types we couldn't map
}

// Per-file framework import bindings for one module root (strawberry|graphene):
// which local names refer to the module, and which symbols were imported from it.
interface FrameworkImports {
  aliases: Set<string>; // names bound to the module (`import strawberry` → 'strawberry')
  symbols: Map<string, string>; // local → canonical (`from strawberry import type` → type→type)
}

// A discovered GraphQL type class, with its resolution keys.
interface GqlClass {
  fileId: string;
  name: string;
  framework: 'strawberry' | 'graphene';
  rootable: boolean; // an object type (can be a root); false for input/interface
  slotBase?: GqlSlot; // a graphene Mutation/Subscription subclass — always a root
  node: ClassNode;
}

// Memoized on the FrameworkContext OBJECT so groupingPrior + syntheticEdges +
// roleTags share ONE parse, while the merge walk's per-checkpoint ctx gets a fresh
// analysis — no cross-tree staleness. Mirrors fastapi / flask / nest.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, GraphqlAnalysis>();

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

function dirSegment(fileId: string): string {
  const slash = fileId.indexOf('/');
  return slash > 0 ? slugify(fileId.slice(0, slash)) : 'root';
}

// Keep the highest-priority candidate role per file (deterministic, lexical
// tiebreak) — mirrors the fastapi/flask/nest addRole + the contribute-step collapse.
function addRole(map: Map<string, GraphqlRole>, fileId: string, role: GraphqlRole): void {
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
  if (from === to) return; // intra-file wiring collapses; the step drops self-edges too
  const key = `${from}→${to}:${relation}`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'graphql', relation } });
  }
}

// A decorator's callee chain (`@strawberry.type(...)` → root 'strawberry', path
// ['type']; `@strawberry.field` → root 'strawberry', path ['field']). The expr is
// either a call (with args) or a bare name/attribute.
function decoratorChain(deco: DecoratorNode): { root: string; path: string[] } | undefined {
  const expr = deco.d.expr;
  if ((expr as ParseNode).nodeType === PN.Call) return callCallee(expr as CallNode);
  return memberChain(expr);
}

// The framework import bindings for one module root in a file (both `import X` and
// `from X import a, b` forms). Deep imports (`import strawberry.federation`) still
// bind the top-level alias.
function frameworkImports(file: ParsedPythonFile, moduleRoot: string): FrameworkImports {
  const aliases = new Set<string>();
  const symbols = new Map<string, string>();
  for (const imp of file.nodes.imports) {
    if ((imp as ParseNode).nodeType === PN.Import) {
      for (const entry of (imp as ImportNode).d.list) {
        const parts = entry.d.module.d.nameParts.map((p) => p.d.value);
        if (parts.length === 0 || parts[0] !== moduleRoot) continue;
        aliases.add(entry.d.alias ? entry.d.alias.d.value : parts[0]);
      }
    } else if ((imp as ParseNode).nodeType === PN.ImportFrom) {
      const from = imp as ImportFromNode;
      if (from.d.module.d.leadingDots !== 0) continue; // relative import — not the framework
      const parts = from.d.module.d.nameParts.map((p) => p.d.value);
      if (parts.length === 0 || parts[0] !== moduleRoot) continue;
      for (const spec of from.d.imports) {
        const local = spec.d.alias ? spec.d.alias.d.value : spec.d.name.d.value;
        symbols.set(local, spec.d.name.d.value);
      }
    }
  }
  return { aliases, symbols };
}

// Classify a strawberry class decorator: 'type' (rootable object type), 'plain'
// (input/interface), or undefined (not a strawberry type class).
function strawberryClassKind(cls: ClassNode, imp: FrameworkImports): 'type' | 'plain' | undefined {
  for (const deco of cls.d.decorators) {
    const chain = decoratorChain(deco);
    if (!chain) continue;
    // `@strawberry.type` / `@<alias>.type(...)` / `@strawberry.federation.type`.
    if (imp.aliases.has(chain.root) && chain.path.length >= 1) {
      const leaf = chain.path[chain.path.length - 1];
      if (STRAWBERRY_TYPE_DECOS.has(leaf)) return 'type';
      if (STRAWBERRY_PLAIN_DECOS.has(leaf)) return 'plain';
    }
    // Bare `@type` / `@input` via `from strawberry import type`.
    if (chain.path.length === 0) {
      const canon = imp.symbols.get(chain.root);
      if (canon && STRAWBERRY_TYPE_DECOS.has(canon)) return 'type';
      if (canon && STRAWBERRY_PLAIN_DECOS.has(canon)) return 'plain';
    }
  }
  return undefined;
}

// Classify a graphene class from its base classes (gated on graphene detected):
// a rootable ObjectType, a Mutation/Subscription root resolver, a plain
// input/interface, or undefined.
function grapheneClassKind(
  cls: ClassNode,
): { rootable: boolean; slotBase?: GqlSlot } | undefined {
  for (const chain of classBaseChains(cls)) {
    const leaf = chain.path.length ? chain.path[chain.path.length - 1] : chain.root;
    if (GRAPHENE_OBJECT_BASES.has(leaf)) return { rootable: true };
    const slot = GRAPHENE_ROOT_BASE_SLOT.get(leaf);
    if (slot) return { rootable: true, slotBase: slot };
    if (GRAPHENE_PLAIN_BASES.has(leaf)) return { rootable: false };
  }
  return undefined;
}

// Is a strawberry method a field resolver (decorated with @strawberry.field /
// .mutation / .subscription, in either module-attr or from-import form)?
function isStrawberryResolver(fn: FunctionNode, imp: FrameworkImports): boolean {
  for (const deco of fn.d.decorators) {
    const chain = decoratorChain(deco);
    if (!chain) continue;
    if (imp.aliases.has(chain.root) && chain.path.length >= 1) {
      if (STRAWBERRY_FIELD_DECOS.has(chain.path[chain.path.length - 1])) return true;
    }
    if (chain.path.length === 0) {
      const canon = imp.symbols.get(chain.root);
      if (canon && STRAWBERRY_FIELD_DECOS.has(canon)) return true;
    }
  }
  return false;
}

// Collect the internal-resolvable TYPE NAMES from a return/type annotation,
// unwrapping generics (`List[User]`), unions (`User | None`), subscripts, and
// forward-ref strings (`"User"`). Container names (List/Optional) and primitives
// simply don't resolve to an internal file downstream, so they're harmless.
function collectAnnotationTypeNames(expr: ExpressionNode | undefined, out: Set<string>): void {
  if (!expr) return;
  const nt = (expr as ParseNode).nodeType;
  if (nt === PN.Name || nt === PN.MemberAccess) {
    const chain = memberChain(expr);
    if (chain) out.add(chain.path.length ? chain.path[chain.path.length - 1] : chain.root);
    return;
  }
  if (nt === PN.Index) {
    const idx = expr as IndexNode;
    collectAnnotationTypeNames(idx.d.leftExpr, out); // e.g. a relay `Connection[User]`
    for (const item of idx.d.items) collectAnnotationTypeNames(item.d.valueExpr, out);
    return;
  }
  if (nt === PN.BinaryOperation) {
    const bin = expr as BinaryOperationNode;
    collectAnnotationTypeNames(bin.d.leftExpr, out);
    collectAnnotationTypeNames(bin.d.rightExpr, out);
    return;
  }
  if (nt === PN.StringList) {
    const s = stringValue(expr);
    if (s && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) out.add(s); // a plain forward-ref name
  }
}

function analyzeGraphql(ctx: FrameworkContext): GraphqlAnalysis {
  const strawberryEnabled = ctx.match.metadata?.strawberry === true;
  const grapheneEnabled = ctx.match.metadata?.graphene === true;
  const { parsed } = parsePythonScope(ctx);

  // Pre-pass: per-file class-name set (so a return type / schema ref resolves to a
  // co-located class file), plus per-file framework import bindings.
  const localClassNames = new Map<string, Set<string>>();
  const strawberryImp = new Map<string, FrameworkImports>();
  const grapheneImp = new Map<string, FrameworkImports>();
  for (const [id, file] of parsed) {
    const names = new Set<string>();
    for (const cls of file.nodes.classes) {
      const n = className(cls);
      if (n) names.add(n);
    }
    localClassNames.set(id, names);
    if (strawberryEnabled) {
      // Merge strawberry + strawberry_django import bindings into one alias/symbol set.
      const merged: FrameworkImports = { aliases: new Set(), symbols: new Map() };
      for (const root of STRAWBERRY_MODULE_ROOTS) {
        const fi = frameworkImports(file, root);
        for (const a of fi.aliases) merged.aliases.add(a);
        for (const [k, v] of fi.symbols) merged.symbols.set(k, v);
      }
      strawberryImp.set(id, merged);
    }
    if (grapheneEnabled) grapheneImp.set(id, frameworkImports(file, 'graphene'));
  }

  // Resolve a bare TYPE/CLASS name to a file: an internal import, else a class
  // co-located in the SAME file. Mirrors nest's resolveClassRef.
  function resolveName(name: string, fromFile: string): string | undefined {
    const binds = parsed.get(fromFile)?.bindings;
    return binds?.get(name) ?? (localClassNames.get(fromFile)?.has(name) ? fromFile : undefined);
  }

  const diag: GraphqlDiag = {
    unresolvedSchemaRoots: new Set(),
    unresolvedReturns: new Set(),
    unresolvedResolvers: new Set(),
  };
  const edges = new Map<string, FrameworkEdge>();

  // Pass 1 — discover every GraphQL class + collect Schema(...) root wiring.
  const classes: GqlClass[] = [];
  // `${rootFile}#${refName}` → slot, from a resolved Schema(query=…) kwarg.
  const schemaRootSlot = new Map<string, GqlSlot>();
  const schemaFiles = new Set<string>(); // files that construct a Schema(...)

  function isSchemaCall(callee: { root: string; path: string[] }, id: string): boolean {
    const leaf = callee.path.length ? callee.path[callee.path.length - 1] : callee.root;
    if (leaf !== 'Schema') return false;
    if (callee.path.length >= 1) {
      // `strawberry.Schema(...)` / `graphene.Schema(...)`.
      const s = strawberryEnabled && strawberryImp.get(id)?.aliases.has(callee.root);
      const g = grapheneEnabled && grapheneImp.get(id)?.aliases.has(callee.root);
      return Boolean(s || g);
    }
    // Bare `Schema(...)` via `from strawberry import Schema`.
    const s = strawberryEnabled && strawberryImp.get(id)?.symbols.get(callee.root) === 'Schema';
    const g = grapheneEnabled && grapheneImp.get(id)?.symbols.get(callee.root) === 'Schema';
    return Boolean(s || g);
  }

  for (const [id, file] of parsed) {
    const sImp = strawberryImp.get(id);
    const gImp = grapheneImp.get(id);

    for (const cls of file.nodes.classes) {
      const name = className(cls);
      if (!name) continue;
      if (strawberryEnabled && sImp) {
        const kind = strawberryClassKind(cls, sImp);
        if (kind) {
          classes.push({ fileId: id, name, framework: 'strawberry', rootable: kind === 'type', node: cls });
          continue;
        }
      }
      if (grapheneEnabled && gImp) {
        const gk = grapheneClassKind(cls);
        if (gk) {
          classes.push({
            fileId: id,
            name,
            framework: 'graphene',
            rootable: gk.rootable,
            slotBase: gk.slotBase,
            node: cls,
          });
        }
      }
    }

    // Schema(...) constructions → resolve each operation-root kwarg to a file.
    for (const call of file.nodes.calls) {
      const callee = callCallee(call);
      if (!callee || !isSchemaCall(callee, id)) continue;
      schemaFiles.add(id); // the GraphQL schema-assembly entry point
      for (const slot of ['query', 'mutation', 'subscription'] as const) {
        const arg = keywordArg(call, slot);
        if (!arg) continue;
        const chain = memberChain(arg);
        if (!chain) {
          diag.unresolvedSchemaRoots.add(`${id}: Schema(${slot}=…)`);
          continue;
        }
        const refName = chain.path.length ? chain.path[chain.path.length - 1] : chain.root;
        const targetFile = resolveName(chain.root, id);
        if (targetFile) {
          schemaRootSlot.set(`${targetFile}#${refName}`, slot);
          addEdge(edges, id, targetFile, 'schema-root');
        } else {
          diag.unresolvedSchemaRoots.add(`${id}: Schema(${slot}=${refName})`);
        }
      }
    }
  }

  // Pass 2 — roles + resolver/field edges, now that schema roots are known.
  const roleByFile = new Map<string, GraphqlRole>();
  const roleFiles = new Set<string>(); // every file carrying any GraphQL role (for grouping)

  for (const gc of classes) {
    // Decide the class's slot (root) or plain-type role.
    let slot: GqlSlot | undefined = gc.slotBase;
    if (!slot && gc.rootable) {
      slot = schemaRootSlot.get(`${gc.fileId}#${gc.name}`) ?? ROOT_NAMES.get(gc.name);
    }
    const role: GraphqlRole = slot ? SLOT_ROLE[slot] : 'graphql-type';
    addRole(roleByFile, gc.fileId, role);
    roleFiles.add(gc.fileId);

    // Resolver return-type + field edges from the class body.
    for (const fn of classDirectFunctions(gc.node)) {
      const fnName = fn.d.name ? fn.d.name.d.value : undefined;
      const isResolver =
        (gc.framework === 'strawberry' && isStrawberryResolver(fn, strawberryImp.get(gc.fileId)!)) ||
        (gc.framework === 'graphene' && fnName !== undefined && isGrapheneResolverName(fnName));
      if (!isResolver) continue;
      const typeNames = new Set<string>();
      collectAnnotationTypeNames(fn.d.returnAnnotation, typeNames);
      let resolvedAny = false;
      for (const tn of typeNames) {
        const target = resolveName(tn, gc.fileId);
        if (target) {
          addEdge(edges, gc.fileId, target, 'resolver-returns');
          resolvedAny = true;
        }
      }
      if (typeNames.size > 0 && !resolvedAny) {
        diag.unresolvedReturns.add(`${gc.fileId}: ${gc.name}.${fnName ?? '<fn>'} → ${[...typeNames].sort().join('|')}`);
      }
    }

    // Field-declaration edges: graphene `x = graphene.Field(User)` type target +
    // any `resolver=` cross-file resolver function (strawberry & graphene).
    for (const a of classDirectAssignments(gc.node)) {
      const rhs = a.d.rightExpr;
      if ((rhs as ParseNode).nodeType !== PN.Call) continue;
      const call = rhs as CallNode;
      const callee = callCallee(call);
      // graphene field type: `Field(User)` / `graphene.List(User)` → first arg type.
      if (gc.framework === 'graphene' && callee) {
        const leaf = callee.path.length ? callee.path[callee.path.length - 1] : callee.root;
        if (GRAPHENE_FIELD_CTORS.has(leaf)) {
          const typeArg = positionalArgs(call)[0];
          const names = new Set<string>();
          collectAnnotationTypeNames(typeArg, names);
          for (const tn of names) {
            const target = resolveName(tn, gc.fileId);
            if (target) addEdge(edges, gc.fileId, target, 'field-type');
          }
        }
      }
      // `resolver=fn` cross-file resolver function (both frameworks).
      const resolverArg = keywordArg(call, 'resolver');
      if (resolverArg) {
        const chain = memberChain(resolverArg);
        const target = chain ? resolveName(chain.root, gc.fileId) : undefined;
        if (target) {
          addEdge(edges, gc.fileId, target, 'field-resolver');
          // A standalone resolver-function file is itself a GraphQL request entry.
          addRole(roleByFile, target, 'graphql-resolver');
          roleFiles.add(target);
        } else if (chain) {
          diag.unresolvedResolvers.add(`${gc.fileId}: resolver=${chain.root}`);
        }
      }
    }
  }

  // The schema-assembly files (a `Schema(...)` construction) are GraphQL entries
  // too — tag them (a root class in the same file still wins by priority).
  for (const f of schemaFiles) {
    addRole(roleByFile, f, 'graphql-schema');
    roleFiles.add(f);
  }

  // Grouping — files carrying a GraphQL role, anchored on a dedicated GraphQL dir.
  const groups = buildGraphqlGroups(roleFiles);

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'graphql' },
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
            : (a.metadata?.relation as string) < (b.metadata?.relation as string)
              ? -1
              : (a.metadata?.relation as string) > (b.metadata?.relation as string)
                ? 1
                : 0,
  );

  // Positive signal for validation (mirrors fastapi/flask/nest's log line).
  if (groups.length > 0 || roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [graphql] ${classes.length} type(s) → ${roleByFile.size} role(s) · ${groups.length} schema group(s) · ${sortedEdges.length} edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  if (
    diag.unresolvedSchemaRoots.size > 0 ||
    diag.unresolvedReturns.size > 0 ||
    diag.unresolvedResolvers.size > 0
  ) {
    const parts: string[] = [];
    if (diag.unresolvedSchemaRoots.size > 0) {
      parts.push(`${diag.unresolvedSchemaRoots.size} unresolvable schema root(s): ${[...diag.unresolvedSchemaRoots].sort().slice(0, 10).join(' · ')}`);
    }
    if (diag.unresolvedReturns.size > 0) {
      parts.push(`${diag.unresolvedReturns.size} unresolvable resolver return type(s): ${[...diag.unresolvedReturns].sort().slice(0, 10).join(' · ')}`);
    }
    if (diag.unresolvedResolvers.size > 0) {
      parts.push(`${diag.unresolvedResolvers.size} unresolvable resolver ref(s): ${[...diag.unresolvedResolvers].sort().slice(0, 10).join(' · ')}`);
    }
    console.log(`  [graphql] degraded: ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

// The nearest ancestor directory of `fileId` whose basename is a dedicated GraphQL
// dir (`graphql`/`gql`/`schema`), shallowest-first; undefined when there is none.
function graphqlAnchor(fileId: string): { anchor: string; segment: string } | undefined {
  const parts = fileId.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (GRAPHQL_DIR_SEGMENTS.has(parts[i].toLowerCase())) {
      return { anchor: parts.slice(0, i + 1).join('/'), segment: parts[i] };
    }
  }
  return undefined;
}

// One subsystem per dedicated GraphQL directory, gathering the GraphQL-role files
// under it. Deterministic, collision-free ids (the assignGroupIds discipline):
// process anchors by ascending path so the SMALLEST wins the bare slug; collisions
// take a `-<dirSegment>` then `-<n>` suffix. Files with no GraphQL dir are left
// ungrouped (directory grouping handles them).
function buildGraphqlGroups(roleFiles: ReadonlySet<string>): FrameworkGroup[] {
  interface Seed {
    anchor: string;
    segment: string;
    fileIds: Set<string>;
  }
  const byAnchor = new Map<string, Seed>();
  for (const fileId of roleFiles) {
    const a = graphqlAnchor(fileId);
    if (!a) continue;
    const seed = byAnchor.get(a.anchor) ?? { anchor: a.anchor, segment: a.segment, fileIds: new Set() };
    seed.fileIds.add(fileId);
    byAnchor.set(a.anchor, seed);
  }
  const taken = new Set<string>();
  const ordered = [...byAnchor.values()].sort((x, y) => (x.anchor < y.anchor ? -1 : x.anchor > y.anchor ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of ordered) {
    const seg = seed.segment.toLowerCase();
    const label = seg === 'graphql' || seg === 'gql' ? 'GraphQL' : humanize(seed.segment);
    const baseSlug = slugify(seed.segment) || 'graphql';
    let id = baseSlug;
    if (taken.has(id)) id = `${baseSlug}-${dirSegment(seed.anchor)}`;
    let n = 2;
    while (taken.has(id)) id = `${baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label, fileIds: [...seed.fileIds].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function getAnalysis(ctx: FrameworkContext): GraphqlAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeGraphql(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const graphqlAdapter: FrameworkAdapter = {
  name: 'graphql',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose manifest is at root reports rootPath '').
    const rootMatch = scoreGraphql(gatherGraphqlSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // A GraphQL backend often lives one dir down (a `backend/` | `server/` | `api/`
    // package in a frontend+backend monorepo). Shallow-scan immediate subdirs for a
    // strawberry/graphene manifest and scope to it. Only when NOT already scoped to
    // a workspace package (the  path).
    if (!ctx.packageDir) {
      for (const sub of shallowManifestSubdirs(base)) {
        const m = scoreGraphql(gatherGraphqlSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // One grouping prior per dedicated GraphQL directory → its own subsystem,
  // authoritative over directory grouping (the fastapi/flask/nest mechanism).
  // Fully deterministic (dir-derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // resolver → returned type, graphene field → type, root field → cross-file
  // resolver, Schema(...) → root type files (all kind 'calls'). File-id endpoints;
  // the step resolves to modules, drops self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // Query/Mutation/Subscription roots + their resolvers → gateway; every other
  // object/input/interface type → service. METADATA; the module's `kind` is
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
