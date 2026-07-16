// The Flutter FrameworkAdapter (WEB/UI) — the FIRST Dart framework adapter, built on
// the shared Dart framework-analysis layer (framework/dart/{analyze,dart-ast}.ts) the
// same way the Elixir fleet is built on framework/elixir/. Net-new; detects against
// pubspec.yaml / pubspec.lock (the `flutter` dep), NOT package.json.
//
// Flutter DECLARES its UI + navigation surface structurally, which we read STATICALLY
// (install-free, never-store-source — parse server-side, persist only the derived
// groups/edges/roles) via the hand-rolled Dart scanner (no repo-code execution).
// parseDartScope pre-scans every in-scope file ONCE (classes / annotations / functions
// / directives) and the three hooks share that one pass:
//
//   * detect()        — the `flutter` dependency. Shallow nested-app detection too (a
//                       `mobile/pubspec.yaml`) + a repo-wide deep fallback.
//   * roleTags        — a widget (`extends StatelessWidget`/`StatefulWidget`/`State<>`/
//                       the Riverpod/Hook widget bases) → `frontend` (role 'screen' if
//                       it's a navigation target OR its name ends Screen/Page/View,
//                       else 'component'); the app entry (a `main()` that `runApp(...)`s)
//                       → `gateway` (role 'app-entry'). METADATA onto the LOCKED
//                       MODULE_KINDS enum; the module's `kind` is unchanged.
//   * syntheticEdges  — THE NAVIGATION SPINE: a route constructor's builder names a
//                       target widget (`GoRoute(builder: … => DetailScreen())`,
//                       `MaterialPageRoute(builder: … => X())`), and a string nav call
//                       (`context.go('/detail')`, `pushNamed('detail')`) resolves
//                       through the route table (literal `path:`/`name:` → widget) —
//                       both → a `calls` edge declaring-file → target-widget-file.
//                       `runApp(Root())` → app-entry → root widget. Navigation the
//                       import graph never names as a verb.
//   * groupingPrior   — a feature folder (`lib/features/<feature>/…`, `lib/screens/
//                       <feature>/…`) holding ≥2 widget files → its own subsystem,
//                       authoritative over the directory heuristic (the Phoenix/Ecto
//                       mechanism). Additive to the workspace partition (per-package).
//
// Dynamic route targets (`context.go(someVar)`) + unresolvable widgets DEGRADE + LOG
// — no silent caps. Everything is deterministic (sorted outputs, ids derived from
// paths/names, lexical tiebreaks; run-twice is byte-identical).
//
// KNOWN best-effort degrades (documented, accepted): `@TypedGoRoute` codegen routers
// (no literal `GoRoute(...)`) yield no route rows; screen-vs-component is a name/route
// heuristic; a file defining many widgets collapses to one file role.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readPubDeps, readPubDepsDeep } from '../../../graph/dart-manifest.js';
import { parseDartScope, type ParsedDartFile } from '../analyze.js';
import { sourceLines } from '../dart-ast.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  FrameworkGroup,
  FrameworkGroupingPrior,
  RoleTag,
} from '../../types.js';
import type { ModuleKind } from '../../../types.js';
import {
  scanRouteConstructions,
  scanRunAppWidget,
  scanNamedNavCalls,
  scanArrowWidgetTargets,
} from './flutter-scan.js';

// ---------------------------------------------------------------------------
// Detection (pubspec → deps; PURE scorer). Never reads source content.

/** Decide the Flutter signal set from a dependency-name set (pure). */
function flutterSignalsFromDeps(deps: Set<string>): { hasFlutter: boolean } {
  return { hasFlutter: deps.has('flutter') };
}

/** Gather the signal set for a single root dir (reads pubspec manifests only). */
export function gatherFlutterSignals(baseDir: string): { hasFlutter: boolean } {
  return flutterSignalsFromDeps(readPubDeps(baseDir));
}

// Non-source dirs the nested scan skips (cheap + can't hold a first-party manifest).
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

/** Immediate subdirs (depth 1) that hold a `pubspec.yaml` — a nested Flutter app. */
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

/**
 * Decide Flutter from the signal set. `flutter` is REQUIRED (a pure Dart CLI/server
 * package is not Flutter — don't claim it). Returns null → generic-Dart fallthrough.
 */
export function scoreFlutter(s: { hasFlutter: boolean }, rootPath = ''): DetectMatch | null {
  if (!s.hasFlutter) return null;
  return {
    adapter: 'flutter',
    confidence: clampConfidence(0.9),
    rootPath,
    metadata: { signals: { flutter: true } },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. A widget renders UI → frontend; the app
// entry is the request/launch entry → gateway. Roles are metadata; the module's
// `kind` is unchanged, never a new kind.
export type FlutterRole = 'app-entry' | 'screen' | 'component';

const ROLE_PRIORITY: Record<FlutterRole, number> = {
  'app-entry': 9,
  screen: 5,
  component: 3,
};
const ROLE_KIND: Record<FlutterRole, ModuleKind> = {
  'app-entry': 'gateway',
  screen: 'frontend',
  component: 'frontend',
};

// The widget superclasses that make a class a Flutter widget → frontend. `State` is
// handled separately (it carries a `State<TheWidget>` type arg).
const WIDGET_SUPERCLASSES = new Set([
  'StatelessWidget',
  'StatefulWidget',
  'InheritedWidget',
  'ConsumerWidget', // Riverpod
  'ConsumerStatefulWidget',
  'HookWidget', // flutter_hooks
  'HookConsumerWidget',
  'StatefulHookConsumerWidget',
]);

// A widget whose NAME ends here reads as a routed screen (the name heuristic).
const SCREEN_SUFFIX_RE = /(Screen|Page|View)$/;

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

// Leading directory segments that are CONTAINERS, not features — stripped before the
// first real feature segment (mirrors the RN adapter's CONTAINER_DIRS idea for Dart).
const CONTAINER_DIRS = new Set([
  'lib',
  'src',
  'ui',
  'widgets',
  'widget',
  'screens',
  'screen',
  'pages',
  'page',
  'views',
  'view',
  'features',
  'feature',
  'modules',
  'module',
  'presentation',
  'app',
]);

/** The base name of a file id (no dir, no `.dart`). */
function baseName(id: string): string {
  const last = id.split('/').pop() ?? id;
  return last.replace(/\.dart$/, '');
}

/**
 * A widget file's feature name: strip leading container dirs, then the first
 * remaining directory segment IS the feature (`lib/features/auth/login.dart` →
 * 'auth'). A file sitting directly in a container (`lib/screens/home.dart`) has no
 * sub-feature dir → undefined (left to directory grouping).
 */
function deriveFeature(fileId: string): string | undefined {
  const segs = fileId.split('/');
  segs.pop(); // drop the filename
  let i = 0;
  while (i < segs.length && CONTAINER_DIRS.has(segs[i].toLowerCase())) i++;
  const first = segs[i];
  return first && first.length > 0 ? first : undefined;
}

// ---------------------------------------------------------------------------
// Analysis.

interface FlutterAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints, kind 'calls'
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface FlutterDiag {
  dynamicNavCalls: number; // context.go(var) etc.
  unresolvedNavTargets: Set<string>; // literal route strings that hit no route-table entry
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, FlutterAnalysis>();

/** Is this parsed file a Flutter widget (defines a widget or a State<> class)? */
function widgetClassNames(parsed: ParsedDartFile): string[] {
  const out: string[] = [];
  for (const c of parsed.classes) {
    if (c.kind !== 'class') continue;
    if (c.superclass && (WIDGET_SUPERCLASSES.has(c.superclass) || c.superclass === 'State')) {
      out.push(c.name);
    }
  }
  return out;
}

/**
 * Does this file declare the app entry — a top-level `main` that calls `runApp`?
 * Comment-aware (via `sourceLines`), like every sibling scanner, so a commented-out
 * `// runApp(...)` never mis-tags a file as the app entry.
 */
function isAppEntry(parsed: ParsedDartFile): boolean {
  if (!parsed.functions.includes('main')) return false;
  return sourceLines(parsed.text).some((l) => /\brunApp\s*\(/.test(l));
}

function addEdge(edges: Map<string, FrameworkEdge>, from: string, to: string, relation: string): void {
  if (from === to) return; // a screen navigating to itself → no edge
  const key = `${from}→${to}`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'flutter', relation } });
  }
}

function analyzeFlutter(ctx: FrameworkContext): FlutterAnalysis {
  const scope = parseDartScope(ctx);
  const diag: FlutterDiag = { dynamicNavCalls: 0, unresolvedNavTargets: new Set() };

  // Pass 1 — the route table (literal path/name → target widget file) + the set of
  // widget classes that are navigation targets + the direct builder→widget edges.
  const edges = new Map<string, FrameworkEdge>();
  const pathToFile = new Map<string, string>();
  const nameToFile = new Map<string, string>();
  const navTargetWidgets = new Set<string>();

  for (const [fileId, parsed] of scope.parsed) {
    for (const rc of scanRouteConstructions(parsed.text)) {
      const targetFile = rc.widget ? scope.resolve(rc.widget) : undefined;
      if (rc.widget && targetFile) {
        navTargetWidgets.add(rc.widget);
        addEdge(edges, fileId, targetFile, `route-${rc.ctor}`);
        if (rc.path) pathToFile.set(rc.path, targetFile);
        if (rc.name) nameToFile.set(rc.name, targetFile);
      }
    }
    // A builder-arrow returning a SCREEN-suffixed widget (`(s) => DetailScreen()`) —
    // catches a custom route wrapper the fixed ctor list can't name (the wonderous
    // `AppRoute` shape). Precision-gated: only a resolvable, screen-suffixed target
    // (never a plain component embed) becomes a nav edge.
    for (const w of scanArrowWidgetTargets(parsed.text)) {
      if (!SCREEN_SUFFIX_RE.test(w)) continue;
      const targetFile = scope.resolve(w);
      if (targetFile) {
        navTargetWidgets.add(w);
        addEdge(edges, fileId, targetFile, 'nav-widget');
      }
    }
    // runApp(Root()) — the app entry mounts its root widget (an edge, but the root
    // widget is the app shell, not a routed screen, so it's NOT a nav-target).
    const root = scanRunAppWidget(parsed.text);
    if (root) {
      const rootFile = scope.resolve(root);
      if (rootFile) addEdge(edges, fileId, rootFile, 'run-app');
    }
  }

  // Pass 2 — string-target nav calls resolved through the route table.
  for (const [fileId, parsed] of scope.parsed) {
    const { targets, dynamic } = scanNamedNavCalls(parsed.text);
    diag.dynamicNavCalls += dynamic;
    for (const t of targets) {
      const targetFile = pathToFile.get(t) ?? nameToFile.get(t);
      if (targetFile) addEdge(edges, fileId, targetFile, 'nav-string');
      else diag.unresolvedNavTargets.add(t);
    }
  }

  // Pass 3 — roles. App entry (gateway) first; then widgets (frontend), screen iff a
  // nav target or a screen-suffixed name, else component.
  const roles = new Map<string, RoleTag>();
  const widgetFiles: string[] = [];
  for (const [fileId, parsed] of scope.parsed) {
    if (isAppEntry(parsed)) {
      roles.set(fileId, {
        role: 'app-entry',
        kind: ROLE_KIND['app-entry'],
        priority: ROLE_PRIORITY['app-entry'],
        metadata: { framework: 'flutter' },
      });
      continue; // app-entry outranks a widget role on the same file
    }
    const widgets = widgetClassNames(parsed);
    if (widgets.length === 0) continue;
    widgetFiles.push(fileId);
    const isScreen = widgets.some((w) => navTargetWidgets.has(w) || SCREEN_SUFFIX_RE.test(w));
    const role: FlutterRole = isScreen ? 'screen' : 'component';
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'flutter' },
    });
  }

  const groups = buildFeatureGroups(widgetFiles);

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  // Positive signal for validation (mirrors phoenix / ecto).
  const screenCount = [...roles.values()].filter((r) => r.role === 'screen').length;
  const componentCount = [...roles.values()].filter((r) => r.role === 'component').length;
  const appEntry = [...roles.values()].filter((r) => r.role === 'app-entry').length;
  if (roles.size > 0 || sortedEdges.length > 0 || groups.length > 0) {
    console.log(
      `  [flutter] ${screenCount} screen(s) · ${componentCount} component(s) · ${appEntry} app-entry · ` +
        `${sortedEdges.length} nav edge(s) · ${groups.length} feature group(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  const degraded: string[] = [];
  if (diag.dynamicNavCalls > 0) degraded.push(`${diag.dynamicNavCalls} dynamic route target(s) (skipped)`);
  if (diag.unresolvedNavTargets.size > 0)
    degraded.push(
      `${diag.unresolvedNavTargets.size} unresolvable route string(s): ${[...diag.unresolvedNavTargets].sort().slice(0, 8).join(' · ')}`,
    );
  if (degraded.length > 0) {
    console.log(`  [flutter] degraded: ${degraded.join(' · ')} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

// A feature folder holding ≥2 widget files → a subsystem (named by the feature dir).
// A lone widget in a feature dir is left to directory grouping (avoids fragmenting a
// layout into identical singleton boxes). Deterministic, collision-free ids.
function buildFeatureGroups(widgetFiles: readonly string[]): FrameworkGroup[] {
  const byFeature = new Map<string, string[]>();
  for (const f of widgetFiles) {
    const feat = deriveFeature(f);
    if (!feat) continue;
    (byFeature.get(feat) ?? byFeature.set(feat, []).get(feat)!).push(f);
  }
  const taken = new Set<string>();
  const groups: FrameworkGroup[] = [];
  for (const feat of [...byFeature.keys()].sort()) {
    const files = byFeature.get(feat)!;
    if (files.length < 2) continue;
    const baseSlug = slugify(feat) || 'feature';
    let id = baseSlug;
    let n = 2;
    while (taken.has(id)) id = `${baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label: humanize(feat) || id, fileIds: [...files].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function getAnalysis(ctx: FrameworkContext): FlutterAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeFlutter(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const flutterAdapter: FrameworkAdapter = {
  name: 'flutter',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreFlutter(gatherFlutterSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      // Nested app (`mobile/pubspec.yaml`) — a shallow scan of immediate subdirs.
      for (const sub of shallowPubspecSubdirs(base)) {
        const m = scoreFlutter(gatherFlutterSignals(join(base, sub)), sub);
        if (m) return m;
      }
      // Repo-wide fallback (FIRES ONLY after root + shallow miss) — a deeply-nested
      // Flutter app in a polyglot monorepo. Union every pubspec's deps; if `flutter`
      // is declared anywhere, detect with rootPath '' (the hooks scan ALL in-scope
      // Dart files). One bounded walk; manifests only, never source content.
      const deep = scoreFlutter(flutterSignalsFromDeps(readPubDepsDeep(ctx.repoDir)), '');
      if (deep) return deep;
    }
    return null;
  },

  // A feature folder of ≥2 widgets → a subsystem, authoritative over directory
  // grouping. Fully deterministic (path-derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // The navigation spine — route builder → widget + string nav → widget (kind
  // 'calls'). File-id endpoints; the step resolves to modules, drops self-edges,
  // dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // widget → frontend (screen/component); app entry → gateway. METADATA; the
  // module's `kind` is unchanged.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE (Dart). Declare the paths the diff-driven hosted walk must
  // treat as framework-relevant. Never-store-source holds: parse server-side, persist
  // only the derived groups/edges/roles.
  scansSourcePath(path: string): boolean {
    return path.endsWith('.dart');
  },
};
