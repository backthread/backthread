// Pure Zeitwerk constant<->path resolution — the reusable core the Ruby graph
// extractor AND every Ruby framework adapter share (the framework layer's
// buildConstantBindings wraps buildConstantIndex).
//
// Ruby's dominant dependency mechanism is NOT `require` — it's autoloading. A
// Rails controller references the constant `User` and Zeitwerk loads
// app/models/user.rb on demand; there is no `require` statement to read. So the
// import backbone is recovered by INVERTING Zeitwerk's file<->constant convention:
//   * a file at <autoload-root>/admin/users_controller.rb DEFINES the constant
//     Admin::UsersController (strip the root prefix, camelize each path segment);
//   * a constant REFERENCE elsewhere is resolved back to that file.
//
// Autoload roots (Rails + gem conventions): each app/<subdir> (except view/asset
// dirs), each app/<subdir>/concerns, and lib/. Deterministic + pure (no fs, no
// parser) — every function here is a total function of its inputs.
//
// camelize is now ACRONYM-aware (it lives in ruby-inflect, threaded here as an
// optional Inflections): with the repo's declared `inflect.acronym` rules,
// `activitypub/inboxes_controller.rb` maps to `ActivityPub::InboxesController`
// instead of `Activitypub::…` — recovering the constant a code-reader would.
// Absent an Inflections (the default), it degrades to the plain camelizer.

import { camelize, EMPTY_INFLECTIONS, type Inflections } from './ruby-inflect.js';

export { camelize } from './ruby-inflect.js';
export type { Inflections } from './ruby-inflect.js';

// app/<x> subdirs that Rails does NOT autoload as Ruby (assets/views/JS), so a
// file under them never defines an autoloadable constant.
const APP_NON_AUTOLOAD = new Set(['views', 'assets', 'javascript', 'javascripts', 'stylesheets', 'images', 'fonts', 'html']);

/**
 * The Zeitwerk autoload roots implied by a file set, longest-first (so
 * fileToConstant matches the most specific root — `app/models/concerns` before
 * `app/models`). Recognizes each `app/<subdir>` (except asset/view dirs), the
 * Rails `app/<subdir>/concerns` collapsed roots, and `lib/`.
 */
export function computeAutoloadRoots(fileIds: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const id of fileIds) {
    const parts = id.split('/');
    if (parts[0] === 'app' && parts.length >= 3 && !APP_NON_AUTOLOAD.has(parts[1])) {
      roots.add(`app/${parts[1]}`);
      // Rails treats app/<subdir>/concerns as its own root (Trackable, not
      // Concerns::Trackable).
      if (parts.length >= 4 && parts[2] === 'concerns') roots.add(`app/${parts[1]}/concerns`);
    } else if (parts[0] === 'lib') {
      roots.add('lib');
    }
  }
  return [...roots].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/**
 * The constant a file DEFINES by its path, or undefined when the file sits under
 * no autoload root (config/, db/migrate/, spec/, a bare Rakefile — those reference
 * constants but don't define autoloadable ones). `roots` MUST be longest-first.
 */
export function fileToConstant(
  fileId: string,
  roots: readonly string[],
  infl: Inflections = EMPTY_INFLECTIONS,
): string | undefined {
  for (const root of roots) {
    const prefix = `${root}/`;
    if (!fileId.startsWith(prefix)) continue;
    const rel = fileId.slice(prefix.length).replace(/\.rb$/, '');
    const segs = rel.split('/').filter(Boolean);
    if (!segs.length) return undefined;
    return segs.map((s) => camelize(s, infl)).join('::');
  }
  return undefined;
}

/** The constant-name -> file-id index for a file set, plus the autoload roots it
 *  was built from. Deterministic: files are visited in sorted order, so on a
 *  (rare) constant collision the smallest file id wins. */
export function buildConstantIndex(
  fileIds: readonly string[],
  infl: Inflections = EMPTY_INFLECTIONS,
): {
  index: Map<string, string>;
  roots: string[];
} {
  const roots = computeAutoloadRoots(fileIds);
  const index = new Map<string, string>();
  for (const id of [...fileIds].sort()) {
    const c = fileToConstant(id, roots, infl);
    if (c && !index.has(c)) index.set(c, id);
  }
  return { index, roots };
}

/** Longest-prefix lookup: try `A::B::C`, then `A::B`, then `A`, down to `minSegs`
 *  leading segments. Returns the first indexed file id, or undefined. */
export function longestPrefixLookup(
  name: string,
  index: ReadonlyMap<string, string>,
  minSegs = 1,
): string | undefined {
  const segs = name.split('::').filter(Boolean);
  for (let j = segs.length; j >= minSegs; j--) {
    const hit = index.get(segs.slice(0, j).join('::'));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Resolve a constant reference to the file that defines it, honoring lexical
 * nesting. Ruby resolves an unqualified `Report` inside `module Admin` against the
 * enclosing scopes first (`Admin::Report`, then top-level `Report`), so we try each
 * nesting prefix deepest-first before the absolute name. The nesting candidates
 * never drop below `scope + first-ref-segment`, so a qualified `Payment::Charge`
 * inside `Admin` can't spuriously resolve to the bare `Admin` scope.
 */
export function resolveConstant(
  ref: string,
  nesting: readonly string[],
  index: ReadonlyMap<string, string>,
): string | undefined {
  const refSegs = ref.split('::').filter(Boolean);
  if (!refSegs.length) return undefined;
  // 1. Nesting-qualified, deepest scope first.
  for (let i = nesting.length; i >= 1; i--) {
    const scope = nesting.slice(0, i);
    const qualified = [...scope, ...refSegs].join('::');
    const hit = longestPrefixLookup(qualified, index, scope.length + 1);
    if (hit) return hit;
  }
  // 2. Absolute (top-level) longest-prefix.
  return longestPrefixLookup(ref, index);
}

/** Join a `require_relative` path against the requiring file's directory,
 *  resolving `.`/`..`. `require_relative '../lib/x'` from `app/a/b.rb` -> `app/lib/x`
 *  ... wait, from `app/a/b.rb` dir is `app/a`, so -> `app/lib/x`. Pure posix. */
export function joinRelative(fromDir: string, rel: string): string {
  const segs = fromDir ? fromDir.split('/') : [];
  for (const s of rel.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') segs.pop();
    else segs.push(s);
  }
  return segs.join('/');
}
