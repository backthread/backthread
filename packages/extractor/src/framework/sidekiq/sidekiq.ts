// The Sidekiq + ActiveJob FrameworkAdapter (async). Covers BOTH the Sidekiq
// worker style (`include Sidekiq::Job` / `Sidekiq::Worker`) and the ActiveJob
// style (`< ApplicationJob` / `ActiveJob::Base`) — they share the enqueue shape.
// Driven by the shared Ruby analysis layer (Prism, install-free).
//
//   * detect()       — a `sidekiq` gem (Sidekiq), else `rails` / `activejob`
//                      (ActiveJob ships with Rails).
//   * roleTags       — a job/worker class → role 'job' on the LOCKED `job` kind
//                      (own-code triggered by a queue/schedule, not a request).
//   * syntheticEdges — a `Job.perform_async` / `perform_later` (+ perform_in/at,
//                      and the `.set(...).perform_later` chain) → a 'calls' edge
//                      from the ENQUEUEING file to the job it kicks off (the async
//                      trigger the import graph can't see — the caller references
//                      the job by constant, and the enqueue is a runtime hop).
//
// The Redis/queue transport itself is an infra-node concern (the InfraAdapter
// seam), not a framework role; this adapter connects the code modules (who
// enqueues which job). Enqueue targets that don't resolve to a known job DEGRADE
// (skipped — a `.perform_async` on a non-job receiver is not an enqueue edge).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readRubyDeps } from '../../graph/ruby-manifest.js';
import { parseRubyScope, type RubyScope } from '../ruby/analyze.js';
import { constantName, positionalArgs, type RubyClass } from '../ruby/ruby-ast.js';
import { CallNode } from '@ruby/prism';
import type { Node } from '@ruby/prism';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  RoleTag,
} from '../types.js';
import type { ModuleKind } from '../../types.js';

// ---------------------------------------------------------------------------
// Detection.

export interface SidekiqSignals {
  hasSidekiq: boolean;
  hasActiveJob: boolean; // rails / activejob
}

export function gatherSidekiqSignals(baseDir: string): SidekiqSignals {
  const deps = readRubyDeps(baseDir);
  return { hasSidekiq: deps.has('sidekiq'), hasActiveJob: deps.has('rails') || deps.has('activejob') };
}

export function scoreSidekiq(s: SidekiqSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasSidekiq && !s.hasActiveJob) return null;
  const confidence = s.hasSidekiq ? 0.85 : 0.7;
  return {
    adapter: 'sidekiq',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: { framework: 'sidekiq', variant: s.hasSidekiq ? 'sidekiq' : 'activejob' },
  };
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

// ---------------------------------------------------------------------------
// Job detection + enqueue reading.

const JOB_ROLE = 'job';
const JOB_KIND: ModuleKind = 'job';
const JOB_PRIORITY = 5;

const JOB_BASES = new Set(['ApplicationJob', 'ActiveJob::Base']);
const SIDEKIQ_INCLUDES = new Set(['Sidekiq::Job', 'Sidekiq::Worker']);
const ENQUEUE_METHODS = new Set(['perform_async', 'perform_later', 'perform_in', 'perform_at', 'perform_bulk']);

/** Is this class an ActiveJob / Sidekiq job? */
function isJob(cls: RubyClass): boolean {
  if (cls.kind !== 'class') return false;
  if (cls.superclass && JOB_BASES.has(cls.superclass)) return true;
  for (const call of cls.bodyCalls) {
    if (call.name !== 'include') continue;
    for (const arg of positionalArgs(call)) {
      const name = constantName(arg);
      if (name && SIDEKIQ_INCLUDES.has(name)) return true;
    }
  }
  return false;
}

/** The base constant of a (possibly chained) call receiver:
 *  `UserJob.perform_async` and `UserJob.set(wait: 1.hour).perform_later` both → `UserJob`. */
function baseReceiverConstant(call: CallNode): string | undefined {
  let recv: Node | null = call.receiver;
  while (recv instanceof CallNode) recv = recv.receiver;
  return constantName(recv);
}

// ---------------------------------------------------------------------------
// Analysis.

interface SidekiqAnalysis {
  roles: Map<string, RoleTag>;
  edges: FrameworkEdge[];
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<SidekiqAnalysis>>();

async function analyzeSidekiq(ctx: FrameworkContext): Promise<SidekiqAnalysis> {
  const scope: RubyScope = await parseRubyScope(ctx);

  // Pass 1 — job classes; index name → file.
  const jobFiles = new Set<string>();
  const jobClassToFile = new Map<string, string>();
  for (const [fileId, parsed] of scope.parsed) {
    for (const cls of parsed.classes) {
      if (!isJob(cls)) continue;
      jobFiles.add(fileId);
      if (!jobClassToFile.has(cls.name)) jobClassToFile.set(cls.name, fileId);
    }
  }

  // Pass 2 — enqueue calls → caller → job edges.
  const edges = new Map<string, FrameworkEdge>();
  for (const [fileId, parsed] of scope.parsed) {
    for (const call of parsed.calls) {
      if (!ENQUEUE_METHODS.has(call.name)) continue;
      const constName = baseReceiverConstant(call);
      if (!constName) continue;
      const to = scope.resolve(constName) ?? jobClassToFile.get(constName);
      if (!to || !jobFiles.has(to) || to === fileId) continue;
      const key = `${fileId}→${to}`;
      if (!edges.has(key)) {
        edges.set(key, { source: fileId, target: to, kind: 'calls', metadata: { framework: 'sidekiq', relation: 'enqueue' } });
      }
    }
  }

  const roles = new Map<string, RoleTag>();
  for (const fileId of [...jobFiles].sort()) {
    roles.set(fileId, { role: JOB_ROLE, kind: JOB_KIND, priority: JOB_PRIORITY, metadata: { framework: 'sidekiq' } });
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(`  [sidekiq] ${roles.size} job module(s) · ${sortedEdges.length} enqueue edge(s)`);
  }
  return { roles, edges: sortedEdges };
}

function getAnalysis(ctx: FrameworkContext): Promise<SidekiqAnalysis> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeSidekiq(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const sidekiqAdapter: FrameworkAdapter = {
  name: 'sidekiq',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreSidekiq(gatherSidekiqSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowGemfileSubdirs(base)) {
        const m = scoreSidekiq(gatherSidekiqSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return (await getAnalysis(ctx)).edges;
  },

  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return (await getAnalysis(ctx)).roles;
  },

  scansSourcePath(path: string): boolean {
    return path.endsWith('.rb');
  },
};
