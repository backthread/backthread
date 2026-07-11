// the gRPC FrameworkAdapter. Net-new adapter following the FastAPI
// / Flask template, reusing the shared Python core
// (py-ast + parsePythonScope). gRPC's request surface is NOT HTTP
// routes — it's a set of RPC services declared in `.proto` files and IMPLEMENTED
// as Python `XServicer` subclasses, wired to a server, and consumed via generated
// client `XStub` classes. We read all of it STATICALLY (install-free,
// never-store-source — a pure syntactic Pyright parse + a light `.proto` line
// scan; never executes repo code), and persist only the derived groups/edges/roles:
//
//   * detect()        — the `grpcio` (/`grpcio-tools`) dependency; a SECONDARY
//                       signal is `.proto` files alongside generated
//                       `*_pb2_grpc.py` stubs (a repo that vendors the codegen
//                       output without declaring the runtime dep). Shallow nested
//                       scan for a `backend/`|`server/` package (mirrors FastAPI's
//                       ). EXISTENCE-only — never parses source in detect.
//   * groupingPrior   — one FrameworkGroup per gRPC SERVICE (the servicer impl
//                       file(s) for that service), so each service becomes its own
//                       named subsystem instead of one folder box. Same mechanism
//                       the FastAPI router / Flask blueprint / Nest @Module prior
//                       use: the contribute-step makes each group its own subsystem.
//   * syntheticEdges  — the wiring the import graph doesn't name as verbs:
//                       `add_XServicer_to_server(impl, server)` (server-setup file
//                       → the servicer impl file, kind 'calls') and a client
//                       `stub.SomeMethod(...)` call (the client file → the in-repo
//                       servicer impl of that service, kind 'calls' — the RPC
//                       boundary the structural graph can't see).
//   * roleTags        — an `XServicer` SUBCLASS (the RPC request entry) → `gateway`.
//                       The generated `*_pb2.py`/`*_pb2_grpc.py` stubs are
//                       recognized + SKIPPED (they're codegen noise, not a role).
//                       METADATA onto the LOCKED MODULE_KINDS enum; never a new
//                       kind (only `role` renders).
//
// Unresolvable wiring targets / client-only stub calls (no in-repo servicer for
// the service) DEGRADE + LOG — no silent caps.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readPythonDeps } from '../../graph/python-manifest.js';
import { parsePythonScope } from '../python/analyze.js';
import {
  callCallee,
  classBaseChains,
  memberChain,
  nameValue,
  positionalArgs,
  PN,
} from '../python/py-ast.js';
import type {
  CallNode,
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
// Detection (fs → deps + config-file EXISTENCE; PURE. Never reads source content).

/** The deterministic gRPC signal set (dependency names + artifact existence). */
export interface GrpcSignals {
  hasGrpcio: boolean; // grpcio — the authoritative runtime signal
  hasGrpcioTools: boolean; // grpcio-tools — the codegen dep (supporting)
  hasProtoFiles: boolean; // any `.proto` in scope (existence only)
  hasGeneratedGrpc: boolean; // any generated `*_pb2_grpc.py` (existence only)
}

// Non-source dirs the artifact scan skips (cheap + can't hold first-party protos).
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

// A generated gRPC/protobuf stub file (`foo_pb2.py`, `foo_pb2_grpc.py`, `.pyi`).
// These are codegen output — never a servicer role, never in a service group.
function isGeneratedStub(fileId: string): boolean {
  const base = fileId.split('/').pop() ?? fileId;
  return /_pb2(_grpc)?\.pyi?$/.test(base);
}

/**
 * Bounded recursive scan for gRPC artifacts (existence only — never reads file
 * CONTENT). Returns whether a `.proto` and a generated `*_pb2_grpc.py` exist
 * under `base`, and stops early once BOTH are found. Depth- and budget-capped so
 * detect stays cheap on a large repo. Skips dot-dirs + non-source dirs.
 */
function scanGrpcArtifacts(base: string, maxDepth = 6, budget = 4000): { hasProto: boolean; hasGeneratedGrpc: boolean } {
  let hasProto = false;
  let hasGeneratedGrpc = false;
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || visited > budget || (hasProto && hasGeneratedGrpc)) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++visited > budget) return;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), depth + 1);
        if (hasProto && hasGeneratedGrpc) return;
      } else if (e.isFile()) {
        if (e.name.endsWith('.proto')) hasProto = true;
        else if (/_pb2_grpc\.pyi?$/.test(e.name)) hasGeneratedGrpc = true;
      }
    }
  };
  walk(base, 0);
  return { hasProto, hasGeneratedGrpc };
}

/** Gather the signal set for a single root dir (deps + artifact existence). */
export function gatherGrpcSignals(baseDir: string): GrpcSignals {
  const deps = readPythonDeps(baseDir);
  // Always run the (bounded, early-terminating) artifact scan so the proto/stub
  // signals are accurate regardless of the declared dep — the secondary match
  // needs them WITHOUT a dep, and the `+0.1 proto` confidence bump then applies
  // UNIFORMLY (not only on the depless path). The scan already runs for every
  // non-grpc repo's detect anyway, so a grpc repo paying for it too is negligible.
  const artifacts = scanGrpcArtifacts(baseDir);
  return {
    hasGrpcio: deps.has('grpcio'),
    hasGrpcioTools: deps.has('grpcio-tools'),
    hasProtoFiles: artifacts.hasProto,
    hasGeneratedGrpc: artifacts.hasGeneratedGrpc,
  };
}

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
 * for a nested gRPC backend (`backend/` | `server/` | `api/`). Sorted, so the
 * first-match pick is deterministic; skips dot-dirs + non-source dirs.
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
 * Decide gRPC from the signal set. `grpcio`/`grpcio-tools` is the authoritative
 * signal; a SECONDARY match is `.proto` files alongside generated `*_pb2_grpc.py`
 * (a repo that vendors the codegen output without declaring the runtime dep).
 * Returns null → generic-Python fallthrough, byte-for-byte unchanged.
 */
export function scoreGrpc(s: GrpcSignals, rootPath = ''): DetectMatch | null {
  const hasDep = s.hasGrpcio || s.hasGrpcioTools;
  const hasSecondary = s.hasProtoFiles && s.hasGeneratedGrpc;
  if (!hasDep && !hasSecondary) return null;
  let confidence: number;
  if (hasDep) {
    confidence = 0.8;
    if (s.hasGrpcioTools) confidence += 0.05;
    if (s.hasProtoFiles) confidence += 0.1;
  } else {
    // Proto + generated stubs, no declared dep — a real but weaker signal.
    confidence = 0.6;
  }
  return {
    adapter: 'grpc',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: {
        grpcio: s.hasGrpcio,
        grpcioTools: s.hasGrpcioTools,
        protoFiles: s.hasProtoFiles,
        generatedGrpc: s.hasGeneratedGrpc,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind`
// is unchanged. A servicer subclass is the RPC request entry → gateway.
export type GrpcRole = 'servicer';
const ROLE_PRIORITY: Record<GrpcRole, number> = { servicer: 7 };
const ROLE_KIND: Record<GrpcRole, ModuleKind> = { servicer: 'gateway' };

// A servicer base class name ends in `Servicer` (generated `add_XServicer…`, the
// `XServicer` base in `*_pb2_grpc.py`); a client stub var is built from `XStub`.
const SERVICER_SUFFIX = 'Servicer';
const STUB_SUFFIX = 'Stub';
// The generated wiring function: `add_<Service>Servicer_to_server(impl, server)`.
const ADD_TO_SERVER_RE = /^add_(.+)Servicer_to_server$/;
// The async/future stub-call forms: `stub.Method.future(req)` / `.with_call(req)`
// — the RPC method is the FIRST segment, the callable modifier the second.
const STUB_CALL_MODIFIERS = new Set(['future', 'with_call']);

// ---------------------------------------------------------------------------
// Analysis.

interface GrpcAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface GrpcDiag {
  unresolvedWiring: Set<string>; // add_*_to_server calls we couldn't map to an impl
  clientOnlyStubs: Set<string>; // stub.Method() with no in-repo servicer for the service
  ambiguousWiring: Set<string>; // a service with >1 impl file (wiring/stub can't pick)
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx gets a fresh analysis — no cross-tree staleness. Mirrors fastapi / flask.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, GrpcAnalysis>();

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
    edges.set(key, { source: from, target: to, kind, metadata: { framework: 'grpc', relation } });
  }
}

// The leaf name of a base-class / callee chain (`a.b.GreeterServicer` →
// 'GreeterServicer'; a bare `GreeterServicer` → 'GreeterServicer').
function chainLeaf(chain: { root: string; path: string[] }): string {
  return chain.path.length ? chain.path[chain.path.length - 1] : chain.root;
}

// The constructor name of an `x = Ctor(...)` assignment RHS (last chain segment,
// so both `GreeterStub(...)` and `pb2_grpc.GreeterStub(...)` read as 'GreeterStub'),
// or undefined when the RHS isn't a plain call.
function assignedCtorName(rhs: ExpressionNode): string | undefined {
  if ((rhs as ParseNode).nodeType !== PN.Call) return undefined;
  const callee = callCallee(rhs as CallNode);
  if (!callee) return undefined;
  return chainLeaf(callee);
}

// The constructed class name of an expression used as an argument: a direct
// `Greeter()` call → 'Greeter'; anything else (a Name, a subscript) → undefined
// (the caller falls back to a same-file `var = Ctor()` lookup / the service name).
function constructedClassName(expr: ExpressionNode | undefined): string | undefined {
  if (!expr || (expr as ParseNode).nodeType !== PN.Call) return undefined;
  const callee = callCallee(expr as CallNode);
  return callee ? chainLeaf(callee) : undefined;
}

// A gRPC service group id/label: named by the service (the servicer base minus
// the `Servicer` suffix — the proto service name). De-collided by assignGroups.
interface ServiceGroupSeed {
  service: string;
  fileIds: Set<string>; // the servicer impl files for this service
  baseSlug: string;
  label: string;
}

// Assign each service its final, collision-free group id ORDER-INDEPENDENTLY:
// process seeds by service name so the id set is identical run-to-run (the
// snapshot grouping-stability invariant); collisions take a `-<dirSegment>` then
// `-<n>` suffix.
function assignServiceGroups(seeds: ServiceGroupSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const ordered = [...seeds].sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of ordered) {
    const firstFile = [...seed.fileIds].sort()[0] ?? '';
    let id = seed.baseSlug;
    if (taken.has(id)) id = `${seed.baseSlug}-${dirSegment(firstFile)}`;
    let n = 2;
    while (taken.has(id)) id = `${seed.baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label: seed.label, fileIds: [...seed.fileIds].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// `.proto` service parsing (a light line/regex scan — enrichment only). The
// service/method structure partly lives in the proto; we surface the RPC method
// inventory onto the servicer role metadata. Never install-dependent.

// Word-boundary anchored (not line-start) so both the conventional multiline
// layout AND an inline `service X { rpc M(...) }` are recognized. `\bservice X {`
// won't match a `string service = 1;` field (no `{` follows the name).
const PROTO_SERVICE_RE = /\bservice\s+([A-Za-z_]\w*)\s*\{/g;
const PROTO_RPC_RE = /\brpc\s+([A-Za-z_]\w*)\s*\(/g;

/** Parse `service X { rpc M(...) … }` blocks → service name → sorted rpc methods. */
export function parseProtoServices(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  PROTO_SERVICE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // Find each service block's body by brace matching from the service header.
  while ((m = PROTO_SERVICE_RE.exec(text)) !== null) {
    const service = m[1];
    const bodyStart = text.indexOf('{', m.index);
    if (bodyStart < 0) continue;
    // Walk to the matching close brace (proto service bodies don't nest braces
    // except in message-less rpc option blocks — a depth counter handles those).
    let depth = 0;
    let i = bodyStart;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = text.slice(bodyStart, i);
    const methods = new Set<string>();
    PROTO_RPC_RE.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = PROTO_RPC_RE.exec(body)) !== null) methods.add(r[1]);
    const existing = out.get(service) ?? [];
    out.set(service, [...new Set([...existing, ...methods])].sort());
  }
  return out;
}

// Bounded recursive scan for in-scope `.proto` files (reads CONTENT — this is
// analysis, which declares scansSourcePath, not detect). Depth/budget-capped.
function collectProtoServices(baseDir: string): Map<string, string[]> {
  const services = new Map<string, string[]>();
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || visited > 8000) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (++visited > 8000) return;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && e.name.endsWith('.proto')) {
        let text: string;
        try {
          text = readFileSync(join(dir, e.name), 'utf8');
        } catch {
          continue;
        }
        for (const [svc, methods] of parseProtoServices(text)) {
          const merged = new Set([...(services.get(svc) ?? []), ...methods]);
          services.set(svc, [...merged].sort());
        }
      }
    }
  };
  walk(baseDir, 0);
  return services;
}

function analyzeGrpc(ctx: FrameworkContext): GrpcAnalysis {
  const { repoDir, rootPath } = ctx;
  const { parsed } = parsePythonScope(ctx);

  // Pass 1 — servicer impl classes + client stub vars + same-file ctor vars.
  //   servicerClassesByFile  : file → its servicer impl CLASS names (same-file resolve)
  //   servicerFilesByService : service name → the impl file(s) (wiring/stub target)
  //   servicesByFile         : file → the services it implements (role metadata)
  //   stubServiceByVar       : file → (stub var → service) (client stub calls)
  //   ctorVarByFile          : file → (var → constructed class) (wiring var-arg)
  const servicerClassesByFile = new Map<string, Set<string>>();
  const servicerFilesByService = new Map<string, Set<string>>();
  const servicesByFile = new Map<string, Set<string>>();
  const stubServiceByVar = new Map<string, Map<string, string>>();
  const ctorVarByFile = new Map<string, Map<string, string>>();
  const roleByFile = new Map<string, GrpcRole>();

  for (const [id, file] of parsed) {
    const generated = isGeneratedStub(id);
    const stubVars = new Map<string, string>();
    const ctorVars = new Map<string, string>();
    for (const a of file.nodes.assignments) {
      const target = nameValue(a.d.leftExpr);
      if (!target) continue;
      const ctor = assignedCtorName(a.d.rightExpr);
      if (!ctor) continue;
      ctorVars.set(target, ctor);
      // A client stub var: `x = GreeterStub(channel)` → service 'Greeter'.
      if (ctor.endsWith(STUB_SUFFIX) && ctor.length > STUB_SUFFIX.length) {
        stubVars.set(target, ctor.slice(0, -STUB_SUFFIX.length));
      }
    }
    stubServiceByVar.set(id, stubVars);
    ctorVarByFile.set(id, ctorVars);

    if (generated) continue; // never a servicer role / group; codegen noise

    for (const cls of file.nodes.classes) {
      const className = nameValue(cls.d.name);
      if (!className) continue;
      for (const base of classBaseChains(cls)) {
        const leaf = chainLeaf(base);
        if (!leaf.endsWith(SERVICER_SUFFIX) || leaf.length === SERVICER_SUFFIX.length) continue;
        const service = leaf.slice(0, -SERVICER_SUFFIX.length);
        (servicerClassesByFile.get(id) ?? servicerClassesByFile.set(id, new Set()).get(id)!).add(className);
        (servicerFilesByService.get(service) ?? servicerFilesByService.set(service, new Set()).get(service)!).add(id);
        (servicesByFile.get(id) ?? servicesByFile.set(id, new Set()).get(id)!).add(service);
        roleByFile.set(id, 'servicer');
      }
    }
  }

  const edges = new Map<string, FrameworkEdge>();
  const diag: GrpcDiag = {
    unresolvedWiring: new Set(),
    clientOnlyStubs: new Set(),
    ambiguousWiring: new Set(),
  };

  // The unique in-repo servicer impl file for a service, or undefined (0 or >1).
  // A service with >1 impl is logged as ambiguous (can't pick a wiring/stub target).
  const uniqueImpl = (service: string): string | undefined => {
    const files = servicerFilesByService.get(service);
    if (!files || files.size === 0) return undefined;
    if (files.size > 1) {
      diag.ambiguousWiring.add(`${service} (${[...files].sort().join(', ')})`);
      return undefined;
    }
    return [...files][0];
  };

  // Pass 2 — wiring + stub-call edges. Generated stubs are skipped (a
  // `*_pb2_grpc.py` never CALLS add_*_to_server / instantiates a stub — it only
  // DEFINES them — but skipping keeps codegen strictly out of the contribution).
  for (const [id, file] of parsed) {
    if (isGeneratedStub(id)) continue;
    const stubVars = stubServiceByVar.get(id)!;
    const ctorVars = ctorVarByFile.get(id)!;
    const binds = file.bindings;

    for (const call of file.nodes.calls) {
      const callee = callCallee(call);
      if (!callee) continue;
      const leaf = chainLeaf(callee);

      // (a) `add_<Service>Servicer_to_server(impl, server)` wiring.
      const wire = ADD_TO_SERVER_RE.exec(leaf);
      if (wire) {
        const service = wire[1];
        // Resolve the impl instance to its servicer file. Prefer the constructed-
        // class arg (`Greeter()` / a `var = Greeter()`), resolved SAME-FILE FIRST
        // (the common grpc layout: impl + bootstrap in one module → a self-edge,
        // dropped), then the file it was IMPORTED from (the production layout:
        // impl in a `servicers/` module → a real cross-module edge). Fall back to
        // the service's UNIQUE in-repo impl only when the impl arg isn't a plain
        // ctor/var — never a global class-name guess (name collisions mis-resolve).
        const firstArg = positionalArgs(call)[0];
        let implClass = constructedClassName(firstArg);
        if (!implClass) {
          const varName = firstArg ? nameValue(firstArg) : undefined;
          if (varName) implClass = ctorVars.get(varName);
        }
        let target: string | undefined;
        if (implClass) {
          if (servicerClassesByFile.get(id)?.has(implClass)) target = id; // same-file
          else {
            const bound = binds.get(implClass); // imported from another module
            if (bound && roleByFile.has(bound)) target = bound;
          }
        }
        if (!target) target = uniqueImpl(service);
        if (target) addEdge(edges, id, target, 'calls', 'add-servicer-to-server');
        else diag.unresolvedWiring.add(`${id}: add_${service}Servicer_to_server(…)`);
        continue;
      }

      // (b) a client stub call — `stub` is a known stub var. Two shapes: the
      // direct `stub.SomeMethod(req)` (RPC method = the one segment) and the
      // async/future `stub.SomeMethod.future(req)` / `.with_call(req)` (RPC method
      // = the first segment, a modifier second). Skip dunder methods. Either →
      // a cross-module call to the in-repo servicer impl of that service.
      const service = stubVars.get(callee.root);
      const isDirectRpc = callee.path.length === 1 && !callee.path[0].startsWith('_');
      const isFutureRpc =
        callee.path.length === 2 &&
        !callee.path[0].startsWith('_') &&
        STUB_CALL_MODIFIERS.has(callee.path[1]);
      if (service && (isDirectRpc || isFutureRpc)) {
        const rpc = callee.path[0];
        const target = uniqueImpl(service);
        if (target) addEdge(edges, id, target, 'calls', 'stub-call');
        else diag.clientOnlyStubs.add(`${id}: ${callee.root}.${rpc}(…) [service ${service}]`);
      }
    }
  }

  // `.proto` enrichment — the RPC method inventory per service, attached to the
  // servicer role metadata (the service structure partly lives in the proto).
  const protoServices = collectProtoServices(join(repoDir, rootPath));

  // Grouping seeds — one per service (its impl file(s)).
  const seeds: ServiceGroupSeed[] = [];
  for (const [service, files] of servicerFilesByService) {
    seeds.push({
      service,
      fileIds: new Set(files),
      baseSlug: slugify(service) || 'service',
      label: humanize(service) || service,
    });
  }
  const groups = assignServiceGroups(seeds);

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    const services = [...(servicesByFile.get(fileId) ?? [])].sort();
    const rpcMethods = [
      ...new Set(services.flatMap((s) => protoServices.get(s) ?? [])),
    ].sort();
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: {
        framework: 'grpc',
        services,
        ...(rpcMethods.length ? { rpcMethods } : {}),
      },
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

  // Positive signal for validation (mirrors fastapi/flask's log line).
  if (groups.length > 0 || roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [grpc] ${roleByFile.size} servicer role(s) · ${groups.length} service group(s) · ${sortedEdges.length} edge(s)` +
        (protoServices.size ? ` · ${protoServices.size} proto service(s)` : ''),
    );
  }
  // No silent caps (locked): log everything that degraded.
  if (diag.unresolvedWiring.size > 0 || diag.clientOnlyStubs.size > 0 || diag.ambiguousWiring.size > 0) {
    const parts: string[] = [];
    if (diag.unresolvedWiring.size > 0) {
      parts.push(`${diag.unresolvedWiring.size} unresolvable wiring: ${[...diag.unresolvedWiring].sort().slice(0, 10).join(' · ')}`);
    }
    if (diag.clientOnlyStubs.size > 0) {
      parts.push(`${diag.clientOnlyStubs.size} client-only stub call(s) (no in-repo servicer): ${[...diag.clientOnlyStubs].sort().slice(0, 10).join(' · ')}`);
    }
    if (diag.ambiguousWiring.size > 0) {
      parts.push(`${diag.ambiguousWiring.size} service(s) with multiple impls: ${[...diag.ambiguousWiring].sort().slice(0, 10).join(' · ')}`);
    }
    console.log(`  [grpc] degraded: ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): GrpcAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeGrpc(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const grpcAdapter: FrameworkAdapter = {
  name: 'grpc',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose manifest is at root reports rootPath '').
    const rootMatch = scoreGrpc(gatherGrpcSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // A gRPC backend often lives one dir down (a `backend/` | `server/` package
    // in a frontend+backend monorepo), so a root-only scan misses it. Shallow-scan
    // immediate subdirs for a grpc manifest and scope to it. Only when NOT already
    // scoped to a workspace package (the  path).
    if (!ctx.packageDir) {
      for (const sub of shallowManifestSubdirs(base)) {
        const m = scoreGrpc(gatherGrpcSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // One grouping prior per gRPC SERVICE → its own subsystem, authoritative over
  // directory grouping (the fastapi/flask/nest mechanism). Fully deterministic
  // (service-name-derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // add_XServicer_to_server wiring + client stub.Method() calls (kind 'calls').
  // File-id endpoints; the step resolves to modules, drops self-edges, dedupes,
  // 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // An XServicer subclass → gateway (RPC request entry). METADATA; the module's
  // `kind` is unchanged. Generated `*_pb2_grpc.py` stubs are skipped.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE (Python + `.proto`). Declare the paths the diff-driven
  // hosted walk must treat as framework-relevant. Never-store-source holds: parse
  // server-side, persist only the derived groups/edges/roles.
  scansSourcePath(path: string): boolean {
    return path.endsWith('.py') || path.endsWith('.pyi') || path.endsWith('.proto');
  },
};
