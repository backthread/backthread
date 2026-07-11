// (Slice 2) — shared detection helpers for the manifest+config-existence
// adapters (Next / Nest / Node / ORM).
//
// Every Slice-2 adapter keeps the SAME pure-builder / fs-adapter split the React
// Native adapter established: a thin fs layer (gather*Signals) reads package.json
// deps + config-file EXISTENCE only — never source content (never-store-source) —
// and a PURE scorer (score*) turns the deterministic signal set into a DetectMatch
// (or null = no match = generic-TS fallthrough). These helpers are the bits the
// four adapters would otherwise duplicate verbatim, factored once. (The RN adapter
// predates this and inlines its own copies — intentionally left untouched.)

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FrameworkDetectContext } from './types.js';

/**
 * The merged dependency map from a package.json (`dependencies` +
 * `devDependencies`); `{}` on any read/parse error. Deterministic — no source,
 * no install, just the manifest.
 */
export function readDeps(baseDir: string): Record<string, string> {
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

/** True if any of `names` exists as a file/dir directly under `baseDir`. */
export function existsAny(baseDir: string, names: readonly string[]): boolean {
  return names.some((n) => existsSync(join(baseDir, n)));
}

/** True if `rel` is an existing directory under `baseDir`. */
export function isDir(baseDir: string, rel: string): boolean {
  try {
    return statSync(join(baseDir, rel)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the base dir + repo-relative posix rootPath a detect pass should scan.
 * Mirrors the RN adapter: a workspace `packageDir` (the per-package fan-out shape,
 * ) scopes the scan + reports its repo-relative path; absent ⇒ the repo
 * root (`''`). Path is posix-normalized so manifests are stable cross-platform.
 */
export function resolveBase(ctx: FrameworkDetectContext): { base: string; rootPath: string } {
  if (ctx.packageDir) {
    return {
      base: ctx.packageDir,
      rootPath: relative(ctx.repoDir, ctx.packageDir).split('\\').join('/'),
    };
  }
  return { base: ctx.repoDir, rootPath: '' };
}

/** Clamp a raw confidence sum into the [0,1] DetectMatch range, 2-dp stable. */
export function clampConfidence(raw: number): number {
  return Math.min(1, Math.max(0, Number(raw.toFixed(2))));
}
