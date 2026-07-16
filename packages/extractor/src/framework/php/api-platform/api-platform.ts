// The API Platform FrameworkAdapter (protocol) — the PHP protocol-tier sibling of
// graphql-ruby / absinthe / the Python gRPC+GraphQL adapters. API Platform turns a
// PHP class into an auto-generated REST + GraphQL API surface by marking it with the
// `#[ApiResource]` attribute (or the legacy `@ApiResource` docblock annotation),
// which we read STATICALLY (install-free, never-store-source) via php-parser.
//
//   * detect()  — any `api-platform/*` Composer dep (core, or the 3.4+/4.x split
//                 packages api-platform/symfony · api-platform/laravel · …).
//   * roleTags  — a class carrying `#[ApiResource]` → role 'api-resource' on the
//                 LOCKED `gateway` kind (it IS the request surface). METADATA only.
//
// roleTags-ONLY (no syntheticEdges, no groupingPrior, no EXTRACTOR_VERSION bump):
// an API Platform resource declares itself ON the class (there is no separate
// router→resource wire the import graph misses), and its dependencies are already
// `use`-import edges. The resource role's priority sits ABOVE php-orm's entity
// priority so an `#[ApiResource]` Doctrine entity collapses to `gateway` (the API
// surface) while php-orm's groupingPrior still groups it into the Data Model
// subsystem — which reads correctly: the API front door lives among the entities
// it exposes. Below Symfony's controller priority, so a real controller still wins.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readComposerDeps } from '../../../graph/php-manifest.js';
import { parsePhpScope, type PhpScope } from '../analyze.js';
import { type PhpClass } from '../php-ast.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  RoleTag,
} from '../../types.js';
import type { ModuleKind } from '../../../types.js';

// ---------------------------------------------------------------------------
// Detection.

export interface ApiPlatformSignals {
  hasApiPlatform: boolean; // any api-platform/* package
}

export function gatherApiPlatformSignals(baseDir: string): ApiPlatformSignals {
  const deps = readComposerDeps(baseDir);
  // Match the whole family: api-platform/core (2.x/3.x), and the 3.4+/4.x split
  // metapackages api-platform/symfony · api-platform/laravel · api-platform/graphql.
  return { hasApiPlatform: [...deps].some((d) => d.startsWith('api-platform/')) };
}

export function scoreApiPlatform(s: ApiPlatformSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasApiPlatform) return null;
  return {
    adapter: 'api-platform',
    confidence: clampConfidence(0.9),
    rootPath,
    metadata: { framework: 'api-platform' },
  };
}

const NESTED_SKIP_DIRS = new Set([
  'vendor', 'var', 'cache', 'storage', 'node_modules', 'src', 'app', 'config', 'public', 'tests',
]);

function shallowComposerSubdirs(base: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
    if (existsSync(join(base, e.name, 'composer.json'))) out.push(e.name);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Roles → the locked `gateway` kind.

const ROLE_KIND: ModuleKind = 'gateway';
// ABOVE php-orm's entity priority (2) so an #[ApiResource] entity collapses to
// gateway; BELOW Symfony's controller priority (8) so a real controller wins.
const ROLE_PRIORITY = 7;

function lastSeg(name: string): string {
  const i = name.lastIndexOf('\\');
  return i >= 0 ? name.slice(i + 1) : name;
}

// `@ApiResource(...)` / `@ApiPlatform\…\ApiResource(...)` in a class docblock (the
// legacy annotation style, API Platform ≤ 2.x).
const API_RESOURCE_ANNOTATION_RE = /@(?:[A-Za-z_]\w*\\)*ApiResource\b/;

/** Is this class an API Platform resource? A `#[ApiResource]` attribute (modern)
 *  or a `@ApiResource` docblock annotation (legacy) on the class. */
function isApiResource(cls: PhpClass): boolean {
  if (cls.attributes.some((a) => lastSeg(a.name) === 'ApiResource')) return true;
  return !!cls.doc && API_RESOURCE_ANNOTATION_RE.test(cls.doc);
}

// ---------------------------------------------------------------------------
// Analysis (parse once; roles only — resources are self-declaring on the class).

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<Map<string, RoleTag>>>();

async function analyzeApiPlatform(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  const scope: PhpScope = await parsePhpScope(ctx);
  const roles = new Map<string, RoleTag>();
  for (const [fileId, parsed] of scope.parsed) {
    if (!parsed.classes.some(isApiResource)) continue;
    roles.set(fileId, {
      role: 'api-resource',
      kind: ROLE_KIND,
      priority: ROLE_PRIORITY,
      metadata: { framework: 'api-platform' },
    });
  }
  if (roles.size > 0) {
    console.log(`  [api-platform] ${roles.size} API resource(s)`);
  }
  return roles;
}

function getRoles(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeApiPlatform(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const apiPlatformAdapter: FrameworkAdapter = {
  name: 'api-platform',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreApiPlatform(gatherApiPlatformSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowComposerSubdirs(base)) {
        const m = scoreApiPlatform(gatherApiPlatformSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // #[ApiResource] classes → the gateway role. METADATA only.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getRoles(ctx);
  },

  // The hook READS SOURCE (PHP). Declare the paths the diff-driven hosted walk must
  // treat as framework-relevant. Never-store-source holds.
  scansSourcePath(path: string): boolean {
    return path.endsWith('.php');
  },
};
