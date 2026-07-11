// the Celery FrameworkAdapter. Extracted from the FastAPI adapter's
// gated Celery pass into a DEDICATED, standalone adapter that fires for
// ANY Celery repo (not only FastAPI + Celery), and DEEPENED: Celery Beat periodic
// schedules and `chain`/`group`/`chord` canvas composition.
//
// Celery declares its background-task surface with decorators + a broker config,
// which we read STATICALLY (install-free, never-store-source — a pure syntactic
// Pyright parse via the shared Python core; never executes repo code), and persist
// only the derived edges/roles:
//
//   * detect()        — the `celery` dependency (a `celery-*` / `django-celery-*`
//                       / `flower` extension raises confidence); shallow nested
//                       scan for a `backend/`|`worker/`|`server/` package (mirrors
//                       FastAPI's ).
//   * roleTags        — a Celery TASK (`@shared_task`, `@app.task`/`@celery_app.task`
//                       incl. an imported Celery app cross-file) → `task`; a Beat
//                       PERIODIC task (`@periodic_task`, or a task referenced by a
//                       `beat_schedule` config entry) → `scheduled-task`. Both map
//                       onto the LOCKED `job` MODULE_KIND (own-code triggered by a
//                       queue / schedule, not a request); never a new kind — only
//                       `role` renders.
//   * syntheticEdges  — the async wiring the import graph would render as a plain
//                       call or miss entirely: `.delay()`/`.apply_async()`/`.s()`/
//                       `.si()` enqueue (kind 'publishes'); `chain(a.s(), b.s())`
//                       sequential composition → task→task 'publishes'; `chord`
//                       header→callback 'publishes'; and a `beat_schedule` entry →
//                       its scheduled task (kind 'publishes', relation 'beat-schedule').
//
// The adapter is IMPORT-GATED (`@shared_task`/`chain`/`group`/`chord`/`Celery`
// are only honored when imported from a `celery` module in that file), so an
// unrelated `itertools.chain(...)` or a foreign `@task` never produces a false
// edge/role. Unresolvable enqueue / composition / schedule targets DEGRADE + LOG —
// no silent caps.
//
// NOTE: Grouping is intentionally NOT contributed — Celery has no per-domain
// structural unit like a FastAPI router / Flask blueprint; task files stay in the
// host framework's / directory grouping. This matches the  behavior the
// adapter extracts (roles + edges only).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampConfidence, resolveBase } from '../detect-util.js';
import { readPythonDeps } from '../../graph/python-manifest.js';
import { syntacticResolve } from '../../graph/python-adapter.js';
import { parsePythonScope } from '../python/analyze.js';
import {
  callCallee,
  dictEntries,
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
  ImportFromNode,
  ImportNode,
  ListNode,
  ParseNode,
} from '@zzzen/pyright-internal/dist/parser/parseNodes.js';
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
// Detection (fs → deps; PURE scorer). Never reads source content.

/** The deterministic Celery signal set (dependency names only). */
export interface CelerySignals {
  hasCelery: boolean; // celery — the authoritative signal
  hasCeleryExtension: boolean; // django-celery-beat / celery-redbeat / flower / celery-*
}

/** Gather the signal set for a single root dir (reads manifests only). */
export function gatherCelerySignals(baseDir: string): CelerySignals {
  const deps = readPythonDeps(baseDir);
  return {
    hasCelery: deps.has('celery'),
    // A Beat/monitoring extension is a strong secondary signal this really is a
    // Celery deployment (vs. `celery` pulled in transitively).
    hasCeleryExtension: [...deps].some(
      (d) => d === 'flower' || d.startsWith('celery-') || d.startsWith('django-celery'),
    ),
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
 * for a nested Celery worker (`backend/` | `worker/` | `server/`). Sorted, so the
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
 * Decide Celery from the signal set. `celery` is REQUIRED; a Beat/monitoring
 * extension raises confidence. Returns null → generic-Python fallthrough,
 * byte-for-byte unchanged.
 */
export function scoreCelery(s: CelerySignals, rootPath = ''): DetectMatch | null {
  if (!s.hasCelery) return null;
  let confidence = 0.8;
  if (s.hasCeleryExtension) confidence += 0.1;
  return {
    adapter: 'celery',
    confidence: clampConfidence(confidence),
    rootPath,
    metadata: {
      signals: { celery: s.hasCelery, celeryExtension: s.hasCeleryExtension },
    },
  };
}

// ---------------------------------------------------------------------------
// Role vocabulary → the LOCKED `job` MODULE_KIND. Roles are metadata; the
// module's `kind` is unchanged. A Celery task and a Beat periodic task are both
// own-code triggered by a queue/schedule (not a request) → `job`; the finer role
// distinguishes an on-demand task from a scheduled one. A scheduled task is the
// more informative label (it runs on a cron), so it outranks a plain task when one
// file is both.
export type CeleryRole = 'scheduled-task' | 'task';

const ROLE_PRIORITY: Record<CeleryRole, number> = {
  'scheduled-task': 6,
  task: 5,
};
const ROLE_KIND: Record<CeleryRole, ModuleKind> = {
  'scheduled-task': 'job',
  task: 'job',
};

// Celery enqueue methods: `.delay()` / `.apply_async()` (immediate) + `.s()` /
// `.si()` (signature / immutable-signature — a task reference wired into a canvas).
const ENQUEUE_METHODS = new Set(['delay', 'apply_async', 's', 'si']);
// Celery canvas composition primitives (imported from `celery`).
const COMPOSITION_NAMES = new Set(['chain', 'group', 'chord']);
// The `celery`-origin symbols this adapter honors — import-gated, so a foreign
// `@task` / `itertools.chain` never fires. `task` covers the legacy bare
// `from celery import task` decorator; `Celery` covers an aliased app import.
const CELERY_SYMBOLS = new Set([
  'shared_task',
  'task',
  'periodic_task',
  'chain',
  'group',
  'chord',
  'Celery',
]);
// Names a `beat_schedule` config binds to (module-level or `app.conf.<name>`).
const BEAT_SCHEDULE_NAMES = new Set(['beat_schedule', 'CELERYBEAT_SCHEDULE', 'CELERY_BEAT_SCHEDULE']);

// ---------------------------------------------------------------------------
// Analysis.

interface CeleryAnalysis {
  edges: FrameworkEdge[]; // file-id endpoints
  roles: Map<string, RoleTag>; // fileId → RoleTag
}

interface CeleryDiag {
  unresolvedEnqueues: Set<string>; // .delay/.apply_async/.s/.si callees we couldn't map
  unresolvedComposition: Set<string>; // chain/group/chord members we couldn't map
  unresolvedSchedules: Set<string>; // beat_schedule entries we couldn't map to a task file
}

// Memoized on the FrameworkContext OBJECT (not repoDir) so syntheticEdges +
// roleTags share ONE parse, while the merge walk's per-checkpoint ctx gets a fresh
// analysis — no cross-tree staleness. Mirrors fastapi / flask / nest.
const ANALYSIS_CACHE = new WeakMap<FrameworkContext, CeleryAnalysis>();

function addRole(map: Map<string, CeleryRole>, fileId: string, role: CeleryRole): void {
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
): void {
  if (from === to) return; // self-references collapse; the contribute-step drops self-edges too
  const key = `${from}→${to}:${kind}`;
  if (!edges.has(key)) {
    edges.set(key, { source: from, target: to, kind, metadata: { framework: 'celery', relation } });
  }
}

// The constructor name of an `x = Ctor(...)` assignment RHS (last chain segment,
// so both `Celery(...)` and `celery.Celery(...)` read as 'Celery'), or undefined.
function assignedCtorName(rhs: ExpressionNode): string | undefined {
  if ((rhs as ParseNode).nodeType !== PN.Call) return undefined;
  const callee = callCallee(rhs as CallNode);
  if (!callee) return undefined;
  return callee.path.length ? callee.path[callee.path.length - 1] : callee.root;
}

// A decorator's callee chain (`@app.task(...)` → root 'app', path ['task'];
// `@shared_task` → root 'shared_task', path []). The decorator expr is either a
// call (with args) or a bare name/attribute.
function decoratorChain(deco: DecoratorNode): { root: string; path: string[] } | undefined {
  const expr = deco.d.expr;
  if ((expr as ParseNode).nodeType === PN.Call) return callCallee(expr as CallNode);
  return memberChain(expr);
}

// The final segment of an assignment LHS (`beat_schedule` → 'beat_schedule';
// `app.conf.beat_schedule` → 'beat_schedule'), or undefined for a non-name LHS.
function assignmentTargetName(leftExpr: ExpressionNode): string | undefined {
  const chain = memberChain(leftExpr);
  if (!chain) return undefined;
  return chain.path.length ? chain.path[chain.path.length - 1] : chain.root;
}

/**
 * Per-file `localName → canonical celery symbol` map for `from celery(.*) import X`
 * (`from celery import shared_task, chain` / `from celery.decorators import
 * periodic_task` / `from celery import Celery as C`). Import-gating: a symbol is
 * only honored when it genuinely came from a `celery` module in THIS file.
 */
function celeryImportNames(imports: ReadonlyArray<ImportNode | ImportFromNode>): Map<string, string> {
  const out = new Map<string, string>();
  for (const imp of imports) {
    if ((imp as ParseNode).nodeType !== PN.ImportFrom) continue;
    const from = imp as ImportFromNode;
    if (from.d.module.d.leadingDots !== 0) continue; // celery is an absolute import
    const parts = from.d.module.d.nameParts.map((p) => p.d.value);
    if (parts[0] !== 'celery') continue; // celery / celery.canvas / celery.schedules / …
    for (const spec of from.d.imports) {
      const imported = spec.d.name.d.value;
      const local = spec.d.alias ? spec.d.alias.d.value : imported;
      if (CELERY_SYMBOLS.has(imported)) out.set(local, imported);
    }
  }
  return out;
}

function analyzeCelery(ctx: FrameworkContext): CeleryAnalysis {
  const { parsed, internalIds, roots } = parsePythonScope(ctx);

  // Pass 1 — per-file celery `import` gates + Celery() app object variables
  // (file-scoped, matching how these module-level singletons are used).
  const celeryImportsByFile = new Map<string, Map<string, string>>();
  const celeryVarsByFile = new Map<string, Set<string>>();
  for (const [id, file] of parsed) {
    const celeryImports = celeryImportNames(file.nodes.imports);
    celeryImportsByFile.set(id, celeryImports);
    const celeryVars = new Set<string>();
    for (const a of file.nodes.assignments) {
      const target = nameValue(a.d.leftExpr);
      if (!target) continue;
      const ctor = assignedCtorName(a.d.rightExpr);
      // Direct `Celery(...)` or an aliased-import `C(...)` where `C` came from celery.
      if (ctor && (ctor === 'Celery' || celeryImports.get(ctor) === 'Celery')) celeryVars.add(target);
    }
    celeryVarsByFile.set(id, celeryVars);
  }

  // Files that construct a Celery() app — so a `@<imported_app>.task` in ANOTHER
  // file (the common `from proj.celery import app` + `@app.task` layout) is
  // recognized as a task, not just a same-file `@celery_app.task`.
  const celeryAppFiles = new Set<string>();
  for (const [f, vars] of celeryVarsByFile) if (vars.size > 0) celeryAppFiles.add(f);

  const roleByFile = new Map<string, CeleryRole>();
  const edges = new Map<string, FrameworkEdge>();
  const diag: CeleryDiag = {
    unresolvedEnqueues: new Set(),
    unresolvedComposition: new Set(),
    unresolvedSchedules: new Set(),
  };

  // Resolve a canvas member expression to its task file id:
  //   `task.s(...)` / `task.si(...)` → the `task` root (path ['s'|'si'])
  //   `task` (bare Name)             → the imported task
  // Deeper chains (`mod.task.s()`) degrade to undefined. Same-file tasks resolve
  // to `thisFile` (a self-edge, dropped by addEdge) via a local-def fallback.
  function resolveCanvasTask(
    expr: ExpressionNode | undefined,
    thisFile: string,
    binds: ReadonlyMap<string, string>,
    localDefs: ReadonlySet<string>,
  ): string | undefined {
    if (!expr) return undefined;
    let root: string | undefined;
    if ((expr as ParseNode).nodeType === PN.Call) {
      const callee = callCallee(expr as CallNode);
      if (callee && callee.path.length === 1 && (callee.path[0] === 's' || callee.path[0] === 'si')) {
        root = callee.root;
      }
    } else {
      const chain = memberChain(expr);
      if (chain && chain.path.length === 0) root = chain.root;
    }
    if (root === undefined) return undefined;
    return binds.get(root) ?? (localDefs.has(root) ? thisFile : undefined);
  }

  // The header tasks of a `chord(header, callback)`: a `group(...)` call's args,
  // a list literal's items, or a single task. The `group` is import-gated
  // (canonical), so an aliased `group as g` header still resolves.
  function resolveChordHeader(
    header: ExpressionNode | undefined,
    thisFile: string,
    binds: ReadonlyMap<string, string>,
    localDefs: ReadonlySet<string>,
    celeryImports: ReadonlyMap<string, string>,
  ): Array<string | undefined> {
    if (!header) return [];
    if ((header as ParseNode).nodeType === PN.Call) {
      const callee = callCallee(header as CallNode);
      if (callee && callee.path.length === 0 && celeryImports.get(callee.root) === 'group') {
        return positionalArgs(header as CallNode).map((m) => resolveCanvasTask(m, thisFile, binds, localDefs));
      }
    }
    if ((header as ParseNode).nodeType === PN.List) {
      return (header as ListNode).d.items.map((m) => resolveCanvasTask(m, thisFile, binds, localDefs));
    }
    return [resolveCanvasTask(header, thisFile, binds, localDefs)];
  }

  // Read a `beat_schedule = { name: { 'task': 'dotted.path', … }, … }` config,
  // resolve each entry's task to a file, tag it `scheduled-task`, and add a
  // config→task 'publishes' edge (relation 'beat-schedule').
  function readBeatSchedule(
    scheduleExpr: ExpressionNode | undefined,
    configFile: string,
    binds: ReadonlyMap<string, string>,
  ): void {
    for (const entry of dictEntries(scheduleExpr)) {
      const spec = entry.valueExpr; // the per-entry `{ 'task': …, 'schedule': … }` dict
      const taskExpr = dictEntries(spec).find((e) => stringValue(e.keyExpr) === 'task')?.valueExpr;
      if (!taskExpr) continue;
      const target = resolveBeatTask(taskExpr, configFile, binds);
      if (target) {
        addRole(roleByFile, target, 'scheduled-task');
        addEdge(edges, configFile, target, 'publishes', 'beat-schedule');
      } else {
        const label = stringValue(taskExpr) ?? nameValue(taskExpr) ?? '<expr>';
        diag.unresolvedSchedules.add(`${configFile}: beat_schedule task ${label}`);
      }
    }
  }

  // Resolve a beat entry's `'task'` value to a file id: a dotted string
  // (`'app.workers.tasks.add'` → its module `app.workers.tasks`) or a bare
  // task reference resolved through the file's import bindings.
  function resolveBeatTask(
    taskExpr: ExpressionNode,
    fromFile: string,
    binds: ReadonlyMap<string, string>,
  ): string | undefined {
    const dotted = stringValue(taskExpr);
    if (dotted) {
      const segs = dotted.split('.');
      if (segs.length < 2) return undefined; // need module.function
      const modulePath = segs.slice(0, -1).join('.');
      return syntacticResolve(modulePath, fromFile, internalIds, roots);
    }
    const chain = memberChain(taskExpr);
    return chain ? binds.get(chain.root) : undefined;
  }

  for (const [id, file] of parsed) {
    const celeryImports = celeryImportsByFile.get(id)!;
    const celeryVars = celeryVarsByFile.get(id)!;
    const binds = file.bindings;
    const localDefs = new Set<string>();
    for (const fn of file.nodes.functions) {
      const n = nameValue(fn.d.name);
      if (n) localDefs.add(n);
    }

    // Task + periodic decorators.
    for (const fn of file.nodes.functions) {
      for (const deco of fn.d.decorators) {
        const chain = decoratorChain(deco);
        if (!chain) continue;
        if (chain.path.length === 0) {
          // Bare `@shared_task` / `@task` / `@periodic_task` — import-gated to celery.
          const canonical = celeryImports.get(chain.root);
          if (canonical === 'periodic_task') addRole(roleByFile, id, 'scheduled-task');
          else if (canonical === 'shared_task' || canonical === 'task') addRole(roleByFile, id, 'task');
        } else if (chain.path.length === 1 && chain.path[0] === 'task') {
          // `@<celeryapp>.task` — the app is defined here OR imported from a file
          // that constructs a Celery() app.
          const importedApp = binds.get(chain.root);
          if (celeryVars.has(chain.root) || (importedApp !== undefined && celeryAppFiles.has(importedApp))) {
            addRole(roleByFile, id, 'task');
          }
        }
      }
    }

    // Enqueue + canvas-composition + beat-config-update edges.
    for (const call of file.nodes.calls) {
      const callee = callCallee(call);
      if (!callee) continue;

      // A bare celery-origin composition primitive (import-gated → canonical, so an
      // aliased `chain as c` still resolves; a foreign `itertools.chain` yields
      // undefined and is skipped). `group(...)` maps here too but emits no
      // task→task edge (its members run in parallel).
      const compositionSym =
        callee.path.length === 0 ? celeryImports.get(callee.root) : undefined;

      if (callee.path.length === 1 && ENQUEUE_METHODS.has(callee.path[0])) {
        // `sometask.delay(...)` / `.apply_async()` / `.s()` / `.si()` — the callee
        // root is the imported task function; a same-file task is a self-edge.
        const obj = callee.root;
        const target = binds.get(obj) ?? (localDefs.has(obj) ? id : undefined);
        if (target) addEdge(edges, id, target, 'publishes', 'celery-enqueue');
        else diag.unresolvedEnqueues.add(`${id}: ${obj}.${callee.path[0]}(…)`);
      } else if (compositionSym && COMPOSITION_NAMES.has(compositionSym)) {
        const args = positionalArgs(call);
        if (compositionSym === 'chain') {
          // Sequential pipe: consecutive resolvable members → task→task publishes.
          // Log each unresolved member once (at its own index), then link the
          // resolved consecutive pairs (never bridging across an unknown).
          const resolved = args.map((m) => resolveCanvasTask(m, id, binds, localDefs));
          resolved.forEach((r, idx) => {
            if (!r) diag.unresolvedComposition.add(`${id}: chain(…) member ${idx} unresolved`);
          });
          for (let i = 0; i < resolved.length - 1; i++) {
            const a = resolved[i];
            const b = resolved[i + 1];
            if (a && b) addEdge(edges, a, b, 'publishes', 'chain');
          }
        } else if (compositionSym === 'chord') {
          // header (a group / list / single) → callback.
          const callback = keywordArg(call, 'body') ?? args[1];
          const cbFile = resolveCanvasTask(callback, id, binds, localDefs);
          const header = resolveChordHeader(args[0], id, binds, localDefs, celeryImports);
          if (cbFile) {
            for (const ht of header) {
              if (ht) addEdge(edges, ht, cbFile, 'publishes', 'chord');
              else diag.unresolvedComposition.add(`${id}: chord(…) header member unresolved`);
            }
          } else {
            diag.unresolvedComposition.add(`${id}: chord(…) callback unresolved`);
          }
        }
        // `group(...)` (compositionSym === 'group') → no task→task ordering edge
        // (each member's `.s()` is already a call-site publishes above).
      }

      // `app.conf.update(beat_schedule={…})` — a beat config passed as a kwarg.
      const beatKwarg = keywordArg(call, 'beat_schedule');
      if (beatKwarg) readBeatSchedule(beatKwarg, id, binds);
    }

    // `beat_schedule = {…}` / `CELERY_BEAT_SCHEDULE = {…}` / `app.conf.beat_schedule = {…}`.
    for (const a of file.nodes.assignments) {
      const name = assignmentTargetName(a.d.leftExpr);
      if (name && BEAT_SCHEDULE_NAMES.has(name)) readBeatSchedule(a.d.rightExpr, id, binds);
    }
  }

  const roles = new Map<string, RoleTag>();
  for (const [fileId, role] of roleByFile) {
    roles.set(fileId, {
      role,
      kind: ROLE_KIND[role],
      priority: ROLE_PRIORITY[role],
      metadata: { framework: 'celery' },
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

  // Positive signal for validation (mirrors fastapi / flask / nest's log line).
  if (roleByFile.size > 0 || sortedEdges.length > 0) {
    console.log(`  [celery] ${roleByFile.size} role(s) · ${sortedEdges.length} edge(s)`);
  }
  // No silent caps (locked): log everything that degraded.
  if (
    diag.unresolvedEnqueues.size > 0 ||
    diag.unresolvedComposition.size > 0 ||
    diag.unresolvedSchedules.size > 0
  ) {
    const parts: string[] = [];
    if (diag.unresolvedEnqueues.size > 0) {
      parts.push(
        `${diag.unresolvedEnqueues.size} unresolvable enqueue(s): ${[...diag.unresolvedEnqueues].sort().slice(0, 10).join(' · ')}`,
      );
    }
    if (diag.unresolvedComposition.size > 0) {
      parts.push(
        `${diag.unresolvedComposition.size} unresolvable composition(s): ${[...diag.unresolvedComposition].sort().slice(0, 10).join(' · ')}`,
      );
    }
    if (diag.unresolvedSchedules.size > 0) {
      parts.push(
        `${diag.unresolvedSchedules.size} unresolvable schedule(s): ${[...diag.unresolvedSchedules].sort().slice(0, 10).join(' · ')}`,
      );
    }
    console.log(`  [celery] degraded: ${parts.join(' · ')} (logged, not silently dropped)`);
  }

  return { edges: sortedEdges, roles };
}

function getAnalysis(ctx: FrameworkContext): CeleryAnalysis {
  let a = ANALYSIS_CACHE.get(ctx);
  if (!a) {
    a = analyzeCelery(ctx);
    ANALYSIS_CACHE.set(ctx, a);
  }
  return a;
}

// ---------------------------------------------------------------------------
// The adapter. Roles + edges only — no groupingPrior (Celery has no per-domain
// structural unit; task files stay in the host framework's / directory grouping).

export const celeryAdapter: FrameworkAdapter = {
  name: 'celery',

  async detect(ctx: FrameworkDetectContext): Promise<DetectMatch | null> {
    const { base, rootPath } = resolveBase(ctx);
    // Root scan first (a repo whose manifest is at root reports rootPath '').
    const rootMatch = scoreCelery(gatherCelerySignals(base), rootPath);
    if (rootMatch) return rootMatch;
    // A Celery worker often lives one dir down (a `backend/` | `worker/` |
    // `server/` package). Shallow-scan immediate subdirs and scope to it. Only
    // when NOT already scoped to a workspace package (the  path).
    if (!ctx.packageDir) {
      for (const sub of shallowManifestSubdirs(base)) {
        const m = scoreCelery(gatherCelerySignals(join(base, sub)), sub);
        if (m) return m;
      }
    }
    return null;
  },

  // `.delay`/`.apply_async`/`.s`/`.si` enqueue + chain/chord composition + beat
  // schedule → 'publishes'. File-id endpoints; the step resolves to modules,
  // drops self-edges, dedupes, 8-verb-validates.
  async syntheticEdges(ctx: FrameworkContext): Promise<FrameworkEdge[]> {
    return getAnalysis(ctx).edges;
  },

  // task / scheduled-task → job. METADATA; the module's `kind` is unchanged.
  async roleTags(ctx: FrameworkContext): Promise<Map<string, RoleTag>> {
    return getAnalysis(ctx).roles;
  },

  // The hooks READ SOURCE (Python). Declare the paths the diff-driven hosted walk
  // must treat as framework-relevant. Never-store-source holds: parse server-side,
  // persist only the derived edges/roles.
  scansSourcePath(path: string): boolean {
    return path.endsWith('.py') || path.endsWith('.pyi');
  },
};

