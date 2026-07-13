// The Ecto FrameworkAdapter (DATA) — the Elixir data-layer sibling of the Python
// `python-orm` adapter, built on the SAME shared Elixir framework-analysis layer
// (framework/elixir/{analyze,elixir-ast}.ts) the Phoenix web adapter uses. Net-new;
// detects against mix.exs / mix.lock (the `ecto` / `ecto_sql` dep), NOT package.json.
//
// Ecto DECLARES its schema surface structurally, which we read STATICALLY
// (install-free, never-store-source — parse server-side, persist only the derived
// groups/edges/roles) via the hand-rolled Elixir scanner (no WASM, never executes
// repo code). parseElixirScope pre-scans every in-scope file ONCE (modules / use
// directives / macro calls) and the three hooks share that one pass:
//
//   * detect()        — the `ecto` OR `ecto_sql` dependency (a small bump for
//                       ecto_sql, the SQL-backed variant). Shallow nested-app
//                       detection too (a `backend/mix.exs`). PURE scorer.
//   * roleTags        — a SCHEMA module (`use Ecto.Schema` + a `schema "table" do`
//                       macro) → role 'schema'; a REPO module (`use Ecto.Repo`) →
//                       role 'repo'. BOTH map onto the LOCKED `service` Module-kind.
//                       A Repo is DATA-ACCESS CODE you wrote — service altitude —
//                       NOT the infra `datastore` kind (that's the Postgres box the
//                       InfraAdapters emit from config). roleTags annotate CODE
//                       modules with code-altitude kinds only; the python-orm 'model'
//                       role sets the precedent (models → service, the datastore
//                       stays an infra concern). METADATA onto the LOCKED enum; the
//                       module's `kind` is unchanged, NEVER a new kind.
//   * syntheticEdges  — THE ASSOCIATION SPINE: a schema's has_many / has_one /
//                       belongs_to / many_to_many macro names the ASSOCIATED schema
//                       MODULE (`has_many :posts, MyApp.Blog.Post`), resolved through
//                       the module registry → a `calls` edge schema-file →
//                       associated-schema-file. A structural data relationship the
//                       import graph never names as a verb (a schema doesn't `alias`
//                       its association targets); 'calls' is the neutral 8-verb verb
//                       (mirrors python-orm's stance — 'reads'/'writes' would imply a
//                       runtime data flow a schema relationship doesn't express).
//   * groupingPrior   — a directory holding ≥2 schema files → a data subsystem
//                       ('Data Model' for a models-ish dir, else the domain dir
//                       name), authoritative over the directory heuristic. Since Ecto
//                       CO-FIRES with Phoenix and registration order is phoenix(web) →
//                       ecto(data), Phoenix's per-context grouping wins where they
//                       overlap — so this stays ADDITIVE, claiming only the schema
//                       dirs Phoenix's context prior didn't (a non-context / flat /
//                       Phoenix-less Ecto layout).
//
// Unresolvable association targets (an external schema, a name we can't place)
// DEGRADE + LOG — no silent caps. Everything is deterministic (sorted outputs, ids
// derived from paths/names, lexical tiebreaks; run-twice is byte-identical).
//
// KNOWN best-effort degrades (documented, accepted):
//   * Only a DIRECT `use Ecto.Schema` / `use Ecto.Repo` is recognized — a project-
//     local `use MyApp.Schema` wrapper (that itself `use`s Ecto.Schema) is NOT
//     followed (would need to expand the wrapper's __using__/1). Common apps use
//     the direct form (verified on Plausible).
//   * An entity needs a LITERAL `schema "table"` — a computed `schema @source do`
//     table is not detected. `embedded_schema` (no table) is deliberately NOT an
//     entity (it maps no row).
//   * `through:` / name-inferred associations (`has_many :x, through: [...]`,
//     `belongs_to :y` with no module) name no module → no edge (not counted as
//     unresolved; there is simply no explicit target).

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

/** The deterministic Ecto signal set (dependency names only). */
export interface EctoSignals {
  hasEcto: boolean; // ecto — the authoritative signal
  hasEctoSql: boolean; // ecto_sql — the SQL-backed variant (supporting bump)
}

/** Decide the signal set from a dependency-name set (pure). */
function ectoSignalsFromDeps(deps: Set<string>): EctoSignals {
  return {
    hasEcto: deps.has('ecto'),
    hasEctoSql: deps.has('ecto_sql'),
  };
}

/** Gather the signal set for a single root dir (reads mix manifests only). */
export function gatherEctoSignals(baseDir: string): EctoSignals {
  return ectoSignalsFromDeps(readMixDeps(baseDir));
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
 * Decide Ecto from the signal set. Either `ecto` OR `ecto_sql` is sufficient (a
 * repo may declare only ecto_sql, which pulls ecto transitively); ecto_sql raises
 * confidence (it's the concrete relational-DB stack). Returns null → generic-Elixir
 * fallthrough, byte-for-byte unchanged.
 */
export function scoreEcto(s: EctoSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasEcto && !s.hasEctoSql) return null;
  let confidence = 0.8;
  if (s.hasEctoSql) confidence += 0.05;
  return {
    adapter: 'ecto',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: { ecto: s.hasEcto, ecto_sql: s.hasEctoSql },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. A schema is your data-model code; a Repo is
// your data-access code — both are `service` altitude (own backend code), NEVER the
// infra `datastore` kind (roles annotate CODE modules with code-altitude kinds
// only; the datastore is an infra concern the InfraAdapters own — the python-orm
// 'model'→service precedent). Repo outranks schema when (rarely) one file is both.
export type EctoRole = 'schema' | 'repo';

const ROLE_PRIORITY: Record<EctoRole, number> = {
  repo: 3,
  schema: 2,
};
const ROLE_KIND: Record<EctoRole, ModuleKind> = {
  schema: 'service',
  repo: 'service',
};

// The `use` targets that identify Ecto roles.
const ECTO_SCHEMA_USE = 'Ecto.Schema';
const ECTO_REPO_USE = 'Ecto.Repo';

// The schema-body macros that name an associated schema MODULE (the association
// spine). Each names the associated queryable as its second positional arg.
const ASSOC_MACROS = new Set(['has_many', 'has_one', 'belongs_to', 'many_to_many']);

// The table-declaring macro. `schema "users" do` marks a persisted entity;
// `embedded_schema` (no table) is deliberately not matched.
const SCHEMA_MACRO = 'schema';

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

// The FIRST module reference (`Foo` / `Foo.Bar.Baz`) in a macro-arg string, after
// stripping string/charlist literals (an association's first positional is the
// atom name, so the first PascalCase dotted token is the associated schema module —
// `:posts, MyApp.Blog.Post` → `MyApp.Blog.Post`; a `join_through: X` tail is
// ignored, which is correct — the queryable, not the join schema, is the target).
function firstModuleToken(args: string): string | undefined {
  const stripped = args.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  const m = stripped.match(/[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*/);
  return m ? m[0] : undefined;
}

// The FIRST string literal in a macro-arg string (`"users" do` → 'users').
function firstStringLiteral(args: string): string | undefined {
  const m = args.match(/"([^"]*)"/);
  return m ? m[1] : undefined;
}

// Robust `use`-target membership: reads the directive scan (scanDirectives), which
// captures `use Ecto.Repo,` even when the trailing option list wraps onto the next
// line — a shape the line-anchored useDirectives regex misses.
function usesModule(parsed: ParsedElixirFile, moduleName: string): boolean {
  return parsed.directives.some((d) => d.keyword === 'use' && d.targets.includes(moduleName));
}

// Directory / file basenames that name a generic data-model home → 'Data Model'.
const MODELS_DIR_NAMES = new Set([
  'models', 'model', 'entities', 'entity', 'schemas', 'schema', 'orm', 'db', 'database', 'tables',
]);

// ---------------------------------------------------------------------------
// Grouping — deterministic, collision-free ids.

interface GroupSeed {
  dir: string;
  baseSlug: string;
  label: string;
  fileIds: string[];
}

// Deterministic, collision-free group ids: sorted by dir, a bare slug goes to the
// first claimant; collisions take a `-<dirBase>` then `-<n>` suffix. Identical
// run-to-run (the snapshot grouping-stability invariant). Mirrors python-orm.
function assignGroups(seeds: GroupSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const byDir = [...seeds].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of byDir) {
    let id = seed.baseSlug;
    if (taken.has(id)) id = `${seed.baseSlug}-${slugify(dirBase(seed.dir)) || 'dir'}`;
    let n = 2;
    while (taken.has(id)) id = `${seed.baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label: seed.label, fileIds: [...seed.fileIds].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Group schema files into a data subsystem: one per DIRECTORY holding ≥2 schema
// files. A models-ish-named dir → 'Data Model'; any other cluster → its humanized
// domain-dir name (mirrors python-orm's buildGroups). A lone scattered schema is
// LEFT to directory grouping — grouping single files would fragment a per-domain
// layout into identical boxes and override the more informative domain subsystem.
// Additive to Phoenix by registration order (phoenix's context prior wins overlaps).
function buildGroups(schemaFiles: readonly string[]): FrameworkGroup[] {
  const byDir = new Map<string, string[]>();
  for (const f of schemaFiles) {
    const dir = dirOf(f);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(f);
  }
  const seeds: GroupSeed[] = [];
  for (const [dir, files] of byDir) {
    if (files.length < 2) continue; // need a cluster of ≥2 schemas in the dir
    const modelsDir = MODELS_DIR_NAMES.has(dirBase(dir).toLowerCase());
    const label = modelsDir ? 'Data Model' : humanize(dirBase(dir));
    seeds.push({ dir, baseSlug: slugify(label) || 'data-model', label, fileIds: files });
  }
  return assignGroups(seeds);
}

// ---------------------------------------------------------------------------
// Analysis.

interface EctoAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface EctoDiag {
  /** association targets (a named module) we couldn't map to a first-party file. */
  unresolvedTargets: Set<string>;
}

// A parsed schema entity: its file + declared table name (if literal).
interface SchemaEntity {
  fileId: string;
  table: string | undefined;
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx gets a fresh analysis — no cross-tree staleness. Mirrors phoenix / python-orm.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, EctoAnalysis>();

function addEdge(
  edges: Map<string, FrameworkEdge>,
  from: string,
  to: string,
  relation: string,
): void {
  if (from === to) return; // a self-referential association collapses; step drops self-edges too
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, {
      source: from,
      target: to,
      kind: 'calls',
      metadata: { framework: 'ecto', relation },
    });
  }
}

// A schema entity iff it `use`s Ecto.Schema AND declares a literal `schema "table"`.
// Returns the table name (or '' for a matched-but-nameless case, which can't happen
// since firstStringLiteral gates the match) or undefined when it is not an entity.
function schemaTable(parsed: ParsedElixirFile): string | undefined {
  if (!usesModule(parsed, ECTO_SCHEMA_USE)) return undefined;
  for (const call of parsed.macroCalls) {
    if (call.name !== SCHEMA_MACRO) continue;
    const table = firstStringLiteral(call.args);
    if (table) return table;
  }
  return undefined;
}

function analyzeEcto(ctx: FrameworkContext): EctoAnalysis {
  const scope = parseElixirScope(ctx);
  const diag: EctoDiag = { unresolvedTargets: new Set() };

  // Pass 1 — classify each in-scope module: schema entity and/or Repo.
  const entities: SchemaEntity[] = [];
  const entityFiles = new Set<string>();
  const roleByFile = new Map<string, EctoRole>();
  const addRole = (fileId: string, role: EctoRole) => {
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
    const table = schemaTable(parsed);
    if (table !== undefined) {
      entities.push({ fileId: id, table });
      entityFiles.add(id);
      addRole(id, 'schema');
    }
    if (usesModule(parsed, ECTO_REPO_USE)) addRole(id, 'repo');
  }

  // Pass 2 — the association spine: each schema's has_many/has_one/belongs_to/
  // many_to_many names an associated schema module → resolve → 'calls' edge.
  const edges = new Map<string, FrameworkEdge>();
  const tableByFile = new Map(entities.map((e) => [e.fileId, e.table]));
  for (const ent of entities) {
    const parsed = scope.parsed.get(ent.fileId);
    if (!parsed) continue;
    for (const call of parsed.macroCalls) {
      if (!ASSOC_MACROS.has(call.name)) continue;
      const mod = firstModuleToken(call.args);
      if (!mod) continue; // through:/name-inferred association — no explicit module target
      const target = scope.resolve(mod);
      if (target) addEdge(edges, ent.fileId, target, call.name);
      else diag.unresolvedTargets.add(`${ent.fileId}: ${call.name} → ${mod}`);
    }
  }

  // Roles — schema entities carry their table name in metadata; Repos are bare.
  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    const metadata: Record<string, unknown> = { framework: 'ecto' };
    if (role === 'schema') {
      const table = tableByFile.get(fileId);
      if (table) metadata.table = table;
    }
    roles.set(fileId, { role, kind: ROLE_KIND[role], priority: ROLE_PRIORITY[role], metadata });
  }

  const groups = buildGroups([...entityFiles]);

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

  const schemaCount = entityFiles.size;
  const repoCount = [...roleByFile.values()].filter((r) => r === 'repo').length;

  // Positive signal for validation (mirrors phoenix / python-orm).
  if (roleByFile.size > 0 || groups.length > 0 || sortedEdges.length > 0) {
    console.log(
      `  [ecto] ${schemaCount} schema(s) · ${repoCount} repo(s) · ${groups.length} data group(s) · ${sortedEdges.length} association edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  if (diag.unresolvedTargets.size > 0) {
    console.log(
      `  [ecto] degraded: ${diag.unresolvedTargets.size} unresolvable association target(s): ` +
        `${[...diag.unresolvedTargets].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`,
    );
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): EctoAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeEcto(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const ectoAdapter: FrameworkAdapter = {
  name: 'ecto',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose mix.exs is at root → rootPath '').
    const rootMatch = scoreEcto(gatherEctoSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // Nested app (`backend/mix.exs`) — a shallow scan of immediate subdirs, scoping
    // the adapter to the first match. Only when NOT already scoped to a workspace
    // package (that's the per-package fan-out).
    if (!ctx.packageDir) {
      for (const sub of shallowMixSubdirs(base)) {
        const m = scoreEcto(gatherEctoSignals(join(base, sub)), sub);
        if (m) return m;
      }
      // Repo-wide fallback (FIRES ONLY after root + shallow miss) — a deeply-nested
      // Elixir umbrella in a polyglot monorepo (`elixir/apps/*/mix.exs`, the Firezone
      // shape) that the depth-1 shallow scan can't see. Union every mix.exs's deps
      // across the repo; if `ecto`/`ecto_sql` is declared anywhere, detect with
      // rootPath '' (the hooks scan ALL in-scope Elixir files). One bounded walk;
      // manifests only, never source content.
      const deep = scoreEcto(ectoSignalsFromDeps(readMixDepsDeep(ctx.repoDir)), '');
      if (deep) return deep;
    }
    return null;
  },

  // A directory of ≥2 schemas → a data subsystem, authoritative over directory
  // grouping (the phoenix/nest mechanism), additive to Phoenix's context prior.
  // Fully deterministic (path-derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // The association spine — has_many/has_one/belongs_to/many_to_many → associated
  // schema file (kind 'calls'). File-id endpoints; the step resolves to modules,
  // drops self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // schema module → role 'schema'; Repo module → role 'repo'. BOTH on the LOCKED
  // `service` kind (data-access CODE, not the infra datastore). METADATA; the
  // module's `kind` is unchanged.
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
