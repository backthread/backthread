// The Phoenix FrameworkAdapter — the FIRST Elixir framework adapter, built on the
// shared Elixir framework-analysis layer (framework/elixir/{analyze,elixir-ast}.ts)
// the same way the Python fleet is built on framework/python/. Net-new; detects
// against mix.exs / mix.lock (the `phoenix` dep), NOT package.json.
//
// Phoenix DECLARES its web surface structurally, which we read STATICALLY
// (install-free, never-store-source — parse server-side, persist only the derived
// groups/edges/roles) via the hand-rolled Elixir scanner (no WASM, never executes
// repo code). parseElixirScope pre-scans every in-scope file ONCE (modules / use
// directives / macro calls) and the three hooks share that one pass:
//
//   * detect()        — the `phoenix` dependency (a small bump for phoenix_live_view).
//                       Shallow nested-app detection too (a `backend/mix.exs`).
//   * groupingPrior   — THE HEADLINE: each Phoenix CONTEXT (a domain dir under
//                       `lib/<app>/<context>/`, NOT the `lib/<app>_web/` tree)
//                       becomes its own subsystem, so a flat `lib/<app>/` folder
//                       splits into per-domain subsystems (Accounts / Billing /
//                       Stats). Same mechanism the Django-app / Nest-@Module priors
//                       use: the contribute-step makes each group its own subsystem,
//                       authoritative over the directory heuristic. The web tree +
//                       scattered top-level files are left to directory grouping.
//   * syntheticEdges  — THE ROUTER ROUTE SPINE: a router module's
//                       get/post/put/patch/delete/head/options/live/forward/resources
//                       macro calls each name a controller / LiveView module, resolved
//                       through the module registry (best-effort across `scope`
//                       alias blocks) → a `calls` edge router-file → controller/live-
//                       file. This is the wiring the import graph never names as a
//                       verb (a router `alias`es its controllers, but the route→handler
//                       dispatch is a macro, not an import).
//   * roleTags        — Endpoint / Router / Controller / Channel → `gateway`;
//                       LiveView / LiveComponent → `frontend`; a context module →
//                       `service` (role 'context'). Read from each file's `use`
//                       directives (the `use <App>Web, :controller` convention passes
//                       the role as an atom arg; the direct `use Phoenix.X` forms are
//                       supported too). METADATA onto the LOCKED MODULE_KINDS enum;
//                       never a new kind (the module's `kind` is unchanged — only
//                       `role` is rendered).
//
// Unresolvable route targets (an external plug, an aliased name we can't place)
// DEGRADE + LOG — no silent caps. Everything is deterministic (sorted outputs, ids
// derived from paths/names, lexical tiebreaks; run-twice is byte-identical).
//
// KNOWN best-effort degrade (documented, accepted): route→handler resolution
// flattens `scope` nesting — a line-oriented scan can't bind a route to its exact
// enclosing scope, so the adapter tries the file's scope-alias prefixes
// LONGEST-first + the web namespace. This resolves the common case (one alias per
// controller name) exactly; a short controller name defined under TWO different
// scope aliases resolves to the longer/lexically-first prefix (deterministic, but
// may mis-attribute in that rare case). Never throws.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readMixDeps, readMixDepsDeep } from '../../graph/elixir-manifest.js';
import { parseElixirScope, type ParsedElixirFile } from '../elixir/analyze.js';
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
// Detection (mix.exs/mix.lock → deps; PURE scorer). Never reads source content.

/** The deterministic Phoenix signal set (dependency names only). */
export interface PhoenixSignals {
  hasPhoenix: boolean; // phoenix — the authoritative signal
  hasLiveView: boolean; // phoenix_live_view — raises confidence (supporting)
}

/** Decide the signal set from a dependency-name set (pure). */
function phoenixSignalsFromDeps(deps: Set<string>): PhoenixSignals {
  return {
    hasPhoenix: deps.has('phoenix'),
    hasLiveView: deps.has('phoenix_live_view'),
  };
}

/** Gather the signal set for a single root dir (reads mix manifests only). */
export function gatherPhoenixSignals(baseDir: string): PhoenixSignals {
  return phoenixSignalsFromDeps(readMixDeps(baseDir));
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
 * nested Elixir/Phoenix app (`backend/` | `server/` in a polyglot monorepo).
 * Sorted, so the first-match pick is deterministic; skips dot-dirs + build dirs to
 * stay cheap. (An umbrella's root mix.lock already carries every child's deps, so a
 * root scan usually suffices; this is the not-at-root monorepo case.)
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
 * Decide Phoenix from the signal set. `phoenix` is REQUIRED (a plain Elixir/Ecto
 * app is not Phoenix — don't claim it); phoenix_live_view raises confidence.
 * Returns null → generic-Elixir fallthrough, byte-for-byte unchanged.
 */
export function scorePhoenix(s: PhoenixSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasPhoenix) return null;
  let confidence = 0.85;
  if (s.hasLiveView) confidence += 0.05;
  return {
    adapter: 'phoenix',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: { phoenix: s.hasPhoenix, phoenix_live_view: s.hasLiveView },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind`
// is unchanged. Endpoint/Router/Controller/Channel are request entries → gateway;
// LiveView/LiveComponent render UI → frontend; a context module is own-code domain
// logic → service.
export type PhoenixRole =
  | 'endpoint'
  | 'router'
  | 'controller'
  | 'channel'
  | 'live-view'
  | 'live-component'
  | 'context';

// Collapse priority when one FILE carries several roles, AND downstream when
// several files of different roles land in one MODULE after clustering (the
// contribute-step keeps the highest). A specific web role always outranks the
// broad 'context' service tag.
const ROLE_PRIORITY: Record<PhoenixRole, number> = {
  endpoint: 9,
  router: 8,
  controller: 7,
  channel: 6,
  'live-view': 5,
  'live-component': 4,
  context: 2,
};
const ROLE_KIND: Record<PhoenixRole, ModuleKind> = {
  endpoint: 'gateway',
  router: 'gateway',
  controller: 'gateway',
  channel: 'gateway',
  'live-view': 'frontend',
  'live-component': 'frontend',
  context: 'service',
};

// The `use Phoenix.X` DIRECT forms → role.
const DIRECT_USE_ROLE: Record<string, PhoenixRole> = {
  'Phoenix.Endpoint': 'endpoint',
  'Phoenix.Router': 'router',
  'Phoenix.Controller': 'controller',
  'Phoenix.Channel': 'channel',
  'Phoenix.LiveView': 'live-view',
  'Phoenix.LiveComponent': 'live-component',
};

// The `use <App>Web, :atom` convention → role. The web module's `__using__/1`
// dispatches on this atom (`def controller`, `def live_view`, …).
const ATOM_USE_ROLE: Record<string, PhoenixRole> = {
  endpoint: 'endpoint',
  router: 'router',
  controller: 'controller',
  channel: 'channel',
  live_view: 'live-view',
  live_component: 'live-component',
};

// The Ecto-schema `use` — a context-dir file that IS a schema is NOT tagged
// 'context' (it's data; the Ecto data adapter owns its role).
const ECTO_SCHEMA_USE = 'Ecto.Schema';

// Router macro calls that name a controller / LiveView module (the route spine).
// `head`/`options`/`resources` ride the same arg shape as the spec's core set.
const ROUTE_MACROS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'live',
  'forward',
  'resources',
]);

// ---------------------------------------------------------------------------
// String / name helpers.

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

// The leading bare atom of a `use` arg tail (`:controller` → 'controller';
// `queue: :mailers` → undefined — that's a keyword list, not a role atom).
function leadingAtom(args: string): string | undefined {
  const m = args.trim().match(/^:([a-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : undefined;
}

// The FIRST module reference (`Foo` / `Foo.Bar.Baz`) in a macro-arg string, after
// stripping string/charlist literals (a route PATH is a string and comes first, so
// the first PascalCase dotted token is the controller/LiveView/scope-alias module).
function firstModuleToken(args: string): string | undefined {
  const stripped = args.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  const m = stripped.match(/[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*/);
  return m ? m[0] : undefined;
}

// The web namespace of a router module: drop its last segment
// (`MyAppWeb.Router` → `MyAppWeb`). Undefined for a bare, dot-less module.
function webNamespace(routerModule: string | undefined): string | undefined {
  if (!routerModule) return undefined;
  const idx = routerModule.lastIndexOf('.');
  return idx > 0 ? routerModule.slice(0, idx) : undefined;
}

// snake_case path segment → PascalCase module segment (`plausible_web` →
// `PlausibleWeb`, `google_analytics` → `GoogleAnalytics`).
function camelize(seg: string): string {
  return seg
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function isTemplateFile(fileId: string): boolean {
  return fileId.endsWith('.heex') || fileId.endsWith('.eex') || fileId.endsWith('.leex');
}

// The candidate owning module(s) for a template file, ordered by likelihood. Two
// conventions: the legacy `<web>/templates/<resource>/<file>` (Phoenix.View →
// `<Web>.<Resource>View`) and the modern colocated `<web>/…/<resource>_html/<file>`
// (`<Web>.<Resource>HTML`). A template is owned by a VIEW/HTML module, NEVER a
// Controller — so Controller is deliberately excluded (no controller→template false
// edge). Deterministic + registry-resolved; unresolved → dropped.
function templateOwnerCandidates(fileId: string): string[] {
  const parts = fileId.split('/');
  const webIdx = parts.findIndex((p) => p.endsWith('_web'));
  if (webIdx < 0) return [];
  const webns = camelize(parts[webIdx]);
  const out: string[] = [];
  // Legacy: the FIRST dir under `templates/` is the resource (`PageView`).
  const tIdx = parts.indexOf('templates', webIdx);
  if (tIdx >= 0 && tIdx + 1 < parts.length - 1) {
    const r = camelize(parts[tIdx + 1]);
    out.push(`${webns}.${r}View`, `${webns}.${r}HTML`);
  }
  // Modern: a `<resource>_html/` dir holding the colocated template (`PageHTML`).
  const htmlIdx = parts.findIndex((p, i) => i > webIdx && i < parts.length - 1 && p.endsWith('_html'));
  if (htmlIdx >= 0) {
    const r = camelize(parts[htmlIdx].slice(0, -'_html'.length));
    out.push(`${webns}.${r}HTML`, `${webns}.${r}View`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context grouping — split a file id at its `lib/` segment.

interface LibParts {
  root: string; // the `<prefix>lib` path (posix), '' + 'lib' → 'lib'
  after: string[]; // segments after `lib/` ([app, context, …, file])
}

/** Split a file id at its first `lib/` segment (handles umbrella `apps/x/lib/…`). */
function libParts(fileId: string): LibParts | undefined {
  const parts = fileId.split('/');
  const i = parts.indexOf('lib');
  if (i < 0 || i === parts.length - 1) return undefined;
  return { root: parts.slice(0, i + 1).join('/'), after: parts.slice(i + 1) };
}

interface ContextSeed {
  key: string; // `<app>/<context>` — the merge key (across lib-roots)
  app: string; // the app segment
  context: string; // the context segment
  roots: Set<string>; // the lib-root(s) this context appears under
}

/**
 * Derive Phoenix contexts from the file layout. A context is a directory
 * `<lib>/<app>/<context>/` where `<app>` is the OTP app namespace (the `_web`
 * sibling identifies it) and `<context>` is a domain dir directly beneath it. The
 * web tree (`<lib>/<app>_web/`) and files sitting directly in `<lib>/<app>/` are
 * left to directory grouping — except a context-HEAD module (`<lib>/<app>/<ctx>.ex`
 * next to a `<ctx>/` dir), which joins its context group for cohesion.
 *
 * Contexts are keyed by `<app>/<context>`, NOT the full dir, so an EE/overlay tree
 * (`extra/lib/<app>/billing/` next to `lib/<app>/billing/`) MERGES into one
 * "Billing" subsystem rather than splitting into two suffixed duplicates.
 */
function buildContextGroups(
  exFiles: readonly string[],
  mixTaskFiles: ReadonlySet<string>,
): FrameworkGroup[] {
  const exFileSet = new Set(exFiles);

  // Per lib-root: collect the top segments, then decide the app namespaces.
  const topByRoot = new Map<string, Set<string>>();
  for (const id of exFiles) {
    const lp = libParts(id);
    if (!lp) continue;
    (topByRoot.get(lp.root) ?? topByRoot.set(lp.root, new Set()).get(lp.root)!).add(lp.after[0]);
  }
  const appsByRoot = new Map<string, Set<string>>();
  for (const [root, tops] of topByRoot) {
    const webSegs = [...tops].filter((t) => t.endsWith('_web'));
    const apps = new Set<string>();
    if (webSegs.length > 0) {
      // Precise: the app root is the `_web` sibling's prefix.
      for (const w of webSegs) apps.add(w.slice(0, -'_web'.length));
    } else {
      // Fallback (headless / API-only Phoenix): every non-web top dir is an app —
      // EXCEPT `mix` (Elixir's reserved build-tool namespace, `lib/mix/tasks/…`),
      // which is never a domain app / context.
      for (const t of tops) if (!t.endsWith('_web') && t !== 'mix') apps.add(t);
    }
    appsByRoot.set(root, apps);
  }

  // Bucket files under their context, merged across lib-roots by `<app>/<context>`.
  const seedByKey = new Map<string, ContextSeed>();
  const filesByKey = new Map<string, string[]>();
  for (const id of exFiles) {
    if (mixTaskFiles.has(id)) continue; // a `Mix.Tasks.*` module is build tooling, not a domain
    const lp = libParts(id);
    if (!lp || lp.after.length < 3) continue; // need <app>/<context>/<file…>
    const [app, context] = lp.after;
    if (!appsByRoot.get(lp.root)?.has(app)) continue; // not an app root (e.g. lib/mix/)
    if (app.endsWith('_web')) continue; // web tree → directory grouping
    const key = `${app}/${context}`;
    const seed = seedByKey.get(key) ?? { key, app, context, roots: new Set<string>() };
    seed.roots.add(lp.root);
    seedByKey.set(key, seed);
    (filesByKey.get(key) ?? filesByKey.set(key, []).get(key)!).push(id);
  }

  // Attach the context-head module (`<lib>/<app>/<context>.ex`), from every root it
  // appears under.
  for (const [key, seed] of seedByKey) {
    for (const root of seed.roots) {
      const head = `${root}/${seed.app}/${seed.context}.ex`;
      if (exFileSet.has(head)) filesByKey.get(key)!.push(head);
    }
  }

  return assignGroupIds([...seedByKey.values()], filesByKey);
}

// Deterministic, collision-free group id per context (sorted by key; a slug
// collision across apps takes an app-segment suffix then a numeric suffix). Order
// is stable run-to-run — the snapshot grouping-stability invariant.
function assignGroupIds(seeds: ContextSeed[], filesByKey: Map<string, string[]>): FrameworkGroup[] {
  const taken = new Set<string>();
  const byKey = [...seeds].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of byKey) {
    const baseSlug = slugify(seed.context) || 'context';
    let id = baseSlug;
    if (taken.has(id)) id = `${baseSlug}-${slugify(seed.app) || 'app'}`;
    let n = 2;
    while (taken.has(id)) id = `${baseSlug}-${n++}`;
    taken.add(id);
    groups.push({
      id,
      label: humanize(seed.context),
      fileIds: [...new Set(filesByKey.get(seed.key) ?? [])].sort(),
    });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Analysis.

interface PhoenixAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface PhoenixDiag {
  unresolvedRoutes: Set<string>; // route targets we couldn't map to a first-party file
  unownedTemplates: number; // templates with no resolvable owning view/controller
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx gets a fresh analysis — no cross-tree staleness. Mirrors fastapi / django.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, PhoenixAnalysis>();

function addRole(map: Map<string, PhoenixRole>, fileId: string, role: PhoenixRole): void {
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
  if (from === to) return; // a router routing to a handler defined in itself → no edge
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'phoenix', relation } });
  }
}

// The role a `use` directive implies (direct `Phoenix.X`, or the `<App>Web, :atom`
// convention), or undefined.
function useRole(parsed: ParsedElixirFile): PhoenixRole | undefined {
  let best: PhoenixRole | undefined;
  for (const u of parsed.uses) {
    const direct = DIRECT_USE_ROLE[u.module];
    const atomRole = (() => {
      const atom = leadingAtom(u.args);
      return atom ? ATOM_USE_ROLE[atom] : undefined;
    })();
    const role = direct ?? atomRole;
    if (role && (best === undefined || ROLE_PRIORITY[role] > ROLE_PRIORITY[best])) best = role;
  }
  return best;
}

function isSchema(parsed: ParsedElixirFile): boolean {
  return parsed.uses.some((u) => u.module === ECTO_SCHEMA_USE);
}

// Resolve a route/scope module reference to its defining file, best-effort across
// `scope` alias prefixes (longest-first → prefer the more specific alias) + the web
// namespace. Deterministic (sorted prefixes). Undefined = unresolvable.
function resolveHandler(
  mod: string,
  scopePrefixes: readonly string[],
  webns: string | undefined,
  resolve: (m: string) => string | undefined,
): string | undefined {
  // 1. Fully-qualified reference.
  const direct = resolve(mod);
  if (direct) return direct;
  // 2. Under a scope alias prefix (longest, then lexical — most specific first).
  for (const p of scopePrefixes) {
    const hit = resolve(`${p}.${mod}`);
    if (hit) return hit;
  }
  // 3. The router's own web namespace (`MyAppWeb.PageController`).
  if (webns) {
    const hit = resolve(`${webns}.${mod}`);
    if (hit) return hit;
  }
  return undefined;
}

function analyzePhoenix(ctx: FrameworkContext): PhoenixAnalysis {
  const scope = parseElixirScope(ctx);
  const roleByFile = new Map<string, PhoenixRole>();
  const edges = new Map<string, FrameworkEdge>();
  const diag: PhoenixDiag = { unresolvedRoutes: new Set(), unownedTemplates: 0 };

  // Pass 1 — web roles + router discovery.
  const routerFiles: string[] = [];
  for (const [id, parsed] of scope.parsed) {
    const role = useRole(parsed);
    if (role) {
      addRole(roleByFile, id, role);
      if (role === 'router') routerFiles.push(id);
    }
  }

  // Pass 2 — context grouping + the 'context' service role. Mix tasks
  // (`defmodule Mix.Tasks.*`) are build tooling, never a domain context.
  const mixTaskFiles = new Set<string>();
  for (const [id, parsed] of scope.parsed) {
    if (parsed.modules.some((m) => m === 'Mix.Tasks' || m.startsWith('Mix.Tasks.'))) mixTaskFiles.add(id);
  }
  const groups = buildContextGroups(scope.exFiles, mixTaskFiles);
  const contextFiles = new Set<string>();
  for (const g of groups) for (const f of g.fileIds) contextFiles.add(f);
  for (const id of contextFiles) {
    const parsed = scope.parsed.get(id);
    if (!parsed) continue; // unreadable / non-module file (e.g. a .heex under a context dir)
    if (isSchema(parsed)) continue; // schemas are data — the Ecto adapter owns them
    addRole(roleByFile, id, 'context');
  }

  // Pass 3 — the router route spine.
  for (const routerFile of routerFiles) {
    const parsed = scope.parsed.get(routerFile)!;
    const webns = webNamespace(parsed.modules[0]);
    // Every scope-alias module in the file (positional `scope "/x", Alias` OR the
    // `scope alias: Alias` keyword form). Longest-first, lexical tiebreak.
    const prefixes = new Set<string>();
    for (const call of parsed.macroCalls) {
      if (call.name !== 'scope') continue;
      const tok = firstModuleToken(call.args);
      if (tok) prefixes.add(tok);
    }
    const scopePrefixes = [...prefixes].sort((a, b) =>
      b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const call of parsed.macroCalls) {
      if (!ROUTE_MACROS.has(call.name)) continue;
      const mod = firstModuleToken(call.args);
      if (!mod) continue;
      const target = resolveHandler(mod, scopePrefixes, webns, scope.resolve);
      if (target) addEdge(edges, routerFile, target, `route-${call.name}`);
      else diag.unresolvedRoutes.add(`${routerFile}: ${call.name} ${mod}`);
    }
  }

  // Pass 4 — attach each template to its owning view/controller module so templates
  // don't float as edge-less leaves. Owner RENDERS template → `calls` edge.
  let routeEdgeCount = edges.size;
  for (const id of scope.exFiles) {
    if (!isTemplateFile(id)) continue;
    let owner: string | undefined;
    for (const cand of templateOwnerCandidates(id)) {
      owner = scope.resolve(cand);
      if (owner) break;
    }
    if (owner) addEdge(edges, owner, id, 'renders-template');
    else diag.unownedTemplates++;
  }
  const templateEdgeCount = edges.size - routeEdgeCount;

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'phoenix' },
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

  // Positive signal for validation (mirrors fastapi / django).
  if (groups.length > 0 || roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [phoenix] ${groups.length} context group(s) · ${roleByFile.size} role(s) · ${routeEdgeCount} route + ${templateEdgeCount} template edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  const degraded: string[] = [];
  if (diag.unresolvedRoutes.size > 0)
    degraded.push(
      `${diag.unresolvedRoutes.size} unresolvable route target(s): ${[...diag.unresolvedRoutes].sort().slice(0, 10).join(' · ')}`,
    );
  if (diag.unownedTemplates > 0)
    degraded.push(`${diag.unownedTemplates} template(s) with no resolvable owner (left edge-less)`);
  if (degraded.length > 0) {
    console.log(`  [phoenix] degraded: ${degraded.join(' · ')} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): PhoenixAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzePhoenix(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const phoenixAdapter: FrameworkAdapter = {
  name: 'phoenix',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose mix.exs is at root → rootPath '').
    const rootMatch = scorePhoenix(gatherPhoenixSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // Nested app (`backend/mix.exs`) — a shallow scan of immediate subdirs, scoping
    // the adapter to the first match. Only when NOT already scoped to a workspace
    // package (that's the per-package fan-out).
    if (!ctx.packageDir) {
      for (const sub of shallowMixSubdirs(base)) {
        const m = scorePhoenix(gatherPhoenixSignals(join(base, sub)), sub);
        if (m) return m;
      }
      // Repo-wide fallback (FIRES ONLY after root + shallow miss) — a deeply-nested
      // Elixir umbrella in a polyglot monorepo (`elixir/apps/web/mix.exs`, the
      // Firezone shape) that the depth-1 shallow scan can't see. Union every mix.exs's
      // deps across the repo; if `phoenix` is declared anywhere, detect with rootPath
      // '' (the hooks scan ALL in-scope Elixir files, so '' covers an app under
      // `elixir/apps/*`). One bounded walk; manifests only, never source content.
      const deep = scorePhoenix(phoenixSignalsFromDeps(readMixDepsDeep(ctx.repoDir)), '');
      if (deep) return deep;
    }
    return null;
  },

  // One grouping prior per Phoenix context → its own subsystem, authoritative over
  // directory grouping (the Django/Nest mechanism). Fully deterministic (path/name-
  // derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // The router route spine — get/post/…/live/forward/resources → controller/live
  // file (kind 'calls'). File-id endpoints; the step resolves to modules, drops
  // self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // endpoint/router/controller/channel → gateway; live-view/live-component →
  // frontend; context module → service. METADATA; the module's `kind` is unchanged.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE (Elixir). Declare the paths the diff-driven hosted walk
  // must treat as framework-relevant. Never-store-source holds: parse server-side,
  // persist only the derived groups/edges/roles.
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
