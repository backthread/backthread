// Workflow-orchestrator adapter tests.
//
// scoreOrchestrator is pure; detect() runs against real tmp dirs (pyproject +
// requirements per tool, a non-orchestrator no-match + a TS no-match, and a
// nested backend). The analysis hooks run over real PythonExtractor graphs of a
// small fixture PER TOOL (Dagster / Prefect / Airflow-TaskFlow solid; Temporal
// best-effort) and assert the file-id-space contributions (roles/groups/edges);
// the contribute-step resolves those to modules downstream.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  orchestratorAdapter,
  scoreOrchestrator,
  gatherOrchestratorSignals,
  classifyDecorator,
  type OrchestratorSignals,
  type OrchestratorTools,
} from './orchestrator.js';
import { PythonExtractor } from '../../graph/python-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_TOOLS: OrchestratorTools = { dagster: false, prefect: false, airflow: false, temporal: false };
const noSignals: OrchestratorSignals = { tools: { ...NO_TOOLS } };

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

// Build a FrameworkContext for a fixture, with the given tools enabled.
async function fixtureCtx(dir: string, tools: Partial<OrchestratorTools>): Promise<{
  ctx: FrameworkContext;
  graph: NormalizedGraph;
}> {
  const graph = await new PythonExtractor().extract(dir);
  const ctx: FrameworkContext = {
    repoDir: dir,
    rootPath: '',
    match: { adapter: 'orchestrator', confidence: 1, rootPath: '', metadata: { tools: { ...NO_TOOLS, ...tools } } },
    graph,
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  };
  return { ctx, graph };
}

// ---------------------------------------------------------------------------
// scoreOrchestrator + classifyDecorator (pure)

describe('scoreOrchestrator (pure)', () => {
  it('returns null with no orchestrator dep (generic-Python fallthrough)', () => {
    expect(scoreOrchestrator(noSignals)).toBeNull();
  });

  it('detects a single orchestrator and records the tools in metadata', () => {
    const m = scoreOrchestrator({ tools: { ...NO_TOOLS, dagster: true } });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('orchestrator');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
    expect((m!.metadata?.tools as OrchestratorTools).dagster).toBe(true);
    expect((m!.metadata?.tools as OrchestratorTools).prefect).toBe(false);
  });

  it('raises confidence when two orchestrators co-exist', () => {
    const m = scoreOrchestrator({ tools: { ...NO_TOOLS, dagster: true, airflow: true } });
    expect(m!.confidence).toBeGreaterThan(0.8);
  });

  it('passes rootPath through', () => {
    const m = scoreOrchestrator({ tools: { ...NO_TOOLS, prefect: true } }, 'pipelines');
    expect(m!.rootPath).toBe('pipelines');
  });
});

describe('classifyDecorator (pure, tool-gated)', () => {
  const all: OrchestratorTools = { dagster: true, prefect: true, airflow: true, temporal: true };
  it('maps each tool vocabulary onto a role', () => {
    expect(classifyDecorator({ root: 'asset', path: [] }, all)).toBe('asset');
    expect(classifyDecorator({ root: 'dg', path: ['multi_asset'] }, all)).toBe('asset');
    expect(classifyDecorator({ root: 'op', path: [] }, all)).toBe('op');
    expect(classifyDecorator({ root: 'job', path: [] }, all)).toBe('job');
    expect(classifyDecorator({ root: 'flow', path: [] }, all)).toBe('flow');
    expect(classifyDecorator({ root: 'dag', path: [] }, all)).toBe('dag');
    expect(classifyDecorator({ root: 'task', path: [] }, all)).toBe('task');
    expect(classifyDecorator({ root: 'task', path: ['virtualenv'] }, all)).toBe('task'); // @task.virtualenv
    expect(classifyDecorator({ root: 'workflow', path: ['run'] }, all)).toBe('workflow');
    expect(classifyDecorator({ root: 'activity', path: ['defn'] }, all)).toBe('activity');
  });
  it('is gated by tool presence (a bare @task is not claimed without a tool)', () => {
    expect(classifyDecorator({ root: 'task', path: [] }, NO_TOOLS)).toBeUndefined();
    expect(classifyDecorator({ root: 'asset', path: [] }, { ...NO_TOOLS, prefect: true })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('orchestratorAdapter.detect (fs fixtures)', () => {
  let dagsterDir: string;
  let prefectDir: string;
  let airflowDir: string;
  let temporalDir: string;
  let multiDir: string;
  let plainPy: string;
  let tsRepo: string;

  beforeAll(() => {
    dagsterDir = mkdtempSync(join(tmpdir(), 'bt-orch-dag-'));
    writeFileSync(join(dagsterDir, 'pyproject.toml'), '[project]\nname="p"\ndependencies=["dagster>=1.7"]\n');

    prefectDir = mkdtempSync(join(tmpdir(), 'bt-orch-pre-'));
    writeFileSync(join(prefectDir, 'requirements.txt'), 'prefect==2.19.0\n');

    airflowDir = mkdtempSync(join(tmpdir(), 'bt-orch-air-'));
    writeFileSync(join(airflowDir, 'requirements.txt'), 'apache-airflow==2.9.0\n');

    temporalDir = mkdtempSync(join(tmpdir(), 'bt-orch-tmp-'));
    writeFileSync(join(temporalDir, 'pyproject.toml'), '[project]\nname="p"\ndependencies=["temporalio>=1.6"]\n');

    multiDir = mkdtempSync(join(tmpdir(), 'bt-orch-multi-'));
    writeFileSync(join(multiDir, 'pyproject.toml'), '[project]\nname="p"\ndependencies=["dagster","prefect"]\n');

    plainPy = mkdtempSync(join(tmpdir(), 'bt-orch-plain-'));
    writeFileSync(join(plainPy, 'pyproject.toml'), '[project]\nname="x"\ndependencies=["requests>=2","click"]\n');

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-orch-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [dagsterDir, prefectDir, airflowDir, temporalDir, multiDir, plainPy, tsRepo]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('detects Dagster (pyproject)', async () => {
    const m = await orchestratorAdapter.detect({ repoDir: dagsterDir });
    expect(m!.adapter).toBe('orchestrator');
    expect((m!.metadata?.tools as OrchestratorTools).dagster).toBe(true);
  });
  it('detects Prefect (requirements)', async () => {
    const m = await orchestratorAdapter.detect({ repoDir: prefectDir });
    expect((m!.metadata?.tools as OrchestratorTools).prefect).toBe(true);
  });
  it('detects Airflow via the apache-airflow distribution name', async () => {
    const m = await orchestratorAdapter.detect({ repoDir: airflowDir });
    expect((m!.metadata?.tools as OrchestratorTools).airflow).toBe(true);
  });
  it('detects Temporal (temporalio)', async () => {
    const m = await orchestratorAdapter.detect({ repoDir: temporalDir });
    expect((m!.metadata?.tools as OrchestratorTools).temporal).toBe(true);
  });
  it('raises confidence on a multi-orchestrator repo', async () => {
    const m = await orchestratorAdapter.detect({ repoDir: multiDir });
    expect(m!.confidence).toBeGreaterThan(0.8);
    const tools = m!.metadata?.tools as OrchestratorTools;
    expect(tools.dagster && tools.prefect).toBe(true);
  });
  it('does NOT detect a non-orchestrator Python repo', async () => {
    expect(await orchestratorAdapter.detect({ repoDir: plainPy })).toBeNull();
  });
  it('does NOT detect a TS repo', async () => {
    expect(await orchestratorAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });
  it('detects a NESTED orchestration package and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-orch-nested-'));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'pipelines'), { recursive: true });
    writeFileSync(join(nested, 'pipelines', 'requirements.txt'), 'dagster>=1.7\n');
    try {
      const m = await orchestratorAdapter.detect({ repoDir: nested });
      expect(m!.rootPath).toBe('pipelines');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });
  it('gatherOrchestratorSignals reads deps from disk', () => {
    expect(gatherOrchestratorSignals(airflowDir).tools.airflow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dagster — asset deps (param + deps=) + @op/@job container

describe('orchestrator — Dagster analysis', () => {
  let dir: string;
  let groups: Awaited<ReturnType<NonNullable<typeof orchestratorAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;
  let ctx: FrameworkContext;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-orch-dagster-'));
    write(dir, 'dagster_proj/__init__.py', '');
    write(dir, 'dagster_proj/raw.py', ['from dagster import asset', '@asset', 'def raw_orders():', '    return []'].join('\n'));
    // Param-based dependency: the `raw_orders` param names an upstream asset.
    write(dir, 'dagster_proj/clean.py', ['from dagster import asset', '@asset', 'def cleaned_orders(raw_orders):', '    return raw_orders'].join('\n'));
    // deps=[…] reference to an imported asset function.
    write(dir, 'dagster_proj/report.py', [
      'from dagster import asset',
      'from dagster_proj.clean import cleaned_orders',
      '@asset(deps=[cleaned_orders])',
      'def report():',
      '    return None',
    ].join('\n'));
    // An @op + @job container that calls the op cross-file.
    write(dir, 'dagster_proj/steps.py', ['from dagster import op', '@op', 'def step_one():', '    return 1'].join('\n'));
    write(dir, 'dagster_proj/nightly.py', [
      'from dagster import job',
      'from dagster_proj.steps import step_one',
      '@job',
      'def nightly():',
      '    step_one()',
    ].join('\n'));

    ({ ctx } = await fixtureCtx(dir, { dagster: true }));
    ({ groups } = await orchestratorAdapter.groupingPrior!(ctx));
    edges = await orchestratorAdapter.syntheticEdges!(ctx);
    roles = await orchestratorAdapter.roleTags!(ctx);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags every decorated unit as job (asset/op/job roles)', () => {
    expect(roles.get('dagster_proj/raw.py')).toMatchObject({ role: 'asset', kind: 'job' });
    expect(roles.get('dagster_proj/clean.py')).toMatchObject({ role: 'asset', kind: 'job' });
    expect(roles.get('dagster_proj/steps.py')).toMatchObject({ role: 'op', kind: 'job' });
    expect(roles.get('dagster_proj/nightly.py')).toMatchObject({ role: 'job', kind: 'job' });
    for (const tag of roles.values()) expect(tag.kind).toBe('job');
  });

  it('emits asset-dependency edges (param name + deps=) as calls', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('dagster_proj/raw.py→dagster_proj/clean.py:calls'); // param raw_orders
    expect(keys).toContain('dagster_proj/clean.py→dagster_proj/report.py:calls'); // deps=[cleaned_orders]
  });

  it('emits a @job → imported @op edge and groups the job with its op', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('dagster_proj/nightly.py→dagster_proj/steps.py:calls');
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get('nightly')?.label).toBe('Nightly');
    expect(byId.get('nightly')?.fileIds).toEqual(['dagster_proj/nightly.py', 'dagster_proj/steps.py']);
  });

  it('is deterministic across two runs', async () => {
    const g2 = (await orchestratorAdapter.groupingPrior!(ctx)).groups;
    const e2 = await orchestratorAdapter.syntheticEdges!(ctx);
    const r2 = await orchestratorAdapter.roleTags!(ctx);
    expect(g2).toEqual(groups);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
    expect([...r2.keys()].sort()).toEqual([...roles.keys()].sort());
  });
});

// ---------------------------------------------------------------------------
// Prefect — @flow container calling an imported @task

describe('orchestrator — Prefect analysis', () => {
  let dir: string;
  let groups: Awaited<ReturnType<NonNullable<typeof orchestratorAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-orch-prefect-'));
    write(dir, 'prefect_proj/__init__.py', '');
    write(dir, 'prefect_proj/tasks.py', ['from prefect import task', '@task', 'def extract():', '    return 1'].join('\n'));
    write(dir, 'prefect_proj/flow.py', [
      'from prefect import flow',
      'from prefect_proj.tasks import extract',
      '@flow(name="ETL")',
      'def etl():',
      '    return extract()',
    ].join('\n'));

    const { ctx } = await fixtureCtx(dir, { prefect: true });
    ({ groups } = await orchestratorAdapter.groupingPrior!(ctx));
    edges = await orchestratorAdapter.syntheticEdges!(ctx);
    roles = await orchestratorAdapter.roleTags!(ctx);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags @flow / @task as job', () => {
    expect(roles.get('prefect_proj/flow.py')).toMatchObject({ role: 'flow', kind: 'job' });
    expect(roles.get('prefect_proj/tasks.py')).toMatchObject({ role: 'task', kind: 'job' });
  });

  it('emits a @flow → imported @task edge (calls) and groups them (named by name=)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('prefect_proj/flow.py→prefect_proj/tasks.py:calls');
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get('etl')?.label).toBe('ETL');
    expect(byId.get('etl')?.fileIds).toEqual(['prefect_proj/flow.py', 'prefect_proj/tasks.py']);
  });
});

// ---------------------------------------------------------------------------
// Airflow (TaskFlow) — @dag container, `>>` / `<<` / set_downstream, dags/ dir

describe('orchestrator — Airflow (TaskFlow) analysis', () => {
  let dir: string;
  let groups: Awaited<ReturnType<NonNullable<typeof orchestratorAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;
  let ctx: FrameworkContext;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-orch-airflow-'));
    write(dir, 'airflow_proj/__init__.py', '');
    write(dir, 'airflow_proj/tasks.py', ['from airflow.decorators import task', '@task', 'def notify():', '    return None', '@task', 'def load():', '    return None'].join('\n'));
    write(dir, 'airflow_proj/common.py', ['from airflow.decorators import task', '@task', 'def cleanup():', '    return None', '@task', 'def archive():', '    return None'].join('\n'));
    // A non-container helper under dags/ (no @dag) — the coarse dags-dir group
    // catches it while the @dag definer gets its own semantic subsystem.
    write(dir, 'airflow_proj/dags/config.py', ['DEFAULT_ARGS = {"retries": 1}'].join('\n'));
    write(dir, 'airflow_proj/dags/etl_dag.py', [
      'from airflow.decorators import dag, task',
      'from airflow_proj.tasks import notify, load',
      'from airflow_proj.common import cleanup, archive',
      '@task',
      'def extract():',
      '    return 1',
      '@dag(dag_id="daily_etl")',
      'def pipeline():',
      '    start = extract()',
      '    notify()', // container-call → tasks.py
      '    start >> cleanup', // RS shift → common.py
      '    load << archive', // LS shift: archive upstream of load → common.py → tasks.py
      '    cleanup.set_downstream(load)', // set_downstream → common.py → tasks.py
      'pipeline()',
    ].join('\n'));

    ({ ctx } = await fixtureCtx(dir, { airflow: true }));
    ({ groups } = await orchestratorAdapter.groupingPrior!(ctx));
    edges = await orchestratorAdapter.syntheticEdges!(ctx);
    roles = await orchestratorAdapter.roleTags!(ctx);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags @dag (headline over @task) and @task files as job', () => {
    expect(roles.get('airflow_proj/dags/etl_dag.py')).toMatchObject({ role: 'dag', kind: 'job' });
    expect(roles.get('airflow_proj/tasks.py')).toMatchObject({ role: 'task', kind: 'job' });
    expect(roles.get('airflow_proj/common.py')).toMatchObject({ role: 'task', kind: 'job' });
  });

  it('resolves cross-file task dependencies (container-call, >>, <<, set_downstream)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('airflow_proj/dags/etl_dag.py→airflow_proj/tasks.py:calls'); // notify() call
    expect(keys).toContain('airflow_proj/dags/etl_dag.py→airflow_proj/common.py:calls'); // start >> cleanup
    expect(keys).toContain('airflow_proj/common.py→airflow_proj/tasks.py:calls'); // load << archive + set_downstream
  });

  it('groups the @dag as a subsystem + the dags/ dir as a subsystem', () => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    // The @dag container group, named by dag_id.
    expect(byId.get('daily-etl')?.label).toBe('Daily Etl');
    expect(byId.get('daily-etl')?.fileIds).toContain('airflow_proj/dags/etl_dag.py');
    expect(byId.get('daily-etl')?.fileIds).toContain('airflow_proj/tasks.py'); // notify member
    // The dags/ directory group catches the non-container helper; the @dag definer
    // is excluded (its per-container subsystem wins).
    const dagsGroup = groups.find((g) => g.label.endsWith('DAGs'));
    expect(dagsGroup).toBeDefined();
    expect(dagsGroup!.fileIds).toContain('airflow_proj/dags/config.py');
    expect(dagsGroup!.fileIds).not.toContain('airflow_proj/dags/etl_dag.py');
  });

  it('is deterministic across two runs', async () => {
    const g2 = (await orchestratorAdapter.groupingPrior!(ctx)).groups;
    const e2 = await orchestratorAdapter.syntheticEdges!(ctx);
    expect(g2).toEqual(groups);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
  });
});

// ---------------------------------------------------------------------------
// Temporal — best-effort (@activity.defn function + @workflow.run method)

describe('orchestrator — Temporal analysis (best-effort)', () => {
  let dir: string;
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-orch-temporal-'));
    write(dir, 'temporal_proj/__init__.py', '');
    write(dir, 'temporal_proj/activities.py', ['from temporalio import activity', '@activity.defn', 'async def compose_greeting(name):', '    return name'].join('\n'));
    write(dir, 'temporal_proj/workflow.py', [
      'from temporalio import workflow',
      'from temporal_proj.activities import compose_greeting',
      '@workflow.defn',
      'class GreetingWorkflow:',
      '    @workflow.run',
      '    async def run(self, name):',
      '        return await workflow.execute_activity(compose_greeting, name)',
    ].join('\n'));

    const { ctx } = await fixtureCtx(dir, { temporal: true });
    edges = await orchestratorAdapter.syntheticEdges!(ctx);
    roles = await orchestratorAdapter.roleTags!(ctx);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags @activity.defn and @workflow.run files as job', () => {
    expect(roles.get('temporal_proj/activities.py')).toMatchObject({ role: 'activity', kind: 'job' });
    expect(roles.get('temporal_proj/workflow.py')).toMatchObject({ role: 'workflow', kind: 'job' });
  });

  it('emits a workflow.execute_activity → activity edge (calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('temporal_proj/workflow.py→temporal_proj/activities.py:calls');
  });
});

// ---------------------------------------------------------------------------
// A non-orchestrator Python repo produces no contributions (fallthrough intact).

describe('orchestrator — no-op when no tools are enabled', () => {
  it('emits no roles/edges/groups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bt-orch-none-'));
    write(dir, 'app/main.py', ['def hello():', '    return 1'].join('\n'));
    try {
      const { ctx } = await fixtureCtx(dir, {}); // no tools
      expect((await orchestratorAdapter.roleTags!(ctx)).size).toBe(0);
      expect(await orchestratorAdapter.syntheticEdges!(ctx)).toEqual([]);
      expect((await orchestratorAdapter.groupingPrior!(ctx)).groups).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
