// The Flutter state-management FrameworkAdapter (the "service"-tier data holders) —
// the Dart sibling of the Elixir Oban / Python-orm role adapters, built on the shared
// Dart framework-analysis layer. Net-new; detects against pubspec (the
// riverpod/provider/bloc/get deps), NOT package.json. Covers the FOUR dominant Flutter
// state libraries in one adapter (they frequently co-exist in one app).
//
//   * detect()        — any of `flutter_bloc`/`bloc`, `provider`, `riverpod`/
//                       `flutter_riverpod`, `get`.
//   * roleTags        — a state holder → `service` (own backend-of-the-UI compute):
//                       `extends Bloc<>` → 'bloc', `extends Cubit<>` → 'cubit',
//                       `extends ChangeNotifier` → 'provider', `@riverpod` / `extends
//                       Notifier<>`/`AsyncNotifier<>`/`StateNotifier<>` → 'notifier',
//                       `extends GetxController` → 'controller'. METADATA onto the
//                       LOCKED MODULE_KINDS enum; the module's `kind` is unchanged.
//   * syntheticEdges  — THE CONSUMPTION SPINE (verb `reads`, best-effort): a widget
//                       consuming a state holder via a literal type arg (`BlocBuilder<
//                       T>`, `Consumer<T>`, `context.watch<T>()`, `Provider.of<T>()`)
//                       → a `reads` edge widget-file → state-holder-file, resolved
//                       through the class registry. A Riverpod `ref.watch(fooProvider)`
//                       resolves through the provider→notifier binding (or a codegen-
//                       name heuristic) when `fooProvider` is a resolvable declaration,
//                       else DEGRADES + LOGS. GetX consumption is deliberately skipped.
//
// Dynamic / unresolvable consumption DEGRADES + LOGS — no silent caps. Everything is
// deterministic (sorted outputs; run-twice is byte-identical).
//
// KNOWN best-effort degrades (documented, accepted): a Riverpod provider var is often
// codegen-generated, so `ref.watch` resolves only for a declared/name-matchable
// provider; GetX consumption yields no edges (role only); a state holder wrapping its
// state in a separate class edges to the holder, not the state.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readPubDeps, readPubDepsDeep } from '../../../graph/dart-manifest.js';
import { parseDartScope, type ParsedDartFile } from '../analyze.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  RoleTag,
} from '../../types.js';
import type { ModuleKind } from '../../../types.js';
import { scanTypeArgConsumers, scanProviderDecls, scanRefReads } from './state-scan.js';

// ---------------------------------------------------------------------------
// Detection (pubspec → deps; PURE scorer). Never reads source content.

export interface StateSignals {
  hasBloc: boolean; // flutter_bloc / bloc
  hasProvider: boolean; // provider
  hasRiverpod: boolean; // riverpod / flutter_riverpod
  hasGetx: boolean; // get
}

function stateSignalsFromDeps(deps: Set<string>): StateSignals {
  return {
    hasBloc: deps.has('flutter_bloc') || deps.has('bloc'),
    hasProvider: deps.has('provider'),
    hasRiverpod: deps.has('riverpod') || deps.has('flutter_riverpod') || deps.has('hooks_riverpod'),
    hasGetx: deps.has('get'),
  };
}

export function gatherStateSignals(baseDir: string): StateSignals {
  return stateSignalsFromDeps(readPubDeps(baseDir));
}

const NESTED_SKIP_DIRS = new Set([
  'node_modules',
  '.dart_tool',
  'build',
  'ios',
  'android',
  '.pub-cache',
  '.symlinks',
  '.fvm',
  'dist',
  'out',
]);

function shallowPubspecSubdirs(base: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
    if (existsSync(join(base, e.name, 'pubspec.yaml'))) out.push(e.name);
  }
  return out.sort();
}

/** Decide state-management from the signal set. Any of the four libs matches. */
export function scoreState(s: StateSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasBloc && !s.hasProvider && !s.hasRiverpod && !s.hasGetx) return null;
  const n = [s.hasBloc, s.hasProvider, s.hasRiverpod, s.hasGetx].filter(Boolean).length;
  return {
    adapter: 'flutter-state',
    confidence: clampConfidence(0.8 + 0.03 * (n - 1)),
    rootPath,
    metadata: {
      signals: { bloc: s.hasBloc, provider: s.hasProvider, riverpod: s.hasRiverpod, getx: s.hasGetx },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → the LOCKED `service` kind. A state holder is own backend-of-the-UI
// compute — service altitude (the python-orm 'model'→service / Ecto 'schema'→service
// precedent). Roles are metadata; the module's `kind` is unchanged, never a new kind.
export type StateRole = 'bloc' | 'cubit' | 'provider' | 'notifier' | 'controller';

const STATE_ROLES: readonly StateRole[] = ['bloc', 'cubit', 'provider', 'notifier', 'controller'];
const ROLE_KIND: ModuleKind = 'service';
// Equal priority — a file usually holds one state holder; a lexical tiebreak keeps a
// rare multi-role file deterministic. All outrank a generic module (priority 5).
const ROLE_PRIORITY = 5;

// The GetX controller bases (explicit — a bare `*Controller` suffix is too broad,
// it collides with TextEditingController / AnimationController / a plain custom
// controller, so GetX stays an allow-list).
const GETX_CONTROLLER_BASES = new Set([
  'GetxController',
  'GetXController',
  'FullLifeCycleController',
  'SuperController',
]);

/**
 * The state role a superclass name implies, or undefined. SUFFIX-based for the
 * bloc/notifier families so it catches the library variants AND an app's own base
 * class in one rule: `HydratedCubit`/`ReplayCubit`/`AppCubit` → cubit; `HydratedBloc`/
 * `AppBloc` → bloc; `AsyncNotifier`/`StateNotifier`/`AutoDisposeNotifier` → notifier.
 * `ChangeNotifier` (the provider package's base) is special-cased to 'provider' BEFORE
 * the generic `*Notifier` rule. GetX stays an explicit allow-list.
 */
function roleForSuperclass(sc: string): StateRole | undefined {
  if (sc === 'ChangeNotifier') return 'provider';
  if (sc.endsWith('Cubit')) return 'cubit';
  if (sc.endsWith('Bloc')) return 'bloc';
  if (sc.endsWith('Notifier')) return 'notifier';
  if (GETX_CONTROLLER_BASES.has(sc)) return 'controller';
  return undefined;
}

// ---------------------------------------------------------------------------
// Analysis.

interface StateAnalysis {
  edges: FrameworkEdge[]; // file-id endpoints, kind 'reads'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface StateDiag {
  dynamicRefReads: number;
  unresolvedProviders: Set<string>;
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, StateAnalysis>();

/** The state role of a file (from its classes / a `@riverpod` annotation), or undefined. */
function fileStateRole(parsed: ParsedDartFile): StateRole | undefined {
  let best: StateRole | undefined;
  const consider = (role: StateRole): void => {
    if (best === undefined || STATE_ROLES.indexOf(role) < STATE_ROLES.indexOf(best)) best = role;
  };
  for (const c of parsed.classes) {
    if (c.kind !== 'class') continue;
    const role = c.superclass ? roleForSuperclass(c.superclass) : undefined;
    if (role) consider(role);
    // `class Foo with ChangeNotifier` — the mixin form of a provider state holder.
    if (c.mixins.includes('ChangeNotifier')) consider('provider');
  }
  // Riverpod codegen: a `@riverpod` class OR function → a notifier/provider.
  if (parsed.annotations.some((a) => a === 'riverpod' || a === 'Riverpod')) consider('notifier');
  return best;
}

function addEdge(edges: Map<string, FrameworkEdge>, from: string, to: string, relation: string): void {
  if (from === to) return; // a state holder reading itself → no edge
  const key = `${from}→${to}`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'reads', metadata: { framework: 'flutter-state', relation } });
  }
}

/** Capitalize the first letter (`foo` → `Foo`) for the codegen provider-name heuristic. */
function capitalize(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function analyzeState(ctx: FrameworkContext): StateAnalysis {
  const scope = parseDartScope(ctx);
  const diag: StateDiag = { dynamicRefReads: 0, unresolvedProviders: new Set() };

  // Pass 1 — roles + the state-holder class registry (class name → file).
  const roles = new Map<string, RoleTag>();
  const stateHolderClassToFile = new Map<string, string>();
  for (const [fileId, parsed] of scope.parsed) {
    const role = fileStateRole(parsed);
    if (!role) continue;
    roles.set(fileId, { role, kind: ROLE_KIND, priority: ROLE_PRIORITY, metadata: { framework: 'flutter-state' } });
    for (const c of parsed.classes) {
      if (c.kind === 'class' && c.name && !stateHolderClassToFile.has(c.name)) {
        stateHolderClassToFile.set(c.name, fileId);
      }
    }
  }

  // The Riverpod provider→notifier binding map (providerVar → notifier class), unioned
  // across all files (a provider is declared once, read anywhere).
  const providerVarToClass = new Map<string, string>();
  for (const [, parsed] of scope.parsed) {
    for (const d of scanProviderDecls(parsed.text)) {
      if (d.notifierClass && !providerVarToClass.has(d.providerVar)) {
        providerVarToClass.set(d.providerVar, d.notifierClass);
      }
    }
  }

  // Pass 2 — the consumption spine.
  const edges = new Map<string, FrameworkEdge>();
  for (const [fileId, parsed] of scope.parsed) {
    // (a) type-arg consumers: BlocBuilder<T> / Consumer<T> / context.watch<T>() → T.
    for (const cls of scanTypeArgConsumers(parsed.text)) {
      const targetFile = scope.resolve(cls);
      if (targetFile) addEdge(edges, fileId, targetFile, 'type-arg');
    }
    // (b) Riverpod ref.watch(fooProvider): provider var → notifier class → file.
    const { providerVars, dynamic } = scanRefReads(parsed.text);
    diag.dynamicRefReads += dynamic;
    for (const v of providerVars) {
      const declared = providerVarToClass.get(v);
      let targetFile: string | undefined;
      if (declared) {
        // An EXPLICIT `NotifierProvider<TheNotifier, …>` binding — trust it (resolve
        // the named class to any in-repo file).
        targetFile = scope.resolve(declared);
      } else if (v.endsWith('Provider')) {
        // The codegen NAME heuristic (`fooProvider` → `Foo`) is guessy — an app can
        // have BOTH a `userProvider` and an unrelated `User` model. Require the guessed
        // class to be an actual STATE HOLDER, so it can't mis-edge to a plain model.
        targetFile = stateHolderClassToFile.get(capitalize(v.slice(0, -'Provider'.length)));
      }
      if (targetFile) addEdge(edges, fileId, targetFile, 'ref-watch');
      else diag.unresolvedProviders.add(v);
    }
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  // Positive signal for validation (mirrors the other adapters).
  const byRole: Record<string, number> = {};
  for (const r of roles.values()) byRole[r.role] = (byRole[r.role] ?? 0) + 1;
  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [flutter-state] ${roles.size} state holder(s) [${Object.entries(byRole).map(([k, v]) => `${k}:${v}`).join(' ')}] · ${sortedEdges.length} reads edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  const degraded: string[] = [];
  if (diag.dynamicRefReads > 0) degraded.push(`${diag.dynamicRefReads} dynamic ref.watch target(s) (skipped)`);
  if (diag.unresolvedProviders.size > 0)
    degraded.push(
      `${diag.unresolvedProviders.size} unresolvable provider var(s): ${[...diag.unresolvedProviders].sort().slice(0, 8).join(' · ')}`,
    );
  if (degraded.length > 0) {
    console.log(`  [flutter-state] degraded: ${degraded.join(' · ')} (logged, not silently dropped)`);
  }

  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): StateAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeState(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const stateAdapter: FrameworkAdapter = {
  name: 'flutter-state',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreState(gatherStateSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowPubspecSubdirs(base)) {
        const m = scoreState(gatherStateSignals(join(base, sub)), sub);
        if (m) return m;
      }
      const deep = scoreState(stateSignalsFromDeps(readPubDepsDeep(ctx.repoDir)), '');
      if (deep) return deep;
    }
    return null;
  },

  // Widget → state-holder consumption (kind 'reads'). File-id endpoints; the step
  // resolves to modules, drops self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // Bloc/Cubit/ChangeNotifier/Notifier/GetxController → the LOCKED `service` kind.
  // METADATA; the module's `kind` is unchanged.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  scansSourcePath(path: string): boolean {
    return path.endsWith('.dart');
  },
};
