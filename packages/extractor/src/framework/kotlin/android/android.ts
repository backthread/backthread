// The Android FrameworkAdapter (web / UI) — the FIRST Kotlin framework adapter, built on
// the shared Kotlin framework-analysis layer (framework/kotlin/{analyze,kotlin-ast}.ts)
// the same way the Elixir fleet is built on framework/elixir/. Net-new; detects against
// an AndroidManifest.xml OR `androidx.*` Gradle deps, NOT package.json.
//
// Android DECLARES its UI surface structurally, which we read STATICALLY (install-free,
// never-store-source — parse server-side, persist only the derived groups/edges/roles)
// via the hand-rolled Kotlin scanner (no WASM, never executes repo code) plus a minimal
// regex scan of AndroidManifest.xml (no XML parser dependency). parseKotlinScope
// pre-scans every in-scope `.kt` file ONCE (types + supertypes + annotations, top-level
// funcs, call names); the three hooks share that one pass:
//
//   * detect()        — an AndroidManifest.xml present anywhere, OR an `androidx.*`
//                       dependency group (the two authoritative Android signals). PURE.
//   * roleTags        — THE HEADLINE. A class's SUPERTYPE places it on the locked
//                       MODULE_KINDS: Activity/Fragment/custom-View → frontend; a file
//                       declaring a top-level `@Composable fun` → frontend ('composable');
//                       ViewModel/AndroidViewModel → service ('view-model'); an Android
//                       Service → service; BroadcastReceiver/ContentProvider → gateway;
//                       Worker/CoroutineWorker/ListenableWorker → job ('worker', LOW
//                       priority so a background-sync module that also holds service code
//                       isn't mislabeled a job). The AndroidManifest's declared
//                       <activity|service|receiver|provider> components are resolved to
//                       their files and tagged authoritatively (catching a component whose
//                       supertype is a project-local base we can't follow). METADATA onto
//                       the LOCKED enum; the module's `kind` is unchanged, never a new one.
//   * syntheticEdges  — navigation the import graph never names as a verb: an
//                       `Intent(ctx, X::class.java)` / `startActivity(...)` launch → a
//                       `calls` edge to X's file, and a Navigation-Compose
//                       `composable(...) { XScreen() }` route → a `calls` edge to the
//                       destination screen's file. Resolved through the FQN registry;
//                       unresolvable / dynamic targets DEGRADE + LOG.
//   * groupingPrior   — a `feature/<name>/` (or `features/`/`ui/`) directory → its own
//                       subsystem, additive to the Gradle multi-module partition (which
//                       already splits a `feature/foryou/` module into its own subsystem;
//                       this claims the single-module `feature/<name>/` sub-tree layout).
//
// Everything deterministic (sorted outputs, ids derived from paths/names, lexical
// tiebreaks; run-twice is byte-identical). KNOWN degrades (documented): a custom
// navigation abstraction (e.g. Navigation-3 `NavKey`/`Navigator`) is not the standard
// `NavHost { composable {} }` spine, so its route edges aren't recovered; a multi-line
// `Intent(...)` split across lines resolves only its same-line `::class` refs; a Service
// role relies on a known Android base class or a manifest `<service>` (a domain
// `*Service` that extends neither is NOT mislabeled a Service).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readGradleDeps, readGradleDepsDeep } from '../../../graph/kotlin-manifest.js';
import { parseKotlinScope, type KotlinScope, type ParsedKotlinFile } from '../analyze.js';
import { sourceLines } from '../kotlin-ast.js';
import { scanAndroidManifests, type ManifestComponent } from './android-manifest.js';
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

// ---------------------------------------------------------------------------
// Detection (AndroidManifest presence OR androidx.* deps; PURE-ish — reads config
// existence + Gradle manifests only, never application source).

export interface AndroidSignals {
  hasAndroidx: boolean; // an androidx.* dependency group — the authoritative signal
  hasManifest: boolean; // an AndroidManifest.xml present (component registry)
}

/** Does a dependency-group set contain an `androidx.*` (or the Android material) group? */
function depsLookAndroid(deps: ReadonlySet<string>): boolean {
  for (const g of deps) {
    if (g === 'androidx' || g.startsWith('androidx.') || g === 'com.google.android.material') return true;
  }
  return false;
}

// Non-source dirs the AndroidManifest walk skips (cheap; can't hold first-party source).
const MANIFEST_SKIP_DIRS = new Set([
  'node_modules',
  'build',
  '.gradle',
  '.idea',
  '.kotlin',
  'buildSrc',
  'build-logic',
  'dist',
  'out',
]);
const MANIFEST_WALK_MAX_DEPTH = 8;

/** Does the repo contain an AndroidManifest.xml anywhere (bounded walk)? */
export function hasAndroidManifest(repoDir: string): boolean {
  let found = false;
  const walk = (dir: string, depth: number): void => {
    if (found || depth > MANIFEST_WALK_MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'AndroidManifest.xml')) {
      found = true;
      return;
    }
    for (const e of entries) {
      if (found) return;
      if (!e.isDirectory() || e.name.startsWith('.') || MANIFEST_SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(repoDir, 0);
  return found;
}

/** Gather the Android signal set for a base dir (Gradle deps + manifest presence). */
export function gatherAndroidSignals(baseDir: string): AndroidSignals {
  return {
    hasAndroidx: depsLookAndroid(readGradleDeps(baseDir)) || depsLookAndroid(readGradleDepsDeep(baseDir)),
    hasManifest: existsSync(join(baseDir, 'AndroidManifest.xml')) || hasAndroidManifest(baseDir),
  };
}

/**
 * Decide Android from the signal set. Either an AndroidManifest OR an androidx.* dep is
 * sufficient. Returns null → generic-Kotlin fallthrough, byte-for-byte unchanged.
 */
export function scoreAndroid(s: AndroidSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasAndroidx && !s.hasManifest) return null;
  let confidence = 0.8;
  if (s.hasAndroidx && s.hasManifest) confidence += 0.1;
  return {
    adapter: 'android',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: { signals: { androidx: s.hasAndroidx, manifest: s.hasManifest } },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind` is
// unchanged. Activity/Fragment/Composable/View render UI → frontend; ViewModel + Service
// are own backend compute → service; BroadcastReceiver/ContentProvider are entry points →
// gateway; a WorkManager Worker is schedule/queue-triggered → job.
export type AndroidRole =
  | 'activity'
  | 'fragment'
  | 'composable'
  | 'view'
  | 'view-model'
  | 'service'
  | 'receiver'
  | 'provider'
  | 'worker';

// Collapse priority when one FILE carries several roles, AND downstream when several
// files of different roles land in one MODULE after clustering (the contribute-step keeps
// the highest). A UI role outranks a service; `worker` is LOWEST (a background-sync module
// that also holds a repository/service is labeled by the service, not the job — the
// documented "background-sync mislabel" fix).
const ROLE_PRIORITY: Record<AndroidRole, number> = {
  activity: 9,
  fragment: 8,
  composable: 7,
  view: 6,
  receiver: 5,
  provider: 4,
  service: 3,
  'view-model': 2,
  worker: 1,
};
const ROLE_KIND: Record<AndroidRole, ModuleKind> = {
  activity: 'frontend',
  fragment: 'frontend',
  composable: 'frontend',
  view: 'frontend',
  'view-model': 'service',
  service: 'service',
  receiver: 'gateway',
  provider: 'gateway',
  worker: 'job',
};

// Known Android Service base classes (a domain `*Service` that extends none of these is
// NOT a Service — accuracy over a name-suffix guess).
const SERVICE_BASES = new Set([
  'Service',
  'IntentService',
  'JobIntentService',
  'LifecycleService',
  'FirebaseMessagingService',
  'TileService',
  'InputMethodService',
  'AccessibilityService',
  'NotificationListenerService',
  'HostApduService',
  'WallpaperService',
  'MediaBrowserServiceCompat',
]);
const WORKER_BASES = new Set(['Worker', 'CoroutineWorker', 'ListenableWorker', 'RxWorker']);
const VIEW_BASES = new Set([
  'View',
  'ViewGroup',
  'SurfaceView',
  'TextureView',
  'GLSurfaceView',
  'AbstractComposeView',
]);

/** The Android role a class's supertype list implies, or undefined. Priority-ordered. */
export function roleFromSupertypes(supertypes: readonly string[]): AndroidRole | undefined {
  const has = (pred: (s: string) => boolean): boolean => supertypes.some(pred);
  if (has((s) => s.endsWith('Activity'))) return 'activity';
  if (has((s) => s.endsWith('Fragment'))) return 'fragment';
  if (has((s) => s.endsWith('ViewModel'))) return 'view-model';
  if (has((s) => WORKER_BASES.has(s))) return 'worker';
  if (has((s) => SERVICE_BASES.has(s))) return 'service';
  if (has((s) => s === 'BroadcastReceiver' || s.endsWith('BroadcastReceiver'))) return 'receiver';
  if (has((s) => s === 'ContentProvider' || s.endsWith('ContentProvider'))) return 'provider';
  if (has((s) => VIEW_BASES.has(s) || s.endsWith('Layout'))) return 'view';
  return undefined;
}

// A manifest component tag → its role.
const MANIFEST_TAG_ROLE: Record<ManifestComponent['tag'], AndroidRole> = {
  activity: 'activity',
  service: 'service',
  receiver: 'receiver',
  provider: 'provider',
};

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

// ---------------------------------------------------------------------------
// Feature-folder grouping.

// The directory segments whose CHILD names a feature subsystem (`feature/foryou/…`).
const FEATURE_PARENT_SEGS = new Set(['feature', 'features']);

interface GroupSeed {
  key: string; // the feature name
  fileIds: string[];
}

/**
 * Group files by their `feature/<name>/` (or `features/<name>/`) directory segment → a
 * per-feature subsystem. Additive to the Gradle module partition: on a multi-module repo
 * each `feature/<name>/` is already its own module/subsystem, so this only claims a
 * single-module app's `feature/<name>/` sub-tree. A file under no feature segment is left
 * to directory grouping.
 */
export function buildFeatureGroups(ktFiles: readonly string[]): FrameworkGroup[] {
  const byFeature = new Map<string, string[]>();
  for (const id of ktFiles) {
    const segs = id.split('/');
    for (let i = 0; i < segs.length - 2; i++) {
      if (FEATURE_PARENT_SEGS.has(segs[i].toLowerCase())) {
        const name = segs[i + 1];
        (byFeature.get(name) ?? byFeature.set(name, []).get(name)!).push(id);
        break;
      }
    }
  }
  const seeds: GroupSeed[] = [...byFeature]
    .filter(([, files]) => files.length >= 2)
    .map(([key, fileIds]) => ({ key, fileIds }));
  return assignGroups(seeds);
}

// Deterministic, collision-free group ids (sorted by key; a slug collision takes a
// numeric suffix). Identical run-to-run (the snapshot grouping-stability invariant).
function assignGroups(seeds: GroupSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const byKey = [...seeds].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of byKey) {
    const base = slugify(seed.key) || 'feature';
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    taken.add(id);
    groups.push({ id, label: humanize(seed.key), fileIds: [...new Set(seed.fileIds)].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Navigation-edge extraction.

// A launch context (Intent / startActivity / setClass) on the same line as a
// `Type::class` reference names the destination component.
const LAUNCH_LINE_RE = /\b(?:Intent|startActivity|startActivityForResult|startService|setClass)\b/;
const CLASS_REF_RE = /\b([A-Z][A-Za-z0-9_]*)::class/g;
// A Navigation-Compose route builder opening a destination lambda.
const COMPOSABLE_CALL_RE = /\bcomposable\s*[(<]/;
// The first composable INVOCATION inside a route lambda (a PascalCase name + `(`).
const COMPOSABLE_INVOKE_RE = /\b([A-Z][A-Za-z0-9_]*)\s*\(/;

/**
 * Navigation edges out of ONE file: Intent/startActivity `X::class` launches + a
 * Navigation-Compose `composable(...) { XScreen(...) }` route destination. Each resolved
 * to a first-party file via `resolveTypeRef`; returns `{ target, relation }` pairs
 * (target = file id). Unresolvable / dynamic targets are dropped (returned in `dropped`).
 */
export function scanNavTargets(
  parsed: ParsedKotlinFile,
  scope: KotlinScope,
): { edges: Array<{ target: string; relation: string }>; dropped: number } {
  const lines = sourceLines(parsed.text);
  const edges: Array<{ target: string; relation: string }> = [];
  let dropped = 0;
  const emit = (name: string, relation: string): void => {
    const target = scope.resolveTypeRef(name, parsed);
    if (target) edges.push({ target, relation });
    else dropped++;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Intent / startActivity launches on this line.
    if (LAUNCH_LINE_RE.test(line)) {
      for (const m of line.matchAll(CLASS_REF_RE)) emit(m[1], 'launch');
    }
    // Navigation-Compose route → the first composable invoked in the lambda body.
    if (COMPOSABLE_CALL_RE.test(line)) {
      const target = firstComposableInBlock(lines, i);
      if (target) emit(target, 'nav-destination');
    }
  }
  return { edges, dropped };
}

/**
 * The first composable INVOCATION (`XScreen(...)`) inside the brace block a `composable`
 * call opens, scanning from `start` to the matching `}` (bounded). Returns the invoked
 * composable's simple name, or undefined (an inline lambda with no single screen call).
 */
function firstComposableInBlock(lines: string[], start: number): string | undefined {
  // Find the `{` that opens the route lambda (this line or a following one).
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length && i < start + 40; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
        if (opened && depth <= 0) return undefined; // block closed with no screen call
      }
    }
    if (!opened) continue;
    // Inside the block: the first PascalCase invocation that is NOT the `composable` call.
    const m = lines[i].match(COMPOSABLE_INVOKE_RE);
    if (m && i > start) return m[1];
    if (i === start) {
      // On the opening line, look AFTER the `{`.
      const brace = lines[i].indexOf('{');
      const after = brace >= 0 ? lines[i].slice(brace + 1) : '';
      const mm = after.match(COMPOSABLE_INVOKE_RE);
      if (mm) return mm[1];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Analysis.

interface AndroidAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[];
  roles: Map<string, RoleTag>;
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, AndroidAnalysis>();

function addEdge(edges: Map<string, FrameworkEdge>, from: string, to: string, relation: string): void {
  if (from === to) return;
  const key = `${from}→${to}`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'android', relation } });
  }
}

function analyzeAndroid(ctx: FrameworkContext): AndroidAnalysis {
  const scope = parseKotlinScope(ctx);
  const roleByFile = new Map<string, AndroidRole>();
  const addRole = (fileId: string, role: AndroidRole): void => {
    const cur = roleByFile.get(fileId);
    if (
      cur === undefined ||
      ROLE_PRIORITY[role] > ROLE_PRIORITY[cur] ||
      (ROLE_PRIORITY[role] === ROLE_PRIORITY[cur] && role < cur)
    ) {
      roleByFile.set(fileId, role);
    }
  };

  // Pass 1 — supertype + @Composable roles.
  for (const [id, parsed] of scope.parsed) {
    for (const t of parsed.types) {
      const role = roleFromSupertypes(t.supertypes);
      if (role) addRole(id, role);
    }
    if (parsed.funs.some((f) => f.annotations.includes('Composable'))) addRole(id, 'composable');
  }

  // Pass 2 — AndroidManifest components (authoritative), resolved to their files. A
  // fully-qualified `android:name` resolves via the FQN registry; a relative name whose
  // manifest package is unknown (modern AGP `namespace`) resolves by its SIMPLE NAME
  // (last registry segment; first sorted-id wins a collision — deterministic).
  const simpleNameIndex = new Map<string, string>();
  for (const [fqn, file] of scope.moduleIndex) {
    const simple = fqn.slice(fqn.lastIndexOf('.') + 1);
    if (!simpleNameIndex.has(simple)) simpleNameIndex.set(simple, file);
  }
  let unresolvedComponents = 0;
  for (const comp of scanAndroidManifests(ctx.repoDir, ctx.rootPath)) {
    const target = (comp.fqn && scope.resolve(comp.fqn)) || simpleNameIndex.get(comp.simpleName);
    if (target && scope.internalIds.has(target)) addRole(target, MANIFEST_TAG_ROLE[comp.tag]);
    else unresolvedComponents++;
  }

  // Pass 3 — navigation edges (Intent launches + Navigation-Compose destinations).
  const edges = new Map<string, FrameworkEdge>();
  let droppedNav = 0;
  for (const [id, parsed] of scope.parsed) {
    const { edges: navs, dropped } = scanNavTargets(parsed, scope);
    droppedNav += dropped;
    for (const nav of navs) addEdge(edges, id, nav.target, nav.relation);
  }

  const groups = buildFeatureGroups(scope.ktFiles);

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'android' },
    });
  }
  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  // Positive signal for validation (mirrors the Elixir fleet's log discipline).
  if (roleByFile.size > 0 || groups.length > 0 || sortedEdges.length > 0) {
    const counts = new Map<AndroidRole, number>();
    for (const r of roleByFile.values()) counts.set(r, (counts.get(r) ?? 0) + 1);
    const roleSummary = [...counts].sort().map(([r, n]) => `${n} ${r}`).join(', ');
    console.log(
      `  [android] ${roleByFile.size} role(s) [${roleSummary}] · ${groups.length} feature group(s) · ${sortedEdges.length} nav edge(s)`,
    );
  }
  const degraded: string[] = [];
  if (unresolvedComponents > 0) degraded.push(`${unresolvedComponents} manifest component(s) unresolved`);
  if (droppedNav > 0) degraded.push(`${droppedNav} nav target(s) unresolvable/dynamic`);
  if (degraded.length > 0) console.log(`  [android] degraded: ${degraded.join(' · ')} (logged, not silently dropped)`);

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): AndroidAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeAndroid(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const androidAdapter: FrameworkAdapter = {
  name: 'android',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreAndroid(gatherAndroidSignals(base), rootPath);
  },

  // A `feature/<name>/` directory → its own subsystem, additive to the Gradle module
  // partition. Fully deterministic (path-derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // Intent/startActivity launches + Navigation-Compose destinations → `calls` edges.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // Activity/Fragment/Composable/View → frontend; ViewModel/Service → service;
  // BroadcastReceiver/ContentProvider → gateway; Worker → job. METADATA; kind unchanged.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks read `.kt` source + AndroidManifest.xml. Declare both so the diff-driven
  // hosted walk re-runs on a relevant change. Never-store-source holds: parse
  // server-side, persist only the derived groups/edges/roles.
  scansSourcePath(path: string): boolean {
    return path.endsWith('.kt') || path.endsWith('AndroidManifest.xml');
  },
};
