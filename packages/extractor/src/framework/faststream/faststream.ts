// the FastStream (+ Taskiq) FrameworkAdapter. Net-new adapter
// following the FastAPI / Flask template, reusing the shared
// Python core (py-ast + parsePythonScope). FastStream is the cleanest
// declarative pub/sub in Python: a broker object + `@broker.subscriber("topic")` /
// `@broker.publisher("topic")` decorators wire event-driven services through
// message brokers (Kafka / RabbitMQ / NATS / Redis). Taskiq is its distributed
// task-queue sibling (`@broker.task` def + `some_task.kiq(...)` enqueue).
//
// We read this surface STATICALLY (install-free, never-store-source — a pure
// syntactic Pyright parse; never executes repo code) and persist only the derived
// groups/edges/roles:
//
//   * detect()        — the `faststream` and/or `taskiq` dependency (either alone
//                       is a valid match; both raises confidence). Shallow nested
//                       scan for a `backend/`|`server/` package (mirrors ).
//   * groupingPrior   — one FrameworkGroup per FastStream *Router (KafkaRouter,
//                       RabbitRouter, …): its defining file + the files that
//                       register subscribers/publishers to it, so a repo that
//                       organises handlers behind routers splits into per-router
//                       subsystems (the FastAPI router / Flask blueprint mechanism).
//                       Optional — a broker-only app (no routers) yields no groups
//                       and stays in directory grouping, byte-for-byte unchanged.
//   * syntheticEdges  — the ASYNC wiring the import graph structurally cannot see:
//                       (a) PUB/SUB — a module that publishes to topic T is linked
//                           to every module subscribing to T (kind 'publishes',
//                           publisher-file → subscriber-file, topic in metadata),
//                       (b) Taskiq `.kiq()` enqueue (kind 'publishes', caller →
//                           task file — the async decoupling the import graph would
//                           render as a plain call), and
//                       (c) `broker.include_router(router)` mounting (kind 'calls').
//   * roleTags        — FastStream app / broker / router objects → `gateway` (the
//                       system's MESSAGE entrypoint, the boundary where external
//                       events enter — the pub/sub analogue of FastAPI's app →
//                       gateway request entrypoint); a `@broker.subscriber` /
//                       `@broker.publisher` handler → `service` (an event-driven
//                       microservice — FastStream's own positioning); a Taskiq
//                       `@broker.task` → `job` (discrete queue-triggered own-code,
//                       matching the Celery-task precedent in ). METADATA
//                       onto the LOCKED MODULE_KINDS enum; never a new kind (only
//                       `role` renders; the module's `kind` is unchanged).
//
// Kind justification (the parent-task brief asked to pick locked kinds + justify):
// gateway/service/job are the three request/message-plane MODULE_KINDS. The broker
// is where messages CROSS the trust boundary → gateway (Linear's issue text floated
// `service` for the broker; the message-entrypoint reading is more faithful and
// matches FastAPI). A subscriber is long-lived event-consuming own-code → `service`
// (not a discrete `job`); a Taskiq task IS a discrete enqueued work unit → `job`.
// This is a deliberate, meaningful split of all three kinds; NO new kind is added.
//
// Pub/sub edge DIRECTION + verb: a single directed edge publisher-file →
// subscriber-file, kind 'publishes'. The topic is the MATCH KEY, not a node
// (FrameworkEdge endpoints must be code file ids), so it can't be an intermediate.
// 'publishes' points in the direction the message travels (producer → consumer),
// consistent with the Celery-enqueue precedent (enqueuer `publishes` to
// worker) and the infra queue precedent (Cloudflare: producer `publishes`, ARP-…).
// `subscribes` (the reverse-direction verb) is NOT used for a producer→consumer
// flow edge — it would invert the data-flow arrow; the subscriber side is captured
// by roleTags + the edge's `topic` metadata.
//
// Truly-dynamic topic names (a variable / f-string, not a static literal) and
// unresolvable kiq / include_router targets DEGRADE + LOG — no silent caps.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readPythonDeps } from '../../graph/python-manifest.js';
import { parsePythonScope } from '../python/analyze.js';
import {
  callCallee,
  keywordArg,
  memberChain,
  nameValue,
  positionalArgs,
  stringValue,
  PN,
} from '../python/py-ast.js';
import type {
  CallNode,
  DecoratorNode,
  ExpressionNode,
  ParseNode,
} from '@zzzen/pyright-internal/dist/parser/parseNodes.js';
import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkContext,
  FrameworkDetectContext,
  FrameworkEdge,
  FrameworkGroup,
  FrameworkGroupingPrior,
  RoleTag,
} from '../types.js';
import type { ModuleKind } from '../../types.js';

// ---------------------------------------------------------------------------
// Detection (fs → deps; PURE scorer). Never reads source content.

/** The deterministic FastStream signal set (dependency names only). */
export interface FastStreamSignals {
  hasFastStream: boolean; // faststream — the pub/sub authoritative signal
  hasTaskiq: boolean; // taskiq (or a taskiq-* broker/backend) — the task-queue signal
}

/** Gather the signal set for a single root dir (reads manifests only). */
export function gatherFastStreamSignals(baseDir: string): FastStreamSignals {
  const deps = readPythonDeps(baseDir);
  return {
    hasFastStream: deps.has('faststream'),
    // `taskiq` core OR any `taskiq-*` broker/result-backend (taskiq-aio-pika,
    // taskiq-redis, taskiq-nats, …) — the task pass is worth running for either.
    hasTaskiq: deps.has('taskiq') || [...deps].some((d) => d.startsWith('taskiq-')),
  };
}

// Non-source dirs the nested scan skips (cheap + can't hold a first-party manifest).
const NESTED_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'venv',
  '.venv',
  '__pycache__',
  'site-packages',
]);

/** True if `dir` holds a Python manifest worth scanning for deps. */
function hasPythonManifest(dir: string): boolean {
  return (
    existsSync(join(dir, 'pyproject.toml')) ||
    existsSync(join(dir, 'setup.py')) ||
    existsSync(join(dir, 'setup.cfg')) ||
    existsSync(join(dir, 'requirements.txt'))
  );
}

/**
 * Immediate subdirs (depth 1) that contain a Python manifest — the shallow search
 * for a nested backend (`backend/` | `server/` | `worker/`). Sorted, so the
 * first-match pick is deterministic; skips dot-dirs + non-source dirs to stay cheap.
 */
function shallowManifestSubdirs(base: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || NESTED_SKIP_DIRS.has(e.name)) continue;
    if (hasPythonManifest(join(base, e.name))) out.push(e.name);
  }
  return out.sort();
}

/**
 * Decide FastStream/Taskiq from the signal set. EITHER `faststream` (pub/sub) or
 * `taskiq` (task queue) is a valid match; both present raises confidence. Returns
 * null → generic-Python fallthrough, byte-for-byte unchanged. The metadata GATES
 * the two analysis passes (faststream → pub/sub; taskiq → tasks), mirroring how
 * FastAPI gates its Celery pass.
 */
export function scoreFastStream(s: FastStreamSignals, rootPath = ''): DetectMatch | null {
  if (!s.hasFastStream && !s.hasTaskiq) return null;
  let confidence = 0.8;
  if (s.hasFastStream && s.hasTaskiq) confidence += 0.1;
  return {
    adapter: 'faststream',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      faststream: s.hasFastStream,
      taskiq: s.hasTaskiq,
      signals: { faststream: s.hasFastStream, taskiq: s.hasTaskiq },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → locked MODULE_KINDS. Roles are metadata; the module's `kind`
// is unchanged. app / broker / router objects are the MESSAGE entrypoint →
// gateway; a subscriber/publisher handler is an event-driven service → service; a
// Taskiq task is discrete queue-triggered own-code → job.
export type FastStreamRole = 'app' | 'broker' | 'router' | 'subscriber' | 'publisher' | 'task';

// Collapse priority when one FILE carries several roles, AND downstream when
// several files of different roles land in one module. The construction entrypoints
// (app/broker) outrank the concrete handlers, which outrank the bare aggregator
// router — mirroring FastAPI's app > route-handler > router: a single-file app
// (`FastStream(broker)` + a `@broker.subscriber` in the same module) reads as the
// app entrypoint; a router file that ALSO declares a handler reads as the handler
// (the informative leaf) rather than the aggregator; a pure aggregator router (its
// handlers all elsewhere) reads as `router`. A subscriber outranks a publisher —
// where a message is consumed is a more informative label than where one leaves.
const ROLE_PRIORITY: Record<FastStreamRole, number> = {
  app: 9,
  broker: 8,
  subscriber: 7,
  publisher: 6,
  router: 5,
  task: 4,
};
const ROLE_KIND: Record<FastStreamRole, ModuleKind> = {
  app: 'gateway',
  broker: 'gateway',
  router: 'gateway',
  subscriber: 'service',
  publisher: 'service',
  task: 'job',
};

// The FastStream app entrypoint constructor.
const APP_CTOR = 'FastStream';
// FastStream router constructors (a KNOWN set — a suffix match on `*Router` would
// wrongly catch FastAPI's `APIRouter` in a FastAPI+FastStream polyglot repo). This
// set includes the broker-integration `faststream.<broker>.fastapi` routers, which
// share these class names.
const ROUTER_CTORS = new Set(['KafkaRouter', 'RabbitRouter', 'NatsRouter', 'RedisRouter']);
// Known destination keyword args across FastStream brokers (Kafka topic, NATS
// subject, Redis channel/list/stream, RabbitMQ queue) — used to read a topic name
// from `@broker.subscriber(channel="…")` / `broker.publish(m, subject="…")` forms.
const TOPIC_KWARGS = ['topic', 'subject', 'channel', 'queue', 'list', 'stream'];

/**
 * A broker constructor: FastStream brokers (KafkaBroker / RabbitBroker /
 * NatsBroker / RedisBroker) AND Taskiq brokers (AioPikaBroker / ListQueueBroker /
 * RedisStreamBroker / InMemoryBroker / PubSubBroker …) all end in `Broker`. A
 * suffix match is safe here: detect() already gated on the faststream/taskiq dep,
 * and we only ACT on a broker var via framework-specific methods (`.subscriber` /
 * `.publisher` / `.task` / `.publish` / `.include_router`), so a stray unrelated
 * `*Broker` yields nothing. FastStream vs Taskiq usage is disambiguated by method
 * name (subscriber/publisher vs task/kiq), not by broker class.
 */
function isBrokerCtor(name: string): boolean {
  return name.endsWith('Broker');
}

// ---------------------------------------------------------------------------
// Analysis.

// One FastStream router: keyed by definer file + var name (a file may define more
// than one). The group accumulates its defining file + every file that registers a
// subscriber/publisher handler to it.
interface RouterSeed {
  key: string; // `${definerFileId}#${varName}` — stable per-router identity
  definerFileId: string;
  varName: string;
  baseSlug: string; // pre-dedup id slug (assignRouterGroups finalizes the id)
  label: string; // humanized subsystem label
  fileIds: Set<string>; // definer + handler files registered to this router
}

interface FastStreamAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface FastStreamDiag {
  dynamicTopics: Set<string>; // subscriber/publisher/publish sites with a non-static topic
  unresolvedKiq: Set<string>; // .kiq() callees we couldn't map to a task file
  unresolvedMounts: Set<string>; // include_router args we couldn't map
  ambiguousRouters: Set<string>; // a decorator root matching multiple routers in a definer
}

// The extracted topic name(s) at one pub/sub site + whether a topic arg was present
// but not statically resolvable (a variable / f-string → we degrade + log).
interface TopicSet {
  topics: string[];
  dynamic: boolean;
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx gets a fresh analysis — no cross-tree staleness. Mirrors fastapi / flask.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, FastStreamAnalysis>();

function slugify(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function humanize(s: string): string {
  const words = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return s;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// The label source for a router definer file — its basename, but a package-level
// router lives in `<pkg>/__init__.py`, whose basename ('__init__') is useless, so
// fall back to the package dir name (`app/orders/__init__.py` → 'orders'). Generic
// definer basenames (`router`/`broker`) get the same treatment.
function moduleLabelSource(fileId: string): string {
  const parts = fileId.split('/');
  const last = (parts[parts.length - 1] ?? fileId).replace(/\.[^.]+$/, '');
  if ((last === '__init__' || last === 'router' || last === 'broker') && parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return last;
}

function dirSegment(fileId: string): string {
  const slash = fileId.indexOf('/');
  return slash > 0 ? slugify(fileId.slice(0, slash)) : 'root';
}

// Keep the highest-priority candidate role per file (deterministic, lexical
// tiebreak) — mirrors the fastapi/flask addRole + the contribute-step's collapse.
function addRole(map: Map<string, FastStreamRole>, fileId: string, role: FastStreamRole): void {
  const cur = map.get(fileId);
  if (
    cur === undefined ||
    ROLE_PRIORITY[role] > ROLE_PRIORITY[cur] ||
    (ROLE_PRIORITY[role] === ROLE_PRIORITY[cur] && role < cur)
  ) {
    map.set(fileId, role);
  }
}

function addEdge(
  edges: Map<string, FrameworkEdge>,
  from: string,
  to: string,
  kind: FrameworkEdge['kind'],
  relation: string,
  extra?: Record<string, unknown>,
): void {
  if (from === to) return; // intra-file wiring collapses; the step drops self-edges too
  const key = `${from}→${to}:${kind}`;
  if (!edges.has(key)) {
    edges.set(key, {
      source: from,
      target: to,
      kind,
      metadata: { framework: 'faststream', relation, ...extra },
    });
  }
}

// The constructor name of an `x = Ctor(...)` assignment RHS (last chain segment, so
// both `KafkaBroker(...)` and `faststream.kafka.KafkaBroker(...)` read as
// 'KafkaBroker'), or undefined.
function assignedCtorName(rhs: ExpressionNode): string | undefined {
  if ((rhs as ParseNode).nodeType !== PN.Call) return undefined;
  const callee = callCallee(rhs as CallNode);
  if (!callee) return undefined;
  return callee.path.length ? callee.path[callee.path.length - 1] : callee.root;
}

// A decorator's callee chain (`@broker.subscriber("t")` → root 'broker', path
// ['subscriber']; `@broker.task` → root 'broker', path ['task']). The decorator
// expr is either a call (with args) or a bare name/attribute.
function decoratorChain(deco: DecoratorNode): { root: string; path: string[] } | undefined {
  const expr = deco.d.expr;
  if ((expr as ParseNode).nodeType === PN.Call) return callCallee(expr as CallNode);
  return memberChain(expr);
}

// A single topic-name arg → its static string, unwrapping a broker-specific
// destination object (`RabbitQueue("orders")` / `PubSub("ch")` → its first
// positional string). Undefined when the arg isn't a static literal.
function topicFromExpr(expr: ExpressionNode | undefined): string | undefined {
  if (!expr) return undefined;
  const direct = stringValue(expr);
  if (direct !== undefined) return direct;
  if ((expr as ParseNode).nodeType === PN.Call) {
    return stringValue(positionalArgs(expr as CallNode)[0]);
  }
  return undefined;
}

/**
 * Collect the static topic name(s) named by a call, scanning positional args in
 * `[positionalStart, positionalEnd)` plus the known destination keyword args.
 * A `subscriber`/`publisher` DECORATOR scans all positionals (Kafka allows several
 * topics: `@broker.subscriber("t1","t2")`); imperative `publish(message, dest, …)`
 * scans ONLY the single dest slot (index 1) — a later positional (e.g. a Kafka
 * partition key passed positionally) is NOT a topic. `dynamic` = a topic arg was
 * present but NONE resolved to a static literal (→ degrade + log).
 */
function collectTopics(call: CallNode, positionalStart: number, positionalEnd = Infinity): TopicSet {
  const topics = new Set<string>();
  const positionals = positionalArgs(call);
  let sawArg = false;
  for (let i = positionalStart; i < Math.min(positionals.length, positionalEnd); i++) {
    sawArg = true;
    const t = topicFromExpr(positionals[i]);
    if (t) topics.add(t);
  }
  for (const kw of TOPIC_KWARGS) {
    const arg = keywordArg(call, kw);
    if (arg === undefined) continue;
    sawArg = true;
    const t = topicFromExpr(arg);
    if (t) topics.add(t);
  }
  return { topics: [...topics].sort(), dynamic: topics.size === 0 && sawArg };
}

// The topic set named by a `@broker.subscriber(...)`/`@broker.publisher(...)`
// decorator (a bare, uncalled decorator names no topic).
function decoratorTopics(deco: DecoratorNode): TopicSet {
  const expr = deco.d.expr;
  if ((expr as ParseNode).nodeType !== PN.Call) return { topics: [], dynamic: false };
  return collectTopics(expr as CallNode, 0);
}

// Router group id source: the router var name (when not the generic `router`/
// `broker`), else the definer's package/basename.
function routerGroupName(varName: string, definerFileId: string): string {
  if (varName && varName !== 'router' && varName !== 'broker') return varName;
  return moduleLabelSource(definerFileId);
}

// Assign each router its final, collision-free group id ORDER-INDEPENDENTLY:
// process seeds by key (definerFileId#varName) so the SMALLEST wins the bare slug,
// and later collisions take a `-<dirSegment>` then `-<n>` suffix. The order is
// stable (not an iteration index), so the id set is identical run-to-run — the
// snapshot grouping-stability invariant. (Mirrors flask's assignBlueprintGroups.)
function assignRouterGroups(seeds: RouterSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const ordered = [...seeds].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of ordered) {
    let id = seed.baseSlug;
    if (taken.has(id)) id = `${seed.baseSlug}-${dirSegment(seed.definerFileId)}`;
    let n = 2;
    while (taken.has(id)) id = `${seed.baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label: seed.label, fileIds: [...seed.fileIds].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function analyzeFastStream(ctx: FrameworkContext): FastStreamAnalysis {
  const { parsed } = parsePythonScope(ctx);
  const faststream = ctx.match.metadata?.faststream === true;
  const taskiq = ctx.match.metadata?.taskiq === true;

  // Pass 1 — per-file app / broker / router object variables (file-scoped, which
  // matches how these module-level singletons are used).
  const appVarsByFile = new Map<string, Set<string>>();
  const brokerVarsByFile = new Map<string, Set<string>>();
  const routerVarsByFile = new Map<string, Set<string>>();
  for (const [id, file] of parsed) {
    const appVars = new Set<string>();
    const brokerVars = new Set<string>();
    const routerVars = new Set<string>();
    for (const a of file.nodes.assignments) {
      const target = nameValue(a.d.leftExpr);
      if (!target) continue;
      const ctor = assignedCtorName(a.d.rightExpr);
      if (!ctor) continue;
      if (ctor === APP_CTOR) appVars.add(target);
      else if (ROUTER_CTORS.has(ctor)) routerVars.add(target);
      else if (isBrokerCtor(ctor)) brokerVars.add(target);
    }
    appVarsByFile.set(id, appVars);
    brokerVarsByFile.set(id, brokerVars);
    routerVarsByFile.set(id, routerVars);
  }

  // Definer-file sets, so an IMPORTED broker/app (`from app.broker import broker` +
  // `@broker.subscriber` elsewhere — the common layout) is recognized cross-file.
  const appDefinerFiles = new Set<string>();
  const brokerDefinerFiles = new Set<string>();
  for (const [f, v] of appVarsByFile) if (v.size > 0) appDefinerFiles.add(f);
  for (const [f, v] of brokerVarsByFile) if (v.size > 0) brokerDefinerFiles.add(f);

  // Router seeds (grouping) + definer index (cross-file decorator attribution).
  // Routers are a FastStream construct → only seeded on the faststream signal, so a
  // Taskiq-only repo yields no groups (and never mis-attributes a `.task` to one).
  const seedsByKey = new Map<string, RouterSeed>();
  const routersByDefiner = new Map<string, Array<{ varName: string; key: string }>>();
  if (faststream) {
    for (const [id, routerVars] of routerVarsByFile) {
      for (const varName of routerVars) {
        const key = `${id}#${varName}`;
        const name = routerGroupName(varName, id);
        seedsByKey.set(key, {
          key,
          definerFileId: id,
          varName,
          baseSlug: slugify(name) || 'router',
          label: humanize(name) || name,
          fileIds: new Set([id]),
        });
        const list = routersByDefiner.get(id) ?? [];
        list.push({ varName, key });
        routersByDefiner.set(id, list);
      }
    }
  }

  const roleByFile = new Map<string, FastStreamRole>();
  const edges = new Map<string, FrameworkEdge>();
  const pubTopicsByFile = new Map<string, Set<string>>(); // file → topics it publishes
  const subTopicsByFile = new Map<string, Set<string>>(); // file → topics it subscribes
  const diag: FastStreamDiag = {
    dynamicTopics: new Set(),
    unresolvedKiq: new Set(),
    unresolvedMounts: new Set(),
    ambiguousRouters: new Set(),
  };

  function recordTopics(map: Map<string, Set<string>>, file: string, topics: string[]): void {
    if (topics.length === 0) return;
    let set = map.get(file);
    if (!set) {
      set = new Set();
      map.set(file, set);
    }
    for (const t of topics) set.add(t);
  }

  // A FastStream broker is a `*Broker` that is actually USED by FastStream (a
  // `.subscriber`/`.publisher`/`.publish`/`.include_router` resolves to it) — as
  // opposed to a Taskiq `*Broker` (used only by `.task`/`.kiq`), which shares the
  // class-name suffix. Populated during the walk; consumed by the object-role pass
  // so a Taskiq broker in a mixed faststream+taskiq repo is NOT tagged `gateway`.
  const faststreamBrokerFiles = new Set<string>();

  // Classify a `@<root>.…` / `<root>.…()` object root: which router (by key), the
  // broker (with its definer file), or the app — resolving same-file vars first,
  // then import bindings to a definer/app file. Undefined ⇒ not a recognized object.
  function resolveBrokerLike(
    thisFile: string,
    root: string,
    binds: ReadonlyMap<string, string>,
  ): { kind: 'router'; key: string } | { kind: 'broker'; definer: string } | { kind: 'app' } | undefined {
    if (routerVarsByFile.get(thisFile)?.has(root)) return { kind: 'router', key: `${thisFile}#${root}` };
    if (brokerVarsByFile.get(thisFile)?.has(root)) return { kind: 'broker', definer: thisFile };
    if (appVarsByFile.get(thisFile)?.has(root)) return { kind: 'app' };
    const target = binds.get(root);
    if (target) {
      const routers = routersByDefiner.get(target);
      if (routers && routers.length > 0) {
        // Prefer the router whose var name matches the imported local name; else, if
        // the definer holds exactly one router, it's unambiguous; else DEGRADE.
        const exact = routers.find((r) => r.varName === root);
        if (exact) return { kind: 'router', key: exact.key };
        if (routers.length === 1) return { kind: 'router', key: routers[0].key };
        diag.ambiguousRouters.add(`${thisFile}: @${root}.… (multiple routers in ${target})`);
        return undefined;
      }
      if (brokerDefinerFiles.has(target)) return { kind: 'broker', definer: target };
      if (appDefinerFiles.has(target)) return { kind: 'app' };
    }
    return undefined;
  }

  // Mark the broker a faststream usage resolved to as FastStream-used (drives the
  // gateway role). A no-op for router/app results.
  function markFastStreamBroker(
    resolved: ReturnType<typeof resolveBrokerLike>,
  ): void {
    if (resolved?.kind === 'broker') faststreamBrokerFiles.add(resolved.definer);
  }

  for (const [id, file] of parsed) {
    const binds = file.bindings;

    // --- Decorators: subscriber / publisher (faststream) + task (taskiq).
    for (const fn of file.nodes.functions) {
      for (const deco of fn.d.decorators) {
        const chain = decoratorChain(deco);
        if (!chain || chain.path.length !== 1) continue;
        const method = chain.path[0];

        if (faststream && (method === 'subscriber' || method === 'publisher')) {
          const resolved = resolveBrokerLike(id, chain.root, binds);
          if (!resolved) continue; // not a recognized broker/router object
          markFastStreamBroker(resolved);
          const topics = decoratorTopics(deco);
          if (topics.dynamic) diag.dynamicTopics.add(`${id}: @${chain.root}.${method}(<dynamic>)`);
          if (method === 'subscriber') {
            addRole(roleByFile, id, 'subscriber');
            recordTopics(subTopicsByFile, id, topics.topics);
          } else {
            addRole(roleByFile, id, 'publisher');
            recordTopics(pubTopicsByFile, id, topics.topics);
          }
          // A handler decorated on a ROUTER joins that router's subsystem.
          if (resolved.kind === 'router') seedsByKey.get(resolved.key)?.fileIds.add(id);
        } else if (taskiq && method === 'task') {
          // `@broker.task` (bare or called) — unambiguously Taskiq (FastStream
          // brokers have no `.task`). Gate on a recognized broker object.
          if (resolveBrokerLike(id, chain.root, binds)) addRole(roleByFile, id, 'task');
        }
      }
    }

    // --- Assigned publisher objects: `pub = broker.publisher("t")` (a publisher
    // used imperatively via `pub.publish(...)`; the topic is fixed at construction).
    if (faststream) {
      for (const a of file.nodes.assignments) {
        const rhs = a.d.rightExpr;
        if ((rhs as ParseNode).nodeType !== PN.Call) continue;
        const callee = callCallee(rhs as CallNode);
        if (!callee || callee.path.length !== 1 || callee.path[0] !== 'publisher') continue;
        const resolved = resolveBrokerLike(id, callee.root, binds);
        if (!resolved) continue;
        markFastStreamBroker(resolved);
        const topics = collectTopics(rhs as CallNode, 0);
        if (topics.dynamic) diag.dynamicTopics.add(`${id}: ${callee.root}.publisher(<dynamic>)`);
        addRole(roleByFile, id, 'publisher');
        recordTopics(pubTopicsByFile, id, topics.topics);
        if (resolved.kind === 'router') seedsByKey.get(resolved.key)?.fileIds.add(id);
      }
    }

    // --- Calls: imperative publish + include_router (faststream) · kiq (taskiq).
    for (const call of file.nodes.calls) {
      const callee = callCallee(call);
      if (!callee || callee.path.length !== 1) continue; // want `obj.method(...)`
      const method = callee.path[0];
      const obj = callee.root;

      if (faststream && method === 'publish') {
        // `broker.publish(message, "topic")` — imperative publish.
        const resolved = resolveBrokerLike(id, obj, binds);
        if (!resolved) continue;
        markFastStreamBroker(resolved);
        addRole(roleByFile, id, 'publisher');
        const topics = collectTopics(call, 1, 2); // only the single dest slot
        if (topics.dynamic) diag.dynamicTopics.add(`${id}: ${obj}.publish(<dynamic>)`);
        recordTopics(pubTopicsByFile, id, topics.topics);
      } else if (faststream && method === 'include_router') {
        // `broker.include_router(router)` — mounting (a plain call in the diagram).
        const resolvedObj = resolveBrokerLike(id, obj, binds);
        if (!resolvedObj) continue;
        markFastStreamBroker(resolvedObj);
        const arg = positionalArgs(call)[0];
        const argRoot = arg ? memberChain(arg)?.root : undefined;
        const target = argRoot
          ? routerVarsByFile.get(id)?.has(argRoot)
            ? id // same-file router → self-edge (dropped by addEdge)
            : binds.get(argRoot)
          : undefined;
        if (target) addEdge(edges, id, target, 'calls', 'include-router');
        else diag.unresolvedMounts.add(`${id}: ${obj}.include_router(…)`);
      } else if (taskiq && method === 'kiq') {
        // `some_task.kiq(...)` — the callee root is the imported task function; the
        // enqueue is the async decoupling the import graph would render as a call.
        const target = binds.get(obj);
        if (target) addEdge(edges, id, target, 'publishes', 'taskiq-kiq');
        else diag.unresolvedKiq.add(`${id}: ${obj}.kiq(…)`);
      }
    }
  }

  // --- Object files are gateways (the message entrypoint), even when their
  // handlers live elsewhere. Deferred to a post-walk pass because the `broker` role
  // is gated on the broker being FastStream-used (`faststreamBrokerFiles`, filled by
  // the walk above) — a Taskiq broker in a mixed repo is a task dispatcher, not a
  // message gateway, so it stays unroled. app (FastStream) + router (KafkaRouter …)
  // are unambiguously FastStream, so they need only the faststream gate. addRole is
  // priority-ordered, so combining these with the handler roles is order-independent.
  if (faststream) {
    for (const id of parsed.keys()) {
      if (appVarsByFile.get(id)!.size > 0) addRole(roleByFile, id, 'app');
      if (routerVarsByFile.get(id)!.size > 0) addRole(roleByFile, id, 'router');
      if (brokerVarsByFile.get(id)!.size > 0 && faststreamBrokerFiles.has(id)) {
        addRole(roleByFile, id, 'broker');
      }
    }
  }

  // --- Pub/sub topic-matching edges: publisher-file → subscriber-file (kind
  // 'publishes'), one edge per (publisher, subscriber) pair that SHARES a topic;
  // the shared topic name(s) ride in metadata. Iterate topic → publishers ×
  // subscribers, all sorted, so the aggregation is order-independent.
  const topicIndex = new Map<string, { pubs: Set<string>; subs: Set<string> }>();
  for (const [file, topics] of pubTopicsByFile) {
    for (const t of topics) {
      let e = topicIndex.get(t);
      if (!e) {
        e = { pubs: new Set(), subs: new Set() };
        topicIndex.set(t, e);
      }
      e.pubs.add(file);
    }
  }
  for (const [file, topics] of subTopicsByFile) {
    for (const t of topics) {
      let e = topicIndex.get(t);
      if (!e) {
        e = { pubs: new Set(), subs: new Set() };
        topicIndex.set(t, e);
      }
      e.subs.add(file);
    }
  }
  // Nested map (publisher -> subscriber -> shared topics) — no string round-trip,
  // so a file id can never be corrupted by a separator, and no non-printable byte
  // lands in the source. Insertion order is stable (sorted topics/pubs/subs), so
  // the resulting edge set is deterministic.
  const pairTopics = new Map<string, Map<string, Set<string>>>();
  for (const topic of [...topicIndex.keys()].sort()) {
    const { pubs, subs } = topicIndex.get(topic)!;
    for (const p of [...pubs].sort()) {
      for (const s of [...subs].sort()) {
        if (p === s) continue; // a passthrough file (pub+sub same topic) doesn't self-link
        let bySub = pairTopics.get(p);
        if (!bySub) {
          bySub = new Map();
          pairTopics.set(p, bySub);
        }
        let set = bySub.get(s);
        if (!set) {
          set = new Set();
          bySub.set(s, set);
        }
        set.add(topic);
      }
    }
  }
  for (const [p, bySub] of pairTopics) {
    for (const [s, topics] of bySub) {
      addEdge(edges, p, s, 'publishes', 'pubsub', { topics: [...topics].sort() });
    }
  }

  const groups = assignRouterGroups([...seedsByKey.values()]);

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'faststream' },
    });
  }

  const sortedEdges = [...edges.values()].sort((a, b) =>
    a.source < b.source
      ? -1
      : a.source > b.source
        ? 1
        : a.target < b.target
          ? -1
          : a.target > b.target
            ? 1
            : a.kind < b.kind
              ? -1
              : a.kind > b.kind
                ? 1
                : 0,
  );

  // Positive signal for validation (mirrors fastapi/flask's log line).
  if (groups.length > 0 || roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(
      `  [faststream] ${roleByFile.size} role(s) · ${groups.length} router group(s) · ${sortedEdges.length} edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  const degraded: string[] = [];
  if (diag.dynamicTopics.size > 0) {
    degraded.push(`${diag.dynamicTopics.size} dynamic topic(s): ${[...diag.dynamicTopics].sort().slice(0, 10).join(' · ')}`);
  }
  if (diag.unresolvedKiq.size > 0) {
    degraded.push(`${diag.unresolvedKiq.size} unresolvable kiq(s): ${[...diag.unresolvedKiq].sort().slice(0, 10).join(' · ')}`);
  }
  if (diag.unresolvedMounts.size > 0) {
    degraded.push(`${diag.unresolvedMounts.size} unresolvable mount(s): ${[...diag.unresolvedMounts].sort().slice(0, 10).join(' · ')}`);
  }
  if (diag.ambiguousRouters.size > 0) {
    degraded.push(`${diag.ambiguousRouters.size} ambiguous router attribution(s): ${[...diag.ambiguousRouters].sort().slice(0, 10).join(' · ')}`);
  }
  if (degraded.length > 0) {
    console.log(`  [faststream] degraded: ${degraded.join(' · ')} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): FastStreamAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeFastStream(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const fastStreamAdapter: FrameworkAdapter = {
  name: 'faststream',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose manifest is at root reports rootPath '').
    const rootMatch = scoreFastStream(gatherFastStreamSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // A FastStream/Taskiq worker often lives one dir down (a `backend/` | `worker/`
    // | `server/` package in a frontend+backend monorepo), so a root-only scan
    // misses it. Shallow-scan immediate subdirs for a match and scope to it. Only
    // when NOT already scoped to a workspace package (the  path).
    if (!ctx.packageDir) {
      for (const sub of shallowManifestSubdirs(base)) {
        const m = scoreFastStream(gatherFastStreamSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // One grouping prior per FastStream *Router → its own subsystem, authoritative
  // over directory grouping (the fastapi/flask mechanism). Fully deterministic
  // (var/package-derived) → no classificationsNeeded. A broker-only app (no
  // routers) yields no groups.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // Pub/sub topic matching (kind 'publishes') + Taskiq kiq enqueue (kind
  // 'publishes') + include_router mounting (kind 'calls'). File-id endpoints; the
  // step resolves to modules, drops self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // app / broker / router → gateway; subscriber / publisher → service; task → job.
  // METADATA; the module's `kind` is unchanged.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE (Python). Declare the paths the diff-driven hosted walk
  // must treat as framework-relevant. Never-store-source holds: parse server-side,
  // persist only the derived groups/edges/roles.
  scansSourcePath(path: string): boolean {
    return path.endsWith('.py') || path.endsWith('.pyi');
  },
};
