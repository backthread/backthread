// The gRPC-Ruby FrameworkAdapter (protocol). The `grpc` gem serves RPCs from a
// servicer — a class that subclasses the generated `<Package>::<Svc>::Service`
// base (from `*_services_pb.rb`) or `include`s GRPC::GenericService. A servicer is
// a request entry → it reads as `gateway`. Driven by the shared Ruby analysis
// layer (Prism, install-free).
//
//   * detect()  — the `grpc` gem.
//   * roleTags  — a servicer class → role 'servicer' on the LOCKED `gateway` kind.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readRubyDeps } from '../../graph/ruby-manifest.js';
import { parseRubyScope } from '../ruby/analyze.js';
import { constantName, positionalArgs, type RubyClass } from '../ruby/ruby-ast.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  RoleTag,
} from '../types.js';
import type { ModuleKind } from '../../types.js';

export interface GrpcRubySignals {
  hasGrpc: boolean;
}
export function gatherGrpcRubySignals(baseDir: string): GrpcRubySignals {
  return { hasGrpc: readRubyDeps(baseDir).has('grpc') };
}
export function scoreGrpcRuby(s: GrpcRubySignals, rootPath = ''): DetectMatch | null {
  if (!s.hasGrpc) return null;
  return { adapter: 'grpc-ruby', confidence: clampConfidence(0.85), rootPath, metadata: { framework: 'grpc-ruby' } };
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
const SERVICER_PRIORITY = 7;

// A servicer subclasses the generated `<Pkg>::<Svc>::Service` base — always
// NAMESPACED (has a `::`), so a bare Rails service-object base like
// `ApplicationService` / `BaseService` (no `::`) never matches.
const SERVICE_SUPERCLASS_RE = /::Service$/;

/** Is this class a gRPC servicer? Its base is a generated `…::Service`, or it
 *  `include`s GRPC::GenericService. Gated on the grpc dep. */
function isServicer(cls: RubyClass): boolean {
  if (cls.kind !== 'class') return false;
  if (cls.superclass && SERVICE_SUPERCLASS_RE.test(cls.superclass)) return true;
  for (const call of cls.bodyCalls) {
    if (call.name !== 'include') continue;
    for (const arg of positionalArgs(call)) {
      if (constantName(arg) === 'GRPC::GenericService') return true;
    }
  }
  return false;
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<Map<string, RoleTag>>>();

async function analyzeGrpcRuby(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  const scope = await parseRubyScope(ctx);
  const roles = new Map<string, RoleTag>();
  for (const [fileId, parsed] of scope.parsed) {
    if (parsed.classes.some(isServicer)) {
      roles.set(fileId, { role: 'servicer', kind: KIND, priority: SERVICER_PRIORITY, metadata: { framework: 'grpc-ruby' } });
    }
  }
  if (roles.size > 0) console.log(`  [grpc-ruby] ${roles.size} servicer(s) → gateway`);
  return roles;
}

function getAnalysis(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeGrpcRuby(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

export const grpcRubyAdapter: FrameworkAdapter = {
  name: 'grpc-ruby',
  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreGrpcRuby(gatherGrpcRubySignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowGemfileSubdirs(base)) {
        const m = scoreGrpcRuby(gatherGrpcRubySignals(join(base, sub)), sub);
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
