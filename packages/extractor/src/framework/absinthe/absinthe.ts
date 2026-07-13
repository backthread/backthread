// The Absinthe FrameworkAdapter (protocol) — the Elixir GraphQL adapter, the
// analogue of the Python Strawberry/Graphene adapter (framework/graphql) and the
// Ruby graphql-ruby adapter. Built on the shared Elixir framework-analysis layer
// (framework/elixir/{analyze,elixir-ast}.ts), the same way Phoenix (web) is;
// detects against mix.exs / mix.lock (the `absinthe` dep), NOT package.json.
//
// Absinthe declares its GraphQL surface as Elixir modules that `use Absinthe.Schema`
// (the root schema) or `use Absinthe.Schema.Notation` (a types module), with
// `object`/`query`/`mutation`/`subscription`/`field`/`resolve` macro calls inside.
// We read this STATICALLY (install-free, never-store-source — the hand-rolled Elixir
// scanner; never executes repo code) and persist only the derived edges/roles:
//
//   * detect()        — the `absinthe` dependency (or `absinthe_plug` /
//                       `absinthe_phoenix`, which pull it in). Shallow nested-app
//                       detection too (a `backend/mix.exs`).
//   * syntheticEdges  — the wiring the import graph never names as a verb (kind
//                       'calls' throughout): an `import_types SomeTypes` macro call →
//                       schema-file → the types module's file ('import-types'); a
//                       `resolve &Resolvers.X.fn/2` reference → schema-file → the
//                       in-repo resolver module's file ('resolve'). A schema `alias`es
//                       its types/resolvers, but the schema→types stitch + the
//                       field→resolver dispatch are Absinthe macros, not imports.
//   * roleTags        — a schema OR notation module → `gateway` (role 'graphql'); a
//                       referenced resolver module → `gateway` (role
//                       'graphql-resolver'). METADATA onto the LOCKED MODULE_KINDS
//                       enum; never a new kind (only `role` renders).
//
// Unresolvable import_types / resolver references (an external type set like
// `Absinthe.Type.Custom`, a `resolve dataloader(...)` / `resolve fn … end` with no
// module capture) DEGRADE + LOG — no silent caps. Everything is deterministic
// (sorted outputs, ids derived from paths/names; run-twice is byte-identical).

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
// Detection (mix.exs/mix.lock → deps; PURE scorer). Never reads source content.

/** The deterministic Absinthe signal set (dependency names only). */
export interface AbsintheSignals {
  hasAbsinthe: boolean; // absinthe (or absinthe_plug / absinthe_phoenix, which pull it in)
}

/** Gather the signal set for a single root dir (reads mix manifests only). */
export function gatherAbsintheSignals(baseDir: string): AbsintheSignals {
  const deps = readMixDeps(baseDir);
  return {
    hasAbsinthe:
      deps.has('absinthe') || deps.has('absinthe_plug') || deps.has('absinthe_phoenix'),
  };
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
 * nested Elixir/Absinthe app (`backend/` | `server/` in a polyglot monorepo).
 * Sorted, so the first-match pick is deterministic; skips dot-dirs + build dirs.
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
 * Decide Absinthe from the signal set. `absinthe` (directly, or via the
 * absinthe_plug / absinthe_phoenix integrations) is REQUIRED. Returns null →
 * generic-Elixir fallthrough, byte-for-byte unchanged.
 */
export function scoreAbsinthe(s: AbsintheSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasAbsinthe) return null;
  return {
    adapter: 'absinthe',
    confidence: clampConfidence(0.85),
    rootPath,
    metadata: { framework: 'absinthe', signals: { absinthe: s.hasAbsinthe } },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind`
// is unchanged. A schema/notation module IS the GraphQL request surface → gateway;
// a resolver module (the field-dispatch target) is a request entry too → gateway.
export type AbsintheRole = 'graphql' | 'graphql-resolver';

// Collapse priority when one FILE carries several roles, AND downstream when
// several files of different roles land in one MODULE after clustering (the
// contribute-step keeps the highest). The schema/notation role outranks the
// referenced-resolver role (a file that is BOTH stays a schema).
const ROLE_PRIORITY: Record<AbsintheRole, number> = {
  graphql: 8,
  'graphql-resolver': 5,
};
const ROLE_KIND: Record<AbsintheRole, ModuleKind> = {
  graphql: 'gateway',
  'graphql-resolver': 'gateway',
};

// The `use Absinthe.X` forms that mark a GraphQL schema/notation module. The root
// schema uses `Absinthe.Schema`; a types module uses `Absinthe.Schema.Notation`;
// the Relay variants ride the same convention.
const SCHEMA_USE_MODULES = new Set([
  'Absinthe.Schema',
  'Absinthe.Schema.Notation',
  'Absinthe.Relay.Schema',
  'Absinthe.Relay.Schema.Notation',
]);

// A resolver reference: `resolve &Resolvers.Content.list_posts/3` (or the
// parenthesized `resolve(&Mod.fn/2)`). Captures the MODULE part of the function
// capture — one-or-more PascalCase segments before the trailing lowercase
// function name + `/arity`. A `resolve fn … end`, a `resolve dataloader(...)`, or a
// bare-local `resolve &local/2` has no module capture → no match (correctly
// ignored). Deliberately NOT read from macroCalls: the shared scanner filters an
// `&`-leading arg out of macroCalls, so this scans the (heredoc-safe) text.
const RESOLVE_CAPTURE_RE =
  /\bresolve\b[\s(]*&\s*([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)\.[a-z_][A-Za-z0-9_]*[?!]?\s*\/\s*\d+/g;

// The `import_types` macro that stitches a types module into a schema.
const IMPORT_TYPES_MACRO = 'import_types';

// ---------------------------------------------------------------------------
// Helpers.

// The FIRST module reference (`Foo` / `Foo.Bar.Baz`) in a macro-arg string, after
// stripping string/charlist literals. For `import_types Foo.Bar` that's the module.
function firstModuleToken(args: string): string | undefined {
  const stripped = args.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  const m = stripped.match(/[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*/);
  return m ? m[0] : undefined;
}

// Every resolver-module reference in a file's text (deduped, sorted for stable
// diagnostics). Each is the MODULE of a `resolve &Mod.fn/arity` capture.
function resolverModuleRefs(text: string): string[] {
  const mods = new Set<string>();
  RESOLVE_CAPTURE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RESOLVE_CAPTURE_RE.exec(text)) !== null) mods.add(m[1]);
  return [...mods].sort();
}

// Does this file `use` an Absinthe schema/notation module?
function isSchemaModule(parsed: ParsedElixirFile): boolean {
  return parsed.uses.some((u) => SCHEMA_USE_MODULES.has(u.module));
}

// ---------------------------------------------------------------------------
// Analysis.

interface AbsintheAnalysis {
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface AbsintheDiag {
  unresolvedImports: Set<string>; // import_types refs we couldn't map to an in-repo file
  unresolvedResolvers: Set<string>; // resolve &Mod.fn/2 refs we couldn't map (external/dynamic)
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so syntheticEdges + roleTags
// share ONE parse, while the merge walk's per-checkpoint ctx gets a fresh analysis —
// no cross-tree staleness. Mirrors phoenix / graphql.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, AbsintheAnalysis>();

function addRole(map: Map<string, AbsintheRole>, fileId: string, role: AbsintheRole): void {
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
  if (from === to) return; // a schema resolving to types/resolvers defined in itself → no edge
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, {
      source: from,
      target: to,
      kind: 'calls',
      metadata: { framework: 'absinthe', relation },
    });
  }
}

function analyzeAbsinthe(ctx: FrameworkContext): AbsintheAnalysis {
  const scope = parseElixirScope(ctx);
  const roleByFile = new Map<string, AbsintheRole>();
  const edges = new Map<string, FrameworkEdge>();
  const diag: AbsintheDiag = { unresolvedImports: new Set(), unresolvedResolvers: new Set() };

  // Pass 1 — schema/notation modules → the 'graphql' gateway role. Collect them; a
  // schema OR a types (notation) module can carry import_types + resolve wiring.
  const schemaFiles: string[] = [];
  for (const [id, parsed] of scope.parsed) {
    if (isSchemaModule(parsed)) {
      addRole(roleByFile, id, 'graphql');
      schemaFiles.push(id);
    }
  }

  // Pass 2 — the schema→types + schema→resolver spine (from schema/notation files).
  let importEdgeCount = 0;
  let resolveEdgeCount = 0;
  for (const id of schemaFiles) {
    const parsed = scope.parsed.get(id)!;
    // (a) import_types SomeTypes → the types module's file.
    for (const call of parsed.macroCalls) {
      if (call.name !== IMPORT_TYPES_MACRO) continue;
      const mod = firstModuleToken(call.args);
      if (!mod) continue;
      const target = scope.resolve(mod);
      if (target) {
        if (!edges.has(`${id}→${target}:calls`) && id !== target) importEdgeCount++;
        addEdge(edges, id, target, 'import-types');
      } else diag.unresolvedImports.add(`${id}: import_types ${mod}`);
    }
    // (b) resolve &Resolvers.X.fn/2 → the in-repo resolver module's file, which is
    // itself a GraphQL request entry.
    for (const mod of resolverModuleRefs(parsed.text)) {
      const target = scope.resolve(mod);
      if (target) {
        if (!edges.has(`${id}→${target}:calls`) && id !== target) resolveEdgeCount++;
        addEdge(edges, id, target, 'resolve');
        addRole(roleByFile, target, 'graphql-resolver');
      } else diag.unresolvedResolvers.add(`${id}: resolve &${mod}.*`);
    }
  }

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'absinthe' },
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

  // Positive signal for validation (mirrors phoenix / graphql).
  if (roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [absinthe] ${schemaFiles.length} schema/notation module(s) · ${roleByFile.size} role(s) · ${importEdgeCount} import_types + ${resolveEdgeCount} resolver edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  const degraded: string[] = [];
  if (diag.unresolvedImports.size > 0)
    degraded.push(
      `${diag.unresolvedImports.size} unresolvable import_types (external/dynamic): ${[...diag.unresolvedImports].sort().slice(0, 10).join(' · ')}`,
    );
  if (diag.unresolvedResolvers.size > 0)
    degraded.push(
      `${diag.unresolvedResolvers.size} unresolvable resolver ref(s): ${[...diag.unresolvedResolvers].sort().slice(0, 10).join(' · ')}`,
    );
  if (degraded.length > 0) {
    console.log(`  [absinthe] degraded: ${degraded.join(' · ')} (logged, not silently dropped)`);
  }

  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): AbsintheAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeAbsinthe(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const absintheAdapter: FrameworkAdapter = {
  name: 'absinthe',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose mix.exs is at root → rootPath '').
    const rootMatch = scoreAbsinthe(gatherAbsintheSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // Nested app (`backend/mix.exs`) — a shallow scan of immediate subdirs, scoping
    // the adapter to the first match. Only when NOT already scoped to a workspace
    // package (that's the per-package fan-out).
    if (!ctx.packageDir) {
      for (const sub of shallowMixSubdirs(base)) {
        const m = scoreAbsinthe(gatherAbsintheSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // import_types → types module + resolve &Mod.fn → resolver module (kind 'calls').
  // File-id endpoints; the step resolves to modules, drops self-edges, dedupes,
  // 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // schema/notation module → gateway (role 'graphql'); a referenced resolver module
  // → gateway (role 'graphql-resolver'). METADATA; the module's `kind` is unchanged.
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
