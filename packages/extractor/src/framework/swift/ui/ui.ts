// The SwiftUI + UIKit FrameworkAdapter (WEB / UI) — the Swift client-UI adapter,
// built on the shared Swift framework-analysis layer (framework/swift/{analyze,
// swift-ast}.ts) the way the Elixir Phoenix adapter is built on framework/elixir/.
// Net-new; one adapter covers BOTH Apple UI stacks (they co-exist in real apps).
//
// SwiftUI/UIKit are NOT declared as manifest dependencies (they're Apple platform
// frameworks), so — unlike every dep-gated adapter — `detect()` reads SOURCE: a
// bounded scan for `import SwiftUI` / `import UIKit`. The adapter declares
// `scansSourcePath` so the diff-driven hosted walk re-runs it on a source change.
// Everything is parsed STATICALLY via the hand-rolled Swift scanner (install-free,
// never-store-source, never executes repo code). parseSwiftScope pre-scans every
// in-scope file ONCE and the three hooks share that pass:
//
//   * roleTags        — REQUIRE THE CONSTRUCT, not just the import: a SwiftUI View
//                       (`: View` + a `var body`) / `Scene`, a UIKit
//                       `UIViewController` / `UIView` subclass → `frontend`
//                       (role view/screen); the app entry (`@main` / `: App` /
//                       `AppDelegate` / `SceneDelegate`) → `frontend` (role
//                       'app-entry', NOT gateway — gateway is reserved for Vapor's
//                       real server routes). METADATA onto the LOCKED MODULE_KINDS.
//   * syntheticEdges  — THE NAVIGATION SPINE: a SwiftUI NavigationLink /
//                       NavigationStack / .navigationDestination / .sheet /
//                       .fullScreenCover / .popover, or a UIKit pushViewController /
//                       present / show, that names another screen → a screen→screen
//                       `calls` edge (the navigation the import graph sees only as a
//                       structural reference; here it's the 'calls' verb). Scoped to
//                       navigation call-sites (not every reference), resolved through
//                       the type registry, UI-role targets only.
//   * groupingPrior   — SPM target = subsystem (primary); for a single-module app
//                       (0–1 target) a FEATURE-FOLDER fallback groups each top-level
//                       feature dir into its own subsystem (the Phoenix-context
//                       mechanism), so a flat `Sources/App/` splits into Countries /
//                       Detail / Settings rather than one blob.
//
// Unresolvable nav targets DEGRADE + LOG (no silent caps). Deterministic (sorted
// outputs, ids derived from paths/names; run-twice is byte-identical).

import { openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { parseSwiftScope, readSwiftTargets, type ParsedSwiftFile } from '../analyze.js';
import { assignFilesToTargets } from '../../../graph/swift-adapter.js';
import { scanImports, stripCommentsAndStrings } from '../swift-ast.js';
import { SWIFT_EXCLUDE_DIRS, SWIFT_EXCLUDE_SUFFIXES } from '../../../graph/file-graph.js';
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
// Detection — a BOUNDED source scan for `import SwiftUI` / `import UIKit`.

const DETECT_FILE_CAP = 600; // stop after scanning this many .swift files
const DETECT_SKIP = new Set<string>([...SWIFT_EXCLUDE_DIRS]);

export interface UiSignals {
  hasSwiftUI: boolean;
  hasUIKit: boolean;
}

function isXcodeContainer(name: string): boolean {
  return SWIFT_EXCLUDE_SUFFIXES.some((s) => name.endsWith(s));
}

/** Read only the HEAD of a file (imports live at the top) — cheap detect. Never throws. */
function readHead(path: string, maxBytes = 4096): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Scan up to DETECT_FILE_CAP `.swift` files under `base` for `import SwiftUI` /
 * `import UIKit`, early-exiting once both are found. Reads only each file's imports
 * (cheap). Never throws (an unreadable dir/file is skipped).
 */
export function detectUiSignals(base: string): UiSignals {
  let hasSwiftUI = false;
  let hasUIKit = false;
  let scanned = 0;
  const walk = (dir: string): void => {
    if (scanned >= DETECT_FILE_CAP || (hasSwiftUI && hasUIKit)) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned >= DETECT_FILE_CAP || (hasSwiftUI && hasUIKit)) return;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || DETECT_SKIP.has(e.name) || isXcodeContainer(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.swift') && e.name !== 'Package.swift') {
        scanned++;
        // Imports are at the top of the file — read only the head (cheap detect).
        for (const mod of scanImports(readHead(join(dir, e.name)))) {
          if (mod === 'SwiftUI') hasSwiftUI = true;
          else if (mod === 'UIKit') hasUIKit = true;
        }
      }
    }
  };
  walk(base);
  return { hasSwiftUI, hasUIKit };
}

/** Decide the UI match from the signal set. Either framework is sufficient. */
export function scoreUi(s: UiSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasSwiftUI && !s.hasUIKit) return null;
  // SwiftUI + UIKit are both strong signals; both present is a mixed app.
  const variant = s.hasSwiftUI && s.hasUIKit ? 'swiftui+uikit' : s.hasSwiftUI ? 'swiftui' : 'uikit';
  return {
    adapter: 'swift-ui',
    confidence: clampConfidence(0.85),
    rootPath,
    metadata: { variant, signals: { swiftui: s.hasSwiftUI, uikit: s.hasUIKit } },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → the LOCKED MODULE_KINDS. Every UI role maps onto `frontend`
// (client UI); the app entry is `frontend` too (NOT gateway — gateway is Vapor's
// server routes). The finer role lives in `role`; the module's `kind` is unchanged.
export type UiRole = 'app-entry' | 'screen' | 'view' | 'scene';

const ROLE_PRIORITY: Record<UiRole, number> = {
  'app-entry': 9,
  screen: 6,
  view: 5,
  scene: 4,
};
const ROLE_KIND: Record<UiRole, ModuleKind> = {
  'app-entry': 'frontend',
  screen: 'frontend',
  view: 'frontend',
  scene: 'frontend',
};

// UIKit controller base classes (a subclass is a screen). Direct inheritance only
// (a line scanner can't resolve transitive superclasses — a documented degrade).
const UIKIT_CONTROLLER_BASES = new Set<string>([
  'UIViewController',
  'UITableViewController',
  'UICollectionViewController',
  'UINavigationController',
  'UITabBarController',
  'UISplitViewController',
  'UIPageViewController',
  'UIActivityViewController',
  'UIHostingController',
]);
// UIKit view base classes (a subclass is a view).
const UIKIT_VIEW_BASES = new Set<string>([
  'UIView',
  'UIControl',
  'UILabel',
  'UIButton',
  'UIImageView',
  'UIStackView',
  'UIScrollView',
  'UITableViewCell',
  'UICollectionViewCell',
  'UICollectionReusableView',
  'UITextField',
  'UITextView',
  'UIVisualEffectView',
]);
// App-delegate protocols → app entry.
const APP_DELEGATE_CONFORMANCES = new Set<string>([
  'UIApplicationDelegate',
  'UIWindowSceneDelegate',
  'NSApplicationDelegate',
]);

// ---------------------------------------------------------------------------
// Navigation call-site markers → a screen→screen edge. A line containing one of
// these that names another screen is a navigation.
const NAV_MARKERS = [
  'NavigationLink',
  'NavigationStack',
  'NavigationSplitView',
  '.navigationDestination',
  '.sheet',
  '.fullScreenCover',
  '.popover',
  'pushViewController',
  'present(',
  'showDetailViewController',
  'setViewControllers',
];
// How many lines after a nav marker to also scan (a `.sheet { … }` closure body
// often puts the destination on the following line).
const NAV_WINDOW = 2;

// ---------------------------------------------------------------------------
// Helpers.

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

// The UI role a parsed file declares (highest-priority across its type decls), or
// undefined. REQUIRES the construct: a View needs `: View` + a `var body`; a UIKit
// screen/view needs the superclass; app-entry needs @main / : App / a delegate
// name/conformance.
export function fileUiRole(parsed: ParsedSwiftFile): UiRole | undefined {
  const hasBody = /\bvar\s+body\b/.test(stripCommentsAndStrings(parsed.text));
  let best: UiRole | undefined;
  const consider = (role: UiRole): void => {
    if (best === undefined || ROLE_PRIORITY[role] > ROLE_PRIORITY[best]) best = role;
  };
  for (const decl of parsed.decls) {
    if (decl.kind === 'extension') continue;
    // App entry.
    if (
      decl.attributes.includes('main') ||
      decl.inherits.includes('App') ||
      decl.name === 'AppDelegate' ||
      decl.name === 'SceneDelegate' ||
      decl.inherits.some((c) => APP_DELEGATE_CONFORMANCES.has(c))
    ) {
      consider('app-entry');
      continue;
    }
    // UIKit controller / view.
    if (decl.inherits.some((c) => UIKIT_CONTROLLER_BASES.has(c))) {
      consider('screen');
      continue;
    }
    if (decl.inherits.some((c) => UIKIT_VIEW_BASES.has(c))) {
      consider('view');
      continue;
    }
    // SwiftUI View / Scene.
    if (decl.inherits.includes('View') && hasBody) {
      consider('view');
      continue;
    }
    if (decl.inherits.includes('Scene')) {
      consider('scene');
      continue;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Feature-folder grouping (single-module fallback).

/** The longest directory prefix (posix) shared by every file — the effective source
 *  root a single-module app hangs its feature dirs off (`App/Feature/x.swift` +
 *  `App/Other/y.swift` → `App`). '' when files span disjoint top-level dirs. */
export function commonDirPrefix(files: readonly string[]): string {
  if (files.length === 0) return '';
  let prefix = files[0].split('/').slice(0, -1);
  for (const f of files.slice(1)) {
    const dir = f.split('/').slice(0, -1);
    let i = 0;
    while (i < prefix.length && i < dir.length && prefix[i] === dir[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix.join('/');
}

/**
 * Feature-folder groups for a single-module app: each top-level dir UNDER the common
 * source root with ≥2 in-scope files → a subsystem (so a flat app splits into
 * Countries / Detail / Settings rather than one blob). The common-prefix root adapts
 * to any layout — an Xcode `<App>/…` tree or a bare `Sources/…` — without hard-coded
 * dir names. Deterministic, collision-free ids. Mirrors the Ecto/python-orm shape.
 */
function buildFeatureGroups(files: readonly string[]): FrameworkGroup[] {
  const root = commonDirPrefix(files);
  const rootPrefix = root === '' ? '' : `${root}/`;
  const byFeature = new Map<string, string[]>();
  for (const id of files) {
    if (!id.startsWith(rootPrefix)) continue;
    const rest = id.slice(rootPrefix.length).split('/');
    if (rest.length < 2) continue; // directly in the source root → no feature
    const feat = rest[0];
    (byFeature.get(feat) ?? byFeature.set(feat, []).get(feat)!).push(id);
  }
  const seeds = [...byFeature.entries()]
    .filter(([, fs]) => fs.length >= 2)
    .map(([feature, fs]) => ({ baseSlug: slugify(feature) || 'feature', label: humanize(feature), fileIds: fs }));
  return assignGroupIds(seeds);
}

interface GroupSeed {
  baseSlug: string;
  label: string;
  fileIds: string[];
}
function assignGroupIds(seeds: GroupSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const byLabel = [...seeds].sort((a, b) => (a.baseSlug < b.baseSlug ? -1 : a.baseSlug > b.baseSlug ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of byLabel) {
    let id = seed.baseSlug;
    let n = 2;
    while (taken.has(id)) id = `${seed.baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label: seed.label, fileIds: [...new Set(seed.fileIds)].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** SPM-target groups: each target with ≥1 in-scope file → a subsystem. */
function buildTargetGroups(files: readonly string[], repoDir: string): FrameworkGroup[] {
  const targets = readSwiftTargets(repoDir);
  if (targets.length < 2) return [];
  const inScope = new Set(files);
  const { filesByTarget } = assignFilesToTargets(files, targets);
  const seeds: GroupSeed[] = [];
  for (const t of targets) {
    const tFiles = (filesByTarget.get(t.name) ?? []).filter((f) => inScope.has(f));
    if (tFiles.length < 1) continue;
    seeds.push({ baseSlug: slugify(t.name) || 'target', label: humanize(t.name), fileIds: tFiles });
  }
  return assignGroupIds(seeds);
}

// ---------------------------------------------------------------------------
// Analysis (shared by the three hooks via a per-context memo).

interface UiAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[];
  roles: Map<string, RoleTag>;
}
interface UiDiag {
  unresolvedNav: Set<string>;
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, UiAnalysis>();

function addEdge(edges: Map<string, FrameworkEdge>, from: string, to: string, relation: string): void {
  if (from === to) return;
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'swift-ui', relation } });
  }
}

const PASCAL_RE = /(?<![\w.])[A-Z][A-Za-z0-9_]*/g;

function analyzeUi(ctx: FrameworkContext): UiAnalysis {
  const scope = parseSwiftScope(ctx);
  const diag: UiDiag = { unresolvedNav: new Set() };

  // Pass 1 — UI roles.
  const roleByFile = new Map<string, UiRole>();
  for (const [id, parsed] of scope.parsed) {
    const role = fileUiRole(parsed);
    if (role) roleByFile.set(id, role);
  }

  // Pass 2 — the navigation spine. For each UI-role file, find nav-marker lines and
  // resolve the screens they name (window = the marker line + NAV_WINDOW following).
  const edges = new Map<string, FrameworkEdge>();
  for (const [id, parsed] of scope.parsed) {
    if (!roleByFile.has(id)) continue;
    const lines = stripCommentsAndStrings(parsed.text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!NAV_MARKERS.some((m) => lines[i].includes(m))) continue;
      const windowText = lines.slice(i, i + 1 + NAV_WINDOW).join(' ');
      for (const m of windowText.matchAll(PASCAL_RE)) {
        const target = scope.resolve(m[0]);
        if (target === undefined) continue; // an Apple type (NavigationLink, …) / unresolved
        if (target === id) continue; // self
        if (!roleByFile.has(target)) continue; // only screen→screen nav edges
        addEdge(edges, id, target, 'navigate');
      }
    }
  }

  // Pass 3 — grouping: SPM targets are PRIMARY, but only "win" when they actually
  // split the repo into ≥2 subsystems (a multi-target SPM package). A single-target
  // app (its only other target is the noise-filtered test target) collapses to one
  // blob under target grouping — useless — so fall back to feature folders, which
  // split the app dir's top-level dirs (UI / Core / Interactors / …) into subsystems.
  // NOTE: grouping is REPO-WIDE (over every in-scope Swift file, not just UI files) —
  // for an iOS app the feature/target axis is the primary subsystem layout. By
  // registration order (ui before data) this wins over the data adapter's models-dir
  // grouping where they overlap (a `Repositories/` feature vs a 'Data Model' subsystem);
  // that's the intended web-first precedence, not a bug.
  const uiFiles = [...roleByFile.keys()];
  let groups = buildTargetGroups(scope.swiftFiles, ctx.repoDir);
  if (groups.length < 2) groups = buildFeatureGroups(scope.swiftFiles.length ? scope.swiftFiles : uiFiles);

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, { role, kind: ROLE_KIND[role], priority: ROLE_PRIORITY[role], metadata: { framework: 'swift-ui' } });
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  // Positive signal (mirrors phoenix / ecto).
  if (roleByFile.size > 0 || groups.length > 0 || sortedEdges.length > 0) {
    console.log(
      `  [swift-ui] ${roleByFile.size} UI role(s) · ${groups.length} group(s) · ${sortedEdges.length} navigation edge(s)`,
    );
  }
  if (diag.unresolvedNav.size > 0) {
    console.log(
      `  [swift-ui] degraded: ${diag.unresolvedNav.size} unresolvable nav target(s) (logged, not silently dropped)`,
    );
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): UiAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeUi(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const swiftUiAdapter: FrameworkAdapter = {
  name: 'swift-ui',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    return scoreUi(detectUiSignals(base), rootPath);
  },

  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  scansSourcePath(path: string): boolean {
    return path.endsWith('.swift');
  },
};
