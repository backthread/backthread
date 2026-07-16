// The async FrameworkAdapter (Laravel Queues + Symfony Messenger) — driven by the
// shared PHP analysis layer (framework/php). Covers BOTH PHP background-work styles:
//   * Laravel Queues — a class `implements ShouldQueue` is a queued job; it's kicked
//     off by `dispatch(new J())` / `J::dispatch()` (+ dispatchSync/Now/AfterResponse
//     and the `->onQueue()` chain).
//   * Symfony Messenger — a `#[AsMessageHandler]` class (or an `__invoke(Msg $m)`
//     typed handler) handles a message; it's kicked off by `$bus->dispatch(new Msg())`.
//     The message class is matched to the handler by the handler's typed parameter.
//
//   * detect()       — Laravel (laravel/framework | illuminate/queue | illuminate/bus)
//                      or Symfony Messenger (symfony/messenger).
//   * roleTags       — a Laravel job → role 'job', a Symfony handler → role 'handler',
//                      BOTH on the LOCKED `job` kind (own-code triggered by a queue,
//                      not a request). METADATA; the module's `kind` is unchanged.
//   * syntheticEdges — an enqueue/dispatch → a **`publishes`** edge from the file that
//                      dispatches to the job/handler it kicks off (the async trigger the
//                      import graph can't see — the caller references the job/message by
//                      constant and the enqueue is a runtime hop).
//
// A dispatch whose target is not a known job/handler DEGRADES + LOGS (no edge). The
// message-transport (Redis/AMQP/…) itself is an infra concern, not a framework role.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../../detect-util.js';
import { readComposerDeps } from '../../../graph/php-manifest.js';
import { parsePhpScope, type PhpScope } from '../analyze.js';
import {
  attributesOf,
  baseStaticClass,
  callArgs,
  callMethodName,
  collectCalls,
  newClass,
  resolveRefToFqn,
  staticCallClass,
  type PhpClass,
} from '../php-ast.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  RoleTag,
} from '../../types.js';
import type { ModuleKind } from '../../../types.js';

// ---------------------------------------------------------------------------
// Detection.

export interface AsyncSignals {
  hasLaravelQueue: boolean; // laravel/framework | illuminate/queue | illuminate/bus
  hasMessenger: boolean; // symfony/messenger
}

export function gatherAsyncSignals(baseDir: string): AsyncSignals {
  const deps = readComposerDeps(baseDir);
  return {
    hasLaravelQueue: deps.has('laravel/framework') || deps.has('illuminate/queue') || deps.has('illuminate/bus'),
    hasMessenger: deps.has('symfony/messenger'),
  };
}

export function scoreAsync(s: AsyncSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasLaravelQueue && !s.hasMessenger) return null;
  const systems = [s.hasLaravelQueue && 'laravel-queue', s.hasMessenger && 'symfony-messenger'].filter(Boolean);
  return { adapter: 'php-async', confidence: clampConfidence(0.8), rootPath, metadata: { framework: 'php-async', systems } };
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
// Roles → the locked `job` kind.

type AsyncRole = 'job' | 'handler';
const ROLE_KIND: ModuleKind = 'job';
const ROLE_PRIORITY = 5;

function lastSeg(name: string): string {
  const i = name.lastIndexOf('\\');
  return i >= 0 ? name.slice(i + 1) : name;
}

// Laravel: a queued job implements ShouldQueue.
function isLaravelJob(cls: PhpClass): boolean {
  return cls.kind === 'class' && cls.implements.some((i) => lastSeg(i) === 'ShouldQueue');
}

// Dispatch method names (Laravel + Symfony Messenger share `dispatch`).
const DISPATCH_METHODS = new Set(['dispatch', 'dispatchSync', 'dispatchNow', 'dispatchAfterResponse']);

/** The handler methods of a Symfony message handler class, each with its message
 *  parameter's (written) type. A `#[AsMessageHandler]` method is authoritative;
 *  else a class-level `#[AsMessageHandler]` selects `__invoke`; else a bare
 *  `__invoke(Msg $m)` typed handler counts (Messenger auto-registers it). */
function handlerMessageTypes(cls: PhpClass): string[] {
  if (cls.kind !== 'class') return [];
  const firstTypedParam = (methodName?: string): string | undefined => {
    const methods = methodName ? cls.methods.filter((m) => m.name === methodName) : cls.methods;
    for (const m of methods) {
      const typed = m.params.find((p) => p.type);
      if (typed?.type) return typed.type;
    }
    return undefined;
  };
  const attrMethods = cls.methods.filter((m) => attributesOf(m.node).some((a) => lastSeg(a.name) === 'AsMessageHandler'));
  if (attrMethods.length) {
    return attrMethods.map((m) => m.params.find((p) => p.type)?.type).filter((t): t is string => !!t);
  }
  const classLevel = cls.attributes.some((a) => lastSeg(a.name) === 'AsMessageHandler');
  const invokeType = firstTypedParam('__invoke');
  if ((classLevel || invokeType) && invokeType) return [invokeType];
  return [];
}

// ---------------------------------------------------------------------------
// Analysis.

interface AsyncAnalysis {
  roles: Map<string, RoleTag>;
  edges: FrameworkEdge[];
}

const ANALYSIS_CACHE = new WeakMap<FrameworkContext, Promise<AsyncAnalysis>>();

async function analyzeAsync(ctx: FrameworkContext): Promise<AsyncAnalysis> {
  const scope: PhpScope = await parsePhpScope(ctx);
  const signals = gatherAsyncSignals(join(ctx.repoDir, ctx.rootPath));

  // Pass 1 — index jobs (by FQN) + handlers (by the message FQN they handle).
  const roles = new Map<string, RoleTag>();
  const jobFqnToFile = new Map<string, string>();
  const messageFqnToHandler = new Map<string, string>();
  for (const [fileId, parsed] of scope.parsed) {
    for (const cls of parsed.classes) {
      if (signals.hasLaravelQueue && isLaravelJob(cls)) {
        jobFqnToFile.set(cls.fqn, fileId);
        roles.set(fileId, { role: 'job', kind: ROLE_KIND, priority: ROLE_PRIORITY, metadata: { framework: 'php-async' } });
      }
      if (signals.hasMessenger) {
        const messages = handlerMessageTypes(cls);
        if (messages.length) {
          for (const msg of messages) {
            const fqn = resolveRefToFqn(msg, parsed.useMap, cls.namespace);
            if (!messageFqnToHandler.has(fqn)) messageFqnToHandler.set(fqn, fileId);
          }
          // 'handler' role; a job role (if the same file also had one) keeps priority.
          if (!roles.has(fileId)) {
            roles.set(fileId, { role: 'handler', kind: ROLE_KIND, priority: ROLE_PRIORITY, metadata: { framework: 'php-async' } });
          }
        }
      }
    }
  }

  // Pass 2 — dispatch calls → publishes edges to the job/handler kicked off.
  const edges = new Map<string, FrameworkEdge>();
  const unresolved = new Set<string>();
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const key = `${from}→${to}`;
    if (!edges.has(key)) {
      edges.set(key, { source: from, target: to, kind: 'publishes', metadata: { framework: 'php-async', relation: 'dispatch' } });
    }
  };
  for (const [fileId, parsed] of scope.parsed) {
    for (const call of collectCalls(parsed.node)) {
      const method = callMethodName(call);
      if (!method || !DISPATCH_METHODS.has(method)) continue;
      // The dispatched class: a `new J()` first arg wins (dispatch(new J()) /
      // Bus::dispatch(new J()) / $bus->dispatch(new Msg())); else the static
      // receiver of a self-dispatch (J::dispatch()).
      const target = newClass(callArgs(call)[0]) ?? (staticCallClass(call) ? baseStaticClass(call) : undefined);
      if (!target) continue;
      const fqn = resolveRefToFqn(target, parsed.useMap, parsed.namespace);
      const to = jobFqnToFile.get(fqn) ?? messageFqnToHandler.get(fqn);
      if (to) addEdge(fileId, to);
      else unresolved.add(target);
    }
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  );

  if (roles.size > 0 || sortedEdges.length > 0) {
    console.log(`  [php-async] ${roles.size} job/handler module(s) · ${sortedEdges.length} dispatch edge(s)`);
  }
  if (unresolved.size > 0) {
    console.log(`  [php-async] degraded: ${unresolved.size} dispatch target(s) not a known job/handler: ${[...unresolved].sort().slice(0, 10).join(' · ')} (logged, not silently dropped)`);
  }
  return { roles, edges: sortedEdges };
}

function getAnalysis(ctx: FrameworkContext): Promise<AsyncAnalysis> {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeAsync(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const asyncAdapter: FrameworkAdapter = {
  name: 'php-async',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    const rootMatch = scoreAsync(gatherAsyncSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    if (!ctx.packageDir) {
      for (const sub of shallowComposerSubdirs(base)) {
        const m = scoreAsync(gatherAsyncSignals(join(base, sub)), sub);
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
    return path.endsWith('.php');
  },
};
