// The Ash FrameworkAdapter (DATA) — the resource-framework sibling of the Ecto
// data adapter, built on the SAME shared Elixir framework-analysis layer
// (framework/elixir/{analyze,elixir-ast}.ts). Net-new; detects against
// mix.exs / mix.lock (the `ash` dep), NOT package.json.
//
// Ash DECLARES its resource surface structurally (a `use Ash.Resource` module
// with a `relationships do … end` block), which we read STATICALLY (install-free,
// never-store-source — parse server-side, persist only the derived
// groups/edges/roles) via the hand-rolled Elixir scanner (no WASM, never executes
// repo code). parseElixirScope pre-scans every in-scope file ONCE (modules / use
// directives / macro calls) and the three hooks share that one pass:
//
//   * detect()        — the `ash` dependency is AUTHORITATIVE (confidence ~0.8);
//                       any Ash extension (ash_postgres / ash_graphql / ash_phoenix)
//                       raises confidence a notch. Shallow nested-app detection too
//                       (a `backend/mix.exs`) + a repo-wide deep fallback. PURE
//                       scorer.
//   * roleTags        — a RESOURCE module (`use Ash.Resource`) → role 'ash-resource';
//                       an API/DOMAIN module (`use Ash.Api` OR `use Ash.Domain` —
//                       Ash 3.0 renamed Api→Domain, both supported) → role 'ash-api'.
//                       A resource is your data-model CODE → the LOCKED `service`
//                       kind (like Ecto schema→service; NEVER the infra `datastore`
//                       kind — that's the Postgres box the InfraAdapters emit). An
//                       Api/Domain is the request/query ENTRY for its resources →
//                       the LOCKED `gateway` kind. METADATA onto the LOCKED enum; the
//                       module's `kind` is unchanged, NEVER a new kind.
//   * syntheticEdges  — THE RELATIONSHIP SPINE: a resource's belongs_to / has_many /
//                       has_one / many_to_many macro (inside `relationships do`)
//                       names the RELATED resource MODULE as its second positional
//                       arg (`belongs_to :author, MyApp.Blog.Author`), resolved
//                       through the module registry → a `calls` edge resource-file →
//                       related-resource-file. IDENTICAL to Ecto's association spine
//                       (a resource doesn't `alias` its relationship targets, so the
//                       import graph never names this as a verb); 'calls' is the
//                       neutral 8-verb verb (mirrors Ecto — 'reads'/'writes' would
//                       imply a runtime data flow a relationship declaration doesn't
//                       express). A relationship macro is only honored when its module
//                       `use`s Ash.Resource (so a stray `has_many` in a non-Ash
//                       module never emits an edge).
//   * groupingPrior   — group resource files by their declared Ash DOMAIN. Ash 3.x
//                       resources name their domain on the use line
//                       (`use Ash.Resource, domain: MyApp.Blog`); resources sharing a
//                       domain → one subsystem labeled by the domain's last segment
//                       (`MyApp.Blog` → 'Blog'). Resources with no parseable domain
//                       fall back to Ecto-style DIRECTORY grouping (a dir with ≥2
//                       resource files → 'Data Model' for a models-ish dir, else the
//                       humanized dir name). Since Ash CO-FIRES with Phoenix and
//                       registration order is phoenix(web) → …data adapters, Phoenix's
//                       per-context grouping wins where they overlap — so this stays
//                       ADDITIVE.
//
// Unresolvable relationship targets (an external resource, a name we can't place)
// DEGRADE + LOG — no silent caps. Everything is deterministic (sorted outputs, ids
// derived from paths/names, lexical tiebreaks; run-twice is byte-identical).
//
// KNOWN best-effort degrades (documented, accepted):
//   * Only a DIRECT `use Ash.Resource` / `use Ash.Api` / `use Ash.Domain` is
//     recognized — a project-local `use MyApp.Resource` wrapper (that itself `use`s
//     Ash.Resource) is NOT followed (would need to expand the wrapper's
//     __using__/1). Common apps use the direct form.
//   * A relationship with NO explicit module — a name-inferred `belongs_to :author`,
//     or the BLOCK form (`belongs_to :author do destination MyApp.Blog.Author end`) —
//     names no module on the macro line → no edge (not counted as unresolved; there
//     is simply no explicit target on the macro, mirroring Ecto's `through:` case).
//   * A resource with no parseable `domain:` (Ash 2.x registry style, or a resource
//     that omits it) falls back to directory grouping — never fabricated.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

/** The deterministic Ash signal set (dependency names only). */
export interface AshSignals {
  hasAsh: boolean; // ash — the authoritative signal
  hasAshPostgres: boolean; // ash_postgres — the Postgres data layer (bump)
  hasAshGraphql: boolean; // ash_graphql — the GraphQL extension (bump)
  hasAshPhoenix: boolean; // ash_phoenix — the Phoenix/LiveView integration (bump)
}

/** Decide the signal set from a dependency-name set (pure). */
function ashSignalsFromDeps(deps: Set<string>): AshSignals {
  return {
    hasAsh: deps.has('ash'),
    hasAshPostgres: deps.has('ash_postgres'),
    hasAshGraphql: deps.has('ash_graphql'),
    hasAshPhoenix: deps.has('ash_phoenix'),
  };
}

/** Gather the signal set for a single root dir (reads mix manifests only). */
export function gatherAshSignals(baseDir: string): AshSignals {
  return ashSignalsFromDeps(readMixDeps(baseDir));
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
 * Decide Ash from the signal set. `ash` is AUTHORITATIVE — required (mix.lock carries
 * it transitively even when only an extension is a direct dep, so this is robust); any
 * Ash extension (ash_postgres / ash_graphql / ash_phoenix) raises confidence a notch.
 * Returns null → generic-Elixir fallthrough, byte-for-byte unchanged.
 */
export function scoreAsh(s: AshSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasAsh) return null;
  let confidence = 0.8;
  if (s.hasAshPostgres || s.hasAshGraphql || s.hasAshPhoenix) confidence += 0.05;
  return {
    adapter: 'ash',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: {
        ash: s.hasAsh,
        ash_postgres: s.hasAshPostgres,
        ash_graphql: s.hasAshGraphql,
        ash_phoenix: s.hasAshPhoenix,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. A resource is your data-model code →
// `service` altitude (own backend code), NEVER the infra `datastore` kind (roles
// annotate CODE modules with code-altitude kinds only; the datastore is an infra
// concern the InfraAdapters own — the Ecto schema→service precedent). An Api/Domain
// is the request/query ENTRY for its resources → `gateway`. Api outranks resource
// when (rarely) one file is both.
export type AshRole = 'ash-api' | 'ash-resource';

const ROLE_PRIORITY: Record<AshRole, number> = {
  'ash-api': 3,
  'ash-resource': 2,
};
const ROLE_KIND: Record<AshRole, ModuleKind> = {
  'ash-resource': 'service',
  'ash-api': 'gateway',
};

// The `use` targets that identify Ash roles. Ash 3.0 renamed Api → Domain; both are
// honored so a 2.x and a 3.x codebase both classify.
const ASH_RESOURCE_USE = 'Ash.Resource';
const ASH_API_USES = ['Ash.Api', 'Ash.Domain'] as const;

// The relationship-block macros that name a related resource MODULE (the relationship
// spine). Each names the related resource as its second positional arg.
const REL_MACROS = new Set(['belongs_to', 'has_many', 'has_one', 'many_to_many']);

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

function dirOf(fileId: string): string {
  const i = fileId.lastIndexOf('/');
  return i >= 0 ? fileId.slice(0, i) : '';
}

function dirBase(dir: string): string {
  if (dir === '') return 'root';
  const i = dir.lastIndexOf('/');
  return i >= 0 ? dir.slice(i + 1) : dir;
}

/** The last dotted segment of a module name (`MyApp.Blog` → 'Blog'). */
function lastSegment(mod: string): string {
  const i = mod.lastIndexOf('.');
  return i >= 0 ? mod.slice(i + 1) : mod;
}

// The FIRST module reference (`Foo` / `Foo.Bar.Baz`) in a macro-arg string, after
// stripping string/charlist literals (a relationship's first positional is the atom
// name, so the first PascalCase dotted token is the related resource module —
// `:posts, MyApp.Blog.Post` → `MyApp.Blog.Post`; a `join_through: X` / trailing
// option is ignored, which is correct — the related resource, not the option, is the
// target). Mirrors Ecto's firstModuleToken.
function firstModuleToken(args: string): string | undefined {
  const stripped = args.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  const m = stripped.match(/[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*/);
  return m ? m[0] : undefined;
}

// Robust `use`-target membership: reads the directive scan (scanDirectives), which
// captures `use Ash.Resource,` even when the trailing option list wraps onto the next
// line — a shape the line-anchored useDirectives regex misses.
function usesModule(parsed: ParsedElixirFile, moduleName: string): boolean {
  return parsed.directives.some((d) => d.keyword === 'use' && d.targets.includes(moduleName));
}

// The `domain:` module declared on a resource's `use Ash.Resource, domain: X` line.
// Read from the raw use args (useDirectives, which joins the wrapped multi-line option
// list). `\bdomain:` won't match a `some_domain:` option (the `_` before `domain` is a
// word char → no boundary). Undefined when the resource declares no domain.
function resourceDomain(parsed: ParsedElixirFile): string | undefined {
  for (const u of parsed.uses) {
    if (u.module !== ASH_RESOURCE_USE) continue;
    const m = u.args.match(/\bdomain:\s*([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)/);
    if (m) return m[1];
  }
  return undefined;
}

// Directory / file basenames that name a generic data-model home → 'Data Model'.
const MODELS_DIR_NAMES = new Set([
  'models', 'model', 'entities', 'entity', 'resources', 'resource', 'schemas', 'schema', 'orm', 'db', 'database', 'tables',
]);

// ---------------------------------------------------------------------------
// Grouping — deterministic, collision-free ids.

interface GroupSeed {
  /** A stable sort/collision key (a real dir, or `domain:<Module>` for a domain group). */
  key: string;
  baseSlug: string;
  label: string;
  fileIds: string[];
}

// Deterministic, collision-free group ids: sorted by key, a bare slug goes to the
// first claimant; collisions take a `-<keyBase>` then `-<n>` suffix. Identical
// run-to-run (the snapshot grouping-stability invariant). Mirrors Ecto's assignGroups.
function assignGroups(seeds: GroupSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const byKey = [...seeds].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of byKey) {
    let id = seed.baseSlug;
    if (taken.has(id)) id = `${seed.baseSlug}-${slugify(dirBase(seed.key)) || 'dir'}`;
    let n = 2;
    while (taken.has(id)) id = `${seed.baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label: seed.label, fileIds: [...seed.fileIds].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// A parsed resource entity: its file + declared domain module (if any).
interface ResourceEntity {
  fileId: string;
  domain: string | undefined;
}

// Group resource files into subsystems: PRIMARY by declared Ash DOMAIN (an explicit,
// named boundary — every resource sharing a domain groups, no min-count threshold,
// since the domain is a first-class semantic signal, unlike Ecto's heuristic
// directory clustering). Resources with NO parseable domain fall back to Ecto-style
// DIRECTORY grouping (a dir with ≥2 such resources → 'Data Model' for a models-ish
// dir, else its humanized dir name; a lone domain-less resource is LEFT to directory
// grouping to avoid fragmenting a layout into identical single-file boxes). The two
// sets are disjoint by construction (a file is domain-grouped iff it declares a
// domain). Additive to Phoenix by registration order.
function buildGroups(resources: readonly ResourceEntity[]): FrameworkGroup[] {
  const seeds: GroupSeed[] = [];

  // Domain groups — every resource that declares a domain, keyed by that domain.
  const byDomain = new Map<string, string[]>();
  const noDomain: string[] = [];
  for (const r of resources) {
    if (r.domain) (byDomain.get(r.domain) ?? byDomain.set(r.domain, []).get(r.domain)!).push(r.fileId);
    else noDomain.push(r.fileId);
  }
  for (const [domain, files] of byDomain) {
    const label = humanize(lastSegment(domain));
    seeds.push({ key: `domain:${domain}`, baseSlug: slugify(label) || 'domain', label, fileIds: files });
  }

  // Directory fallback — domain-less resources, ≥2 per dir (Ecto-style).
  const byDir = new Map<string, string[]>();
  for (const f of noDomain) {
    const dir = dirOf(f);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(f);
  }
  for (const [dir, files] of byDir) {
    if (files.length < 2) continue; // need a cluster of ≥2 domain-less resources
    const modelsDir = MODELS_DIR_NAMES.has(dirBase(dir).toLowerCase());
    const label = modelsDir ? 'Data Model' : humanize(dirBase(dir));
    seeds.push({ key: dir, baseSlug: slugify(label) || 'data-model', label, fileIds: files });
  }

  return assignGroups(seeds);
}

// ---------------------------------------------------------------------------
// Analysis.

interface AshAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface AshDiag {
  /** relationship targets (a named module) we couldn't map to a first-party file. */
  unresolvedTargets: Set<string>;
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx gets a fresh analysis — no cross-tree staleness. Mirrors ecto / phoenix.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, AshAnalysis>();

function addEdge(
  edges: Map<string, FrameworkEdge>,
  from: string,
  to: string,
  relation: string,
): void {
  if (from === to) return; // a self-referential relationship collapses; step drops self-edges too
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, {
      source: from,
      target: to,
      kind: 'calls',
      metadata: { framework: 'ash', relation },
    });
  }
}

function analyzeAsh(ctx: FrameworkContext): AshAnalysis {
  const scope = parseElixirScope(ctx);
  const diag: AshDiag = { unresolvedTargets: new Set() };

  // Pass 1 — classify each in-scope module: Ash resource and/or Api/Domain.
  const resources: ResourceEntity[] = [];
  const roleByFile = new Map<string, AshRole>();
  const addRole = (fileId: string, role: AshRole) => {
    const cur = roleByFile.get(fileId);
    if (
      cur === undefined ||
      ROLE_PRIORITY[role] > ROLE_PRIORITY[cur] ||
      (ROLE_PRIORITY[role] === ROLE_PRIORITY[cur] && role < cur)
    ) {
      roleByFile.set(fileId, role);
    }
  };

  for (const [id, parsed] of scope.parsed) {
    if (usesModule(parsed, ASH_RESOURCE_USE)) {
      resources.push({ fileId: id, domain: resourceDomain(parsed) });
      addRole(id, 'ash-resource');
    }
    if (ASH_API_USES.some((m) => usesModule(parsed, m))) addRole(id, 'ash-api');
  }

  // Pass 2 — the relationship spine: each resource's belongs_to/has_many/has_one/
  // many_to_many names a related resource module → resolve → 'calls' edge. Only a
  // module that `use`s Ash.Resource is walked here, so a stray macro elsewhere emits
  // no edge.
  const edges = new Map<string, FrameworkEdge>();
  for (const ent of resources) {
    const parsed = scope.parsed.get(ent.fileId);
    if (!parsed) continue;
    for (const call of parsed.macroCalls) {
      if (!REL_MACROS.has(call.name)) continue;
      const mod = firstModuleToken(call.args);
      if (!mod) continue; // block-form / name-inferred relationship — no explicit module target
      const target = scope.resolve(mod);
      if (target) addEdge(edges, ent.fileId, target, call.name);
      else diag.unresolvedTargets.add(`${ent.fileId}: ${call.name} → ${mod}`);
    }
  }

  // Roles — resources carry their domain (when declared) in metadata; Apis are bare.
  const domainByFile = new Map(resources.map((r) => [r.fileId, r.domain]));
  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    const metadata: Record<string, unknown> = { framework: 'ash' };
    if (role === 'ash-resource') {
      const domain = domainByFile.get(fileId);
      if (domain) metadata.domain = domain;
    }
    roles.set(fileId, { role, kind: ROLE_KIND[role], priority: ROLE_PRIORITY[role], metadata });
  }

  const groups = buildGroups(resources);

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

  const resourceCount = resources.length;
  const apiCount = [...roleByFile.values()].filter((r) => r === 'ash-api').length;

  // Positive signal for validation (mirrors ecto / phoenix).
  if (roleByFile.size > 0 || groups.length > 0 || sortedEdges.length > 0) {
    console.log(
      `  [ash] ${resourceCount} resource(s) · ${apiCount} api/domain module(s) · ${groups.length} domain group(s) · ${sortedEdges.length} relationship edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  if (diag.unresolvedTargets.size > 0) {
    console.log(
      `  [ash] degraded: ${diag.unresolvedTargets.size} unresolvable relationship target(s): ` +
        `${[...diag.unresolvedTargets].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`,
    );
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): AshAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeAsh(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const ashAdapter: FrameworkAdapter = {
  name: 'ash',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose mix.exs is at root → rootPath '').
    const rootMatch = scoreAsh(gatherAshSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // Nested app (`backend/mix.exs`) — a shallow scan of immediate subdirs, scoping
    // the adapter to the first match. Only when NOT already scoped to a workspace
    // package (that's the per-package fan-out).
    if (!ctx.packageDir) {
      for (const sub of shallowMixSubdirs(base)) {
        const m = scoreAsh(gatherAshSignals(join(base, sub)), sub);
        if (m) return m;
      }
      // Repo-wide fallback (FIRES ONLY after root + shallow miss) — a deeply-nested
      // Elixir umbrella in a polyglot monorepo (`elixir/apps/*/mix.exs`). Union every
      // mix.exs's deps across the repo; if `ash` is declared anywhere, detect with
      // rootPath '' (the hooks scan ALL in-scope Elixir files). One bounded walk;
      // manifests only, never source content.
      const deep = scoreAsh(ashSignalsFromDeps(readMixDepsDeep(ctx.repoDir)), '');
      if (deep) return deep;
    }
    return null;
  },

  // Resources grouped by declared Ash domain (fallback: a ≥2-resource dir → a data
  // subsystem), authoritative over directory grouping, additive to Phoenix's context
  // prior. Fully deterministic (path/name-derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // The relationship spine — belongs_to/has_many/has_one/many_to_many → related
  // resource file (kind 'calls'). File-id endpoints; the step resolves to modules,
  // drops self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // resource module → role 'ash-resource' on the LOCKED `service` kind (data-model
  // CODE, not the infra datastore); Api/Domain module → role 'ash-api' on `gateway`.
  // METADATA; the module's `kind` is unchanged.
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
