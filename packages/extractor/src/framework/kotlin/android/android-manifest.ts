// Minimal AndroidManifest.xml component scan — NO XML parser dependency (none is in the
// dep tree, and adding one would break the Kotlin-is-dep-free promise). AndroidManifest is
// CONFIG (not application source), so reading it is install-free + never-store-source
// safe. A regex tag scan extracts the declared components — `<activity|service|receiver|
// provider android:name="…">` — which are the authoritative Android component registry:
// a class listed here IS an Activity/Service/Receiver/Provider regardless of what base it
// visibly extends (it may extend a project-local base the scanner can't follow).
//
// The `android:name` value is resolved against the manifest's package: a leading-dot
// (`.MainActivity`) or bare (`MainActivity`) name is relative to `<manifest package="…">`
// (older projects) — modern AGP moves the package to a Gradle `namespace`, which this
// scanner does NOT read, so a relative name with no manifest package resolves by its
// SIMPLE NAME against the FQN registry instead (the caller's fallback). A fully-qualified
// name (`com.example.MainActivity`) resolves directly.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ManifestComponent {
  tag: 'activity' | 'service' | 'receiver' | 'provider';
  /** Best-effort fully-qualified class name (package + name), or '' when unknown. */
  fqn: string;
  /** The class's simple name — the registry fallback when the package is unknown. */
  simpleName: string;
}

// `<manifest ... package="com.example">` — the (older-AGP) package the components resolve
// relative to. Modern projects declare `namespace` in build.gradle instead (not read here).
const MANIFEST_PACKAGE_RE = /<manifest\b[^>]*\bpackage\s*=\s*"([^"]+)"/;
// A component tag with an android:name. `android:name` may precede or follow other attrs,
// so capture the tag then find android:name within the same element's attribute run.
const COMPONENT_RE = /<(activity|service|receiver|provider)\b([^>]*)>/g;
const ANDROID_NAME_RE = /\bandroid:name\s*=\s*"([^"]+)"/;

/** Resolve an `android:name` value + manifest package into a component descriptor. */
export function resolveComponentName(
  tag: ManifestComponent['tag'],
  name: string,
  pkg: string | undefined,
): ManifestComponent {
  const simpleName = name.slice(name.lastIndexOf('.') + 1);
  let fqn = '';
  if (name.startsWith('.')) {
    fqn = pkg ? pkg + name : '';
  } else if (name.includes('.')) {
    fqn = name; // already fully-qualified
  } else {
    fqn = pkg ? `${pkg}.${name}` : '';
  }
  return { tag, fqn, simpleName };
}

/** Parse ONE AndroidManifest.xml's text into its declared components. */
export function parseAndroidManifest(text: string): ManifestComponent[] {
  const pkg = text.match(MANIFEST_PACKAGE_RE)?.[1];
  const out: ManifestComponent[] = [];
  for (const m of text.matchAll(COMPONENT_RE)) {
    const tag = m[1] as ManifestComponent['tag'];
    const name = m[2].match(ANDROID_NAME_RE)?.[1];
    if (name) out.push(resolveComponentName(tag, name, pkg));
  }
  return out;
}

// Build/vendor dirs the manifest walk skips (cheap; can't hold a first-party manifest).
const SKIP_DIRS = new Set([
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
const WALK_MAX_DEPTH = 10;

/** Is `dir` (repo-relative posix) within the adapter's matched root? */
function inScope(rel: string, rootPath: string): boolean {
  if (rootPath === '') return true;
  return rel === rootPath || rel.startsWith(`${rootPath}/`) || rootPath.startsWith(`${rel}/`) || rel === '';
}

/**
 * Every declared component across every AndroidManifest.xml under `repoDir` (scoped to
 * `rootPath`). A bounded walk (skips build/vendor + dot dirs, depth-capped). NEVER throws
 * (an unreadable dir/file is skipped). Deduped by (tag, fqn|simpleName), sorted.
 */
export function scanAndroidManifests(repoDir: string, rootPath: string): ManifestComponent[] {
  const seen = new Set<string>();
  const out: ManifestComponent[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > WALK_MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === 'AndroidManifest.xml' && inScope(rel, rootPath)) {
        try {
          for (const comp of parseAndroidManifest(readFileSync(join(abs, e.name), 'utf8'))) {
            const key = `${comp.tag}:${comp.fqn || comp.simpleName}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push(comp);
            }
          }
        } catch {
          // unreadable manifest — skip
        }
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      walk(join(abs, e.name), childRel, depth + 1);
    }
  };
  walk(repoDir, '', 0);
  return out.sort((a, b) =>
    a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : (a.fqn || a.simpleName) < (b.fqn || b.simpleName) ? -1 : 1,
  );
}
