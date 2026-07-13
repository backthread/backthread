// The GraphQL-Ruby FrameworkAdapter (protocol). The `graphql` gem declares the
// API surface as classes: a Schema (< GraphQL::Schema), and types / resolvers /
// mutations under an `app/graphql` (or `graphql/`) tree. All are the GraphQL
// request surface → they read as `gateway`. Driven by the shared Ruby analysis
// layer (Prism, install-free).
//
//   * detect()  — the `graphql` gem.
//   * roleTags  — a GraphQL file → role 'graphql' on the LOCKED `gateway` kind
//                 (the schema class scores highest). Convention-driven: the
//                 `graphql/` dir tree, plus any class whose base is a GraphQL::*.

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

export interface GraphqlRubySignals {
  hasGraphql: boolean;
}
export function gatherGraphqlRubySignals(baseDir: string): GraphqlRubySignals {
  return { hasGraphql: readRubyDeps(baseDir).has('graphql') };
}
export function scoreGraphqlRuby(s: GraphqlRubySignals, rootPath = ''): DetectMatch | null {
  if (!s.hasGraphql) return null;
  return { adapter: 'graphql-ruby', confidence: clampConfidence(0.85), rootPath, metadata: { framework: 'graphql-ruby' } };
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
const SCHEMA_PRIORITY = 8;
const GRAPHQL_PRIORITY = 6;

const GRAPHQL_DIR_RE = /(^|\/)graphql\//;
const SCHEMA_SUPERCLASS_RE = /(^|::)GraphQL::Schema$/;
const GRAPHQL_BASE_RE = /(^|::)GraphQL::/; // any GraphQL::Schema::Object / Resolver / Mutation …

function graphqlRole(cls: RubyClass | undefined, fileId: string): { role: string; priority: number } | undefined {
  if (cls?.superclass && SCHEMA_SUPERCLASS_RE.test(cls.superclass)) return { role: 'graphql-schema', priority: SCHEMA_PRIORITY };
  if (cls?.superclass && GRAPHQL_BASE_RE.test(cls.superclass)) return { role: 'graphql', priority: GRAPHQL_PRIORITY };
  if (GRAPHQL_DIR_RE.test(fileId) && cls) return { role: 'graphql', priority: GRAPHQL_PRIORITY };
  return undefined;
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<Map<string, RoleTag>>>();

async function analyzeGraphqlRuby(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  const scope = await parseRubyScope(ctx);
  const roles = new Map<string, RoleTag>();
  for (const [fileId, parsed] of scope.parsed) {
    let best: { role: string; priority: number } | undefined;
    for (const cls of parsed.classes.length ? parsed.classes : [undefined]) {
      const r = graphqlRole(cls, fileId);
      if (r && (!best || r.priority > best.priority)) best = r;
    }
    if (best) roles.set(fileId, { role: best.role, kind: KIND, priority: best.priority, metadata: { framework: 'graphql-ruby' } });
  }
  if (roles.size > 0) console.log(`  [graphql-ruby] ${roles.size} graphql file(s) → gateway`);
  return roles;
}

function getAnalysis(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeGraphqlRuby(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

export const graphqlRubyAdapter: FrameworkAdapter = {
  name: 'graphql-ruby',
  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreGraphqlRuby(gatherGraphqlRubySignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowGemfileSubdirs(base)) {
        const m = scoreGraphqlRuby(gatherGraphqlRubySignals(join(base, sub)), sub);
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
