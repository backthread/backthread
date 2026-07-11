// Celery adapter tests.
//
// scoreCelery is pure; detect() runs against real tmp dirs (pyproject +
// requirements, a non-Celery Python no-match + a TS no-match, and a nested
// worker). The analysis hooks run over a real PythonExtractor graph of a small
// STANDALONE Celery worker (NO FastAPI/Flask — proving the extracted adapter
// fires on any celery repo) exercising the extracted  behavior (shared_task
// / cross-file @app.task / .delay enqueue) AND the deepening (Beat schedules,
// @periodic_task, chain/group/chord canvas). Assertions are in the file-id space
// the contribute-step resolves to modules downstream.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  celeryAdapter,
  scoreCelery,
  gatherCelerySignals,
  type CelerySignals,
} from './celery.js';
import { PythonExtractor } from '../../graph/python-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: CelerySignals = { hasCelery: false, hasCeleryExtension: false };

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// scoreCelery (pure)

describe('scoreCelery (pure)', () => {
  it('returns null with no celery dep (generic-Python fallthrough)', () => {
    expect(scoreCelery(NO_SIGNALS)).toBeNull();
    // A celery-* extension alone (no celery) is NOT a Celery match.
    expect(scoreCelery({ hasCelery: false, hasCeleryExtension: true })).toBeNull();
  });

  it('detects Celery on the celery dep', () => {
    const m = scoreCelery({ ...NO_SIGNALS, hasCelery: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('celery');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('raises confidence with a beat/monitoring extension', () => {
    const m = scoreCelery({ hasCelery: true, hasCeleryExtension: true });
    expect(m!.confidence).toBeGreaterThan(0.8);
    expect((m!.metadata?.signals as Record<string, boolean>).celeryExtension).toBe(true);
  });

  it('passes rootPath through', () => {
    const m = scoreCelery({ ...NO_SIGNALS, hasCelery: true }, 'worker');
    expect(m!.rootPath).toBe('worker');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('celeryAdapter.detect (fs fixtures)', () => {
  let pyproject: string;
  let requirements: string;
  let plainPy: string;
  let tsRepo: string;

  beforeAll(() => {
    pyproject = mkdtempSync(join(tmpdir(), 'bt-celery-toml-'));
    writeFileSync(
      join(pyproject, 'pyproject.toml'),
      [
        '[project]',
        'name = "worker"',
        'dependencies = [',
        '  "celery[redis]>=5.3",', // the [redis] extra must not defeat the name match
        '  "redis>=5",',
        ']',
      ].join('\n'),
    );

    requirements = mkdtempSync(join(tmpdir(), 'bt-celery-req-'));
    writeFileSync(
      join(requirements, 'requirements.txt'),
      ['# worker deps', 'celery==5.3.6', 'django-celery-beat==2.6.0', 'redis'].join('\n'),
    );

    plainPy = mkdtempSync(join(tmpdir(), 'bt-celery-plain-'));
    writeFileSync(join(plainPy, 'pyproject.toml'), '[project]\nname = "x"\ndependencies = ["requests>=2", "click"]\n');

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-celery-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [pyproject, requirements, plainPy, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects Celery from pyproject PEP 621 dependencies (celery[redis] extra stripped)', async () => {
    const m = await celeryAdapter.detect({ repoDir: pyproject });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('celery');
  });

  it('detects Celery from requirements.txt (django-celery-beat bumps confidence)', async () => {
    const m = await celeryAdapter.detect({ repoDir: requirements });
    expect(m).not.toBeNull();
    expect(m!.confidence).toBeGreaterThan(0.8);
    expect((m!.metadata?.signals as Record<string, boolean>).celeryExtension).toBe(true);
  });

  it('does NOT detect a non-Celery Python repo', async () => {
    expect(await celeryAdapter.detect({ repoDir: plainPy })).toBeNull();
  });

  it('does NOT detect a TS repo (no Python manifest)', async () => {
    expect(await celeryAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED Celery worker and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-celery-nested-'));
    // A frontend+worker monorepo: no root Python manifest; celery under worker/.
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'worker'), { recursive: true });
    writeFileSync(join(nested, 'worker', 'requirements.txt'), 'celery>=5.3\n');
    try {
      const m = await celeryAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('worker');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherCelerySignals reads deps from disk', () => {
    const s = gatherCelerySignals(requirements);
    expect(s.hasCelery).toBe(true);
    expect(s.hasCeleryExtension).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real STANDALONE Celery worker fixture

describe('celeryAdapter analysis (syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  // A fresh ctx OBJECT each call so the WeakMap analysis cache misses → the
  // determinism test re-derives from scratch (not a cache echo).
  const freshCtx = (): FrameworkContext => ({
    repoDir: dir,
    rootPath: '',
    match: { adapter: 'celery', confidence: 1, rootPath: '' },
    graph,
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-celery-app-'));
    // The Celery app + a Beat schedule (references a task by dotted name), plus a
    // second schedule via the `app.conf.update(beat_schedule=…)` kwarg form.
    write(dir, 'proj/celery_app.py', [
      'from celery import Celery',
      'app = Celery("proj")',
      'app.conf.beat_schedule = {',
      '    "nightly-report": {"task": "proj.tasks.reports.build_report", "schedule": 3600.0},',
      '}',
      'app.conf.update(beat_schedule={',
      '    "hourly-cleanup": {"task": "proj.tasks.cleanup.purge", "schedule": 3600.0},',
      '})',
    ].join('\n'));
    // A bare @shared_task worker.
    write(dir, 'proj/tasks/ingest.py', [
      'from celery import shared_task',
      '@shared_task',
      'def process_import(x):',
      '    return x',
    ].join('\n'));
    // The cross-file @app.task layout: Celery() app in one module, task in another.
    write(dir, 'proj/tasks/emails.py', [
      'from proj.celery_app import app',
      '@app.task',
      'def send_welcome(uid):',
      '    return uid',
    ].join('\n'));
    // A task that is ALSO a beat target → scheduled-task must win over plain task.
    write(dir, 'proj/tasks/reports.py', [
      'from celery import shared_task',
      '@shared_task',
      'def build_report():',
      '    return "ok"',
    ].join('\n'));
    // A legacy @periodic_task → scheduled-task.
    write(dir, 'proj/tasks/periodic.py', [
      'from celery.decorators import periodic_task',
      '@periodic_task(run_every=60)',
      'def heartbeat():',
      '    return "beat"',
    ].join('\n'));
    // A task referenced only by the update(beat_schedule=…) form → scheduled-task.
    write(dir, 'proj/tasks/cleanup.py', [
      'from celery import shared_task',
      '@shared_task',
      'def purge():',
      '    return "purged"',
    ].join('\n'));
    // Enqueue call sites: .delay and .apply_async.
    write(dir, 'proj/services/importer.py', [
      'from proj.tasks.ingest import process_import',
      'def kick_off(x):',
      '    process_import.delay(x)',
    ].join('\n'));
    write(dir, 'proj/services/mailer.py', [
      'from proj.tasks.emails import send_welcome',
      'def notify(uid):',
      '    send_welcome.apply_async(args=[uid])',
    ].join('\n'));
    // Canvas composition: chain (sequential) + chord (header→callback).
    write(dir, 'proj/workflows/pipeline.py', [
      'from celery import chain, chord, group',
      'from proj.tasks.ingest import process_import',
      'from proj.tasks.reports import build_report',
      'from proj.tasks.emails import send_welcome',
      'def run_pipeline(x):',
      '    chain(process_import.s(x), build_report.s()).apply_async()',
      '    chord(group(process_import.s(x), build_report.s()), send_welcome.s()).apply_async()',
    ].join('\n'));
    // An ALIASED canvas import — `chain as celery_chain` must still resolve.
    write(dir, 'proj/workflows/aliased.py', [
      'from celery import chain as celery_chain',
      'from proj.tasks.cleanup import purge',
      'from proj.tasks.reports import build_report',
      'def run_cleanup():',
      '    celery_chain(purge.s(), build_report.s()).apply_async()',
    ].join('\n'));
    // A NON-celery itertools.chain — the import gate must keep it out of the graph.
    write(dir, 'proj/util/batch.py', [
      'from itertools import chain',
      'def flatten(xss):',
      '    return list(chain(*xss))',
    ].join('\n'));

    graph = await new PythonExtractor().extract(dir);
    const ctx = freshCtx();
    edges = await celeryAdapter.syntheticEdges!(ctx);
    roles = await celeryAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags tasks + scheduled-tasks onto the locked job kind', () => {
    // A bare @shared_task and a cross-file @app.task are both tasks → job.
    expect(roles.get('proj/tasks/ingest.py')).toMatchObject({ role: 'task', kind: 'job' });
    expect(roles.get('proj/tasks/emails.py')).toMatchObject({ role: 'task', kind: 'job' });
    // A @periodic_task and a beat-scheduled task are scheduled-tasks → job.
    expect(roles.get('proj/tasks/periodic.py')).toMatchObject({ role: 'scheduled-task', kind: 'job' });
    // reports.py is a @shared_task AND a beat target — scheduled-task wins (priority).
    expect(roles.get('proj/tasks/reports.py')).toMatchObject({ role: 'scheduled-task', kind: 'job' });
    // cleanup.py is scheduled only via the update(beat_schedule=…) kwarg form.
    expect(roles.get('proj/tasks/cleanup.py')).toMatchObject({ role: 'scheduled-task', kind: 'job' });
    // The Celery() app config file itself is not own-code — no role.
    expect(roles.get('proj/celery_app.py')).toBeUndefined();
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('emits .delay / .apply_async enqueue edges (kind publishes, not a plain call)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('proj/services/importer.py→proj/tasks/ingest.py:publishes');
    expect(keys).toContain('proj/services/mailer.py→proj/tasks/emails.py:publishes');
  });

  it('emits Beat schedule → task edges from both the assignment and update() kwarg forms', () => {
    const keys = new Set(edges.map(edgeKey));
    // `app.conf.beat_schedule = {…}` (assignment) → reports.
    expect(keys).toContain('proj/celery_app.py→proj/tasks/reports.py:publishes');
    // `app.conf.update(beat_schedule={…})` (kwarg) → cleanup.
    expect(keys).toContain('proj/celery_app.py→proj/tasks/cleanup.py:publishes');
  });

  it('emits chain() sequential + chord() header→callback composition edges', () => {
    const keys = new Set(edges.map(edgeKey));
    // chain(process_import.s, build_report.s) → ingest → reports.
    expect(keys).toContain('proj/tasks/ingest.py→proj/tasks/reports.py:publishes');
    // chord(group(process_import.s, build_report.s), send_welcome.s) → each header → callback.
    expect(keys).toContain('proj/tasks/ingest.py→proj/tasks/emails.py:publishes');
    expect(keys).toContain('proj/tasks/reports.py→proj/tasks/emails.py:publishes');
  });

  it('resolves an ALIASED canvas import (chain as celery_chain → task→task edge)', () => {
    const keys = new Set(edges.map(edgeKey));
    // celery_chain(purge.s(), build_report.s()) → cleanup → reports.
    expect(keys).toContain('proj/tasks/cleanup.py→proj/tasks/reports.py:publishes');
  });

  it('does NOT treat a non-celery itertools.chain as a canvas (import-gated)', () => {
    // batch.py imports chain from itertools — no edge, no role, must never appear.
    expect(edges.some((e) => e.source === 'proj/util/batch.py' || e.target === 'proj/util/batch.py')).toBe(false);
    expect(roles.get('proj/util/batch.py')).toBeUndefined();
  });

  it('every synthetic edge is an 8-verb publishes with the celery framework tag', () => {
    for (const e of edges) {
      expect(e.kind).toBe('publishes');
      expect((e.metadata as Record<string, unknown>).framework).toBe('celery');
    }
  });

  it('is deterministic across two independent runs (fresh ctx → re-derived, byte-identical)', async () => {
    const ctx2 = freshCtx();
    const e2 = await celeryAdapter.syntheticEdges!(ctx2);
    const r2 = await celeryAdapter.roleTags!(ctx2);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
    expect([...r2.entries()].map(([k, v]) => `${k}:${v.role}`).sort()).toEqual(
      [...roles.entries()].map(([k, v]) => `${k}:${v.role}`).sort(),
    );
  });
});
