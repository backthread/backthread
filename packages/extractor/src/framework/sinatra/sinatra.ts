// The Sinatra FrameworkAdapter (web, non-Rails). Sinatra declares routes with a
// block DSL (`get "/x" do … end`) either at the top level (classic
// Sinatra::Application) or inside a `< Sinatra::Base` class (modular). Both make
// the file a request entry, so it reads as a `gateway`. Driven by the shared Ruby
// analysis layer (Prism, install-free).
//
//   * detect()  — the `sinatra` gem.
//   * roleTags  — a Sinatra app file → role 'sinatra-app' on the LOCKED `gateway`
//                 kind. Routes are inline blocks, so there's no cross-file spine to
//                 draw (unlike Rails) — the role is the legibility.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readRubyDeps } from '../../graph/ruby-manifest.js';
import { parseRubyScope } from '../ruby/analyze.js';
import { blockOf, stringValue, type RubyClass } from '../ruby/ruby-ast.js';
import { CallNode } from '@ruby/prism';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  RoleTag,
} from '../types.js';
import type { ModuleKind } from '../../types.js';

export interface SinatraSignals {
  hasSinatra: boolean;
}
export function gatherSinatraSignals(baseDir: string): SinatraSignals {
  return { hasSinatra: readRubyDeps(baseDir).has('sinatra') };
}
export function scoreSinatra(s: SinatraSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasSinatra) return null;
  return { adapter: 'sinatra', confidence: clampConfidence(0.85), rootPath, metadata: { framework: 'sinatra' } };
}

const NESTED_SKIP_DIRS = new Set(['node_modules', 'vendor', 'tmp', 'log', 'app', 'lib', 'config', 'db', 'spec', 'test']);
function shallowGemfileSubdirs(base: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
    if (existsSync(join(base, e.name, 'Gemfile'))) out.push(e.name);
  }
  return out.sort();
}

const APP_ROLE = 'sinatra-app';
const APP_KIND: ModuleKind = 'gateway';
const APP_PRIORITY = 8;

const SINATRA_BASES = new Set(['Sinatra::Base', 'Sinatra::Application']);
const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

/** A `get "/path" do … end` route call: an HTTP-verb name, a string path first arg
 *  starting with '/', and a block. Precise enough (gated on the sinatra dep) that a
 *  stray `get(url)` HTTP-client call isn't mistaken for a route. */
function isRouteCall(call: CallNode): boolean {
  if (!ROUTE_VERBS.has(call.name)) return false;
  if (!blockOf(call)) return false;
  const args = call.arguments_?.arguments_ ?? [];
  const first = args[0];
  const path = first ? stringValue(first) : undefined;
  return !!path && path.startsWith('/');
}

function isSinatraAppFile(classes: RubyClass[], calls: CallNode[]): boolean {
  if (classes.some((c) => c.superclass && SINATRA_BASES.has(c.superclass))) return true;
  return calls.some(isRouteCall);
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<Map<string, RoleTag>>>();

async function analyzeSinatra(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  const scope = await parseRubyScope(ctx);
  const roles = new Map<string, RoleTag>();
  for (const [fileId, parsed] of scope.parsed) {
    if (isSinatraAppFile(parsed.classes, parsed.calls)) {
      roles.set(fileId, { role: APP_ROLE, kind: APP_KIND, priority: APP_PRIORITY, metadata: { framework: 'sinatra' } });
    }
  }
  if (roles.size > 0) console.log(`  [sinatra] ${roles.size} app file(s) → gateway`);
  return roles;
}

function getAnalysis(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeSinatra(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

export const sinatraAdapter: FrameworkAdapter = {
  name: 'sinatra',
  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreSinatra(gatherSinatraSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowGemfileSubdirs(base)) {
        const m = scoreSinatra(gatherSinatraSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx);
  },
  scansSourcePath(path: string): boolean {
    return path.endsWith('.rb') || path.endsWith('.ru');
  },
};
