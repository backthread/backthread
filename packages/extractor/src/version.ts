// The published package version, read from package.json at runtime. This is the
// SINGLE source of truth for the extractor version that both the CLI (local
// structure extraction) and the hosted container stamp on their output, so a
// version mismatch between the two — which would mean subtly different graphs —
// is detectable (the container↔CLI version-lockstep guard).
//
// NOTE: distinct from `EXTRACTOR_VERSION` in graph/file-graph.ts, which is the
// incremental-cache SCHEMA version (bumped to invalidate stale blob caches).
// This constant is the npm package version.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Bundlers (esbuild `define`) inline this so a bundled consumer — where
// `import.meta.url` + an fs read of package.json don't work — still reports the
// real version. Absent when running unbundled (the `typeof` guard below is safe
// on an undeclared identifier — it evaluates to 'undefined' rather than throwing).
declare const __EXTRACTOR_VERSION__: string | undefined;

function readPackageVersion(): string {
  // Preferred: a build-time injected version (survives bundling).
  try {
    if (typeof __EXTRACTOR_VERSION__ === 'string' && __EXTRACTOR_VERSION__) {
      return __EXTRACTOR_VERSION__;
    }
  } catch {
    /* not injected — fall through to the unbundled fs read */
  }
  // Fallback: read package.json (works when installed/unbundled).
  try {
    // dev: src/version.ts → ../package.json; built: dist/version.js → ../package.json.
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const EXTRACTOR_PACKAGE_VERSION: string = readPackageVersion();
