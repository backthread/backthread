// Flask adapter tests.
//
// scoreFlask is pure; detect() runs against real tmp dirs (pyproject +
// requirements, a non-Flask Python no-match + a TS no-match, and a nested
// backend). The analysis hooks run over a real PythonExtractor graph of a small
// Flask fixture (app + blueprints + routes + CLI + add_url_rule) and assert the
// file-id-space contributions (the contribute-step resolves those to modules
// downstream; that resolution is covered by contribute-step.test.ts).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  flaskAdapter,
  scoreFlask,
  gatherFlaskSignals,
  type FlaskSignals,
} from './flask.js';
import { PythonExtractor } from '../../graph/python-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: FlaskSignals = { hasFlask: false, hasFlaskExtension: false };

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// scoreFlask (pure)

describe('scoreFlask (pure)', () => {
  it('returns null with no flask dep (generic-Python fallthrough)', () => {
    expect(scoreFlask(NO_SIGNALS)).toBeNull();
    // A flask-* extension alone (no flask) is NOT a Flask match.
    expect(scoreFlask({ hasFlask: false, hasFlaskExtension: true })).toBeNull();
  });

  it('detects Flask on the flask dep', () => {
    const m = scoreFlask({ ...NO_SIGNALS, hasFlask: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('flask');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('raises confidence with a flask-* extension', () => {
    const m = scoreFlask({ hasFlask: true, hasFlaskExtension: true });
    expect(m!.confidence).toBeGreaterThan(0.8);
    expect((m!.metadata?.signals as Record<string, boolean>).flaskExtension).toBe(true);
  });

  it('passes rootPath through', () => {
    const m = scoreFlask({ ...NO_SIGNALS, hasFlask: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real manifests

describe('flaskAdapter.detect (fs fixtures)', () => {
  let pyproject: string;
  let requirements: string;
  let plainPy: string;
  let tsRepo: string;

  beforeAll(() => {
    pyproject = mkdtempSync(join(tmpdir(), 'bt-flask-toml-'));
    writeFileSync(
      join(pyproject, 'pyproject.toml'),
      [
        '[project]',
        'name = "svc"',
        'dependencies = [',
        '  "flask>=3.0",',
        '  "flask-sqlalchemy>=3.1",',
        ']',
      ].join('\n'),
    );

    requirements = mkdtempSync(join(tmpdir(), 'bt-flask-req-'));
    writeFileSync(
      join(requirements, 'requirements.txt'),
      ['# app deps', 'Flask==3.0.0', 'Flask-Login==0.6.3', 'gunicorn'].join('\n'),
    );

    plainPy = mkdtempSync(join(tmpdir(), 'bt-flask-plain-'));
    writeFileSync(join(plainPy, 'pyproject.toml'), '[project]\nname = "x"\ndependencies = ["requests>=2", "click"]\n');

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-flask-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [pyproject, requirements, plainPy, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects Flask from pyproject PEP 621 dependencies (extension bumps confidence)', async () => {
    const m = await flaskAdapter.detect({ repoDir: pyproject });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('flask');
    expect(m!.confidence).toBeGreaterThan(0.8);
  });

  it('detects Flask from requirements.txt', async () => {
    const m = await flaskAdapter.detect({ repoDir: requirements });
    expect(m).not.toBeNull();
    expect((m!.metadata?.signals as Record<string, boolean>).flaskExtension).toBe(true);
  });

  it('does NOT detect a non-Flask Python repo', async () => {
    expect(await flaskAdapter.detect({ repoDir: plainPy })).toBeNull();
  });

  it('does NOT detect a TS repo (no Python manifest)', async () => {
    expect(await flaskAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED Flask backend and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-flask-nested-'));
    // A frontend+backend monorepo: no root Python manifest; flask under backend/.
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'requirements.txt'), 'flask>=3.0\n');
    try {
      const m = await flaskAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherFlaskSignals reads deps from disk', () => {
    const s = gatherFlaskSignals(requirements);
    expect(s.hasFlask).toBe(true);
    expect(s.hasFlaskExtension).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real Flask fixture

describe('flaskAdapter analysis (groupingPrior / syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let groups: Awaited<ReturnType<NonNullable<typeof flaskAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-flask-app-'));
    // The Flask app entry: registers two blueprints + binds two cross-file views.
    write(dir, 'app/__init__.py', [
      'from flask import Flask',
      'from app.views.legacy import legacy_view',
      'from app.views.item import ItemView',
      'app = Flask(__name__)',
      'from app.auth import bp as auth_bp',
      "app.register_blueprint(auth_bp, url_prefix='/auth')",
      'from app.api import bp as api_bp',
      'app.register_blueprint(api_bp)',
      "app.add_url_rule('/legacy', 'legacy', view_func=legacy_view)",
      "app.add_url_rule('/item', view_func=ItemView.as_view('item'))",
    ].join('\n'));
    // Auth blueprint: definer + a routes module that decorates it.
    write(dir, 'app/auth/__init__.py', [
      'from flask import Blueprint',
      "bp = Blueprint('auth', __name__)",
      'from app.auth import routes',
    ].join('\n'));
    write(dir, 'app/auth/routes.py', [
      'from app.auth import bp',
      "@bp.route('/login', methods=['GET', 'POST'])",
      'def login():',
      "    return ''",
      "@bp.get('/me')", // the Flask 2.0 HTTP shortcut must register too
      'def me():',
      "    return ''",
    ].join('\n'));
    // Api blueprint: definer + routes.
    write(dir, 'app/api/__init__.py', [
      'from flask import Blueprint',
      "bp = Blueprint('api', __name__)",
      'from app.api import users',
    ].join('\n'));
    write(dir, 'app/api/users.py', [
      'from app.api import bp',
      "@bp.route('/users')",
      'def users():',
      '    return []',
    ].join('\n'));
    // A CLI command bound to the IMPORTED app object (the app-level CLI form).
    write(dir, 'app/commands.py', [
      'from app import app',
      "@app.cli.command('init-db')",
      'def init_db():',
      '    pass',
    ].join('\n'));
    // The cross-file view targets of add_url_rule.
    write(dir, 'app/views/legacy.py', ['def legacy_view():', "    return 'ok'"].join('\n'));
    write(dir, 'app/views/item.py', ['class ItemView:', '    pass'].join('\n'));

    graph = await new PythonExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'flask', confidence: 1, rootPath: '' },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    ({ groups } = await flaskAdapter.groupingPrior!(ctx));
    edges = await flaskAdapter.syntheticEdges!(ctx);
    roles = await flaskAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('tags roles onto locked MODULE_KINDS (gateway for app/blueprint/route, job for cli)', () => {
    expect(roles.get('app/__init__.py')).toMatchObject({ role: 'app', kind: 'gateway' });
    expect(roles.get('app/auth/__init__.py')).toMatchObject({ role: 'blueprint', kind: 'gateway' });
    expect(roles.get('app/auth/routes.py')).toMatchObject({ role: 'route-handler', kind: 'gateway' });
    expect(roles.get('app/api/__init__.py')).toMatchObject({ role: 'blueprint', kind: 'gateway' });
    expect(roles.get('app/api/users.py')).toMatchObject({ role: 'route-handler', kind: 'gateway' });
    // A CLI command on the imported app object → job.
    expect(roles.get('app/commands.py')).toMatchObject({ role: 'cli-command', kind: 'job' });
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('groups each Blueprint into its own named subsystem (definer + route files)', () => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get('auth')?.label).toBe('Auth');
    expect(byId.get('auth')?.fileIds).toEqual(['app/auth/__init__.py', 'app/auth/routes.py']);
    expect(byId.get('api')?.label).toBe('Api');
    expect(byId.get('api')?.fileIds).toEqual(['app/api/__init__.py', 'app/api/users.py']);
  });

  it('emits app.register_blueprint mounting edges (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('app/__init__.py→app/auth/__init__.py:calls');
    expect(keys).toContain('app/__init__.py→app/api/__init__.py:calls');
  });

  it('emits add_url_rule view-binding edges to cross-file views (view_func + as_view)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('app/__init__.py→app/views/legacy.py:calls'); // view_func=legacy_view
    expect(keys).toContain('app/__init__.py→app/views/item.py:calls'); // view_func=ItemView.as_view(...)
  });

  it('does NOT turn a same-file @bp.route decorator into an edge', () => {
    // routes.py decorates its own imported bp — that's the ROLE, never an edge.
    expect(edges.some((e) => e.source === 'app/auth/routes.py')).toBe(false);
    expect(edges.some((e) => e.source === 'app/api/users.py')).toBe(false);
  });

  it('is deterministic across two runs (stable ids + ordering)', async () => {
    const g2 = (await flaskAdapter.groupingPrior!(ctx)).groups;
    const e2 = await flaskAdapter.syntheticEdges!(ctx);
    const r2 = await flaskAdapter.roleTags!(ctx);
    expect(g2).toEqual(groups);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
    expect([...r2.keys()].sort()).toEqual([...roles.keys()].sort());
  });
});
