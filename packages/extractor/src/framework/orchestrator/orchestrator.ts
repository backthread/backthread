// the Workflow-orchestrator FrameworkAdapter. ONE adapter for the
// four Python workflow/DAG orchestrators, built on a single shared
// "decorated flow/task/asset" heuristic + per-tool refinement. Follows the
// FastAPI/Flask template (/997) and reuses the shared Python core
// (py-ast + parsePythonScope). Install-free + deterministic (a pure
// syntactic Pyright parse; never executes repo code); persist only the derived
// groups/edges/roles.
//
// The unifying idea: in every one of these tools the UNIT OF WORK is a DECORATED
// function — @asset (Dagster) / @flow,@task (Prefect) / @dag,@task (Airflow
// TaskFlow) / @activity.defn,@workflow.run (Temporal). One heuristic tags all of
// them; a small per-tool table refines the role name + the dependency DSL.
//
//   * detect()        — any of `dagster` / `prefect` / `apache-airflow` /
//                       `temporalio`. The metadata carries WHICH tools are
//                       present, so the analysis only runs the vocab/edge passes
//                       for the tools actually in the repo (mirrors FastAPI's
//                       `celery` flag).
//   * roleTags        — a decorated flow/task/asset/op/dag/activity/workflow →
//                       `job` (the  role: own-code triggered by a
//                       schedule/queue/event, not a request). METADATA onto the
//                       LOCKED MODULE_KINDS enum; never a new kind.
//   * groupingPrior   — a `dags/` directory → one subsystem; and every
//                       orchestration CONTAINER (Airflow `@dag`, Dagster `@job`,
//                       Prefect `@flow`) → a subsystem grouping the definer +
//                       the task/asset files it references. Same authoritative-
//                       over-directory mechanism the FastAPI router / Nest
//                       @Module priors use.
//   * syntheticEdges  — the task-dependency wiring the import graph doesn't name
//                       as verbs, resolved STATICALLY to `calls` where possible:
//                         · Dagster asset deps — an @asset fn PARAMETER named
//                           after another asset, or `@asset(deps=[…])`.
//                         · Prefect/Dagster/Airflow — a @task/@op called from a
//                           @flow/@job/@dag (cross-file, via import bindings).
//                         · Airflow `a >> b` / `a << b` / `a.set_downstream(b)`.
//                         · Temporal `workflow.execute_activity(fn, …)`.
//                       Endpoints in FILE-id space; the contribute-step resolves
//                       to modules, drops self-edges (same-file deps collapse),
//                       dedupes, 8-verb-validates. Dynamic/unresolvable deps
//                       DEGRADE + LOG — no silent caps.
//
// Dagster + Prefect + Airflow-TaskFlow are covered solidly; Temporal is
// best-effort (its workflow is a decorated CLASS — caught via the always-present
// `@workflow.run` method rather than class-decorator collection).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readPythonDeps } from '../../graph/python-manifest.js';
import { parsePythonScope } from '../python/analyze.js';
import {
  callCallee,
  keywordArg,
  listItems,
  memberChain,
  nameValue,
  positionalArgs,
  stringValue,
  PN,
} from '../python/py-ast.js';
import type {
  BinaryOperationNode,
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

/** Which orchestrators are declared (dependency names only). */
export interface OrchestratorTools {
  dagster: boolean;
  prefect: boolean;
  airflow: boolean;
  temporal: boolean;
}

/** The deterministic orchestrator signal set. */
export interface OrchestratorSignals {
  tools: OrchestratorTools;
}

/** Gather the signal set for a single root dir (reads manifests only). */
export function gatherOrchestratorSignals(baseDir: string): OrchestratorSignals {
  const deps = readPythonDeps(baseDir);
  return {
    tools: {
      dagster: deps.has('dagster'),
      prefect: deps.has('prefect'),
      // The PyPI distribution is `apache-airflow`; accept a bare `airflow` too.
      airflow: deps.has('apache-airflow') || deps.has('airflow'),
      temporal: deps.has('temporalio'),
    },
  };
}

function toolCount(t: OrchestratorTools): number {
  return (t.dagster ? 1 : 0) + (t.prefect ? 1 : 0) + (t.airflow ? 1 : 0) + (t.temporal ? 1 : 0);
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
 * for a nested orchestration package. Sorted, so the first-match pick is
 * deterministic; skips dot-dirs + non-source dirs to stay cheap.
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
 * Decide the orchestrator match from the signal set. At least one of the four
 * deps is REQUIRED; a second raises confidence (a repo wiring two orchestrators
 * is an even stronger signal). Returns null → generic-Python fallthrough,
 * byte-for-byte unchanged.
 */
export function scoreOrchestrator(s: OrchestratorSignals, rootPath = ''): DetectMatch | null {
  const n = toolCount(s.tools);
  if (n === 0) return null;
  let confidence = 0.8;
  if (n > 1) confidence += 0.1;
  return {
    adapter: 'orchestrator',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: { tools: s.tools },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → the LOCKED `job` kind (own-code triggered by a schedule /
// queue / event, not a request). Roles are metadata; the module's `kind` is
// unchanged. Every orchestrator unit is a `job`.
export type OrchestratorRole =
  | 'workflow' // Temporal @workflow.*
  | 'dag' // Airflow @dag / DAG(...)
  | 'job' // Dagster @job / @graph
  | 'flow' // Prefect @flow
  | 'asset' // Dagster @asset / @multi_asset / @graph_asset
  | 'op' // Dagster @op
  | 'activity' // Temporal @activity.defn
  | 'task' // Prefect/Airflow @task
  | 'sensor' // Dagster @sensor / @asset_sensor
  | 'schedule' // Dagster @schedule
  | 'task-group'; // Airflow @task_group

// Collapse priority when one FILE carries several roles (a @dag file that also
// declares @task functions reads as `dag` — the orchestration headline; a
// Prefect @flow+@task file reads as `flow`). Higher wins; lexical tiebreak.
const ROLE_PRIORITY: Record<OrchestratorRole, number> = {
  workflow: 11,
  dag: 10,
  job: 9,
  flow: 8,
  asset: 7,
  op: 6,
  activity: 5,
  task: 4,
  sensor: 3,
  schedule: 2,
  'task-group': 1,
};

// Every role maps onto the single locked kind `job` (never a new Module-kind).
const ROLE_KIND: ModuleKind = 'job';

// Roles that are orchestration CONTAINERS — each becomes its own subsystem
// grouping the tasks/assets it references (Airflow @dag, Dagster @job, Prefect
// @flow). Temporal's @workflow is a unit, not a container of other files.
const CONTAINER_ROLES = new Set<OrchestratorRole>(['dag', 'job', 'flow']);

// Roles that are a "unit" a container can reference cross-file (a call from a
// @flow/@job/@dag to one of these files becomes a `calls` edge + group member).
const UNIT_ROLES = new Set<OrchestratorRole>(['asset', 'op', 'task', 'flow', 'activity', 'workflow']);

// Temporal orchestration-call methods whose first positional arg is the
// activity/child-workflow reference (best-effort).
const TEMPORAL_CALL_METHODS = new Set([
  'execute_activity',
  'execute_local_activity',
  'execute_activity_method',
  'execute_child_workflow',
  'start_activity',
  'start_child_workflow',
  'start_local_activity',
]);

// Airflow imperative dependency setters (a.set_downstream(b) / b.set_upstream(a)).
const DOWNSTREAM_METHODS = new Set(['set_downstream', 'set_upstream']);

// Pinned OperatorType values (parser/tokenizerTypes) for the Airflow `>>` / `<<`
// task-dependency DSL. The dep is pinned EXACTLY (same rationale as py-ast's PN).
const OP_RSHIFT = 31; // `a >> b` — a upstream of b
const OP_LSHIFT = 17; // `a << b` — b upstream of a

/**
 * Classify a decorator's `{root, path}` chain to an orchestrator role, GATED by
 * which tools the repo declares (so a bare `@task` is only claimed when a tool
 * that defines it is present). Matches on the chain LEAF (`@dg.asset` and bare
 * `@asset` both read as leaf `asset`), so it's import-alias-independent.
 */
export function classifyDecorator(
  chain: { root: string; path: string[] },
  tools: OrchestratorTools,
): OrchestratorRole | undefined {
  const leaf = chain.path.length ? chain.path[chain.path.length - 1] : chain.root;

  if (tools.dagster) {
    if (leaf === 'asset' || leaf === 'multi_asset' || leaf === 'graph_asset' || leaf === 'graph_multi_asset' || leaf === 'asset_check') return 'asset';
    if (leaf === 'op') return 'op';
    if (leaf === 'job' || leaf === 'graph') return 'job';
    if (leaf === 'sensor' || leaf === 'asset_sensor' || leaf === 'multi_asset_sensor' || leaf === 'run_status_sensor' || leaf === 'run_failure_sensor') return 'sensor';
    if (leaf === 'schedule') return 'schedule';
  }
  if (tools.airflow) {
    // The TaskFlow `task` namespace covers `@task` and `@task.<variant>`
    // (virtualenv/docker/kubernetes/branch/short_circuit/…): match the ROOT.
    if (chain.root === 'task') return 'task';
    if (leaf === 'dag') return 'dag';
    if (leaf === 'task_group') return 'task-group';
  }
  if (tools.prefect) {
    if (leaf === 'flow') return 'flow';
    if (leaf === 'task') return 'task';
  }
  if (tools.temporal) {
    // @workflow.defn (class) / @workflow.run|signal|query|update (method).
    if (chain.root === 'workflow') return 'workflow';
    // @activity.defn (function).
    if (chain.root === 'activity' && (chain.path.length === 0 || chain.path[0] === 'defn')) return 'activity';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Analysis.

interface OrchestratorAnalysis {
  groups: FrameworkGroup[];
  edges: FrameworkEdge[]; // file-id endpoints
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface OrchestratorDiag {
  ambiguousAssets: Set<string>; // an asset name resolving to >1 file
  unresolvedShift: Set<string>; // a `>>`/`<<` operand we couldn't map to a file
  unresolvedTemporal: Set<string>; // an execute_activity target we couldn't map
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so groupingPrior +
// syntheticEdges + roleTags share ONE parse, while the merge walk's per-checkpoint
// ctx gets a fresh analysis. Mirrors fastapi / flask / nest.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, OrchestratorAnalysis>();

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

function baseName(fileId: string): string {
  const last = fileId.split('/').pop() ?? fileId;
  return last.replace(/\.[^.]+$/, '');
}

function dirSegment(fileId: string): string {
  const slash = fileId.indexOf('/');
  return slash > 0 ? slugify(fileId.slice(0, slash)) : 'root';
}

// Keep the highest-priority candidate role per file (deterministic, lexical
// tiebreak) — mirrors the fastapi/flask addRole + the contribute-step's collapse.
function addRole(map: Map<string, OrchestratorRole>, fileId: string, role: OrchestratorRole): void {
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
  relation: string,
): void {
  if (from === to) return; // intra-file deps collapse; the step drops self-edges too
  const key = `${from}→${to}:calls`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind: 'calls', metadata: { framework: 'orchestrator', relation } });
  }
}

// The constructor name of an `x = Ctor(...)` assignment RHS (last chain segment,
// so both `DAG(...)` and `airflow.DAG(...)` read as 'DAG'), or undefined.
function assignedCtorName(rhs: ExpressionNode): string | undefined {
  if ((rhs as ParseNode).nodeType !== PN.Call) return undefined;
  const callee = callCallee(rhs as CallNode);
  if (!callee) return undefined;
  return callee.path.length ? callee.path[callee.path.length - 1] : callee.root;
}

// A decorator's callee chain (`@bp.route(...)` → root 'bp', path ['route'];
// `@shared_task` → root 'shared_task', path []; `@workflow.defn` → root
// 'workflow', path ['defn']). The decorator expr is either a call or a bare
// name/attribute. Mirrors the fastapi/flask local helper (per-adapter pattern).
function decoratorChain(deco: DecoratorNode): { root: string; path: string[] } | undefined {
  const expr = deco.d.expr;
  if ((expr as ParseNode).nodeType === PN.Call) return callCallee(expr as CallNode);
  return memberChain(expr);
}

// A container decorator's human label: its `dag_id=`/`name=` string arg when the
// decorator is called, else the decorated function's name.
function containerLabel(deco: DecoratorNode, fnName: string): string {
  const expr = deco.d.expr;
  if ((expr as ParseNode).nodeType === PN.Call) {
    const call = expr as CallNode;
    const s = stringValue(keywordArg(call, 'dag_id')) ?? stringValue(keywordArg(call, 'name'));
    if (s) return s;
  }
  return fnName;
}

// Resolve a symbol name used at a task-dependency site to a file id: an imported
// symbol resolves to its module file; anything else (a local task variable, an
// unresolved name) resolves to THIS file → a self-edge the step drops.
function resolveName(root: string, binds: ReadonlyMap<string, string>, thisFile: string): string {
  return binds.get(root) ?? thisFile;
}

// Resolve a task-dependency operand EXPRESSION (a task variable `a`, an
// attribute `mod.a`, or a task call `extract()`) to a file id, or undefined when
// it isn't a dotted-name/call we can anchor (a dynamic expression → logged).
function operandFile(
  expr: ExpressionNode,
  binds: ReadonlyMap<string, string>,
  thisFile: string,
): string | undefined {
  const mc = memberChain(expr);
  if (mc) return resolveName(mc.root, binds, thisFile);
  if ((expr as ParseNode).nodeType === PN.Call) {
    const callee = callCallee(expr as CallNode);
    if (callee) return resolveName(callee.root, binds, thisFile);
  }
  return undefined;
}

// The upstream-most (`head`) or downstream-most (`tail`) task operands of a
// `>>`/`<<` chain, expanding list operands (`[a, b] >> c`) and recursing through
// nested shifts. For `a >> b`: head = a's head, tail = b's tail; `<<` mirrors.
function shiftEnds(expr: ExpressionNode, side: 'head' | 'tail'): ExpressionNode[] {
  const t = (expr as ParseNode).nodeType;
  if (t === PN.List) return listItems(expr);
  if (t === PN.BinaryOperation) {
    const b = expr as BinaryOperationNode;
    if (b.d.operator === OP_RSHIFT) return shiftEnds(side === 'head' ? b.d.leftExpr : b.d.rightExpr, side);
    if (b.d.operator === OP_LSHIFT) return shiftEnds(side === 'head' ? b.d.rightExpr : b.d.leftExpr, side);
    return [expr]; // a non-shift operator is an opaque endpoint
  }
  return [expr]; // a Name / MemberAccess / Call leaf
}

// Deterministic, collision-free group ids ( discipline): process seeds by
// a stable key so the SMALLEST wins a bare slug; collisions take a `-<dir>` then
// `-<n>` suffix. Order is stable (never an iteration index), so the id set is
// identical run-to-run — the snapshot grouping-stability invariant.
interface GroupSeed {
  key: string; // stable identity for ordering (dags-dir path or container fileId)
  baseSlug: string;
  label: string;
  fileIds: Set<string>;
}

function assignGroups(seeds: GroupSeed[]): FrameworkGroup[] {
  const taken = new Set<string>();
  const ordered = [...seeds].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const groups: FrameworkGroup[] = [];
  for (const seed of ordered) {
    let id = seed.baseSlug;
    if (taken.has(id)) id = `${seed.baseSlug}-${dirSegment(seed.key)}`;
    let n = 2;
    while (taken.has(id)) id = `${seed.baseSlug}-${n++}`;
    taken.add(id);
    groups.push({ id, label: seed.label, fileIds: [...seed.fileIds].sort() });
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The `dags/` directory path prefix a file lives under (up to & including the
// `dags` segment), or undefined. `svc/dags/etl.py` → `svc/dags`.
function dagsDirOf(fileId: string): string | undefined {
  const parts = fileId.split('/');
  const idx = parts.findIndex((p) => p.toLowerCase() === 'dags');
  if (idx < 0 || idx === parts.length - 1) return undefined; // not under a dags/ dir
  return parts.slice(0, idx + 1).join('/');
}

function analyzeOrchestrator(ctx: FrameworkContext): OrchestratorAnalysis {
  const { parsed } = parsePythonScope(ctx);
  const tools = (ctx.match.metadata?.tools as OrchestratorTools | undefined) ?? {
    dagster: false,
    prefect: false,
    airflow: false,
    temporal: false,
  };

  const roleByFile = new Map<string, OrchestratorRole>();
  const diag: OrchestratorDiag = {
    ambiguousAssets: new Set(),
    unresolvedShift: new Set(),
    unresolvedTemporal: new Set(),
  };

  // Pass 1 — roles + indexes (asset-name → file(s); the set of unit files; the
  // container files; each asset def's params/deps for the Dagster dependency pass).
  const assetFilesByName = new Map<string, Set<string>>(); // asset fn name → defining file(s)
  const unitFiles = new Set<string>(); // files that define any orchestrator unit
  interface Container {
    role: OrchestratorRole;
    label: string;
  }
  const containerByFile = new Map<string, Container>(); // container file → its label/role
  interface AssetDef {
    fileId: string;
    params: string[];
    depsItems: ExpressionNode[];
  }
  const assetDefs: AssetDef[] = [];

  for (const [id, file] of parsed) {
    // Classic Airflow `dag = DAG(...)` (the non-decorator, context-manager-adjacent
    // form) — its file is a DAG orchestration unit + container.
    if (tools.airflow) {
      for (const a of file.nodes.assignments) {
        if (assignedCtorName(a.d.rightExpr) !== 'DAG') continue;
        addRole(roleByFile, id, 'dag');
        if (!containerByFile.has(id)) {
          const call = a.d.rightExpr as CallNode;
          const label =
            stringValue(keywordArg(call, 'dag_id')) ??
            stringValue(positionalArgs(call)[0]) ??
            nameValue(a.d.leftExpr) ??
            baseName(id);
          containerByFile.set(id, { role: 'dag', label });
        }
      }
    }

    for (const fn of file.nodes.functions) {
      const fnName = fn.d.name.d.value;
      for (const deco of fn.d.decorators) {
        const chain = decoratorChain(deco);
        if (!chain) continue;
        const role = classifyDecorator(chain, tools);
        if (!role) continue;
        addRole(roleByFile, id, role);
        if (UNIT_ROLES.has(role)) unitFiles.add(id);
        if (role === 'asset') {
          let set = assetFilesByName.get(fnName);
          if (!set) {
            set = new Set();
            assetFilesByName.set(fnName, set);
          }
          set.add(id);
          const call = (deco.d.expr as ParseNode).nodeType === PN.Call ? (deco.d.expr as CallNode) : undefined;
          const params = fn.d.params.map((p) => p.d.name?.d.value).filter((n): n is string => !!n);
          const depsItems = call ? listItems(keywordArg(call, 'deps')) : [];
          assetDefs.push({ fileId: id, params, depsItems });
        }
        if (CONTAINER_ROLES.has(role) && !containerByFile.has(id)) {
          containerByFile.set(id, { role, label: containerLabel(deco, fnName) });
        }
      }
    }
  }

  // Resolve an asset KEY (a param name, a `deps=` string key) to its defining
  // file via the global asset-name index — Dagster wires assets by key, not by
  // import. Ambiguous (same name in >1 file) → undefined + logged.
  function assetByName(name: string): string | undefined {
    const set = assetFilesByName.get(name);
    if (!set || set.size === 0) return undefined;
    if (set.size > 1) {
      diag.ambiguousAssets.add(`${name} → {${[...set].sort().join(', ')}}`);
      return undefined;
    }
    return [...set][0];
  }

  // Pass 2 — edges + container group membership.
  const edges = new Map<string, FrameworkEdge>();
  const containerMembers = new Map<string, Set<string>>(); // container file → member files
  for (const id of containerByFile.keys()) containerMembers.set(id, new Set([id]));

  // Dagster asset deps — an @asset PARAMETER named after an asset (resolved by
  // asset key), or an `@asset(deps=[…])` reference (an imported asset fn → its
  // import binding; a string key → the asset index). Direction: upstream → this.
  for (const def of assetDefs) {
    const binds = parsed.get(def.fileId)!.bindings;
    for (const paramName of def.params) {
      const upstream = assetByName(paramName);
      if (upstream) addEdge(edges, upstream, def.fileId, 'asset-dep-param');
    }
    for (const item of def.depsItems) {
      let upstream: string | undefined;
      const mc = memberChain(item);
      if (mc) upstream = binds.get(mc.root) ?? assetByName(mc.root);
      else {
        const key = stringValue(item);
        if (key) upstream = assetByName(key.split('/').pop() ?? key);
      }
      if (upstream) addEdge(edges, upstream, def.fileId, 'asset-dep');
    }
  }

  for (const [id, file] of parsed) {
    const binds = file.bindings;
    const isContainer = containerByFile.has(id);

    // Container → imported-unit calls (Prefect @flow → @task, Dagster @job → @op,
    // Airflow @dag → an imported @task). Same-file tasks aren't imported → no
    // binding → no edge (they collapse anyway). Each target also joins the group.
    if (isContainer) {
      for (const call of file.nodes.calls) {
        const callee = callCallee(call);
        if (!callee) continue;
        const target = binds.get(callee.root);
        if (target && target !== id && unitFiles.has(target)) {
          addEdge(edges, id, target, 'contains-task');
          containerMembers.get(id)!.add(target);
        }
      }
    }

    // Temporal orchestration calls (best-effort): the first positional arg of
    // `workflow.execute_activity(fn, …)` / `execute_child_workflow(Wf, …)` is the
    // activity/child-workflow reference.
    if (tools.temporal) {
      for (const call of file.nodes.calls) {
        const callee = callCallee(call);
        if (!callee || callee.path.length === 0) continue;
        if (!TEMPORAL_CALL_METHODS.has(callee.path[callee.path.length - 1])) continue;
        const arg = positionalArgs(call)[0];
        if (!arg) continue;
        const target = operandFile(arg, binds, id);
        if (target && target !== id) addEdge(edges, id, target, 'temporal-execute');
        else if (!target) diag.unresolvedTemporal.add(`${id}: ${callee.path.join('.')}(…)`);
      }
    }

    // Airflow imperative dependency setters + the `>>`/`<<` DSL.
    if (tools.airflow) {
      for (const call of file.nodes.calls) {
        const callee = callCallee(call);
        if (!callee || callee.path.length !== 1 || !DOWNSTREAM_METHODS.has(callee.path[0])) continue;
        const arg = positionalArgs(call)[0];
        if (!arg) continue;
        const obj = resolveName(callee.root, binds, id);
        const other = operandFile(arg, binds, id);
        if (!other) {
          diag.unresolvedShift.add(`${id}: ${callee.root}.${callee.path[0]}(…)`);
          continue;
        }
        // set_downstream: obj → other; set_upstream: other → obj.
        if (callee.path[0] === 'set_downstream') addEdge(edges, obj, other, 'set-downstream');
        else addEdge(edges, other, obj, 'set-upstream');
      }
      for (const b of file.nodes.binaryOps) {
        const rs = b.d.operator === OP_RSHIFT;
        const ls = b.d.operator === OP_LSHIFT;
        if (!rs && !ls) continue;
        // Upstream set → downstream set. RS `L >> R`: tails(L) → heads(R);
        // LS `L << R` (R upstream of L): tails(R) → heads(L).
        const ups = rs ? shiftEnds(b.d.leftExpr, 'tail') : shiftEnds(b.d.rightExpr, 'tail');
        const downs = rs ? shiftEnds(b.d.rightExpr, 'head') : shiftEnds(b.d.leftExpr, 'head');
        for (const u of ups) {
          const uf = operandFile(u, binds, id);
          if (!uf) {
            diag.unresolvedShift.add(`${id}: dynamic shift operand`);
            continue;
          }
          for (const d of downs) {
            const df = operandFile(d, binds, id);
            if (!df) {
              diag.unresolvedShift.add(`${id}: dynamic shift operand`);
              continue;
            }
            addEdge(edges, uf, df, 'shift-dep');
          }
        }
      }
    }
  }

  // Grouping — a `dags/` dir group + a per-container group. A `@dag`/`@job`/
  // `@flow` DEFINER is excluded from the coarse dags-dir group so its finer,
  // semantic per-container subsystem always wins; the dags-dir group then catches
  // the rest (classic `with DAG(...)` files, shared helpers, configs) that have
  // no container of their own.
  const seeds: GroupSeed[] = [];
  const dagsDirs = new Map<string, Set<string>>();
  for (const id of parsed.keys()) {
    if (containerByFile.has(id)) continue; // its own per-container group wins
    const dir = dagsDirOf(id);
    if (!dir) continue;
    let set = dagsDirs.get(dir);
    if (!set) {
      set = new Set();
      dagsDirs.set(dir, set);
    }
    set.add(id);
  }
  for (const [dir, fileIds] of dagsDirs) {
    // Label the group by its parent dir when nested (`svc/dags` → "Svc DAGs"),
    // else just "DAGs". Slug from the full dir path so multiple dags/ dirs never
    // collide.
    const parts = dir.split('/');
    const parent = parts.length >= 2 ? humanize(parts[parts.length - 2]) : '';
    seeds.push({
      key: `dagsdir:${dir}`,
      baseSlug: slugify(dir) || 'dags',
      label: parent ? `${parent} DAGs` : 'DAGs',
      fileIds,
    });
  }
  for (const [id, container] of containerByFile) {
    seeds.push({
      key: `container:${id}`,
      baseSlug: slugify(container.label) || 'workflow',
      label: humanize(container.label) || container.label,
      fileIds: containerMembers.get(id)!,
    });
  }
  const groups = assignGroups(seeds);

  // Materialize the role tags.
  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND,
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'orchestrator' },
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
            : 0,
  );

  // Positive signal for validation (mirrors fastapi/flask's log line).
  if (groups.length > 0 || roleByFile.size > 0 || sortedEdges.length > 0) {
    const present = (Object.keys(tools) as (keyof OrchestratorTools)[]).filter((k) => tools[k]);
    console.log(
      `  [orchestrator] ${present.join('+') || 'none'}: ${roleByFile.size} role(s) · ${groups.length} group(s) · ${sortedEdges.length} edge(s)`,
    );
  }
  // No silent caps (locked): log everything that degraded.
  const degraded: string[] = [];
  if (diag.ambiguousAssets.size > 0) {
    degraded.push(`${diag.ambiguousAssets.size} ambiguous asset name(s): ${[...diag.ambiguousAssets].sort().slice(0, 10).join(' · ')}`);
  }
  if (diag.unresolvedShift.size > 0) {
    degraded.push(`${diag.unresolvedShift.size} dynamic/unresolved task dependency(ies): ${[...diag.unresolvedShift].sort().slice(0, 10).join(' · ')}`);
  }
  if (diag.unresolvedTemporal.size > 0) {
    degraded.push(`${diag.unresolvedTemporal.size} unresolved Temporal call(s): ${[...diag.unresolvedTemporal].sort().slice(0, 10).join(' · ')}`);
  }
  if (degraded.length > 0) {
    console.log(`  [orchestrator] degraded: ${degraded.join(' · ')} (logged, not silently dropped)`);
  }

  return { groups, edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): OrchestratorAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeOrchestrator(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter.

export const orchestratorAdapter: FrameworkAdapter = {
  name: 'orchestrator',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose manifest is at root reports rootPath '').
    const rootMatch = scoreOrchestrator(gatherOrchestratorSignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // The orchestration package often lives one dir down (a `pipelines/` |
    // `dagster_project/` | `airflow/` package in a larger repo). Shallow-scan
    // immediate subdirs for a manifest and scope to it. Only when NOT already
    // scoped to a workspace package (the  path).
    if (!ctx.packageDir) {
      for (const sub of shallowManifestSubdirs(base)) {
        const m = scoreOrchestrator(gatherOrchestratorSignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // A `dags/` dir + each orchestration container (@dag/@job/@flow) → its own
  // subsystem, authoritative over directory grouping. Fully deterministic
  // (name/path-derived) → no classificationsNeeded.
  async groupingPrior(ctx: FrameworkContext): Promise<FrameworkGroupingPrior> {
    return { groups: getAnalysis(ctx).groups };
  },

  // Task-dependency wiring → `calls` (statically resolvable ones; dynamic ones
  // degrade + log). File-id endpoints; the step resolves to modules, drops
  // self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // Every decorated flow/task/asset/op/dag/activity/workflow → `job`. METADATA;
  // the module's `kind` is unchanged.
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
