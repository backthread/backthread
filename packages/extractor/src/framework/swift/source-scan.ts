// Shared detect-time source-scan helpers for the Swift framework adapters.
//
// SwiftUI/UIKit/SwiftData/CoreData are Apple platform frameworks — NOT manifest
// dependencies — so unlike the dep-gated adapters, the Swift UI/data/vapor adapters
// must read SOURCE to detect (a bounded scan for `import SwiftUI`, `import Fluent`, a
// `.xcdatamodeld` bundle, …). Each adapter's `detect()` previously hand-rolled a
// near-identical `readHead`, `isXcodeContainer`, and a bounded `.swift` file-walk;
// this module is the ONE shared implementation the three now call.
//
// Behavior is byte-identical to the pre-dedup per-adapter walks: same readdir order
// (depth-first), same `scanned` cap semantics, same dir-skip policy
// (dot-prefixed / SWIFT_EXCLUDE_DIRS / Xcode-container bundle), same `Package.swift`
// (a manifest, not a node) exclusion, and the same never-throws posture. The walker
// invokes the callback for EVERY directory AND `.swift` file entry, so a caller can
// still observe a bundle dir (CoreData's `.xcdatamodeld`) before it is skipped.

import { openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SWIFT_EXCLUDE_DIRS, SWIFT_EXCLUDE_SUFFIXES } from '../../graph/file-graph.js';

const SWIFT_EXCLUDE_SET = new Set<string>([...SWIFT_EXCLUDE_DIRS]);

/**
 * Does `name` end with an Xcode CONTAINER-bundle suffix (`.xcodeproj` / `.xcworkspace`
 * / `.xcassets` / `.playground`)? Such dirs hold generated project metadata / assets /
 * playground scratch — never first-party Swift source — so a detect walk skips
 * recursing into them (mirroring listSourceFiles' exclusion via SWIFT_EXCLUDE_SUFFIXES).
 */
export function isXcodeContainer(name: string): boolean {
  return SWIFT_EXCLUDE_SUFFIXES.some((s) => name.endsWith(s));
}

/**
 * Read only the HEAD of a file (imports live at the top — the cheap detect read).
 * Never throws (an unreadable / absent file yields '').
 */
export function readHead(path: string, maxBytes = 4096): string {
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

/** One entry the detect walk visits — a directory or a `.swift` source file. */
export interface SwiftSourceEntry {
  kind: 'dir' | 'file';
  /** The entry's basename. */
  name: string;
}

/**
 * Walk `.swift` source files under `base`, bounded by `cap` scanned files, invoking
 * `onEntry` for every directory AND `.swift` file the walk visits (in readdir order,
 * depth-first). For a FILE, `readFileHead()` lazily reads the file's head (imports live
 * at the top); for a DIR it returns '' (a dir has no head). The dir callback exists so
 * a caller can OBSERVE a bundle dir (e.g. CoreData's `.xcdatamodeld`) BEFORE it is
 * skipped. Return `true` from `onEntry` to early-exit the whole walk.
 *
 * A directory is recursed into unless it is dot-prefixed, in SWIFT_EXCLUDE_DIRS
 * (`.build`/`Pods`/`DerivedData`/`Carthage`/`node_modules`), or an Xcode container
 * bundle. `Package.swift` (a manifest, not a source node) is neither counted nor read.
 * Never throws (an unreadable dir/file is skipped). Only `.swift` files count against
 * `cap`, so the walk stays bounded on any repo.
 */
export function scanSwiftSourceHeads(
  base: string,
  onEntry: (entry: SwiftSourceEntry, readFileHead: () => string) => boolean | void,
  cap: number,
): void {
  let scanned = 0;
  let stop = false;
  const emptyHead = (): string => '';
  const walk = (dir: string): void => {
    if (stop || scanned >= cap) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip its subtree, never throw
    }
    for (const e of entries) {
      if (stop || scanned >= cap) return;
      if (e.isDirectory()) {
        // Observe the dir (e.g. `.xcdatamodeld`) BEFORE the skip check, matching the
        // pre-dedup data walk. The callback may early-exit the whole walk.
        if (onEntry({ kind: 'dir', name: e.name }, emptyHead) === true) {
          stop = true;
          return;
        }
        if (e.name.startsWith('.') || SWIFT_EXCLUDE_SET.has(e.name) || isXcodeContainer(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.swift') && e.name !== 'Package.swift') {
        scanned++;
        const full = join(dir, e.name);
        if (onEntry({ kind: 'file', name: e.name }, () => readHead(full)) === true) {
          stop = true;
          return;
        }
      }
    }
  };
  walk(base);
}
