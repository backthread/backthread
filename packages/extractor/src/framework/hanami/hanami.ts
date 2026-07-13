// The Hanami FrameworkAdapter (web, non-Rails). Hanami (2.x) declares one action
// class per endpoint (`class Show < <App>::Action` / `Hanami::Action`) plus a
// router (config/routes.rb, `Hanami.app.routes`). Both are request entries → they
// read as `gateway`. Driven by the shared Ruby analysis layer (Prism, install-free).
//
//   * detect()  — a `hanami` / `hanami-router` / `hanami-controller` gem.
//   * roleTags  — an action class → role 'action' on the LOCKED `gateway` kind; the
//                 router file → role 'router' on `gateway`.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readRubyDeps } from '../../graph/ruby-manifest.js';
import { parseRubyScope } from '../ruby/analyze.js';
import type { RubyClass } from '../ruby/ruby-ast.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  RoleTag,
} from '../types.js';
import type { ModuleKind } from '../../types.js';

export interface HanamiSignals {
  hasHanami: boolean;
}
export function gatherHanamiSignals(baseDir: string): HanamiSignals {
  const deps = readRubyDeps(baseDir);
  return { hasHanami: deps.has('hanami') || deps.has('hanami-router') || deps.has('hanami-controller') };
}
export function scoreHanami(s: HanamiSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasHanami) return null;
  return { adapter: 'hanami', confidence: clampConfidence(0.85), rootPath, metadata: { framework: 'hanami' } };
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

const KIND: ModuleKind = 'gateway';
const ROUTER_PRIORITY = 8;
const ACTION_PRIORITY = 7;

const ACTION_SUPERCLASS_RE = /(^|::)Action$/; // Hanami::Action, MyApp::Action, …
const ACTIONS_DIR_RE = /(^|\/)actions\//;
const ROUTES_FILE_RE = /(^|\/)config\/routes\.rb$/;

/** An action class: its superclass ends in `Action` (the Hanami action base), or
 *  it lives under an `actions/` dir (the Hanami convention). Gated on the hanami dep. */
function isHanamiAction(cls: RubyClass, fileId: string): boolean {
  if (cls.kind !== 'class') return false;
  if (cls.superclass && ACTION_SUPERCLASS_RE.test(cls.superclass)) return true;
  return ACTIONS_DIR_RE.test(fileId);
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<Map<string, RoleTag>>>();

async function analyzeHanami(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  const scope = await parseRubyScope(ctx);
  const roles = new Map<string, RoleTag>();
  for (const [fileId, parsed] of scope.parsed) {
    if (ROUTES_FILE_RE.test(fileId)) {
      roles.set(fileId, { role: 'router', kind: KIND, priority: ROUTER_PRIORITY, metadata: { framework: 'hanami' } });
      continue;
    }
    if (parsed.classes.some((c) => isHanamiAction(c, fileId))) {
      roles.set(fileId, { role: 'action', kind: KIND, priority: ACTION_PRIORITY, metadata: { framework: 'hanami' } });
    }
  }
  if (roles.size > 0) console.log(`  [hanami] ${roles.size} action/router file(s) → gateway`);
  return roles;
}

function getAnalysis(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeHanami(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

export const hanamiAdapter: FrameworkAdapter = {
  name: 'hanami',
  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreHanami(gatherHanamiSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowGemfileSubdirs(base)) {
        const m = scoreHanami(gatherHanamiSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx);
  },
  scansSourcePath(path: string): boolean {
    return path.endsWith('.rb');
  },
};
