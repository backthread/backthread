// The Broadway FrameworkAdapter (async) — an Elixir data-ingestion-pipeline adapter
// built on the shared Elixir framework-analysis layer (framework/elixir/{analyze,
// elixir-ast}.ts), the sibling of the Oban adapter. Net-new; detects against
// mix.exs / mix.lock (the `broadway` dep), NOT package.json.
//
// Broadway declares its multi-stage pipeline surface structurally, which we read
// STATICALLY (install-free, never-store-source — the hand-rolled Elixir scanner never
// executes repo code). parseElixirScope pre-scans every in-scope file ONCE and the
// two hooks share that pass:
//
//   * detect()        — the `broadway` dependency (a `broadway_*` transport, e.g.
//                       `broadway_kafka` / `broadway_sqs` / `broadway_rabbitmq`, is a
//                       supporting signal). Shallow nested-app detection too.
//   * roleTags        — a Broadway PIPELINE (a module that `use Broadway`, defining
//                       the `handle_message/3` + `handle_batch/4` contract) → role
//                       'broadway-pipeline' on the LOCKED `job` MODULE_KIND (own-code
//                       triggered by a message queue, not a request); never a new
//                       kind — only `role` renders.
//   * syntheticEdges  — the PRODUCER wiring the import graph never names as a verb: a
//                       pipeline's `producer: [module: {MyProducer, _}]` config (in
//                       its `start_link/1` `Broadway.start_link` call) names a GenStage
//                       producer module. If that producer is an IN-REPO module → a
//                       `subscribes` edge pipeline → producer (the pipeline consumes
//                       from it). An EXTERNAL transport producer (`BroadwayKafka.
//                       Producer`, `BroadwaySQS.Producer`, …) is skipped — it's a
//                       dependency node, not a code module.
//
// Unresolvable producers (a `module:` reference that neither resolves in-repo nor
// looks like a known external transport) DEGRADE + LOG — no silent caps. Everything
// is deterministic (sorted outputs, ids derived from paths/names; run-twice is
// byte-identical). Never throws.
//
// NOTE: Grouping is intentionally NOT contributed — a Broadway pipeline is a single
// module, not a per-domain structural unit; pipeline files stay in the host
// framework's / directory grouping (mirrors Oban / Celery's roles-+-edges-only stance).

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

/** The deterministic Broadway signal set (dependency names only). */
export interface BroadwaySignals {
  hasBroadway: boolean; // broadway — the authoritative signal
  hasBroadwayTransport: boolean; // broadway_kafka / broadway_sqs / broadway_* transport
}

/** Decide the signal set from a dependency-name set (pure). */
function broadwaySignalsFromDeps(deps: Set<string>): BroadwaySignals {
  return {
    hasBroadway: deps.has('broadway'),
    // A `broadway_*` transport adapter is a strong secondary signal this really is a
    // Broadway deployment (vs. `broadway` pulled in transitively).
    hasBroadwayTransport: [...deps].some((d) => d !== 'broadway' && d.startsWith('broadway_')),
  };
}

/** Gather the signal set for a single root dir (reads mix manifests only). */
export function gatherBroadwaySignals(baseDir: string): BroadwaySignals {
  return broadwaySignalsFromDeps(readMixDeps(baseDir));
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
 * nested Elixir app (`backend/` | `server/`). Sorted, so the first-match pick is
 * deterministic; skips dot-dirs + build dirs to stay cheap.
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
 * Decide Broadway from the signal set. `broadway` is REQUIRED; a `broadway_*`
 * transport raises confidence. Returns null → generic-Elixir fallthrough, byte-for-
 * byte unchanged.
 */
export function scoreBroadway(s: BroadwaySignals, rootPath = ''): DetectMatch | null {
  if (!s.hasBroadway) return null;
  let confidence = 0.8;
  if (s.hasBroadwayTransport) confidence += 0.1;
  return {
    adapter: 'broadway',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: { broadway: s.hasBroadway, broadwayTransport: s.hasBroadwayTransport },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → the LOCKED `job` MODULE_KIND. A Broadway pipeline is own-code
// triggered by a message queue (not a request) → `job`; the finer role is metadata.
export type BroadwayRole = 'broadway-pipeline';

const ROLE_PRIORITY: Record<BroadwayRole, number> = { 'broadway-pipeline': 5 };
const ROLE_KIND: Record<BroadwayRole, ModuleKind> = { 'broadway-pipeline': 'job' };

// The `use Broadway` directive marks a pipeline module. Matched by a LINE-SCAN (like
// the Oban adapter) so a multi-line `use Broadway,\n  ...` form is still seen; the
// `(?:,|$)` tail keeps `use Broadway.Notifier` / `use BroadwayDashboard` from matching.
const PIPELINE_USE_RE = /^\s*use\s+Broadway\s*(?:,|$)/;

// A `producer: [module: {MyProducer, opts}]` config entry — the GenStage producer
// the pipeline consumes from. Captures the module path after `module:` (with or
// without the `{...}` tuple wrapper).
const PRODUCER_MODULE_RE = /\bmodule:\s*\{?\s*([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)/g;

// A `module:` reference that doesn't resolve in-repo AND looks like a dependency's
// transport producer is EXTERNAL (skipped, not a degrade). Broadway transports
// conventionally namespace under `Broadway*` / `OffBroadway*` and end in `.Producer`.
function looksExternalProducer(mod: string): boolean {
  const top = mod.split('.')[0];
  return (
    top.startsWith('Broadway') ||
    top.startsWith('OffBroadway') ||
    mod.endsWith('.Producer') ||
    mod === 'Broadway.DummyProducer'
  );
}

// ---------------------------------------------------------------------------
// Analysis.

interface BroadwayAnalysis {
  edges: FrameworkEdge[]; // file-id endpoints
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface BroadwayDiag {
  unresolvedProducers: Set<string>; // producer `module:` refs we couldn't place
}

// Memoized on the FrameworkContext OBJECT — see the oban / phoenix note.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, BroadwayAnalysis>();

function addEdge(
  edges: Map<string, FrameworkEdge>,
  from: string,
  to: string,
  relation: string,
): void {
  if (from === to) return; // a pipeline whose producer is defined in itself → no edge
  const key = `${from}→${to}:subscribes`;
  if (!edges.has(key)) {
    edges.set(key, {
      source: from,
      target: to,
      kind: 'subscribes',
      metadata: { framework: 'broadway', relation },
    });
  }
}

/** Does the file `use Broadway` (single- OR multi-line options)? */
function isPipeline(parsed: ParsedElixirFile): boolean {
  return sourceLines(parsed.text).some((ln) => PIPELINE_USE_RE.test(ln));
}

function analyzeBroadway(ctx: FrameworkContext): BroadwayAnalysis {
  const scope = parseElixirScope(ctx);

  // Pass 1 — pipeline files.
  const pipelineFiles = new Set<string>();
  for (const [id, parsed] of scope.parsed) {
    if (isPipeline(parsed)) pipelineFiles.add(id);
  }

  // Pass 2 — producer edges. A pipeline's `producer: [module: {P, _}]` names a
  // GenStage producer; an in-repo producer → subscribes edge, an external transport
  // → skip, anything else → degrade.
  const edges = new Map<string, FrameworkEdge>();
  const diag: BroadwayDiag = { unresolvedProducers: new Set() };
  for (const id of pipelineFiles) {
    const parsed = scope.parsed.get(id)!;
    const lines = sourceLines(parsed.text); // heredoc-aware
    const seen = new Set<string>();
    for (const ln of lines) {
      for (const m of ln.matchAll(PRODUCER_MODULE_RE)) {
        const mod = m[1];
        if (seen.has(mod)) continue;
        seen.add(mod);
        const target = scope.resolve(mod);
        if (target) {
          addEdge(edges, id, target, 'broadway-producer');
        } else if (looksExternalProducer(mod)) {
          // A dependency's transport producer — an infra/external concern, not a code
          // module. Skipped by design (not a degrade).
        } else {
          diag.unresolvedProducers.add(`${id}: producer module ${mod}`);
        }
      }
    }
  }

  const roles = new Map<string, RoleTag>();
  for (const id of [...pipelineFiles].sort()) {
    roles.set(id, {
      role: 'broadway-pipeline',
      kind: ROLE_KIND['broadway-pipeline'],
      priority: ROLE_PRIORITY['broadway-pipeline'],
      metadata: { framework: 'broadway' },
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

  // Positive signal for validation (mirrors oban / celery's log line).
  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(`  [broadway] ${roles.size} pipeline(s) · ${sortedEdges.length} producer edge(s)`);
  }
  // No silent caps (locked): log everything that degraded.
  if (diag.unresolvedProducers.size > 0) {
    console.log(
      `  [broadway] degraded: ${diag.unresolvedProducers.size} unresolvable producer(s): ${[...diag.unresolvedProducers].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`,
    );
  }

  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): BroadwayAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeBroadway(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter. Roles + edges only — no groupingPrior (a Broadway pipeline is a
// single module, not a per-domain structural unit).

export const broadwayAdapter: FrameworkAdapter = {
  name: 'broadway',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose mix.exs is at root → rootPath '').
    const rootMatch = scoreBroadway(gatherBroadwaySignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // Nested app (`backend/mix.exs`) — a shallow scan of immediate subdirs, scoping
    // the adapter to the first match. Only when NOT already scoped to a workspace
    // package (the per-package fan-out).
    if (!ctx.packageDir) {
      for (const sub of shallowMixSubdirs(base)) {
        const m = scoreBroadway(gatherBroadwaySignals(join(base, sub)), sub);
        if (m) return m;
      }
      // Repo-wide fallback (FIRES ONLY after root + shallow miss) — a deeply-nested
      // Elixir umbrella in a polyglot monorepo (`elixir/apps/*/mix.exs`, the Firezone
      // shape) that the depth-1 shallow scan can't see. Union every mix.exs's deps
      // across the repo; if `broadway` is declared anywhere, detect with rootPath ''
      // (the hooks scan ALL in-scope Elixir files). One bounded walk; manifests only,
      // never source content.
      const deep = scoreBroadway(broadwaySignalsFromDeps(readMixDepsDeep(ctx.repoDir)), '');
      if (deep) return deep;
    }
    return null;
  },

  // A pipeline's `producer: [module: {P, _}]` → 'subscribes' pipeline → in-repo
  // producer. File-id endpoints; the step resolves to modules, drops self-edges,
  // dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // A pipeline (`use Broadway`) → role 'broadway-pipeline' on the locked `job` kind.
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
