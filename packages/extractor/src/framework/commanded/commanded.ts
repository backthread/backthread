// The Commanded FrameworkAdapter (CQRS / event-sourcing) — an Elixir framework
// adapter built on the shared Elixir framework-analysis layer (framework/elixir/
// {analyze,elixir-ast}.ts), the sibling of the Phoenix (web) / Ecto (data) /
// Oban·Broadway (async) adapters. Net-new; detects against mix.exs / mix.lock (the
// `commanded` dep), NOT package.json.
//
// Commanded declares its CQRS surface structurally, which we read STATICALLY
// (install-free, never-store-source — the hand-rolled Elixir scanner never executes
// repo code). parseElixirScope pre-scans every in-scope file ONCE (modules / use
// directives / macro calls / defs) and the two hooks share that one pass:
//
//   * detect()        — the `commanded` dependency (a `commanded_*` companion, e.g.
//                       `commanded_ecto_projections` / `commanded_eventstore_adapter`,
//                       is a supporting signal). Shallow nested-app detection too (a
//                       `backend/mix.exs`). PURE scorer.
//   * roleTags        — the four CQRS building blocks → the LOCKED MODULE_KINDS:
//                         · AGGREGATE       → role 'aggregate'      → kind `service`
//                             (own domain-decision code that folds commands into
//                             events; NOT infra). Detected by `use
//                             Commanded.Aggregates.Aggregate` OR (the common form) a
//                             module defining BOTH a `def execute` AND a `def apply`
//                             (the aggregate command/event protocol). The heuristic is
//                             bounded — detection is dep-gated to commanded repos — and
//                             requires BOTH public defs to avoid false positives.
//                         · COMMAND ROUTER  → role 'command-router' → kind `gateway`
//                             (the request-side entry that routes a command to its
//                             aggregate). `use Commanded.Commands.Router`.
//                         · EVENT HANDLER   → role 'event-handler'  → kind `job`
//                             (own-code triggered by an event stream, not a request).
//                             `use Commanded.Event.Handler`.
//                         · PROJECTOR       → role 'projector'      → kind `job`
//                             (an event-triggered read-model writer). `use
//                             Commanded.Projections.Ecto`.
//                       The `use`-based roles OUTRANK the aggregate execute+apply
//                       heuristic when one file matches both. METADATA onto the LOCKED
//                       enum; the module's `kind` is unchanged, NEVER a new kind.
//   * syntheticEdges  — THE DISPATCH SPINE (primary, structural): in a command-router
//                       module each `dispatch <Commands>, to: <Aggregate>, …` macro
//                       names the target aggregate MODULE via the `to:` option. The
//                       `to:` reference is resolved to its file precise-first: a
//                       fully-qualified `MyApp.Bank.Aggregates.Account` through the
//                       shared registry directly; a bare aliased `Account` through the
//                       ROUTER'S OWN `alias` block (the compile-accurate binding), with
//                       a guarded UNIQUE last-segment lookup as a final safety net → a
//                       `calls` edge router-file → aggregate-file. This mirrors the
//                       Phoenix route spine: the router `alias`es its aggregates, but
//                       the route→aggregate dispatch is a macro, not an import, so the
//                       import graph never names it as a verb. Multi-line dispatches
//                       (the `identity:` option almost always wraps) are handled by a
//                       heredoc-aware source-line scan, not the line-oriented macro
//                       accessor.
//
// Unresolvable `to:` targets (an external/unknown aggregate) DEGRADE + LOG; an
// AMBIGUOUS bare target (two in-repo modules share the last segment) is NOT guessed —
// it degrades too (accuracy over recall: a wrong edge teaches a false mental model).
// No silent caps. Everything is deterministic (sorted outputs, ids derived from
// paths/names, lexical tiebreaks; run-twice is byte-identical). Never throws.
//
// KNOWN best-effort degrades (documented, accepted):
//   * HANDLER / PROJECTOR edges are NOT emitted. An event handler/projector reacts to
//     EVENTS by name (`@events [...]` / pattern-matched `handle/2` heads), not to a
//     cleanly-named in-repo module, so there is no unambiguous module reference to
//     turn into an edge without inventing a fuzzy one. Roles-only for handlers /
//     projectors is deliberate (the same stance Oban/Broadway take for their
//     roles-only surfaces) — the dispatch spine is the structural backbone.
//   * A bare `to:` reference the router's `alias` block doesn't cover resolves only via
//     the safety-net when its last segment is UNIQUE across the in-repo modules; a
//     genuinely ambiguous short name degrades rather than guess.
//   * A partially-qualified alias (`to: Aggregates.Account`) that the exact registry
//     can't place degrades (it has a dot, so the bare last-segment fallback is skipped).
//
// NOTE: Grouping is intentionally NOT contributed. Commanded has no clean per-domain
// structural unit the way a Phoenix context (`lib/app/<context>/`) or a NestJS
// @Module does — aggregates, routers, handlers and projectors are scattered by the
// host app's own directory convention. Contributing single-file groups would only
// fragment the host framework's grouping, so this adapter stays roles-+-edges-only
// (mirrors Oban / Broadway's stance).

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

/** The deterministic Commanded signal set (dependency names only). */
export interface CommandedSignals {
  hasCommanded: boolean; // commanded — the authoritative signal
  hasCommandedExtension: boolean; // commanded_ecto_projections / commanded_* — supporting
}

/** Decide the signal set from a dependency-name set (pure). */
function commandedSignalsFromDeps(deps: Set<string>): CommandedSignals {
  return {
    hasCommanded: deps.has('commanded'),
    // A `commanded_*` companion (Ecto projections, an EventStore adapter) is a strong
    // secondary signal this really is a Commanded deployment (vs. transitively pulled).
    hasCommandedExtension: [...deps].some((d) => d !== 'commanded' && d.startsWith('commanded_')),
  };
}

/** Gather the signal set for a single root dir (reads mix manifests only). */
export function gatherCommandedSignals(baseDir: string): CommandedSignals {
  return commandedSignalsFromDeps(readMixDeps(baseDir));
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
 * Decide Commanded from the signal set. `commanded` is REQUIRED; a `commanded_*`
 * companion raises confidence. Returns null → generic-Elixir fallthrough, byte-for-
 * byte unchanged.
 */
export function scoreCommanded(s: CommandedSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasCommanded) return null;
  let confidence = 0.8;
  if (s.hasCommandedExtension) confidence += 0.1;
  return {
    adapter: 'commanded',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: { commanded: s.hasCommanded, commandedExtension: s.hasCommandedExtension },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind` is
// unchanged. An aggregate is own domain-decision code → service; a command router is
// the request-side entry → gateway; an event handler / projector is own-code driven
// by an event stream (not a request) → job.
export type CommandedRole = 'aggregate' | 'command-router' | 'event-handler' | 'projector';

// Collapse priority when one FILE carries several roles, AND downstream when several
// files of different roles land in one MODULE after clustering (the contribute-step
// keeps the highest). The `use`-based roles (router / event-handler / projector) all
// outrank the aggregate execute+apply HEURISTIC, so a file that both `use`s a
// Commanded behaviour and happens to define execute+apply resolves to the explicit
// behaviour role.
const ROLE_PRIORITY: Record<CommandedRole, number> = {
  'command-router': 8,
  projector: 6,
  'event-handler': 5,
  aggregate: 3,
};
const ROLE_KIND: Record<CommandedRole, ModuleKind> = {
  aggregate: 'service',
  'command-router': 'gateway',
  'event-handler': 'job',
  projector: 'job',
};

// The `use <Module>` targets that identify a Commanded role by behaviour injection.
const USE_ROLE: Record<string, CommandedRole> = {
  'Commanded.Aggregates.Aggregate': 'aggregate',
  'Commanded.Commands.Router': 'command-router',
  'Commanded.Event.Handler': 'event-handler',
  'Commanded.Projections.Ecto': 'projector',
};

// A `dispatch …, to: <Aggregate>` target — the module named after the `to:` keyword.
// `\b` keeps `into:` / `unto:` from matching; the keyword-position guard (`^` OR a
// preceding comma) keeps prose in a @moduledoc from matching. Applied per source line
// so a multi-line dispatch (the wrapped `to:` on its own continuation line) is caught.
const DISPATCH_TO_RE = /(?:^|,)\s*to:\s*([A-Z][A-Za-z0-9_.]*)/g;

// The `def execute` + `def apply` pair that marks an aggregate by convention (the
// command/event protocol). PUBLIC defs only — a `defp` helper named execute/apply is
// not the protocol.
const AGG_EXECUTE = 'execute';
const AGG_APPLY = 'apply';

function lastSegment(mod: string): string {
  const i = mod.lastIndexOf('.');
  return i >= 0 ? mod.slice(i + 1) : mod;
}

// The Commanded roles a file's `use` directives imply (multi-line option lists are
// already joined by the shared useDirectives accessor).
function useRoles(parsed: ParsedElixirFile): CommandedRole[] {
  const out: CommandedRole[] = [];
  for (const u of parsed.uses) {
    const role = USE_ROLE[u.module];
    if (role) out.push(role);
  }
  return out;
}

// A module defining BOTH a public `def execute` AND a public `def apply` — the
// aggregate command/event protocol (the common form that never `use`s the behaviour).
function hasExecuteAndApply(parsed: ParsedElixirFile): boolean {
  let execute = false;
  let apply = false;
  for (const d of parsed.defs) {
    if (d.kind !== 'def') continue; // public defs only
    if (d.name === AGG_EXECUTE) execute = true;
    else if (d.name === AGG_APPLY) apply = true;
  }
  return execute && apply;
}

// ---------------------------------------------------------------------------
// Analysis.

interface CommandedAnalysis {
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface CommandedDiag {
  /** `to:` targets that named no in-repo module (external/unknown aggregate). */
  unresolvedTargets: Set<string>;
  /** bare `to:` targets whose last segment matched ≥2 in-repo modules — not guessed. */
  ambiguousTargets: Set<string>;
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so syntheticEdges + roleTags
// share ONE parse, while the merge walk's per-checkpoint ctx gets a fresh analysis —
// no cross-tree staleness. Mirrors phoenix / ecto / oban.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, CommandedAnalysis>();

function addRole(map: Map<string, CommandedRole>, fileId: string, role: CommandedRole): void {
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
  if (from === to) return; // a router dispatching to an aggregate defined in itself → no edge
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, {
      source: from,
      target: to,
      kind: 'calls',
      metadata: { framework: 'commanded', relation },
    });
  }
}

function analyzeCommanded(ctx: FrameworkContext): CommandedAnalysis {
  const scope = parseElixirScope(ctx);
  const diag: CommandedDiag = { unresolvedTargets: new Set(), ambiguousTargets: new Set() };

  // Pass 1 — roles + router discovery. A file's `use` directives (router / handler /
  // projector / aggregate-by-behaviour) are recorded; the execute+apply heuristic adds
  // the aggregate role (lower priority, so a `use`-based role wins a same-file tie).
  const roleByFile = new Map<string, CommandedRole>();
  const routerFiles: string[] = [];
  for (const [id, parsed] of scope.parsed) {
    let isRouter = false;
    for (const role of useRoles(parsed)) {
      addRole(roleByFile, id, role);
      if (role === 'command-router') isRouter = true;
    }
    if (hasExecuteAndApply(parsed)) addRole(roleByFile, id, 'aggregate');
    if (isRouter) routerFiles.push(id);
  }
  routerFiles.sort();

  // A repo-wide last-segment → defining-file(s) index, the guarded SAFETY-NET fallback
  // for a bare `to:` token the router's own alias block didn't cover (a scanner-missed
  // alias). A non-unique last segment is left AMBIGUOUS (not guessed).
  const filesByLastSeg = new Map<string, Set<string>>();
  for (const [id, parsed] of scope.parsed) {
    for (const mod of parsed.modules) {
      const seg = lastSegment(mod);
      (filesByLastSeg.get(seg) ?? filesByLastSeg.set(seg, new Set()).get(seg)!).add(id);
    }
  }

  // A router file's OWN `alias` directives → short-name → fully-qualified module (the
  // precise, compile-accurate binding for a bare `to:` target, the way Elixir resolves
  // it — mirrors the Phoenix adapter's scope-alias handling). `alias A.B.{X, Y}` is
  // already expanded to `A.B.X`/`A.B.Y` by the shared directive scanner. Two aliases
  // sharing a last segment (a real Elixir ambiguity) map to null so we don't guess.
  function buildAliasMap(parsed: ParsedElixirFile): Map<string, string | null> {
    const map = new Map<string, string | null>();
    for (const d of parsed.directives) {
      if (d.keyword !== 'alias') continue;
      for (const full of d.targets) {
        const seg = lastSegment(full);
        if (!map.has(seg)) map.set(seg, full);
        else if (map.get(seg) !== full) map.set(seg, null); // conflicting alias → ambiguous
      }
    }
    return map;
  }

  // Resolve a `to:` module token to its defining file id, precise-first:
  //   1. fully-qualified (`MyApp.Bank.Aggregates.Account`) → the shared registry.
  //   2. the ROUTER'S OWN alias for the short name → its full module → the registry.
  //   3. a top-level module named exactly the bare token → the registry.
  //   4. the guarded UNIQUE last-segment safety-net (≥2 candidates ⇒ ambiguous).
  type Resolution = { file: string } | { degrade: 'unresolved' | 'ambiguous' };
  function resolveTarget(token: string, aliasByLast: Map<string, string | null>): Resolution {
    if (token.includes('.')) {
      const direct = scope.resolve(token);
      return direct ? { file: direct } : { degrade: 'unresolved' };
    }
    if (aliasByLast.has(token)) {
      const full = aliasByLast.get(token);
      if (full == null) return { degrade: 'ambiguous' }; // conflicting aliases in the router
      const hit = scope.resolve(full);
      return hit ? { file: hit } : { degrade: 'unresolved' }; // aliases an external/unknown module
    }
    const top = scope.resolve(token);
    if (top) return { file: top };
    const candidates = filesByLastSeg.get(token);
    if (!candidates || candidates.size === 0) return { degrade: 'unresolved' };
    if (candidates.size > 1) return { degrade: 'ambiguous' };
    return { file: [...candidates][0] };
  }

  // Pass 2 — the dispatch spine. Each router file's `to:` targets → a `calls` edge.
  const edges = new Map<string, FrameworkEdge>();
  for (const routerFile of routerFiles) {
    const parsed = scope.parsed.get(routerFile)!;
    const aliasByLast = buildAliasMap(parsed);
    const seen = new Set<string>();
    for (const raw of sourceLines(parsed.text)) {
      // Skip module-attribute + comment lines (a `@moduledoc "… to: Foo …"` or a
      // commented-out `# dispatch …, to: Foo` must never seed a false edge). Strip a
      // trailing inline comment so `dispatch X, to: Y  # to: Old` can't double-match.
      if (/^\s*[@#]/.test(raw)) continue;
      const ln = raw.replace(/#.*$/, '');
      for (const m of ln.matchAll(DISPATCH_TO_RE)) {
        const token = m[1];
        if (seen.has(token)) continue;
        seen.add(token);
        const res = resolveTarget(token, aliasByLast);
        if ('file' in res) {
          addEdge(edges, routerFile, res.file, 'dispatch');
        } else if (res.degrade === 'ambiguous') {
          diag.ambiguousTargets.add(`${routerFile}: dispatch to ${token}`);
        } else {
          diag.unresolvedTargets.add(`${routerFile}: dispatch to ${token}`);
        }
      }
    }
  }

  const roles = new Map<string, RoleTag>();
  for (const fileId of [...roleByFile.keys()].sort()) {
    const role = roleByFile.get(fileId)!;
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'commanded' },
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

  const roleCounts = { aggregate: 0, 'command-router': 0, 'event-handler': 0, projector: 0 };
  for (const role of roleByFile.values()) roleCounts[role]++;

  // Positive signal for validation (mirrors phoenix / ecto / oban's log line).
  if (roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [commanded] ${roleCounts.aggregate} aggregate(s) · ${roleCounts['command-router']} router(s) · ` +
        `${roleCounts['event-handler']} handler(s) · ${roleCounts.projector} projector(s) · ` +
        `${sortedEdges.length} dispatch edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  const degraded: string[] = [];
  if (diag.unresolvedTargets.size > 0)
    degraded.push(
      `${diag.unresolvedTargets.size} unresolvable dispatch target(s): ` +
        `${[...diag.unresolvedTargets].sort().slice(0, 10).join(' · ')}`,
    );
  if (diag.ambiguousTargets.size > 0)
    degraded.push(
      `${diag.ambiguousTargets.size} ambiguous dispatch target(s) (last segment not unique, not guessed): ` +
        `${[...diag.ambiguousTargets].sort().slice(0, 10).join(' · ')}`,
    );
  if (degraded.length > 0) {
    console.log(`  [commanded] degraded: ${degraded.join(' · ')} (logged, not silently dropped)`);
  }

  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): CommandedAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeCommanded(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter. Roles + edges only — no groupingPrior (Commanded has no clean
// per-domain structural unit; see the file header).

export const commandedAdapter: FrameworkAdapter = {
  name: 'commanded',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose mix.exs is at root → rootPath '').
    const rootMatch = scoreCommanded(gatherCommandedSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // Nested app (`backend/mix.exs`) — a shallow scan of immediate subdirs, scoping
    // the adapter to the first match. Only when NOT already scoped to a workspace
    // package (that's the per-package fan-out).
    if (!ctx.packageDir) {
      for (const sub of shallowMixSubdirs(base)) {
        const m = scoreCommanded(gatherCommandedSignals(join(base, sub)), sub);
        if (m) return m;
      }
      // Repo-wide fallback (FIRES ONLY after root + shallow miss) — a deeply-nested
      // Elixir umbrella in a polyglot monorepo (`elixir/apps/*/mix.exs`, the Firezone
      // shape) that the depth-1 shallow scan can't see. Union every mix.exs's deps
      // across the repo; if `commanded` is declared anywhere, detect with rootPath ''
      // (the hooks scan ALL in-scope Elixir files). One bounded walk; manifests only,
      // never source content.
      const deep = scoreCommanded(commandedSignalsFromDeps(readMixDepsDeep(ctx.repoDir)), '');
      if (deep) return deep;
    }
    return null;
  },

  // The dispatch spine — a router's `dispatch …, to: <Aggregate>` → aggregate file
  // (kind 'calls'). File-id endpoints; the step resolves to modules, drops self-edges,
  // dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // aggregate → service; command-router → gateway; event-handler / projector → job.
  // METADATA; the module's `kind` is unchanged.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE (Elixir). Declare the paths the diff-driven hosted walk must
  // treat as framework-relevant. Never-store-source holds: parse server-side, persist
  // only the derived edges/roles.
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
