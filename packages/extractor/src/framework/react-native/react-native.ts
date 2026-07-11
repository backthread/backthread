// (Slice 1) — the React Native / Expo FrameworkAdapter.
//
// FIRST implementation of the FrameworkAdapter contract, and `detect()` ONLY
// this slice: it decides "is this an RN/Expo app, and is it Expo or bare RN?"
// from package.json deps + config-file existence — never source content
// (never-store-source). The graph contributions (navigation graph, JS↔native
// bridge boundary, screen roles) land in .  reverses the 
// "connect now, group later" deferral and adds the `groupingPrior` hook:
// screens registered in one navigator (Stack/Tab/Drawer) become one feature
// subsystem (a feature-folder fallback covers route files with no navigator —
// e.g. Expo Router pages). `classificationsNeeded` stays absent (grouping is
// fully deterministic — name/path-derived, zero LLM).
//
// Detection signals (manifest + config existence only):
//   * deps:    `react-native` and/or `expo`
//   * configs: app.json · app.config.{js,ts,cjs,mjs} · metro.config.{js,ts,cjs}
//              · react-native.config.{js,ts}
//   * native:  ios/ + android/ dirs
//
// The scoring is a PURE function (scoreReactNative) so it unit-tests without a
// real repo dir; the adapter just gathers the fs signals and calls it — the
// same pure-builder / fs-adapter split the infra adapters use.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import {
  SyntaxKind,
  type ArrowFunction,
  type Block,
  type CallExpression,
  type JsxAttribute,
  type JsxExpression,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyAssignment,
  type ReturnStatement,
  type SourceFile,
  type StringLiteral,
} from 'ts-morph';
import {
  addAllSourceFiles,
  buildExtractionProject,
  readTsconfigCompilerOptions,
  toId,
} from '../../graph/ts-morph-adapter.js';
import { SOURCE_EXTENSIONS } from '../../graph/file-graph.js';
import { extractExpoRouterTree, type RouteRole } from '../routing/index.js';
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

// Config-file name sets — existence-only checks (we never read their content).
const APP_CONFIG_NAMES = ['app.config.js', 'app.config.ts', 'app.config.cjs', 'app.config.mjs'];
const METRO_CONFIG_NAMES = ['metro.config.js', 'metro.config.ts', 'metro.config.cjs'];
const RN_CONFIG_NAMES = ['react-native.config.js', 'react-native.config.ts'];

// ---------------------------------------------------------------------------
// Signal gathering (fs) — kept thin so the scoring stays pure + testable.

/** The merged dependency map from a package.json (deps + devDeps); {} on any error. */
function readDeps(baseDir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(baseDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The deterministic RN/Expo signal set read from a repo (or workspace package). */
export interface ReactNativeSignals {
  hasReactNativeDep: boolean;
  hasExpoDep: boolean;
  hasAppJson: boolean;
  hasAppConfig: boolean; // app.config.{js,ts,cjs,mjs} — Expo's dynamic config
  hasMetroConfig: boolean; // metro.config.* — the RN bundler, RN-specific
  hasRnConfig: boolean; // react-native.config.* — RN CLI autolinking, RN-specific
  hasIosDir: boolean;
  hasAndroidDir: boolean;
}

/** Gather the signal set for a single root dir. */
export function gatherReactNativeSignals(baseDir: string): ReactNativeSignals {
  const deps = readDeps(baseDir);
  return {
    hasReactNativeDep: 'react-native' in deps,
    hasExpoDep: 'expo' in deps,
    hasAppJson: existsSync(join(baseDir, 'app.json')),
    hasAppConfig: APP_CONFIG_NAMES.some((n) => existsSync(join(baseDir, n))),
    hasMetroConfig: METRO_CONFIG_NAMES.some((n) => existsSync(join(baseDir, n))),
    hasRnConfig: RN_CONFIG_NAMES.some((n) => existsSync(join(baseDir, n))),
    hasIosDir: isDir(join(baseDir, 'ios')),
    hasAndroidDir: isDir(join(baseDir, 'android')),
  };
}

// ---------------------------------------------------------------------------
// Pure scoring.

/**
 * Decide RN/Expo from the signal set. Returns a DetectMatch, or null if the
 * signals are too weak/ambiguous to claim the stack (so the generic-TS
 * fallthrough stays intact).
 *
 * A SUFFICIENT (match-on-its-own) signal is one of:
 *   * a `react-native` or `expo` dep                  — the authoritative signal
 *   * metro.config.* or react-native.config.*         — RN-toolchain-specific
 *   * BOTH ios/ and android/ native dirs              — a built RN project
 *
 * app.json / app.config / a single native dir are SUPPORTING signals (they
 * raise confidence) but never sufficient alone — app.json in particular is too
 * generic to claim a stack on its own.
 *
 * Variant: `expo` dep (or an `app.config.*` dynamic config) ⇒ 'expo', else
 * 'bare'. Recorded in metadata + reflected in confidence.
 */
export function scoreReactNative(s: ReactNativeSignals, rootPath = ''): DetectMatch | null {
  const hasDep = s.hasReactNativeDep || s.hasExpoDep;
  const hasRnToolingConfig = s.hasMetroConfig || s.hasRnConfig;
  const hasBothNative = s.hasIosDir && s.hasAndroidDir;

  // Gate: need at least one SUFFICIENT signal. Supporting-only ⇒ no match.
  if (!hasDep && !hasRnToolingConfig && !hasBothNative) return null;

  let confidence = 0;
  if (s.hasReactNativeDep) confidence += 0.5;
  if (s.hasExpoDep) confidence += 0.5;
  if (s.hasMetroConfig) confidence += 0.2;
  if (s.hasRnConfig) confidence += 0.2;
  if (hasBothNative) confidence += 0.3;
  else if (s.hasIosDir || s.hasAndroidDir) confidence += 0.1;
  if (s.hasAppConfig) confidence += 0.1;
  if (s.hasAppJson) confidence += 0.05;
  confidence = Math.min(1, Number(confidence.toFixed(2)));

  const variant: 'expo' | 'bare' = s.hasExpoDep || s.hasAppConfig ? 'expo' : 'bare';

  return {
    adapter: 'react-native',
    confidence,
    rootPath,
    metadata: {
      variant,
      signals: {
        reactNativeDep: s.hasReactNativeDep,
        expoDep: s.hasExpoDep,
        appJson: s.hasAppJson,
        appConfig: s.hasAppConfig,
        metroConfig: s.hasMetroConfig,
        rnConfig: s.hasRnConfig,
        iosDir: s.hasIosDir,
        androidDir: s.hasAndroidDir,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// the navigation graph + JS↔native boundary extraction.
//
// All STATIC ts-morph parsing (install-free, never-store-source: read inside the
// destroy-on-exit sandbox; persist only the derived edges/roles, never source).
// Three signals:
//   * React Navigation screen registry — EAGER `<Stack.Screen name component>` +
//     static `createXNavigator({ screens })`, AND LAZY registration:
//     `getComponent={() => Screen | require('./x') | import('./x')}` and a
//     statically-resolvable non-string `name` (const / enum / `'X' as 'Y'`) —
//     plus statically-resolvable `navigation.navigate('X')` / `.push('X')`
//     targets → screen→screen nav edges (kind 'calls'). Truly-dynamic names /
//     targets are LOGGED + skipped (no silent caps).
//   * NativeModules / TurboModules / requireNativeComponent usage → the JS↔native
//     boundary: the touching file gets the `nativeModule` role, and importers of
//     a native-boundary file get a bridge edge (kind 'calls') into it.
//   * Per-file roles: navigator / screen / nativeModule / hook / component.
//
// Endpoints are repo-relative posix FILE ids (toId) — the NormalizedGraph file-id
// space the contribution step (contribute-step.ts) resolves to module ids via
// fileModuleMap, dropping intra-module self-edges and deduping.

// role vocabulary across BOTH the React-Navigation analysis (Slice A)
// and the Expo Router route tree (Slice B). ONE file can carry a role from each
// — an Expo app may use Expo Router AND React Navigation — so the two role sets
// share ONE collapse scale: higher priority dominates (a file matching several
// detectors, AND a module aggregating several roles), with a lexical role
// tiebreak — the SAME order the contribute-step's beats() applies at the module
// level. The `kind` each maps onto is a LOCKED Module-kind (never a new one):
// UI + route roles (navigator/screen/hook/component/page/layout/route) →
// `frontend`; the JS↔native bridge → `service` (own on-device compute); an Expo
// Router API route (`endpoint`) → `gateway` (a server REQUEST entry, not UI).
// Slice A/B do NOT apply this kind (the module keeps the classifier's kind);
// it's carried for a future classifier, and only `role` is rendered.
export type ReactNativeRole = 'navigator' | 'nativeModule' | 'screen' | 'hook' | 'component';
// The two vocabularies merged onto one scale. RouteRole = the routing lib's
// 'route' | 'page' | 'layout' | 'endpoint'.
type AdapterRole = ReactNativeRole | RouteRole;

const ROLE_PRIORITY: Record<AdapterRole, number> = {
  endpoint: 9, // Expo Router API route — a server boundary; the only `gateway` here
  navigator: 8, // React Navigation navigator (structural container)
  layout: 7, // Expo Router layout (structural container)
  nativeModule: 6, // JS↔native bridge
  page: 5, // Expo Router page — a concrete routed screen
  screen: 4, // React Navigation screen
  route: 3, // Expo Router generic routable (Expo never emits it; kept for the type)
  hook: 2,
  component: 1,
};
const ROLE_KIND: Record<AdapterRole, ModuleKind> = {
  endpoint: 'gateway',
  navigator: 'frontend',
  layout: 'frontend',
  nativeModule: 'service',
  page: 'frontend',
  screen: 'frontend',
  route: 'frontend',
  hook: 'frontend',
  component: 'frontend',
};

const NAVIGATOR_FACTORIES = new Set([
  'createStackNavigator',
  'createNativeStackNavigator',
  'createBottomTabNavigator',
  'createMaterialTopTabNavigator',
  'createMaterialBottomTabNavigator',
  'createDrawerNavigator',
]);
// `navigation.<m>('Screen')` — methods whose first string arg is a screen name.
// `navigate`/`replace` are nav-unambiguous → an unresolved string is LOGGED.
// `push`/`popTo`/`jumpTo`/`navigateDeprecated` collide with Array/other APIs
// (`arr.push('x')`), so they only emit on a REGISTRY HIT and miss silently —
// a non-screen string there is not a dropped nav target, it's not a nav call.
const NAV_LOG_METHODS = new Set(['navigate', 'replace']);
const NAV_SOFT_METHODS = new Set(['push', 'popTo', 'jumpTo', 'navigateDeprecated']);
const NATIVE_GLOBALS = new Set(['NativeModules', 'TurboModuleRegistry']);
const NATIVE_FUNCS = new Set(['requireNativeComponent', 'requireNativeModule']);

const SOURCE_EXT_SET = new Set<string>(SOURCE_EXTENSIONS);

interface ReactNativeAnalysis {
  /** screen→screen nav edges, file-id endpoints, kind 'calls' (React Navigation). */
  navEdges: FrameworkEdge[];
  /** consumer→native-boundary bridge edges, file-id endpoints, kind 'calls'. */
  bridgeEdges: FrameworkEdge[];
  /** Expo Router route→route nav edges, file-id endpoints, kind 'calls' (Slice B). */
  routeEdges: FrameworkEdge[];
  /** fileId → RoleTag (one per file; multi-match collapsed by ROLE_PRIORITY). */
  roles: Map<string, RoleTag>;
  /** feature grouping prior: navigator-membership + feature-folder. */
  groups: FrameworkGroup[];
}

// Analysis is memoized on the FrameworkContext OBJECT (not repoDir): the step
// passes the SAME ctx to syntheticEdges + roleTags so they share one parse,
// while the merge walk's per-checkpoint ctx (same clone.dir path, different tree)
// gets a fresh analysis — no cross-tree staleness.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, ReactNativeAnalysis>();

function roleTag(role: ReactNativeRole): RoleTag {
  return { role, kind: ROLE_KIND[role], priority: ROLE_PRIORITY[role] };
}

// Keep the highest-priority candidate role per file (deterministic, lexical
// tiebreak) — a screen that also touches NativeModules reads as `nativeModule`.
function addRole(map: Map<string, ReactNativeRole>, fileId: string, role: ReactNativeRole): void {
  const cur = map.get(fileId);
  if (
    cur === undefined ||
    ROLE_PRIORITY[role] > ROLE_PRIORITY[cur] ||
    (ROLE_PRIORITY[role] === ROLE_PRIORITY[cur] && role < cur)
  ) {
    map.set(fileId, role);
  }
}

// localImportedName → resolved repo-relative file id, for a single source file.
// When ts-morph resolves the specifier we trust it; when it doesn't (a tsconfig
// path alias the in-memory Project mis-anchors), we fall back to our
// own alias resolver so `#/`-aliased screen imports still bind to real files.
function buildImportNameMap(
  sf: SourceFile,
  repoDir: string,
  aliasResolve: (spec: string) => string | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const decl of sf.getImportDeclarations()) {
    const resolved = decl.getModuleSpecifierSourceFile();
    let fileId: string | undefined;
    if (resolved) {
      fileId = toId(repoDir, resolved.getFilePath());
    } else {
      const spec = decl.getModuleSpecifierValue();
      fileId = spec ? aliasResolve(spec) : undefined;
    }
    if (!fileId) continue;
    const def = decl.getDefaultImport();
    if (def) map.set(def.getText(), fileId);
    const ns = decl.getNamespaceImport();
    if (ns) map.set(ns.getText(), fileId);
    for (const ni of decl.getNamedImports()) {
      map.set((ni.getAliasNode() ?? ni.getNameNode()).getText(), fileId);
    }
  }
  return map;
}

// Diagnostics accumulated across all files for the single "no silent caps" log:
// screens whose NAME couldn't be statically resolved, and screens whose name
// resolved but whose COMPONENT couldn't (e.g. a require to a path we can't find).
interface ScreenDiag {
  dynamicNames: number;
  unresolvedComponents: Set<string>;
}

// Resolve a bare base path (extensionless) to a real source-file id: the path
// itself, then each source extension, then an index file, in the FIXED
// SOURCE_EXTENSIONS order so the pick is snapshot-stable.
function resolveAgainstIdSet(base: string, idSet: ReadonlySet<string>): string | undefined {
  if (idSet.has(base)) return base;
  for (const ext of SOURCE_EXTENSIONS) {
    const cand = `${base}.${ext}`;
    if (idSet.has(cand)) return cand;
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const cand = `${base}/index.${ext}`;
    if (idSet.has(cand)) return cand;
  }
  return undefined;
}

// tsconfig path-alias resolution. The in-memory extraction Project
// mis-anchors the very common `"paths": { "#/*": ["./src/*"] }` shape that has
// NO `baseUrl` (the relative `./src/*` target resolves against the wrong dir),
// so ts-morph silently fails to resolve `#/`-aliased imports — which is exactly
// how real RN apps (Bluesky) register every screen. We read the alias patterns
// ourselves and resolve them against the known file-id set, deterministically.
interface AliasPattern {
  prefix: string; // wildcard: the part before '*' (e.g. '#/'); exact: the full key
  wildcard: boolean;
  targets: string[]; // repo-relative base dirs (wildcard) or file paths (exact)
}

// Build the alias patterns from the repo's tsconfig/jsconfig `paths`. The
// tsconfig READ (candidate search + JSONC parse: comments + trailing commas, no
// `extends` follow) is now the SHARED graph/ts-morph-adapter helper
// centralized it so this adapter and the structural extractor can't drift on
// what parses (the no-baseUrl + trailing-comma shape that previously dropped
// every alias). This adapter then keeps its OWN pattern model + id-set resolver
// (makeAliasResolver / makeSpecifierResolver), because RN must resolve arbitrary
// string specifiers — including the lazy `require('#/…')` / `import('#/…')`
// screen forms — against the file-id set, which ts-morph's static-declaration
// resolution structurally cannot do.
//
// Note: deferring to the shared reader adopts its "FIRST config declaring
// baseUrl||paths wins" rule (the config the TS compiler loads); the old local
// reader skipped a baseUrl-only config to keep hunting for one with `paths`.
// Negligible/more-correct in practice (paths + baseUrl live in the same root
// tsconfig); fixtures + real RN repos are unaffected. The '*' wildcard + leading
// './' are normalized away so resolution stays a plain join.
function readAliasPatterns(repoDir: string): AliasPattern[] {
  const paths = readTsconfigCompilerOptions(repoDir)?.paths;
  if (!paths || typeof paths !== 'object') return [];
  const out: AliasPattern[] = [];
  for (const [key, val] of Object.entries(paths)) {
    if (!Array.isArray(val)) continue;
    const wildcard = key.endsWith('/*');
    const prefix = wildcard ? key.slice(0, -1) : key; // '#/*' → '#/'
    const targets = (val as unknown[])
      .filter((t): t is string => typeof t === 'string')
      .map((t) => {
        let s = t.replace(/^\.\//, '').replace(/^\//, '');
        if (wildcard) s = s.replace(/\*$/, '').replace(/\/$/, ''); // './src/*' → 'src'
        return s;
      });
    if (targets.length > 0) out.push({ prefix, wildcard, targets });
  }
  return out;
}

// A non-relative specifier → a real file id via the tsconfig path aliases, or
// undefined. Tries each matching pattern's targets in declared order against the
// id set (with extension/index resolution) — fully deterministic.
function makeAliasResolver(
  patterns: readonly AliasPattern[],
  idSet: ReadonlySet<string>,
): (spec: string) => string | undefined {
  return (spec) => {
    for (const { prefix, wildcard, targets } of patterns) {
      if (wildcard) {
        if (!spec.startsWith(prefix)) continue;
        const rest = spec.slice(prefix.length);
        for (const base of targets) {
          const full = base ? `${base}/${rest}` : rest;
          const r = resolveAgainstIdSet(full, idSet);
          if (r) return r;
        }
      } else {
        if (spec !== prefix) continue;
        for (const base of targets) {
          const r = resolveAgainstIdSet(base, idSet);
          if (r) return r;
        }
      }
    }
    return undefined;
  };
}

// Deterministic specifier resolver over the known source-file id set, for the
// lazy `require('…')` / `import('…')` forms: RELATIVE specifiers resolve against
// the importing file's dir; a non-relative (bare/aliased) specifier falls to the
// tsconfig alias resolver. Snapshot-stable by construction.
function makeSpecifierResolver(
  idSet: ReadonlySet<string>,
  aliasResolve: (spec: string) => string | undefined,
): (fromFileId: string, spec: string) => string | undefined {
  return (fromFileId, spec) => {
    if (!spec.startsWith('.')) return aliasResolve(spec);
    const slash = fromFileId.lastIndexOf('/');
    const dir = slash >= 0 ? fromFileId.slice(0, slash) : '';
    return resolveAgainstIdSet(posix.join(dir, spec), idSet);
  };
}

// Structural accessors — ts-morph exposes getExpression()/getInitializer()/
// getLiteralValue() on many concrete node types but not on the base Node, and we
// reach them only after a getKind() gate, so a guarded optional-call is both safe
// and avoids a forest of per-kind casts.
function innerExpression(node: Node): Node | undefined {
  return (node as unknown as { getExpression?: () => Node | undefined }).getExpression?.();
}
function nodeInitializer(node: Node): Node | undefined {
  return (node as unknown as { getInitializer?: () => Node | undefined }).getInitializer?.();
}
function literalValue(node: Node): string | undefined {
  return (node as unknown as { getLiteralValue?: () => string }).getLiteralValue?.();
}

// Statically resolve a string from an expression node — a string literal, an
// `as`/parenthesis/non-null-wrapped literal (the RUNTIME value; a type cast like
// `'X' as 'Y'` is type-only), or a const / enum member / object-literal-const
// property whose value is itself a static string. Truly computed → undefined.
function staticStringValue(node: Node, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  switch (node.getKind()) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return literalValue(node);
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.TypeAssertionExpression: {
      const inner = innerExpression(node);
      return inner ? staticStringValue(inner, depth + 1) : undefined;
    }
    case SyntaxKind.Identifier:
    case SyntaxKind.PropertyAccessExpression:
      return resolveConstString(node, depth);
    default:
      return undefined;
  }
}

// Resolve an Identifier / PropertyAccess referring to a const string, enum
// member, or const object property to its string value (symbol-based; degrades
// to undefined without resolution rather than throwing).
function resolveConstString(node: Node, depth: number): string | undefined {
  let sym;
  try {
    sym = node.getSymbol();
  } catch {
    return undefined;
  }
  const decl = sym?.getValueDeclaration() ?? sym?.getDeclarations()?.[0];
  if (!decl) return undefined;
  switch (decl.getKind()) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.EnumMember:
    case SyntaxKind.PropertyAssignment: {
      const init = nodeInitializer(decl);
      return init ? staticStringValue(init, depth + 1) : undefined;
    }
    default:
      return undefined;
  }
}

// Resolve a screen-registration `name` to its runtime string value, or undefined
// when it's truly computed/dynamic. Handles a JSX string attr (`name="X"`) and a
// statically-resolvable JSX expression (`name={'X' as 'Y'}`, `name={ROUTE}`, …).
function resolveScreenName(nameAttr: JsxAttribute): string | undefined {
  const init = nameAttr.getInitializer();
  if (!init) return undefined;
  if (init.getKind() === SyntaxKind.StringLiteral) {
    return (init as StringLiteral).getLiteralValue();
  }
  if (init.getKind() === SyntaxKind.JsxExpression) {
    const expr = (init as JsxExpression).getExpression();
    return expr ? staticStringValue(expr) : undefined;
  }
  return undefined;
}

// Resolve a component-producing expression used in a screen registration to its
// file id. Handles BOTH eager `component={X}` and the lazy `getComponent` forms
//: an imported identifier, a namespace member, or a `require('./x')` /
// `import('./x')` (incl. a `.Named` access on either). `as`/paren/non-null
// wrappers are unwrapped. An imported symbol → its source file; a locally-defined
// component (or nested navigator) → the registering file. Anything else (an
// inline `() => <Foo/>`, a require we can't resolve install-free) → undefined,
// so the caller LOGS + skips rather than mis-register the screen.
function resolveComponentRef(
  expr: Node,
  imports: Map<string, string>,
  selfFileId: string,
  resolveSpecifier: (spec: string) => string | undefined,
  depth = 0,
): string | undefined {
  if (depth > 8) return undefined;
  switch (expr.getKind()) {
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.TypeAssertionExpression: {
      const inner = innerExpression(expr);
      return inner ? resolveComponentRef(inner, imports, selfFileId, resolveSpecifier, depth + 1) : undefined;
    }
    case SyntaxKind.Identifier:
      return imports.get(expr.getText()) ?? selfFileId;
    case SyntaxKind.PropertyAccessExpression: {
      const base = (expr as PropertyAccessExpression).getExpression();
      // `require('./x').Named` / `import('./x').Named` → resolve the call.
      if (base.getKind() === SyntaxKind.CallExpression) {
        return resolveComponentRef(base, imports, selfFileId, resolveSpecifier, depth + 1);
      }
      // `Ns.Component` → resolve the root identifier (imported, else self file).
      if (base.getKind() === SyntaxKind.Identifier) {
        return imports.get(base.getText()) ?? selfFileId;
      }
      return resolveComponentRef(base, imports, selfFileId, resolveSpecifier, depth + 1);
    }
    case SyntaxKind.CallExpression: {
      const call = expr as CallExpression;
      const callee = call.getExpression();
      const isRequire = callee.getKind() === SyntaxKind.Identifier && callee.getText() === 'require';
      const isImport = callee.getKind() === SyntaxKind.ImportKeyword || callee.getText() === 'import';
      if (!isRequire && !isImport) return undefined;
      const arg = call.getArguments()[0];
      if (!arg || arg.getKind() !== SyntaxKind.StringLiteral) return undefined;
      return resolveSpecifier((arg as StringLiteral).getLiteralValue());
    }
    default:
      return undefined;
  }
}

// From a `getComponent={() => …}` initializer (an arrow / function expression),
// return the single expression it RETURNS — a concise arrow body, or the first
// top-level `return`'s argument in a block body. Undefined otherwise.
function getComponentReturnExpr(fn: Node): Node | undefined {
  const k = fn.getKind();
  if (k !== SyntaxKind.ArrowFunction && k !== SyntaxKind.FunctionExpression) return undefined;
  const body = (fn as ArrowFunction).getBody();
  if (!body) return undefined;
  if (body.getKind() !== SyntaxKind.Block) return body; // concise arrow body
  for (const stmt of (body as Block).getStatements()) {
    if (stmt.getKind() === SyntaxKind.ReturnStatement) {
      return (stmt as ReturnStatement).getExpression();
    }
  }
  return undefined;
}

// The static-config screen property KEY → screen name: a plain identifier/string
// key, or a computed `[ROUTE]` key resolved to its static string. Dynamic → undefined.
function staticPropName(pa: PropertyAssignment): string | undefined {
  const nameNode = pa.getNameNode();
  if (nameNode.getKind() === SyntaxKind.ComputedPropertyName) {
    const e = innerExpression(nameNode);
    return e ? staticStringValue(e) : undefined;
  }
  if (nameNode.getKind() === SyntaxKind.StringLiteral) {
    return (nameNode as StringLiteral).getLiteralValue();
  }
  return nameNode.getText();
}

// A static-config screen VALUE → component file id. The value is either the
// component reference directly (`Home: HomeScreen`) or a screen-config object
// (`Home: { screen: X }` / `{ component: X }` / `{ getComponent: () => … }`).
function resolveConfigScreenComponent(
  init: Node,
  imports: Map<string, string>,
  selfFileId: string,
  resolveSpecifier: (spec: string) => string | undefined,
): string | undefined {
  if (init.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const obj = init as ObjectLiteralExpression;
    for (const key of ['screen', 'component', 'getComponent']) {
      const p = obj.getProperty(key);
      if (!p || p.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const v = (p as PropertyAssignment).getInitializer();
      if (!v) continue;
      if (key === 'getComponent') {
        const ret = getComponentReturnExpr(v);
        return ret ? resolveComponentRef(ret, imports, selfFileId, resolveSpecifier) : undefined;
      }
      return resolveComponentRef(v, imports, selfFileId, resolveSpecifier);
    }
    return undefined;
  }
  return resolveComponentRef(init, imports, selfFileId, resolveSpecifier);
}

// Collect screen registrations from one file: JSX `<X.Screen name component|
// getComponent>` plus the static `createXNavigator({ screens })` config.
// `resolveSpecifier` is the per-file (bound to this file) relative require/import
// resolver. Diagnostics accumulate into `diag` for one aggregated log.
function collectScreens(
  sf: SourceFile,
  imports: Map<string, string>,
  selfFileId: string,
  registry: Map<string, string>,
  screenFiles: Set<string>,
  resolveSpecifier: (spec: string) => string | undefined,
  diag: ScreenDiag,
  membership: Set<string>,
): boolean {
  let isNavigator = false;

  const register = (screenName: string, componentFile: string): void => {
    if (!registry.has(screenName)) registry.set(screenName, componentFile);
    screenFiles.add(componentFile);
    // record this screen's component file as a member of THIS file's
    // navigator(s), so the grouping prior can group a navigator's screens into
    // one feature subsystem (independent of the global first-wins registry).
    membership.add(componentFile);
  };

  // The component file from a screen element's `component` / `getComponent` attr.
  // Returns a file id (resolved), null (an attr was present but unresolvable →
  // caller logs), or undefined (no component-binding attr at all).
  const componentFileOf = (
    el: JsxOpeningElement | JsxSelfClosingElement,
  ): string | null | undefined => {
    const comp = el.getAttribute('component');
    if (comp && comp.getKind() === SyntaxKind.JsxAttribute) {
      const init = (comp as JsxAttribute).getInitializer();
      if (init && init.getKind() === SyntaxKind.JsxExpression) {
        const e = (init as JsxExpression).getExpression();
        if (e) return resolveComponentRef(e, imports, selfFileId, resolveSpecifier) ?? null;
      }
      return null;
    }
    const getComp = el.getAttribute('getComponent');
    if (getComp && getComp.getKind() === SyntaxKind.JsxAttribute) {
      const init = (getComp as JsxAttribute).getInitializer();
      if (init && init.getKind() === SyntaxKind.JsxExpression) {
        const fn = (init as JsxExpression).getExpression();
        const ret = fn ? getComponentReturnExpr(fn) : undefined;
        if (ret) return resolveComponentRef(ret, imports, selfFileId, resolveSpecifier) ?? null;
      }
      return null;
    }
    return undefined;
  };

  const jsxEls = [
    ...sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];
  for (const el of jsxEls) {
    const tag = el.getTagNameNode().getText();
    if (tag.endsWith('.Navigator') || tag === 'Navigator') isNavigator = true;
    if (!(tag.endsWith('.Screen') || tag === 'Screen')) continue;
    isNavigator = true;
    const nameAttr = el.getAttribute('name');
    if (!nameAttr || nameAttr.getKind() !== SyntaxKind.JsxAttribute) continue;
    const screenName = resolveScreenName(nameAttr as JsxAttribute);
    if (screenName === undefined) {
      diag.dynamicNames++;
      continue;
    }
    const componentFile = componentFileOf(el);
    if (componentFile === undefined) continue; // no component/getComponent binding
    if (componentFile === null) {
      diag.unresolvedComponents.add(screenName);
      continue;
    }
    register(screenName, componentFile);
  }

  // Static config API: createXNavigator({ screens: { Home: HomeScreen, … } }).
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!NAVIGATOR_FACTORIES.has(call.getExpression().getText())) continue;
    isNavigator = true;
    const arg = call.getArguments()[0];
    if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
    const screensProp = (arg as ObjectLiteralExpression).getProperty('screens');
    if (!screensProp || screensProp.getKind() !== SyntaxKind.PropertyAssignment) continue;
    const screensInit = (screensProp as PropertyAssignment).getInitializer();
    if (!screensInit || screensInit.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
    for (const prop of (screensInit as ObjectLiteralExpression).getProperties()) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const pa = prop as PropertyAssignment;
      const screenName = staticPropName(pa);
      if (screenName === undefined) {
        diag.dynamicNames++;
        continue;
      }
      const init = pa.getInitializer();
      if (!init) continue;
      const componentFile = resolveConfigScreenComponent(init, imports, selfFileId, resolveSpecifier);
      if (componentFile === undefined) {
        diag.unresolvedComponents.add(screenName);
        continue;
      }
      register(screenName, componentFile);
    }
  }

  return isNavigator;
}

// Does this file touch the JS↔native bridge (NativeModules / TurboModules /
// requireNative*)? Specific patterns only, to avoid false positives.
function usesNative(sf: SourceFile): boolean {
  for (const pae of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const base = pae.getExpression();
    if (base.getKind() === SyntaxKind.Identifier && NATIVE_GLOBALS.has(base.getText())) return true;
  }
  for (const eae of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const base = eae.getExpression();
    if (base.getKind() === SyntaxKind.Identifier && NATIVE_GLOBALS.has(base.getText())) return true;
  }
  for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = vd.getInitializer();
    if (init && init.getKind() === SyntaxKind.Identifier && NATIVE_GLOBALS.has(init.getText())) return true;
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (NATIVE_FUNCS.has(call.getExpression().getText())) return true;
  }
  return false;
}

function hasJsx(sf: SourceFile): boolean {
  return (
    sf.getFirstDescendantByKind(SyntaxKind.JsxElement) !== undefined ||
    sf.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) !== undefined ||
    sf.getFirstDescendantByKind(SyntaxKind.JsxFragment) !== undefined
  );
}

// basename without extension: src/hooks/useAuth.ts → 'useAuth'.
function baseName(fileId: string): string {
  const last = fileId.split('/').pop() ?? fileId;
  return last.replace(/\.[^.]+$/, '');
}

function inScope(fileId: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return fileId === rootPath || fileId.startsWith(`${rootPath}/`);
}

// ---------------------------------------------------------------------------
// feature grouping prior (the deferred "group later").
//
// PRIMARY signal: navigator membership — screens registered in one navigator
// (Stack/Tab/Drawer) belong to ONE feature subsystem, regardless of where their
// files sit on disk (the headline value: screens grouped by feature, not by
// directory). The group id derives from the NAVIGATOR FILE name (deterministic +
// meaningful — RootNavigator → 'root', AuthStack → 'auth'), NEVER an index.
//
// that primary signal OVER-COLLAPSES at real scale: production RN apps
// (Bluesky) register EVERY screen in a SINGLE `Navigation.tsx` (often via tab
// sub-navigators in one file), so navigator membership yields ONE group for the
// whole app. The fix is an adaptive per-navigator mode:
//   * COHESIVE navigator (its screens share ONE feature directory) → keep them
//     as one group named by the navigator (the AuthStack case, the fixtures).
//   * MEGA / incoherent navigator (its screens span MANY feature directories) →
//     the navigator is a routing HUB, not a feature; SPLIT its screens to their
//     own feature folders (Bluesky's src/screens/<Feature>/… + src/view/screens/
//     <Feature>.tsx), so a 78-screen app becomes ~dozens of legible features.
// The cohesion test is the distinct directory-feature count over the navigator's
// member screens (filename-as-feature is excluded from cohesion so same-directory
// screens read as cohesive). Logged per mode — no silent cap.
//
// FALLBACK: a feature folder for screen/route-family files in NO navigator — the
// Expo Router case (file-based routing has no navigator). The feature is the
// first meaningful directory segment under a container root (a route group
// `(tabs)` → 'tabs'). A root-level file with no determinable feature is LOGGED,
// never silently dropped (no filename fallback here — that's the SPLIT path).
//
// The contribute-step namespaces these as `<adapter>:<id>` (here
// `react-native:<id>`) and overrides the claimed modules' subsystem, beating the
// directory heuristic. Fully deterministic (name/path-derived) → no LLM, so no
// `classificationsNeeded`.

// Roles whose files are candidates for the feature-folder fallback (screens that
// somehow escaped navigator membership + the Expo Router route family).
const FALLBACK_ROLES = new Set<string>(['screen', 'page', 'layout', 'route', 'endpoint']);
// Directory segments that are CONTAINERS, not features — stripped (repeatedly,
// outermost-first) before the first real feature segment is read. Covers the
// common RN/Expo layout roots (src · app · view(s) · screen(s) · scene(s) ·
// feature(s) · page(s) · modules), so `src/view/screens/Home.tsx` → 'Home' and
// `src/screens/Messages/ChatList.tsx` → 'Messages'.
const CONTAINER_DIRS = new Set<string>([
  'src',
  'app',
  'view',
  'views',
  'screen',
  'screens',
  'scene',
  'scenes',
  'feature',
  'features',
  'page',
  'pages',
  'modules',
]);
// Trailing navigator-y suffixes stripped from a navigator file's basename to get
// a clean feature name (only when something remains).
const NAV_NAME_SUFFIX = /(Navigators?|Navigation|Nav|Stack|Tabs?|Drawer|Routers?|Routes|Screens)$/;
// Basenames too generic to name a navigator group — fall back to the parent dir.
const GENERIC_NAV_BASENAMES = new Set<string>([
  'index',
  'navigation',
  'navigator',
  'navigators',
  'routes',
  'router',
  'app',
]);

// Deterministic slug (camelCase → kebab, drop non-alnum). Mirrors the Nest/infra
// id discipline so the group id is stable across snapshots.
function slugify(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Humanize a raw name into a subsystem label (split camel/kebab/snake, title-case).
function humanizeName(s: string): string {
  const words = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return s;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// The last directory segment of a file id (the parent dir name); '' at root.
function parentDirName(fileId: string): string {
  const segs = fileId.split('/');
  return segs.length >= 2 ? segs[segs.length - 2] : '';
}

// A navigator file's feature name: its basename with a navigator-y suffix
// stripped; a generic basename (index/navigation/…) falls back to the parent dir.
function navigatorGroupName(fileId: string): string {
  let base = baseName(fileId);
  if (GENERIC_NAV_BASENAMES.has(base.toLowerCase())) {
    base = parentDirName(fileId) || base;
  }
  const stripped = base.replace(NAV_NAME_SUFFIX, '');
  return stripped.length > 0 ? stripped : base;
}

// A screen/route file's feature name. Strips leading CONTAINER segments, then:
//   * a remaining directory segment is the feature (a route group `(tabs)` →
//     'tabs');
//   * if NOTHING remains (the file sits directly in a container, e.g.
//     `src/view/screens/Home.tsx`) → `allowFilename` decides: the SPLIT path
//     uses the file basename ('Home'); the Expo fallback path returns undefined
//     (a root-level route — logged as ungroupable, never silently dropped).
function deriveFeature(fileId: string, allowFilename: boolean): string | undefined {
  const segs = fileId.split('/');
  const file = segs.pop() ?? fileId;
  let i = 0;
  while (i < segs.length && CONTAINER_DIRS.has(segs[i].toLowerCase())) i++;
  const first = segs[i];
  if (first) {
    const stripped = first.replace(/^\((.*)\)$/, '$1'); // route group → bare name
    if (stripped.length > 0) return stripped;
  }
  if (!allowFilename) return undefined;
  const fn = baseName(file);
  return fn.length > 0 ? fn : undefined;
}

// The directory-only feature key used for the COHESION test (no filename
// fallback): files in the same container directory share a key, so same-folder
// screens read as one cohesive feature. A file with no sub-feature directory
// keys on its container dir path, distinguishing e.g. src/view/screens from
// src/legacy/screens.
function featureDirKey(fileId: string): string {
  const dir = deriveFeature(fileId, false);
  if (dir) return dir.toLowerCase();
  const slash = fileId.lastIndexOf('/');
  return ` dir:${slash >= 0 ? fileId.slice(0, slash) : ''}`;
}

// Build the grouping prior: per-navigator COHESIVE (one group) vs MEGA (split by
// feature folder), then a feature-folder fallback for non-navigator screen/route
// files. Deterministic by construction: sorted inputs, set-union accumulation,
// sorted output, lexical label tiebreak — so two runs are byte-identical.
function buildGroupingPrior(
  navMembership: Map<string, Set<string>>,
  roles: Map<string, RoleTag>,
): { groups: FrameworkGroup[]; ungroupable: string[]; keptNavs: number; splitNavs: number } {
  const acc = new Map<string, { label: string; fileIds: Set<string> }>();
  const add = (id: string, label: string, files: Iterable<string>): void => {
    let g = acc.get(id);
    if (!g) {
      g = { label, fileIds: new Set<string>() };
      acc.set(id, g);
    } else if (label < g.label) {
      g.label = label; // deterministic on the (rare) same-id/different-label case
    }
    for (const f of files) g.fileIds.add(f);
  };

  const claimed = new Set<string>();
  const ungroupable: string[] = [];
  let keptNavs = 0;
  let splitNavs = 0;

  // Assign one screen-ish file to its own feature folder (filename-as-feature
  // when it sits directly in a container) — the SPLIT path + the mega-navigator's
  // own file. A file with no determinable feature is logged, never dropped.
  const splitFile = (f: string): void => {
    if (claimed.has(f)) return;
    const feat = deriveFeature(f, true);
    if (!feat) {
      ungroupable.push(f);
      return;
    }
    const id = slugify(feat) || 'feature';
    add(id, humanizeName(feat) || id, [f]);
    claimed.add(f);
  };

  // Per-navigator (sorted; first-claim wins so a screen in two navigators is
  // deterministic). A navigator with NO statically-resolvable screens has nothing
  // to group → skip (keeps the directory heuristic, not a noisy singleton).
  for (const navFile of [...navMembership.keys()].sort()) {
    const members = navMembership.get(navFile)!;
    if (members.size === 0) continue;
    const memberList = [...members].sort();
    const dirKeys = new Set(memberList.map(featureDirKey));
    if (dirKeys.size <= 1) {
      // COHESIVE — the navigator's screens are one feature; keep them together
      // under the navigator name (defeats the directory heuristic — the headline
      // value). Only add files not already claimed by an earlier navigator.
      keptNavs++;
      const name = navigatorGroupName(navFile);
      const id = slugify(name) || 'navigator';
      const fresh = [navFile, ...memberList].filter((f) => !claimed.has(f));
      if (fresh.length > 0) {
        add(id, humanizeName(name) || id, fresh);
        for (const f of fresh) claimed.add(f);
      }
    } else {
      // MEGA / incoherent — a routing hub spanning many features; distribute its
      // screens (and the navigator file itself) to their own feature folders.
      splitNavs++;
      splitFile(navFile);
      for (const m of memberList) splitFile(m);
    }
  }

  // Fallback — screen/route-family files in no navigator (Expo Router pages, or
  // an orphan screen), grouped by feature folder. Root-level files with no
  // determinable feature are logged (no silent cap; no filename fallback here).
  for (const fileId of [...roles.keys()].sort()) {
    if (!FALLBACK_ROLES.has(roles.get(fileId)!.role)) continue;
    if (claimed.has(fileId)) continue;
    const feature = deriveFeature(fileId, false);
    if (!feature) {
      ungroupable.push(fileId);
      continue;
    }
    const id = slugify(feature) || 'feature';
    add(id, humanizeName(feature) || id, [fileId]);
    claimed.add(fileId);
  }

  const groups: FrameworkGroup[] = [...acc.entries()]
    .map(([id, g]) => ({ id, label: g.label, fileIds: [...g.fileIds].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { groups, ungroupable, keptNavs, splitNavs };
}

// ---------------------------------------------------------------------------
// Slice B — Expo Router routes (consumes the  routing library).
//
// When an Expo Router route dir (`app/` | `src/app/`) exists, the shared
// extractor returns a RouteTree (routes + nav edges) in the SAME file-id space
// the contribution step resolves. We map it onto adapter contributions:
//   * each RouteNode.fileId → a RoleTag (page/layout/route/endpoint), `kind`
//     mapped onto the LOCKED Module-kind enum (route UI → frontend, an `+api`
//     endpoint → gateway). parentFileId + routePath ride as role METADATA —
//     nesting is structural metadata, NEVER an edge (locked).
//   * each RouteNavEdge → a `calls` FrameworkEdge (nav = calls; the only verb).
// Detection-gated + additive: no route dir ⇒ `extractExpoRouterTree` returns
// null ⇒ no Expo contribution ⇒ behavior unchanged.

interface ExpoRouterContribution {
  edges: FrameworkEdge[];
  roles: Map<string, RoleTag>;
}

function analyzeExpoRouter(repoDir: string, rootPath: string): ExpoRouterContribution | null {
  const tree = extractExpoRouterTree({ repoDir, rootPath });
  if (!tree) return null;

  // Route roles. parentFileId + routePath carried as metadata (NOT edges).
  const roles = new Map<string, RoleTag>();
  for (const node of tree.routes) {
    roles.set(node.fileId, {
      role: node.role,
      kind: ROLE_KIND[node.role],
      priority: ROLE_PRIORITY[node.role],
      metadata: {
        framework: 'react-native',
        convention: tree.convention,
        routePath: node.routePath,
        ...(node.parentFileId !== undefined ? { parentFileId: node.parentFileId } : {}),
      },
    });
  }

  // Nav edges → `calls`. The step resolves file ids → modules, drops self-edges,
  // and dedupes these AGAINST the React-Navigation edges (overlap collapses).
  const edges: FrameworkEdge[] = tree.navEdges.map((e) => ({
    source: e.fromFileId,
    target: e.toFileId,
    kind: 'calls',
    metadata: { framework: 'react-native', convention: tree.convention, relation: 'navigation' },
  }));

  return { edges, roles };
}

// Mirror of contribute-step.ts beats(): higher priority wins; lexical role
// tiebreak keeps the pick deterministic regardless of merge/iteration order.
function roleBeats(incoming: RoleTag, incumbent: RoleTag): boolean {
  const a = incoming.priority ?? 0;
  const b = incumbent.priority ?? 0;
  if (a !== b) return a > b;
  return incoming.role < incumbent.role;
}

// Fold one role map into another, collapsing a per-file collision (a file that
// matched both a React-Navigation role AND an Expo route role) by roleBeats and
// recording it for a single aggregated log — no silent pick (constraint 7).
function mergeRole(
  into: Map<string, RoleTag>,
  fileId: string,
  tag: RoleTag,
  collisions: Map<string, Set<string>>,
): void {
  const cur = into.get(fileId);
  if (cur === undefined) {
    into.set(fileId, tag);
    return;
  }
  if (cur.role !== tag.role) {
    let set = collisions.get(fileId);
    if (!set) {
      set = new Set([cur.role]);
      collisions.set(fileId, set);
    }
    set.add(tag.role);
  }
  if (roleBeats(tag, cur)) into.set(fileId, tag);
}

function analyzeReactNative(ctx: FrameworkContext): ReactNativeAnalysis {
  const { repoDir, rootPath, graph } = ctx;
  const project = buildExtractionProject(repoDir);
  addAllSourceFiles(project, repoDir);
  const sourceFiles = project.getSourceFiles();

  const fileById = new Map<string, SourceFile>();
  for (const sf of sourceFiles) fileById.set(toId(repoDir, sf.getFilePath()), sf);

  // Pass 1 — global screen registry + navigator/screen role signals.
  const registry = new Map<string, string>(); // screen name → component file id
  const screenFiles = new Set<string>();
  const navigatorFiles = new Set<string>();
  // navigator file id → the set of screen component files it registers
  // (the navigator-membership grouping signal).
  const navMembership = new Map<string, Set<string>>();
  const importMaps = new Map<string, Map<string, string>>();
  const idSet = new Set(fileById.keys());
  const aliasResolve = makeAliasResolver(readAliasPatterns(repoDir), idSet);
  const resolveSpecifier = makeSpecifierResolver(idSet, aliasResolve);
  const screenDiag: ScreenDiag = { dynamicNames: 0, unresolvedComponents: new Set() };
  for (const [fileId, sf] of fileById) {
    if (!inScope(fileId, rootPath)) continue;
    const imports = buildImportNameMap(sf, repoDir, aliasResolve);
    importMaps.set(fileId, imports);
    const membership = new Set<string>();
    const navigator = collectScreens(
      sf,
      imports,
      fileId,
      registry,
      screenFiles,
      (spec) => resolveSpecifier(fileId, spec),
      screenDiag,
      membership,
    );
    if (navigator) {
      navigatorFiles.add(fileId);
      navMembership.set(fileId, membership);
    }
  }

  // Pass 2 — nav edges from navigate()/push() targets + native boundary files.
  const navEdges: FrameworkEdge[] = [];
  const seenNav = new Set<string>();
  const nativeFiles = new Set<string>();
  let dynamicNavTargets = 0;
  const unresolvedNavTargets = new Set<string>();

  for (const [fileId, sf] of fileById) {
    if (!inScope(fileId, rootPath)) continue;
    if (usesNative(sf)) nativeFiles.add(fileId);

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
      const method = (callee as PropertyAccessExpression).getName();
      const isLog = NAV_LOG_METHODS.has(method);
      const isSoft = NAV_SOFT_METHODS.has(method);
      if (!isLog && !isSoft) continue;
      const arg = call.getArguments()[0];
      if (!arg) continue;
      if (arg.getKind() !== SyntaxKind.StringLiteral) {
        // Dynamic target — only count it for the nav-unambiguous methods, so
        // `arr.push(x)` doesn't masquerade as a dropped navigation.
        if (isLog) dynamicNavTargets++;
        continue;
      }
      const target = (arg as StringLiteral).getLiteralValue();
      const targetFile = registry.get(target);
      if (!targetFile) {
        if (isLog) unresolvedNavTargets.add(target);
        continue;
      }
      const key = `${fileId}→${targetFile}`;
      if (seenNav.has(key)) continue;
      seenNav.add(key);
      navEdges.push({ source: fileId, target: targetFile, kind: 'calls', metadata: { framework: 'react-native', relation: 'navigation', screen: target } });
    }
  }

  // Pass 3 — JS↔native bridge edges: importers (from the structural graph) of a
  // native-boundary file → that file. Native code itself is off-graph (we never
  // parse ios/android source); the boundary FILE is the JS side of the bridge.
  const bridgeEdges: FrameworkEdge[] = [];
  const seenBridge = new Set<string>();
  if (nativeFiles.size > 0) {
    for (const e of graph.edges) {
      if (e.external) continue;
      if (!nativeFiles.has(e.to)) continue;
      if (e.from === e.to) continue;
      const key = `${e.from}→${e.to}`;
      if (seenBridge.has(key)) continue;
      seenBridge.add(key);
      bridgeEdges.push({ source: e.from, target: e.to, kind: 'calls', metadata: { framework: 'react-native', relation: 'native-bridge' } });
    }
  }

  // Roles — combine all signals; highest priority per file wins.
  const roleByFile = new Map<string, ReactNativeRole>();
  for (const f of navigatorFiles) addRole(roleByFile, f, 'navigator');
  for (const f of nativeFiles) addRole(roleByFile, f, 'nativeModule');
  for (const f of screenFiles) addRole(roleByFile, f, 'screen');
  for (const [fileId, sf] of fileById) {
    if (!inScope(fileId, rootPath)) continue;
    if (/^use[A-Z0-9]/.test(baseName(fileId))) addRole(roleByFile, fileId, 'hook');
    if (hasJsx(sf)) addRole(roleByFile, fileId, 'component');
  }
  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) roles.set(fileId, roleTag(role));

  // Slice B — Expo Router routes. DETECTION-GATED: no `app/`|`src/app/` route dir
  // ⇒ analyzeExpoRouter returns null ⇒ no route roles/edges ⇒ the Slice-A output
  // (and a non-Expo repo) is byte-identical. When present, fold the route roles
  // into the SAME role map — one file can carry a React-Navigation role (Slice A)
  // AND an Expo route role (Slice B); collapse by priority, record the collision
  // — and collect the route nav edges into their own bucket (the step dedupes
  // them against the React-Navigation edges + resolves both to modules).
  const routeEdges: FrameworkEdge[] = [];
  const roleCollisions = new Map<string, Set<string>>();
  const expo = analyzeExpoRouter(repoDir, rootPath);
  if (expo) {
    for (const [fileId, tag] of expo.roles) mergeRole(roles, fileId, tag, roleCollisions);
    routeEdges.push(...expo.edges);
  }

  // Registration summary (a positive signal for validation) + the "no silent
  // caps" registration diagnostics: screens whose name/component couldn't be
  // statically resolved (lazy registration recovered, the rest logged).
  if (navigatorFiles.size > 0 || registry.size > 0) {
    console.log(
      `  [react-native] registered ${registry.size} screen(s) across ${navigatorFiles.size} navigator file(s)`,
    );
  }
  if (screenDiag.dynamicNames > 0 || screenDiag.unresolvedComponents.size > 0) {
    const parts: string[] = [];
    if (screenDiag.dynamicNames > 0) parts.push(`${screenDiag.dynamicNames} dynamic screen name(s)`);
    if (screenDiag.unresolvedComponents.size > 0) {
      parts.push(
        `${screenDiag.unresolvedComponents.size} screen(s) with an unresolvable component: ${[...screenDiag.unresolvedComponents].sort().join(', ')}`,
      );
    }
    console.log(`  [react-native] registration skipped ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  // No silent caps ( constraint 7): log dropped/unresolved targets once.
  if (dynamicNavTargets > 0 || unresolvedNavTargets.size > 0) {
    const parts: string[] = [];
    if (dynamicNavTargets > 0) parts.push(`${dynamicNavTargets} dynamic target(s)`);
    if (unresolvedNavTargets.size > 0) {
      parts.push(`${unresolvedNavTargets.size} unregistered target(s): ${[...unresolvedNavTargets].sort().join(', ')}`);
    }
    console.log(`  [react-native] skipped ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  // No silent caps: a file that matched BOTH a React-Navigation role AND an Expo
  // route role had them collapsed by priority — report each (roles seen + winner),
  // never a silent pick. (The contribute-step logs the analogous per-MODULE
  // collapse after file→module resolution; this is the per-FILE collapse.)
  if (roleCollisions.size > 0) {
    const sample = [...roleCollisions.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, 10)
      .map(([fileId, set]) => `${fileId} {${[...set].sort().join(', ')}} → kept '${roles.get(fileId)?.role}'`);
    console.log(
      `  [react-native] ${roleCollisions.size} file(s) matched both a React-Navigation and an Expo Router role (collapsed by priority): ${sample.join(' · ')}` +
        (roleCollisions.size > sample.length ? ' …' : ''),
    );
  }

  // the feature grouping prior (navigator membership + feature-folder
  // fallback). Built from the final role map (so the fallback sees every role).
  const { groups, ungroupable, keptNavs, splitNavs } = buildGroupingPrior(navMembership, roles);
  if (groups.length > 0) {
    console.log(
      `  [react-native] grouped into ${groups.length} feature subsystem(s) from ${navMembership.size} navigator file(s) ` +
        `(${keptNavs} cohesive navigator group(s) + ${splitNavs} mega-navigator(s) split by feature folder + feature-folder fallback)`,
    );
  }
  if (ungroupable.length > 0) {
    const sample = [...ungroupable].sort().slice(0, 10);
    console.log(
      `  [react-native] ${ungroupable.length} screen/route file(s) had no determinable feature folder (not grouped): ${sample.join(', ')}` +
        (ungroupable.length > sample.length ? ' …' : ''),
    );
  }

  // Deterministic ordering — module-id resolution + dedupe downstream rely on a
  // stable input order; sort by endpoints.
  const byEndpoints = (a: FrameworkEdge, b: FrameworkEdge) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  navEdges.sort(byEndpoints);
  bridgeEdges.sort(byEndpoints);
  routeEdges.sort(byEndpoints);

  return { navEdges, bridgeEdges, routeEdges, roles, groups };
}

function getAnalysis(ctx: FrameworkContext): ReactNativeAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeReactNative(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const reactNativeAdapter: FrameworkAdapter = {
  name: 'react-native',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    // Thin single-root pass: scan the workspace package when given, else the
    // repo root (per-package fan-out is ). rootPath is the repo-relative
    // posix path of that base ('' for the repo root).
    const base = ctx.packageDir ?? ctx.repoDir;
    const rootPath = ctx.packageDir
      ? relative(ctx.repoDir, ctx.packageDir).split('\\').join('/')
      : '';
    return scoreReactNative(gatherReactNativeSignals(base), rootPath);
  },

  // the feature grouping prior: navigator membership (primary) +
  // feature-folder fallback. The contribute-step namespaces each group
  // `react-native:<id>` and overrides the claimed modules' subsystem, beating the
  // directory heuristic (screens grouped by feature, not by folder). Deterministic
  // (name/path-derived) → no classificationsNeeded (the deferred-LLM channel stays
  // empty, preserving the zero-LLM property).
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // the navigation graph + JS↔native boundary (file-id space; the
  // contribution step resolves to modules). kind 'calls' only.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    const a = getAnalysis(ctx);
    // React-Navigation nav + JS↔native bridge (Slice A) + Expo Router route nav
    // (Slice B). All `calls`, file-id endpoints; the step dedupes the union.
    return [...a.navEdges, ...a.bridgeEdges, ...a.routeEdges];
  },

  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE — React-Navigation navigator config + navigate() calls
  // + NativeModules usage (Slice A), AND the Expo Router `app/` route files +
  // their <Link href>/router.push() nav targets (Slice B) — so declare the
  // source paths the diff-driven hosted walk must treat as framework-relevant.
  // Every Expo route file is a source file (.ts/.tsx/.js/.jsx, incl. `+api.ts`),
  // so the source-extension test already covers them. Never-store-source holds:
  // read server-side, persist only derived edges/roles.
  scansSourcePath(path: string): boolean {
    const ext = path.split('.').pop();
    return ext !== undefined && SOURCE_EXT_SET.has(ext);
  },
};
