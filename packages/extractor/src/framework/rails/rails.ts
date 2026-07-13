// The Rails FrameworkAdapter (web) — the first Ruby framework adapter, driven by
// the shared Ruby analysis layer (framework/ruby). Rails declares its request
// surface by CONVENTION (app/controllers, config/routes.rb), which we read
// STATICALLY (install-free, never-store-source — parse server-side, persist only
// the derived roles/edges) via Prism.
//
//   * detect()       — the `rails` / `railties` gem.
//   * roleTags       — Rails class conventions onto the LOCKED MODULE_KINDS:
//                      controllers -> gateway, ActionMailer -> job, ActionCable
//                      channels/connections -> gateway, ViewComponent -> frontend,
//                      helpers -> frontend. METADATA; the module's `kind` is finer
//                      in RoleTag.role, never a new kind.
//   * syntheticEdges — the ROUTE SPINE: config/routes.rb -> the controller each
//                      route maps to (kind 'calls'), namespace-aware. This is the
//                      wiring the import graph can't see (Rails routes reference a
//                      controller by a string, not a constant).
//
// Engines are partitioned by the workspace layer (a `*.gemspec` dir is a package),
// so this adapter needs no grouping prior. Unresolvable route targets DEGRADE +
// LOG (no silent caps).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readRubyDeps } from '../../graph/ruby-manifest.js';
import { camelize } from '../../graph/ruby-zeitwerk.js';
import { pluralize, type Inflections } from '../../graph/ruby-inflect.js';
import { parseRubyScope, type RubyScope } from '../ruby/analyze.js';
import {
  collectCalls,
  keywordArg,
  literalValue,
  positionalArgs,
  stringValue,
  symbolValue,
  type RubyClass,
} from '../ruby/ruby-ast.js';
import { BlockNode, CallNode } from '@ruby/prism';
import type { Node } from '@ruby/prism';
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
// Detection (fs → deps; PURE scorer). Never reads source content.

export interface RailsSignals {
  hasRails: boolean; // rails or railties — the authoritative signal
}

export function gatherRailsSignals(baseDir: string): RailsSignals {
  const deps = readRubyDeps(baseDir);
  return { hasRails: deps.has('rails') || deps.has('railties') };
}

export function scoreRails(s: RailsSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasRails) return null;
  return { adapter: 'rails', confidence: clampConfidence(0.9), rootPath, metadata: { framework: 'rails' } };
}

const NESTED_SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'tmp', 'log', 'app', 'lib', 'config', 'db', 'spec', 'test',
]);

/** Immediate subdirs (depth 1) holding a Gemfile — a nested Rails backend. */
function shallowGemfileSubdirs(base: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
    if (existsSync(join(base, e.name, 'Gemfile'))) out.push(e.name);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Roles → locked MODULE_KINDS.

export type RailsRole = 'controller' | 'channel' | 'cable-connection' | 'mailer' | 'view-component' | 'helper';

const ROLE_KIND: Record<RailsRole, ModuleKind> = {
  controller: 'gateway',
  channel: 'gateway',
  'cable-connection': 'gateway',
  mailer: 'job',
  'view-component': 'frontend',
  helper: 'frontend',
};

const ROLE_PRIORITY: Record<RailsRole, number> = {
  controller: 8,
  channel: 7,
  'cable-connection': 6,
  mailer: 5,
  'view-component': 4,
  helper: 3,
};

// Rails' directory + naming convention IS the reliable role signal (every class in
// app/controllers is an XController regardless of inheritance depth). Matches the
// app/<dir> segment anywhere so an engine's own app/controllers is covered too.
function railsRole(fileId: string, cls: RubyClass): RailsRole | undefined {
  const inApp = (sub: string): boolean => new RegExp(`(^|/)app/${sub}/`).test(fileId);
  const name = cls.simpleName;
  if (inApp('controllers') && name.endsWith('Controller')) return 'controller';
  if (inApp('mailers') && name.endsWith('Mailer')) return 'mailer';
  if (inApp('channels') && name.endsWith('Connection')) return 'cable-connection';
  if (inApp('channels') && name.endsWith('Channel')) return 'channel';
  if (inApp('components') && name.endsWith('Component')) return 'view-component';
  if (inApp('helpers') && name.endsWith('Helper')) return 'helper';
  return undefined;
}

// ---------------------------------------------------------------------------
// Route spine — config/routes.rb → controllers.

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'match']);

/** The direct statement nodes inside a call's `do…end` block. */
function blockStatements(call: CallNode): Node[] {
  const block = call.block;
  if (!(block instanceof BlockNode)) return [];
  return block.body ? block.body.compactChildNodes() : [];
}

/** A `"controller/path#action"` string → the namespaced controller constant. */
function controllerFromAction(
  action: string | undefined,
  modulePrefix: string[],
  infl: Inflections,
): string | undefined {
  if (!action || !action.includes('#')) return undefined;
  const ctrlPath = action.split('#')[0];
  if (!ctrlPath) return undefined;
  const parts = ctrlPath.split('/').filter(Boolean).map((p) => camelize(p, infl));
  if (!parts.length) return undefined;
  parts[parts.length - 1] += 'Controller';
  return [...modulePrefix, ...parts].join('::');
}

/** The `"x#y"` action string of a route call (the `to:` kwarg or a positional). */
function actionStringOf(call: CallNode): string | undefined {
  const to = stringValue(keywordArg(call, 'to'));
  if (to) return to;
  for (const a of positionalArgs(call)) {
    const s = stringValue(a);
    if (s && s.includes('#')) return s;
  }
  return undefined;
}

/**
 * Walk a routes block, namespace-aware, emitting the controller constant(s) each
 * route maps to. Each `emit` receives ALTERNATIVE candidates for ONE route
 * directive (resolving any one satisfies it); the caller logs "unresolved" only
 * when the whole set fails, so a defensive fallback candidate never pollutes the
 * degraded log.
 *
 * Handles namespace/scope blocks; resources/resource with a `controller:` override
 * (used VERBATIM — Rails never re-pluralizes an explicit controller), a `module:`
 * kwarg (`resource :inbox, module: :activitypub` → ActivityPub::InboxesController),
 * and real Rails inflection (a singular `resource :inbox` → the plural
 * `InboxesController`, not the naive `inboxs`); the HTTP verbs + match; and root.
 */
function walkRoutes(
  statements: Node[],
  modulePrefix: string[],
  infl: Inflections,
  emit: (candidates: string[]) => void,
): void {
  for (const stmt of statements) {
    if (!(stmt instanceof CallNode)) continue;
    const name = stmt.name;

    if (name === 'namespace') {
      const seg = symbolValue(positionalArgs(stmt)[0]) ?? stringValue(positionalArgs(stmt)[0]);
      walkRoutes(blockStatements(stmt), seg ? [...modulePrefix, camelize(seg, infl)] : modulePrefix, infl, emit);
    } else if (name === 'scope') {
      const mod = literalValue(keywordArg(stmt, 'module'));
      walkRoutes(blockStatements(stmt), mod ? [...modulePrefix, camelize(mod, infl)] : modulePrefix, infl, emit);
    } else if (name === 'resources' || name === 'resource') {
      // A `module:` kwarg namespaces this resource's controller (and its nested
      // routes): `resource :inbox, module: :activitypub` → ActivityPub::Inboxes…
      const mod = literalValue(keywordArg(stmt, 'module'));
      const prefix = mod ? [...modulePrefix, camelize(mod, infl)] : modulePrefix;
      const ctrl = (base: string): string => [...prefix, `${camelize(base, infl)}Controller`].join('::');
      const override = literalValue(keywordArg(stmt, 'controller'));
      if (override) {
        // An explicit controller is used exactly — no pluralization guessing.
        emit([ctrl(override)]);
      } else {
        const bases = positionalArgs(stmt)
          .map((a) => symbolValue(a) ?? stringValue(a))
          .filter(Boolean) as string[];
        for (const base of bases) {
          // `resource :inbox` (singular) → the PLURAL controller (InboxesController);
          // `resources :posts` (plural) → the name as-is. Emit both spellings as
          // alternatives so we resolve either without a false miss.
          const plural = pluralize(base, infl);
          const cands = name === 'resource' ? [plural, base] : [base, plural];
          emit([...new Set(cands)].map(ctrl));
        }
      }
      walkRoutes(blockStatements(stmt), prefix, infl, emit); // nested resources / member / collection
    } else if (name === 'root') {
      const c = controllerFromAction(
        stringValue(keywordArg(stmt, 'to')) ?? stringValue(positionalArgs(stmt)[0]),
        modulePrefix,
        infl,
      );
      if (c) emit([c]);
    } else if (HTTP_VERBS.has(name)) {
      const c = controllerFromAction(actionStringOf(stmt), modulePrefix, infl);
      if (c) emit([c]);
    } else if (stmt.block) {
      // an unknown directive carrying a block (concern, constraints, scope variants) —
      // recurse with the same prefix so nested routes aren't lost.
      walkRoutes(blockStatements(stmt), modulePrefix, infl, emit);
    }
  }
}

function isRoutesFile(fileId: string): boolean {
  return /(^|\/)config\/routes\.rb$/.test(fileId);
}

// ---------------------------------------------------------------------------
// Analysis (parse once; roles + edges). Async — Prism loads its WASI module once.

interface RailsAnalysis {
  roles: Map<string, RoleTag>;
  edges: FrameworkEdge[];
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<RailsAnalysis>>();

function addEdge(edges: Map<string, FrameworkEdge>, from: string, to: string): void {
  if (from === to) return;
  const key = `${from}→${to}`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'rails', relation: 'route' } });
  }
}

async function analyzeRails(ctx: FrameworkContext): Promise<RailsAnalysis> {
  const scope: RubyScope = await parseRubyScope(ctx);

  // Roles — the highest-priority Rails role per file.
  const roleByFile = new Map<string, RailsRole>();
  for (const [fileId, parsed] of scope.parsed) {
    for (const cls of parsed.classes) {
      const role = railsRole(fileId, cls);
      if (!role) continue;
      const cur = roleByFile.get(fileId);
      if (cur === undefined || ROLE_PRIORITY[role] > ROLE_PRIORITY[cur]) roleByFile.set(fileId, role);
    }
  }
  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, { role, kind: ROLE_KIND[role], priority: ROLE_PRIORITY[role], metadata: { framework: 'rails' } });
  }

  // Route spine — each config/routes.rb → the controllers its routes map to.
  const edges = new Map<string, FrameworkEdge>();
  const unresolved = new Set<string>();
  for (const [fileId, parsed] of scope.parsed) {
    if (!isRoutesFile(fileId)) continue;
    for (const draw of collectCalls(parsed.node)) {
      if (draw.name !== 'draw' || !(draw.block instanceof BlockNode)) continue;
      walkRoutes(blockStatements(draw), [], scope.inflections, (candidates) => {
        // Resolve the first candidate that hits; a route directive is only
        // "unresolved" when EVERY spelling it could map to is absent.
        const hit = candidates.map((c) => scope.resolve(c)).find(Boolean);
        if (hit) addEdge(edges, fileId, hit);
        else if (candidates.length) unresolved.add(candidates[0]);
      });
    }
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(`  [rails] ${roles.size} role(s) · ${sortedEdges.length} route edge(s)`);
  }
  if (unresolved.size > 0) {
    console.log(
      `  [rails] degraded: ${unresolved.size} route target(s) unresolved: ${[...unresolved].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`,
    );
  }
  return { roles, edges: sortedEdges };
}

function getAnalysis(ctx: FrameworkContext): Promise<RailsAnalysis> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeRails(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const railsAdapter: FrameworkAdapter = {
  name: 'rails',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreRails(gatherRailsSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowGemfileSubdirs(base)) {
        const m = scoreRails(gatherRailsSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // config/routes.rb → controller (kind 'calls'). File-id endpoints; the step
  // resolves to modules, drops self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return (await getAnalysis(ctx)).edges;
  },

  // Rails class conventions → roles on the locked MODULE_KINDS. METADATA only.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return (await getAnalysis(ctx)).roles;
  },

  // The hooks READ SOURCE (Ruby). Declare the paths the diff-driven hosted walk
  // must treat as framework-relevant. Never-store-source holds.
  scansSourcePath(path: string): boolean {
    return path.endsWith('.rb');
  },
};
