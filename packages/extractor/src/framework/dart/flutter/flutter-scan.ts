// Pure, comment-aware navigation + app-entry scanners for Flutter source — the
// pieces the widget-graph backbone never needed: which widget a route constructor
// builds, the literal route path/name that construction registers, the string a
// `context.go(...)` / `pushNamed(...)` navigates to, and the root widget `runApp`
// mounts. All best-effort + deterministic (a hand-rolled scanner, never executes
// repo code), reusing dart-scan's comment/string-blanking so a commented-out route
// never registers.
//
// Documented degrades (accepted, v1): a dynamic route target (`context.go(var)`) is
// not a literal → surfaced in `dynamicNavCalls` for logging, never a fabricated edge.
// `@TypedGoRoute` codegen routers (no literal `GoRoute(...)`) yield no route rows.

import { sourceLines } from '../../../graph/dart-scan.js';

/** One route construction: the widget it builds + the literal path/name it registers. */
export interface RouteConstruction {
  ctor: string; // MaterialPageRoute | GoRoute | …
  widget?: string; // the widget class the builder returns (a nav TARGET)
  path?: string; // a literal `path: '/x'` (go_router)
  name?: string; // a literal `name: 'x'` (go_router)
}

// The route/page constructors whose `builder:` / `pageBuilder:` names a target
// widget. These are unambiguously navigation (unlike a bare `Builder(...)` /
// `ListView.builder`), so anchoring to them keeps the nav edges precise.
const ROUTE_CTOR_RE = /\b(MaterialPageRoute|CupertinoPageRoute|PageRouteBuilder|GoRoute|ShellRoute)\b/g;
// Inside a route ctor's window: the first `=> [const] Widget(` the builder returns.
const BUILDER_WIDGET_RE = /=>\s*(?:const\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/;
const PATH_ARG_RE = /\bpath\s*:\s*(['"])([^'"]+)\1/;
const NAME_ARG_RE = /\bname\s*:\s*(['"])([^'"]+)\1/;
// A bounded lookahead window after a route ctor (a GoRoute's args + builder sit
// close to its declaration). Big enough for a multi-line GoRoute, small enough that
// the NEXT route's builder doesn't bleed in.
const ROUTE_WINDOW = 600;

/** Comment-stripped source as one string (reuses dart-scan's blanking). */
function cleanText(text: string): string {
  return sourceLines(text).join('\n');
}

/**
 * Every route construction in `text`: for each route/page constructor, the widget
 * its builder returns (a nav target) + any literal `path:` / `name:` it registers.
 * Rows with neither a widget nor a path/name are dropped.
 */
export function scanRouteConstructions(text: string): RouteConstruction[] {
  const clean = cleanText(text);
  const out: RouteConstruction[] = [];
  for (const m of clean.matchAll(ROUTE_CTOR_RE)) {
    const start = (m.index ?? 0) + m[0].length;
    const window = clean.slice(start, start + ROUTE_WINDOW);
    const widget = window.match(BUILDER_WIDGET_RE)?.[1];
    const path = window.match(PATH_ARG_RE)?.[2];
    const name = window.match(NAME_ARG_RE)?.[2];
    if (widget || path || name) out.push({ ctor: m[1], widget, path, name });
  }
  return out;
}

/** The root widget `runApp(RootWidget(...))` mounts, or undefined. */
export function scanRunAppWidget(text: string): string | undefined {
  const m = cleanText(text).match(/\brunApp\s*\(\s*(?:const\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/);
  return m?.[1];
}

// Any `=> [const] Widget(` builder-arrow widget construction. Broader than the route
// constructors above — it also catches a CUSTOM route wrapper (`AppRoute('/x', (s) =>
// DetailScreen())`, the wonderous shape) the fixed ctor list can't name. The caller
// keeps precision by only edging targets that RESOLVE to an in-repo file AND read as a
// screen (name-suffixed / already a route target), so an embed of a plain component is
// never mistaken for navigation.
const ARROW_WIDGET_RE = /=>\s*(?:const\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/g;

/** Every widget class returned from a `=> Widget(` builder arrow, in source order. */
export function scanArrowWidgetTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of cleanText(text).matchAll(ARROW_WIDGET_RE)) out.push(m[1]);
  return out;
}

// A path-style nav call: `context.go('/x')` / `.push('/x')` / `.replace('/x')`.
const PATH_NAV_RE = /\bcontext\s*\.\s*(?:go|push|pushReplacement|replace)\s*\(\s*(['"])([^'"]+)\1/g;
// A named nav call: `.goNamed('x')` / `.pushNamed(context, '/x')` / … — the route
// string may be the first OR second (after a `context,`) argument.
const NAMED_NAV_RE =
  /\.\s*(?:goNamed|pushNamed|pushReplacementNamed|replaceNamed|popAndPushNamed|restorablePushNamed)\s*\(\s*(?:[A-Za-z_][\w.]*\s*,\s*)?(['"])([^'"]+)\1/g;
// A dynamic path/named nav call whose target is NOT a literal (a variable / expr).
const DYNAMIC_NAV_RE =
  /\b(?:context\s*\.\s*(?:go|push|replace)|\.\s*(?:goNamed|pushNamed|pushReplacementNamed))\s*\(\s*(?![A-Za-z_][\w.]*\s*,\s*['"])(?!['"])[^)]/g;

/** The result of scanning a file's string-target navigation calls. */
export interface NamedNavCalls {
  /** Literal route strings (a path like `/detail` or a go_router name like `detail`). */
  targets: string[];
  /** Count of nav calls whose target is a non-literal (dynamic) — for logging. */
  dynamic: number;
}

/**
 * String-target navigation calls in `text`: the literal route strings (path or name
 * form — the caller resolves each against the route table) + a count of dynamic
 * (non-literal) targets to log. Comment-aware.
 */
export function scanNamedNavCalls(text: string): NamedNavCalls {
  const clean = cleanText(text);
  const targets: string[] = [];
  for (const m of clean.matchAll(PATH_NAV_RE)) targets.push(m[2]);
  for (const m of clean.matchAll(NAMED_NAV_RE)) targets.push(m[2]);
  const dynamic = [...clean.matchAll(DYNAMIC_NAV_RE)].length;
  return { targets, dynamic };
}
