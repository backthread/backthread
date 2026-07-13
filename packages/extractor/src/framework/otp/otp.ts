// The OTP FrameworkAdapter (runtime / supervision) — the highest-value Elixir-specific
// signal: the SUPERVISION TREE is the architecture of a running Elixir system, and the
// import graph never names it (a supervisor doesn't `alias` its children — it lists
// them in a runtime child spec). Built on the shared Elixir framework-analysis layer
// (framework/elixir/{analyze,elixir-ast}.ts) like the Phoenix/Ecto adapters.
//
// OTP is DEP-LESS (Supervisor/Application ship with Elixir/OTP), so there is no mix dep
// to gate on. Instead detect() reads the CHEAP MANIFEST signal every runnable Elixir
// app carries and a pure library lacks: the Mix `application/0` `mod: {App.Application,
// []}` callback (graph/elixir-manifest.ts, never eval mix.exs). parseElixirScope
// pre-scans every in-scope file ONCE and the two hooks share that pass:
//
//   * roleTags        — a module that `use Application` → role 'application'; one that
//                       `use Supervisor` / `use DynamicSupervisor` → role 'supervisor'.
//                       BOTH map onto the LOCKED `service` MODULE_KIND (own runtime
//                       code that owns a supervision subtree — never a new kind). The
//                       finer role renders via metadata.
//   * syntheticEdges  — THE SUPERVISION SPINE: in each application/supervisor file, the
//                       child spec list (`children = [ ... ]`, or an inline
//                       `Supervisor.start_link([ ... ], _)` / `Supervisor.init([ ... ],
//                       _)`) is parsed; each child (`Mod`, `{Mod, arg}`,
//                       `Supervisor.child_spec({Mod, arg})`) names a module, resolved
//                       through the module registry → a `calls` edge supervisor-file →
//                       child-file (metadata relation 'supervises'). The application
//                       module's list is the tree ROOT (application → top supervisor →
//                       workers). 'calls' is the neutral 8-verb verb (a supervision
//                       relationship isn't a data flow; mirrors Ecto's association edge
//                       stance).
//
// Accuracy over recall (a wrong edge teaches a false mental model): only children that
// resolve to an in-repo module become edges. External children (`Phoenix.PubSub`,
// `Finch`, `DNSCluster`) are the common case and drop SILENTLY (they have no internal
// edge — not a degrade). A child token whose top namespace IS internal but doesn't
// resolve is LOGGED (a genuine miss). Dynamic children (a runtime-computed module, a
// bare `%{...}` map spec with no literal module) yield no token → dropped. Everything
// deterministic (sorted outputs, ids from paths/names; run-twice byte-identical).
//
// KNOWN best-effort degrades (documented, accepted):
//   * Child specs are read only from application/supervisor ROLE files — a bare
//     `Supervisor.start_link` in a plain module (no `use`) is not a source.
//   * A DynamicSupervisor adds children at runtime (no static list) → role only, no
//     edges.
//   * A `%{id: _, start: {Mod, _, _}}` map child resolves via its FIRST module token
//     (usually the id/module), which is the right child in the common case.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import {
  mixDeclaresApplicationMod,
  mixDeclaresApplicationModDeep,
} from '../../graph/elixir-manifest.js';
import { sourceLines, topNamespace } from '../../graph/elixir-scan.js';
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
// Detection (mix.exs `application/0` `mod:` callback; PURE, manifest-only).

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

/** Immediate subdirs (depth 1) holding a `mix.exs` — the nested-app shallow search. */
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

/** An OTP match for a root that declares an `application/0` `mod:` callback. */
function otpMatch(rootPath: string): DetectMatch {
  return {
    adapter: 'otp',
    confidence: clampConfidence(0.75), // a manifest signal (no dep to strengthen it)
    rootPath,
    metadata: { signal: 'application-mod-callback' },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → the LOCKED `service` MODULE_KIND. An application/supervisor is own
// runtime code owning a supervision subtree — service altitude, never a new kind. The
// application (tree root) outranks a plain supervisor when one file is both.
export type OtpRole = 'application' | 'supervisor';

const ROLE_PRIORITY: Record<OtpRole, number> = { application: 4, supervisor: 3 };
const ROLE_KIND: Record<OtpRole, ModuleKind> = { application: 'service', supervisor: 'service' };

// The `use` targets that identify OTP roles.
const APPLICATION_USE = 'Application';
const SUPERVISOR_USES = new Set(['Supervisor', 'DynamicSupervisor']);

// ---------------------------------------------------------------------------
// Child-spec parsing.
//
// The child spec is what a supervisor lists as `children` and hands to
// `Supervisor.start_link(children, _)` / `Supervisor.init(children, _)`. Two shapes:
//   * a named build:  `children = <expr>`, where <expr> is often a COMPOSITION —
//     `if ... do [] else [...] end ++ [...]` (the idiomatic Livebook/Plausible form) —
//     so we take EVERY top-level list literal between `children =` and the
//     start_link/init that consumes it, not just a list glued to the `=`.
//   * an inline list: `Supervisor.start_link([...], _)` / `Supervisor.init([...], _)`.
// A child module is the first POSITIONAL (non-`key:`) module of its element (`Mod`,
// `{Mod, _}`, `Supervisor.child_spec({Mod, _})`, a `warmed_cache(Mod, _)` spec-builder
// helper); an element leading with a lowercase var/atom or `%{...}` map (a
// runtime-computed child) yields no module → dropped. Skipping keyword-VALUE modules is
// what keeps an option value (`{module, name: MyApp.ZTA}` → the child is the var
// `module`, NOT `MyApp.ZTA`) from becoming a false edge — accuracy over recall.

// A `children =` assignment head (not `==`). Anchors the named-build span.
const CHILDREN_ASSIGN_RE = /\bchildren\s*=(?!=)/g;
// The Supervisor.start_link/init call that CONSUMES the child spec (ends the span).
const SUPERVISOR_CALL_RE = /\bSupervisor\.(?:start_link|init)\(/;
// An inline child list passed straight to the supervisor.
const INLINE_LIST_RE = /\bSupervisor\.(?:start_link|init)\(\s*\[/g;

/** Strip string/charlist literals + a trailing `#` comment from one physical line. */
function stripLine(line: string): string {
  let s = line.replace(/"(?:[^"\\]|\\.)*"/g, '  ').replace(/'(?:[^'\\]|\\.)*'/g, '  ');
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  return s;
}

/**
 * The inner text of the bracket opened at `openIdx` (`s[openIdx] === '['`), matched by
 * `[`/`]` depth (a `]` only ever closes a `[`, so nested `{}`/`()` are transparent).
 * Undefined if unbalanced (a truncated read).
 */
function balancedBracket(s: string, openIdx: number): string | undefined {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') {
      depth--;
      if (depth === 0) return s.slice(openIdx + 1, i);
    }
  }
  return undefined;
}

/** Split a list body at TOP-LEVEL commas (respecting `{}`/`[]`/`()` nesting). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// A module token, optionally preceded by a `key:` keyword marker (group 1). When group
// 1 is present the module is a keyword-OPTION VALUE (`name: Some.Mod`), never the child.
const CHILD_TOKEN_RE = /([a-z_][A-Za-z0-9_]*:\s*)?([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)/g;

/**
 * The child MODULE of one list element — the first module token in a POSITIONAL (not
 * keyword-value) position:
 *   * `Mod`                                    → Mod
 *   * `{Mod, opt: X}`                          → Mod (the tuple head)
 *   * `Supervisor.child_spec({Mod, _}, _)`     → Mod (the OTP helper's first arg)
 *   * `warmed_cache(Mod, opt: X)`              → Mod (a spec-builder helper's subject)
 *   * `{var, name: App.ZTA}`                   → undefined (child is the runtime `var`;
 *                                                 App.ZTA is only an option VALUE)
 *   * `%{id: _, start: {M, _, _}}` / a bare atom → undefined (no positional module)
 * Skipping keyword-value modules is what keeps an option value from becoming a false
 * supervision edge — accuracy over recall.
 */
function childModuleOf(element: string): string | undefined {
  let e = element.trim();
  // `Supervisor.child_spec({Mod, _}, _)` — the OTP helper; the child is its FIRST arg
  // (a plain `Mod.child_spec(:atom, _)` is left alone — there Mod itself is the child).
  const sup = e.match(/^Supervisor\.child_spec\(\s*(.*)$/);
  if (sup) e = sup[1].trim();
  // Unwrap a leading tuple brace so `{Mod, …}`'s Mod is positional.
  if (e.startsWith('{')) e = e.slice(1);
  for (const m of e.matchAll(CHILD_TOKEN_RE)) {
    if (m[1]) continue; // preceded by `key:` → an option value, not the child
    return m[2];
  }
  return undefined;
}

/** Every TOP-LEVEL `[...]` list body within [start,end) — one per list, each once. */
function collectTopLevelLists(s: string, start: number, end: number, claimed: Set<number>): string[] {
  const lists: string[] = [];
  let depth = 0; // over {} () — so a `[` inside a tuple/map/call is NOT a top-level list
  let i = start;
  while (i < end) {
    const c = s[i];
    if (c === '{' || c === '(') {
      depth++;
      i++;
    } else if (c === '}' || c === ')') {
      depth--;
      i++;
    } else if (c === '[' && depth === 0) {
      const inner = balancedBracket(s, i);
      if (inner === undefined) break;
      if (!claimed.has(i)) {
        claimed.add(i);
        lists.push(inner);
      }
      i += inner.length + 2; // past this list's `]`
    } else {
      i++;
    }
  }
  return lists;
}

function addChildren(listInner: string, out: string[]): void {
  for (const el of splitTopLevel(listInner)) {
    const child = childModuleOf(el);
    if (child) out.push(child);
  }
}

/** Every child module token referenced by the file's supervision child specs. */
function extractChildModules(text: string): string[] {
  const cleaned = sourceLines(text).map(stripLine).join('\n');
  const out: string[] = [];
  const claimed = new Set<number>(); // list-open positions already consumed

  // (A) Named builds: each `children = <expr>` up to the start_link/init that consumes
  // it. Every top-level list literal in that span contributes (composition-aware).
  for (const am of cleaned.matchAll(CHILDREN_ASSIGN_RE)) {
    const start = am.index! + am[0].length;
    const rel = cleaned.slice(start).search(SUPERVISOR_CALL_RE);
    const end = rel === -1 ? start : start + rel;
    if (end > start) {
      for (const inner of collectTopLevelLists(cleaned, start, end, claimed)) addChildren(inner, out);
    }
  }

  // (B) Inline lists passed straight to the supervisor (no `children` var).
  for (const m of cleaned.matchAll(INLINE_LIST_RE)) {
    const openIdx = m.index! + m[0].length - 1;
    if (claimed.has(openIdx)) continue;
    const inner = balancedBracket(cleaned, openIdx);
    if (inner !== undefined) {
      claimed.add(openIdx);
      addChildren(inner, out);
    }
  }
  return out;
}

// Robust `use`-target membership (reads the directive scan so a wrapped multi-line
// `use Supervisor,\n  restart: :temporary` option list is still caught).
function usesAnyModule(parsed: ParsedElixirFile, names: (n: string) => boolean): boolean {
  return parsed.directives.some((d) => d.keyword === 'use' && d.targets.some(names));
}

function otpRole(parsed: ParsedElixirFile): OtpRole | undefined {
  if (usesAnyModule(parsed, (n) => n === APPLICATION_USE)) return 'application';
  if (usesAnyModule(parsed, (n) => SUPERVISOR_USES.has(n))) return 'supervisor';
  return undefined;
}

// ---------------------------------------------------------------------------
// Analysis.

interface OtpAnalysis {
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface OtpDiag {
  /** internal-looking child modules we couldn't map to a first-party file. */
  unresolved: Set<string>;
}

// Memoized on the FrameworkContext OBJECT so syntheticEdges + roleTags share ONE parse,
// while the merge walk's per-checkpoint ctx gets a fresh analysis. Mirrors phoenix/ecto.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, OtpAnalysis>();

function addRole(map: Map<string, OtpRole>, fileId: string, role: OtpRole): void {
  const cur = map.get(fileId);
  if (cur === undefined || ROLE_PRIORITY[role] > ROLE_PRIORITY[cur]) map.set(fileId, role);
}

function addEdge(edges: Map<string, FrameworkEdge>, from: string, to: string): void {
  if (from === to) return; // a supervisor listing itself → no self-edge
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, {
      source: from,
      target: to,
      kind: 'calls',
      metadata: { framework: 'otp', relation: 'supervises' },
    });
  }
}

function analyzeOtp(ctx: FrameworkContext): OtpAnalysis {
  const scope = parseElixirScope(ctx);
  const diag: OtpDiag = { unresolved: new Set() };

  // Pass 1 — application / supervisor roles.
  const roleByFile = new Map<string, OtpRole>();
  for (const [id, parsed] of scope.parsed) {
    const role = otpRole(parsed);
    if (role) addRole(roleByFile, id, role);
  }

  // The internal top-namespaces, so an unresolved-but-internal child (a genuine miss)
  // is logged while an external child (Phoenix.PubSub, Finch) drops silently.
  const internalTops = new Set<string>();
  for (const mod of scope.moduleIndex.keys()) internalTops.add(topNamespace(mod));

  // Pass 2 — the supervision spine, from each application/supervisor file's child specs.
  // A DynamicSupervisor (children added at runtime) simply has no child list → no edges.
  const edges = new Map<string, FrameworkEdge>();
  for (const [id] of roleByFile) {
    const parsed = scope.parsed.get(id);
    if (!parsed) continue;
    for (const childToken of extractChildModules(parsed.text)) {
      const target = scope.resolve(childToken);
      if (target) addEdge(edges, id, target);
      else if (internalTops.has(topNamespace(childToken))) diag.unresolved.add(`${id}: ${childToken}`);
      // else external child — expected drop, silent.
    }
  }

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'otp' },
    });
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  // Positive signal for validation (mirrors phoenix / ecto).
  const appCount = [...roleByFile.values()].filter((r) => r === 'application').length;
  const supCount = [...roleByFile.values()].filter((r) => r === 'supervisor').length;
  if (roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [otp] ${appCount} application(s) · ${supCount} supervisor(s) · ${sortedEdges.length} supervision edge(s)`,
    );
  }
  // No silent caps (locked): log every internal-looking child we couldn't resolve.
  if (diag.unresolved.size > 0) {
    console.log(
      `  [otp] degraded: ${diag.unresolved.size} unresolvable internal child(ren): ` +
        `${[...diag.unresolved].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`,
    );
  }

  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): OtpAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeOtp(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter. Roles + supervision edges only — no groupingPrior (a supervision tree
// cuts ACROSS domains; it's a wiring spine, not a per-domain unit, so worker/supervisor
// files stay in the host framework's / directory grouping — mirrors Oban's stance).

export const otpAdapter: FrameworkAdapter = {
  name: 'otp',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose mix.exs is at root → rootPath '').
    if (mixDeclaresApplicationMod(base)) return otpMatch(rootPath);
    // Nested app (`backend/mix.exs`) — a shallow scan of immediate subdirs. Only when
    // NOT already scoped to a workspace package (that's the per-package fan-out).
    if (!ctx.packageDir) {
      for (const sub of shallowMixSubdirs(base)) {
        if (mixDeclaresApplicationMod(join(base, sub))) return otpMatch(sub);
      }
      // Repo-wide fallback (FIRES ONLY after root + shallow miss) — a deeply-nested
      // umbrella child (`elixir/apps/web/mix.exs`) declaring the app callback. One
      // bounded walk; manifests only, never source content.
      if (mixDeclaresApplicationModDeep(ctx.repoDir)) return otpMatch('');
    }
    return null;
  },

  // The supervision spine — each application/supervisor's child specs → child files
  // (kind 'calls', relation 'supervises'). File-id endpoints; the step resolves to
  // modules, drops self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // `use Application` → role 'application'; `use Supervisor`/`use DynamicSupervisor` →
  // role 'supervisor'. BOTH on the LOCKED `service` kind. METADATA; kind is unchanged.
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
