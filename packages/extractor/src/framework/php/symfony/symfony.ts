// The Symfony FrameworkAdapter (web) — driven by the shared PHP analysis layer
// (framework/php). Symfony declares its request surface by CONVENTION + PHP-8
// ATTRIBUTES (src/Controller, `#[Route]`), which we read STATICALLY (install-free,
// never-store-source) via php-parser.
//
//   * detect()   — the `symfony/framework-bundle` package.
//   * roleTags   — Symfony class conventions onto the LOCKED MODULE_KINDS:
//                  controllers -> gateway (src/Controller, or a class carrying a
//                  `#[Route]` / `@Route` / extends AbstractController), console
//                  commands -> job (src/Command extending Command / `#[AsCommand]`).
//                  METADATA; the module's `kind` is finer in RoleTag.role. NO Twig
//                  -> frontend (templates are excluded from the graph).
//
// roleTags-PRIMARY, few/no synthetic edges: Symfony's `#[Route]` is self-declaring
// ON the controller (there is no separate router->controller wire the import graph
// misses, unlike Laravel's routes/*.php spine), and a controller's injected service
// dependencies are already `use`-import edges. YAML/XML route + service config is an
// accepted degrade. Directory-primary grouping needs no prior.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readComposerDeps } from '../../../graph/php-manifest.js';
import { parsePhpScope, type PhpScope } from '../analyze.js';
import { attributesOf, type PhpClass } from '../php-ast.js';
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

export interface SymfonySignals {
  hasSymfony: boolean; // symfony/framework-bundle — the authoritative signal
}

export function gatherSymfonySignals(baseDir: string): SymfonySignals {
  const deps = readComposerDeps(baseDir);
  return { hasSymfony: deps.has('symfony/framework-bundle') };
}

export function scoreSymfony(s: SymfonySignals, rootPath = ''): DetectMatch | null {
  if (!s.hasSymfony) return null;
  return { adapter: 'symfony', confidence: clampConfidence(0.9), rootPath, metadata: { framework: 'symfony' } };
}

const NESTED_SKIP_DIRS = new Set(['vendor', 'var', 'cache', 'storage', 'node_modules', 'src', 'app', 'config', 'public', 'tests']);

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
// Roles → locked MODULE_KINDS.

export type SymfonyRole = 'controller' | 'command';

const ROLE_KIND: Record<SymfonyRole, ModuleKind> = {
  controller: 'gateway',
  command: 'job',
};

const ROLE_PRIORITY: Record<SymfonyRole, number> = {
  controller: 8,
  command: 6,
};

function lastSeg(name: string): string {
  const i = name.lastIndexOf('\\');
  return i >= 0 ? name.slice(i + 1) : name;
}

function inSrc(fileId: string, sub: string): boolean {
  return new RegExp(`(^|/)src/${sub}/`).test(fileId);
}

/** Any `#[Route]` attribute on the class or one of its methods. */
function hasRouteAttribute(cls: PhpClass): boolean {
  if (cls.attributes.some((a) => lastSeg(a.name) === 'Route')) return true;
  return cls.methods.some((m) => attributesOf(m.node).some((a) => lastSeg(a.name) === 'Route'));
}

// `@Route(...)` / `@Symfony\…\Route(...)` in a class or method docblock.
const ROUTE_ANNOTATION_RE = /@(?:[A-Za-z_][\w]*\\)*Route\b/;

/** Any `@Route` docblock annotation on the class or one of its methods. */
function hasRouteAnnotation(cls: PhpClass): boolean {
  if (cls.doc && ROUTE_ANNOTATION_RE.test(cls.doc)) return true;
  return cls.methods.some((m) => !!m.doc && ROUTE_ANNOTATION_RE.test(m.doc));
}

/** A class that IS a Symfony controller: extends an AbstractController, or declares
 *  a `#[Route]` / `@Route` on the class or a method. */
function isController(cls: PhpClass): boolean {
  if (cls.extends && lastSeg(cls.extends).endsWith('AbstractController')) return true;
  return hasRouteAttribute(cls) || hasRouteAnnotation(cls);
}

/** A class that IS a Symfony console command: extends a *Command, or carries the
 *  `#[AsCommand]` attribute. */
function isCommand(cls: PhpClass): boolean {
  if (cls.extends && lastSeg(cls.extends).endsWith('Command')) return true;
  return cls.attributes.some((a) => lastSeg(a.name) === 'AsCommand');
}

/**
 * A file's Symfony role. Controllers are path-primary (src/Controller) with a
 * content fallback (a `#[Route]` / `@Route` / AbstractController class anywhere);
 * commands need the class signal (src/Command + a Command class). Highest-priority
 * role per file.
 */
function symfonyRole(fileId: string, classes: readonly PhpClass[]): SymfonyRole | undefined {
  if (inSrc(fileId, 'Controller') || classes.some(isController)) return 'controller';
  if (inSrc(fileId, 'Command') && classes.some(isCommand)) return 'command';
  return undefined;
}

// ---------------------------------------------------------------------------
// Analysis (parse once; roles only — routes are self-declaring on controllers).

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<Map<string, RoleTag>>>();

async function analyzeSymfony(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  const scope: PhpScope = await parsePhpScope(ctx);
  const roles = new Map<string, RoleTag>();
  for (const [fileId, parsed] of scope.parsed) {
    const role = symfonyRole(fileId, parsed.classes);
    if (!role) continue;
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'symfony' },
    });
  }
  if (roles.size > 0) {
    const controllers = [...roles.values()].filter((r) => r.role === 'controller').length;
    const commands = roles.size - controllers;
    console.log(`  [symfony] ${controllers} controller(s) · ${commands} command(s)`);
  }
  return roles;
}

function getRoles(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeSymfony(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const symfonyAdapter: FrameworkAdapter = {
  name: 'symfony',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreSymfony(gatherSymfonySignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowComposerSubdirs(base)) {
        const m = scoreSymfony(gatherSymfonySignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // Symfony class conventions → roles on the locked MODULE_KINDS. METADATA only.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getRoles(ctx);
  },

  // The hook READS SOURCE (PHP). Declare the paths the diff-driven hosted walk must
  // treat as framework-relevant. Never-store-source holds.
  scansSourcePath(path: string): boolean {
    return path.endsWith('.php');
  },
};
