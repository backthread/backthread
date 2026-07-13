// The Oban FrameworkAdapter (async) — an Elixir background-job adapter built on the
// shared Elixir framework-analysis layer (framework/elixir/{analyze,elixir-ast}.ts),
// the same way the Python fleet's Celery adapter is built on framework/python/. Net-
// new; detects against mix.exs / mix.lock (the `oban` dep), NOT package.json.
//
// Oban declares its background-job surface structurally, which we read STATICALLY
// (install-free, never-store-source — the hand-rolled Elixir scanner never executes
// repo code). parseElixirScope pre-scans every in-scope file ONCE (modules / use
// directives / macro calls) and the two hooks share that one pass:
//
//   * detect()        — the `oban` dependency (an `oban_*` extension, e.g.
//                       `oban_web` / `oban_pro`, is a supporting signal). Shallow
//                       nested-app detection too (a `backend/mix.exs`).
//   * roleTags        — an Oban WORKER (a module that `use Oban.Worker`, whose
//                       `@impl Oban.Worker def perform/1` is the job body) → role
//                       'oban-worker' on the LOCKED `job` MODULE_KIND (own-code
//                       triggered by a queue, not a request); never a new kind —
//                       only `role` renders.
//   * syntheticEdges  — the ENQUEUE wiring the import graph never names as a verb: an
//                       `Oban.insert` / `Oban.insert_all` call in a file that also
//                       builds a `<Worker>.new(args)` changeset (directly or via the
//                       `<Worker>.new(args) |> Oban.insert()` pipe) → a `publishes`
//                       edge from the ENQUEUER file to the WORKER file. The worker
//                       module is resolved through the shared registry (a fully-
//                       qualified `MyApp.Workers.X.new` directly; a bare aliased
//                       `X.new` via the worker last-segment index).
//
// Unresolvable enqueues (an `Oban.insert` with no attributable worker `.new`) DEGRADE
// + LOG — no silent caps. Everything is deterministic (sorted outputs, ids derived
// from paths/names; run-twice is byte-identical). Never throws.
//
// NOTE: Grouping is intentionally NOT contributed — Oban has no per-domain structural
// unit like a Phoenix context; worker files stay in the host framework's / directory
// grouping (mirrors Celery's roles-+-edges-only stance).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readMixDeps, readMixDepsDeep } from '../../graph/elixir-manifest.js';
import { parseElixirScope, type ParsedElixirFile } from '../elixir/analyze.js';
import { sourceLines } from '../../graph/elixir-scan.js';
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
// Detection (mix.exs/mix.lock → deps; PURE scorer). Never reads source content.

/** The deterministic Oban signal set (dependency names only). */
export interface ObanSignals {
  hasOban: boolean; // oban — the authoritative signal
  hasObanExtension: boolean; // oban_web / oban_pro / oban_* — a supporting signal
}

/** Decide the signal set from a dependency-name set (pure). */
function obanSignalsFromDeps(deps: Set<string>): ObanSignals {
  return {
    hasOban: deps.has('oban'),
    // An `oban_*` companion (Web dashboard / Pro) is a strong secondary signal this
    // really is an Oban deployment (vs. `oban` pulled in transitively).
    hasObanExtension: [...deps].some((d) => d !== 'oban' && d.startsWith('oban_')),
  };
}

/** Gather the signal set for a single root dir (reads mix manifests only). */
export function gatherObanSignals(baseDir: string): ObanSignals {
  return obanSignalsFromDeps(readMixDeps(baseDir));
}

// Non-source dirs the nested scan skips (cheap + can't hold a first-party manifest).
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

/**
 * Immediate subdirs (depth 1) that hold a `mix.exs` — the shallow search for a
 * nested Elixir app (`backend/` | `server/` in a polyglot monorepo). Sorted, so the
 * first-match pick is deterministic; skips dot-dirs + build dirs to stay cheap.
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
 * Decide Oban from the signal set. `oban` is REQUIRED; an `oban_*` extension raises
 * confidence. Returns null → generic-Elixir fallthrough, byte-for-byte unchanged.
 */
export function scoreOban(s: ObanSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasOban) return null;
  let confidence = 0.8;
  if (s.hasObanExtension) confidence += 0.1;
  return {
    adapter: 'oban',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: { oban: s.hasOban, obanExtension: s.hasObanExtension },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → the LOCKED `job` MODULE_KIND. An Oban worker is own-code
// triggered by a queue (not a request) → `job`; the finer role is metadata.
export type ObanRole = 'oban-worker';

const ROLE_PRIORITY: Record<ObanRole, number> = { 'oban-worker': 5 };
const ROLE_KIND: Record<ObanRole, ModuleKind> = { 'oban-worker': 'job' };

// The `use Oban.Worker` directive marks a worker module (it injects the
// `@behaviour Oban.Worker` + `perform/1` contract). This is the authoritative signal.
// Matched by a LINE-SCAN rather than the shared single-line `parsed.uses` because the
// idiomatic Oban form spreads options over lines (`use Oban.Worker,\n  queue: :x,\n
// max_attempts: 3`), which the shared `use ...` accessor (a whole-line regex) can't
// see. The negative lookahead keeps `Oban.WorkerFoo` / `Oban.Worker.Sub` from matching.
const WORKER_USE_RE = /^\s*use\s+Oban\.Worker(?![.\w])/;

// `Oban.insert` / `Oban.insert_all` (+ their `!` bang variants) — the enqueue that
// actually schedules a job. `.new(...)` alone only builds a changeset; requiring an
// insert in the file avoids a false edge from a test that builds `Worker.new` for a
// `perform/1` unit assertion without ever enqueuing.
const INSERT_RE = /\bOban\.insert(?:_all)?!?/;
// A `<Module>.new(` changeset builder — the worker being enqueued. Captures the
// module path before `.new` (`MyApp.Workers.EmailWorker.new(%{})` → the full path;
// a bare aliased `EmailWorker.new(%{})` → `EmailWorker`).
const WORKER_NEW_RE = /\b([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)\.new\b/g;

function lastSegment(mod: string): string {
  const i = mod.lastIndexOf('.');
  return i >= 0 ? mod.slice(i + 1) : mod;
}

// ---------------------------------------------------------------------------
// Analysis.

interface ObanAnalysis {
  edges: FrameworkEdge[]; // file-id endpoints
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface ObanDiag {
  unresolvedEnqueues: Set<string>; // files with an Oban.insert but no attributable worker
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so syntheticEdges + roleTags
// share ONE parse, while the merge walk's per-checkpoint ctx gets a fresh analysis —
// no cross-tree staleness. Mirrors phoenix / celery.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, ObanAnalysis>();

function addEdge(
  edges: Map<string, FrameworkEdge>,
  from: string,
  to: string,
  relation: string,
): void {
  if (from === to) return; // a worker enqueuing itself → no edge
  const key = `${from}→${to}:publishes`;
  if (!edges.has(key)) {
    edges.set(key, {
      source: from,
      target: to,
      kind: 'publishes',
      metadata: { framework: 'oban', relation },
    });
  }
}

/** Does the file `use Oban.Worker` (single- OR multi-line options)? */
function isWorker(parsed: ParsedElixirFile): boolean {
  return sourceLines(parsed.text).some((ln) => WORKER_USE_RE.test(ln));
}

function analyzeOban(ctx: FrameworkContext): ObanAnalysis {
  const scope = parseElixirScope(ctx);

  // Pass 1 — worker files + the worker last-segment index (for aliased references).
  const workerFiles = new Set<string>();
  for (const [id, parsed] of scope.parsed) {
    if (isWorker(parsed)) workerFiles.add(id);
  }
  // Bare aliased enqueues (`alias MyApp.Workers.X` → `X.new`) resolve through the
  // last segment of a worker module. First (sorted-id) worker wins a collision, so
  // the mapping is deterministic.
  const workerByLastSeg = new Map<string, string>();
  for (const id of [...workerFiles].sort()) {
    for (const mod of scope.parsed.get(id)!.modules) {
      const seg = lastSegment(mod);
      if (!workerByLastSeg.has(seg)) workerByLastSeg.set(seg, id);
    }
  }

  // Resolve a captured `<Module>.new` token to a WORKER file, or undefined.
  //   * fully-qualified (`MyApp.Workers.X`) → the shared registry, gated on the
  //     resolved file being a worker (so `Ecto.Changeset.new` never links).
  //   * bare single-segment (`X`, an alias) → the worker last-segment index.
  function resolveWorkerTarget(token: string): string | undefined {
    const direct = scope.resolve(token);
    if (direct && workerFiles.has(direct)) return direct;
    if (!token.includes('.')) return workerByLastSeg.get(token);
    return undefined;
  }

  const edges = new Map<string, FrameworkEdge>();
  const diag: ObanDiag = { unresolvedEnqueues: new Set() };

  for (const [id, parsed] of scope.parsed) {
    // Heredoc-aware physical lines (a `@doc` code example never registers).
    const lines = sourceLines(parsed.text);
    const hasInsert = lines.some((ln) => INSERT_RE.test(ln));
    if (!hasInsert) continue; // not an enqueuer

    let linked = 0;
    const seenTokens = new Set<string>();
    for (const ln of lines) {
      for (const m of ln.matchAll(WORKER_NEW_RE)) {
        const token = m[1];
        if (seenTokens.has(token)) continue;
        seenTokens.add(token);
        const target = resolveWorkerTarget(token);
        if (target) {
          // Resolved to a worker (including this same file — a self-enqueue that
          // addEdge drops but which still counts as "attributed", so it is NOT flagged
          // unresolved).
          addEdge(edges, id, target, 'oban-enqueue');
          linked++;
        }
      }
    }
    // An enqueuer that yielded no worker edge (the worker was built elsewhere, or the
    // insert takes a raw `%Oban.Job{}` we don't parse) DEGRADES + is logged.
    if (linked === 0) diag.unresolvedEnqueues.add(id);
  }

  const roles = new Map<string, RoleTag>();
  for (const id of [...workerFiles].sort()) {
    roles.set(id, {
      role: 'oban-worker',
      kind: ROLE_KIND['oban-worker'],
      priority: ROLE_PRIORITY['oban-worker'],
      metadata: { framework: 'oban' },
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

  // Positive signal for validation (mirrors phoenix / celery's log line).
  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(`  [oban] ${roles.size} worker(s) · ${sortedEdges.length} enqueue edge(s)`);
  }
  // No silent caps (locked): log everything that degraded.
  if (diag.unresolvedEnqueues.size > 0) {
    console.log(
      `  [oban] degraded: ${diag.unresolvedEnqueues.size} enqueuer(s) with no attributable worker: ${[...diag.unresolvedEnqueues].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`,
    );
  }

  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): ObanAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeOban(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter. Roles + edges only — no groupingPrior (Oban has no per-domain
// structural unit; worker files stay in the host framework's / directory grouping).

export const obanAdapter: FrameworkAdapter = {
  name: 'oban',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose mix.exs is at root → rootPath '').
    const rootMatch = scoreOban(gatherObanSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // Nested app (`backend/mix.exs`) — a shallow scan of immediate subdirs, scoping
    // the adapter to the first match. Only when NOT already scoped to a workspace
    // package (that's the per-package fan-out).
    if (!ctx.packageDir) {
      for (const sub of shallowMixSubdirs(base)) {
        const m = scoreOban(gatherObanSignals(join(base, sub)), sub);
        if (m) return m;
      }
      // Repo-wide fallback (FIRES ONLY after root + shallow miss) — a deeply-nested
      // Elixir umbrella in a polyglot monorepo (`elixir/apps/*/mix.exs`, the Firezone
      // shape) that the depth-1 shallow scan can't see. Union every mix.exs's deps
      // across the repo; if `oban` is declared anywhere, detect with rootPath '' (the
      // hooks scan ALL in-scope Elixir files). One bounded walk; manifests only,
      // never source content.
      const deep = scoreOban(obanSignalsFromDeps(readMixDepsDeep(ctx.repoDir)), '');
      if (deep) return deep;
    }
    return null;
  },

  // `Oban.insert` / `Oban.insert_all` + a `<Worker>.new(...)` changeset → 'publishes'
  // enqueuer → worker. File-id endpoints; the step resolves to modules, drops
  // self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // A worker (`use Oban.Worker`) → role 'oban-worker' on the locked `job` kind.
  // METADATA; the module's `kind` is unchanged.
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
