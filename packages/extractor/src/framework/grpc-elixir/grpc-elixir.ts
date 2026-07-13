// The gRPC-Elixir FrameworkAdapter (protocol) — the Elixir gRPC adapter, the
// analogue of the Python gRPC adapter (framework/grpc) and the Ruby grpc-ruby
// adapter. Built on the shared Elixir framework-analysis layer
// (framework/elixir/{analyze,elixir-ast}.ts); detects against mix.exs / mix.lock
// (the `grpc` dep), NOT package.json.
//
// The `grpc` library (elixir-grpc) serves RPCs from a SERVICER — a hand-written
// module that does `use GRPC.Server, service: <Package>.<Svc>.Service`, wiring the
// impl to the generated service behaviour. The generated code lives in `*.pb.ex`
// message/service stubs (protobuf-elixir output). We read all of it STATICALLY
// (install-free, never-store-source — the hand-rolled Elixir scanner; never
// executes repo code) and persist only the derived edges/roles:
//
//   * detect()        — the `grpc` dependency. A SECONDARY signal is `.proto` files
//                       alongside generated `*.pb.ex` stubs (a repo that vendors the
//                       codegen output without declaring the runtime dep). Shallow
//                       nested-app detection too (a `backend/mix.exs`). EXISTENCE-
//                       only — never parses source in detect.
//   * syntheticEdges  — the wiring the import graph doesn't name as a verb: a
//                       servicer's `use GRPC.Server, service: X.Service` → a `calls`
//                       edge servicer-file → the generated service-stub file (when
//                       in-repo). The servicer `alias`es nothing toward the stub —
//                       the impl↔service binding is the `use` option.
//   * roleTags        — a `use GRPC.Server` module (the RPC request entry) →
//                       `gateway` (role 'servicer'). Generated `*.pb.ex` message /
//                       service stubs are SKIPPED (codegen noise, not a role).
//                       METADATA onto the LOCKED MODULE_KINDS enum; never a new kind.
//
// Unresolvable service bindings (a `service:` module with no in-repo stub — the
// codegen output isn't committed) DEGRADE + LOG — no silent caps. Everything is
// deterministic (sorted outputs; run-twice is byte-identical).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readMixDeps } from '../../graph/elixir-manifest.js';
import { parseElixirScope, type ParsedElixirFile } from '../elixir/analyze.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  RoleTag,
} from '../types.js';
import type { ModuleKind } from '../../types.js';

// ---------------------------------------------------------------------------
// Detection (mix.exs/mix.lock → deps + artifact EXISTENCE; PURE. No source reads).

/** The deterministic gRPC-Elixir signal set (dep name + artifact existence). */
export interface GrpcElixirSignals {
  hasGrpc: boolean; // grpc — the authoritative runtime signal
  hasProtoFiles: boolean; // any `.proto` in scope (existence only)
  hasGeneratedPb: boolean; // any generated `*.pb.ex` (existence only)
}

// Non-source dirs the nested mix.exs / subdir search skips.
const NESTED_SKIP_DIRS = new Set([
  'node_modules',
  'deps',
  '_build',
  'dist',
  'build',
  'out',
  'cover',
  'priv',
  'assets',
]);

// Non-source dirs the ARTIFACT scan skips. Deliberately does NOT include `priv`:
// Elixir gRPC projects conventionally keep their `.proto` files under `priv/protos/`
// (and generated `*.pb.ex` under `lib/`), so skipping `priv` would blind the
// secondary signal. Only build/vendor output is skipped.
const ARTIFACT_SKIP_DIRS = new Set([
  'node_modules',
  'deps',
  '_build',
  'dist',
  'build',
  'out',
  'cover',
]);

/** A generated protobuf/gRPC Elixir stub (`foo.pb.ex`) — codegen, never a servicer. */
function isGeneratedStub(fileId: string): boolean {
  return fileId.endsWith('.pb.ex');
}

/**
 * Bounded recursive scan for gRPC artifacts (existence only — never reads file
 * CONTENT). Returns whether a `.proto` and a generated `*.pb.ex` exist under
 * `base`, stopping early once BOTH are found. Depth- and budget-capped so detect
 * stays cheap on a large repo. Skips dot-dirs + build dirs.
 */
function scanGrpcArtifacts(
  base: string,
  maxDepth = 6,
  budget = 4000,
): { hasProto: boolean; hasGeneratedPb: boolean } {
  let hasProto = false;
  let hasGeneratedPb = false;
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || visited > budget || (hasProto && hasGeneratedPb)) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++visited > budget) return;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || ARTIFACT_SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), depth + 1);
        if (hasProto && hasGeneratedPb) return;
      } else if (e.isFile()) {
        if (e.name.endsWith('.proto')) hasProto = true;
        else if (e.name.endsWith('.pb.ex')) hasGeneratedPb = true;
      }
    }
  };
  walk(base, 0);
  return { hasProto, hasGeneratedPb };
}

/** Gather the signal set for a single root dir (deps + artifact existence). */
export function gatherGrpcElixirSignals(baseDir: string): GrpcElixirSignals {
  const deps = readMixDeps(baseDir);
  const artifacts = scanGrpcArtifacts(baseDir);
  return {
    hasGrpc: deps.has('grpc'),
    hasProtoFiles: artifacts.hasProto,
    hasGeneratedPb: artifacts.hasGeneratedPb,
  };
}

/**
 * Immediate subdirs (depth 1) that hold a `mix.exs` — the shallow search for a
 * nested Elixir/gRPC app (`backend/` | `server/` in a polyglot monorepo). Sorted,
 * so the first-match pick is deterministic; skips dot-dirs + build dirs.
 */
function shallowMixSubdirs(base: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
    if (existsSync(join(base, e.name, 'mix.exs'))) out.push(e.name);
  }
  return out.sort();
}

/**
 * Decide gRPC-Elixir from the signal set. `grpc` is the authoritative signal; a
 * SECONDARY match is `.proto` files alongside generated `*.pb.ex` (a repo that
 * vendors the codegen output without declaring the runtime dep). Returns null →
 * generic-Elixir fallthrough, byte-for-byte unchanged.
 */
export function scoreGrpcElixir(s: GrpcElixirSignals, rootPath = ''): DetectMatch | null {
  const hasSecondary = s.hasProtoFiles && s.hasGeneratedPb;
  if (!s.hasGrpc && !hasSecondary) return null;
  let confidence: number;
  if (s.hasGrpc) {
    confidence = 0.8;
    if (s.hasProtoFiles) confidence += 0.1;
  } else {
    // Proto + generated stubs, no declared dep — a real but weaker signal.
    confidence = 0.6;
  }
  return {
    adapter: 'grpc-elixir',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      framework: 'grpc-elixir',
      signals: {
        grpc: s.hasGrpc,
        protoFiles: s.hasProtoFiles,
        generatedPb: s.hasGeneratedPb,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind`
// is unchanged. A servicer (`use GRPC.Server`) is the RPC request entry → gateway.
export type GrpcElixirRole = 'servicer';
const ROLE_PRIORITY: Record<GrpcElixirRole, number> = { servicer: 7 };
const ROLE_KIND: Record<GrpcElixirRole, ModuleKind> = { servicer: 'gateway' };

// A servicer's `use` module (the hand-written impl wires itself to the generated
// service behaviour with `use GRPC.Server, service: X.Service`). The generated
// service stub uses `GRPC.Service` instead — distinct, and skipped via `.pb.ex`.
const SERVER_USE_MODULE = 'GRPC.Server';
// A `@behaviour <X>.Service` attribute is a secondary servicer signal — some impls
// declare the generated service behaviour explicitly rather than via `use`'s option.
const SERVICE_BEHAVIOUR_RE = /(^|\.)Service$/;

// ---------------------------------------------------------------------------
// Helpers.

// The FIRST module reference (`Foo` / `Foo.Bar.Baz`) in a `use`-arg string, after
// stripping string literals. For `service: Helloworld.Greeter.Service` that's the
// service-stub module.
function firstModuleToken(args: string): string | undefined {
  const stripped = args.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  const m = stripped.match(/[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*/);
  return m ? m[0] : undefined;
}

// The `use GRPC.Server` directive of a servicer file (undefined when absent).
function serverUse(parsed: ParsedElixirFile): { module: string; args: string } | undefined {
  return parsed.uses.find((u) => u.module === SERVER_USE_MODULE);
}

// Is this file a servicer? A `use GRPC.Server`, or a `@behaviour <X>.Service`
// (the explicit-behaviour form). Generated `.pb.ex` files are excluded upstream.
function isServicer(parsed: ParsedElixirFile): boolean {
  if (serverUse(parsed)) return true;
  return parsed.attributes.some(
    (a) => a.name === 'behaviour' && SERVICE_BEHAVIOUR_RE.test(a.value.trim()),
  );
}

// ---------------------------------------------------------------------------
// Analysis.

interface GrpcElixirAnalysis {
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface GrpcElixirDiag {
  unresolvedServices: Set<string>; // `service: X` with no in-repo stub (codegen not committed)
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so syntheticEdges + roleTags
// share ONE parse, while the merge walk's per-checkpoint ctx gets a fresh analysis —
// no cross-tree staleness. Mirrors phoenix / grpc.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, GrpcElixirAnalysis>();

function addEdge(
  edges: Map<string, FrameworkEdge>,
  from: string,
  to: string,
  relation: string,
): void {
  if (from === to) return; // a servicer + its stub in one file → no self-edge
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, {
      source: from,
      target: to,
      kind: 'calls',
      metadata: { framework: 'grpc-elixir', relation },
    });
  }
}

function analyzeGrpcElixir(ctx: FrameworkContext): GrpcElixirAnalysis {
  const scope = parseElixirScope(ctx);
  const roleByFile = new Map<string, GrpcElixirRole>();
  const edges = new Map<string, FrameworkEdge>();
  const diag: GrpcElixirDiag = { unresolvedServices: new Set() };

  for (const [id, parsed] of scope.parsed) {
    if (isGeneratedStub(id)) continue; // codegen: never a servicer role / edge source
    if (!isServicer(parsed)) continue;
    roleByFile.set(id, 'servicer');

    // The servicer→service-stub edge, from the `use GRPC.Server, service: X.Service`
    // option. Resolve the service module to its (usually generated `.pb.ex`) file.
    const use = serverUse(parsed);
    if (!use) continue; // a @behaviour-only servicer has no `service:` option to wire
    const svcMod = firstModuleToken(use.args);
    if (!svcMod) continue; // `use GRPC.Server` with no service option (a stream impl) — role only
    const target = scope.resolve(svcMod);
    if (target) addEdge(edges, id, target, 'grpc-service');
    else diag.unresolvedServices.add(`${id}: service: ${svcMod}`);
  }

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'grpc-elixir' },
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
            : 0,
  );

  // Positive signal for validation (mirrors phoenix / grpc).
  if (roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [grpc-elixir] ${roleByFile.size} servicer role(s) · ${sortedEdges.length} service edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  if (diag.unresolvedServices.size > 0) {
    console.log(
      `  [grpc-elixir] degraded: ${diag.unresolvedServices.size} service binding(s) with no in-repo stub: ${[...diag.unresolvedServices].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`,
    );
  }

  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): GrpcElixirAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeGrpcElixir(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const grpcElixirAdapter: FrameworkAdapter = {
  name: 'grpc-elixir',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose mix.exs is at root → rootPath '').
    const rootMatch = scoreGrpcElixir(gatherGrpcElixirSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // Nested app (`backend/mix.exs`) — a shallow scan of immediate subdirs, scoping
    // the adapter to the first match. Only when NOT already scoped to a workspace
    // package (that's the per-package fan-out).
    if (!ctx.packageDir) {
      for (const sub of shallowMixSubdirs(base)) {
        const m = scoreGrpcElixir(gatherGrpcElixirSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // servicer `use GRPC.Server, service: X.Service` → generated service-stub file
  // (kind 'calls'). File-id endpoints; the step resolves to modules, drops
  // self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // A `use GRPC.Server` servicer → gateway (role 'servicer'). METADATA; the module's
  // `kind` is unchanged. Generated `*.pb.ex` stubs are skipped.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE (Elixir). Declare the paths the diff-driven hosted walk
  // must treat as framework-relevant. Never-store-source holds: parse server-side,
  // persist only the derived edges/roles.
  scansSourcePath(path: string): boolean {
    return (
      path.endsWith('.ex') ||
      path.endsWith('.exs') ||
      path.endsWith('.heex') ||
      path.endsWith('.eex') ||
      path.endsWith('.leex')
    );
  },
};
