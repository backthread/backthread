// Django adapter tests.
//
// scoreDjango is pure; detect() runs against real tmp dirs (pyproject +
// requirements + a dep-free manage.py/settings match + a non-Django Python
// no-match + a TS no-match + a nested backend). The analysis hooks run over a real
// PythonExtractor graph of a small Django + DRF + Ninja + signals fixture and
// assert the file-id-space contributions (the contribute-step resolves those to
// modules downstream; that resolution is covered by contribute-step.test.ts).

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  djangoAdapter,
  scoreDjango,
  gatherDjangoSignals,
  type DjangoSignals,
} from './django.js';
import { PythonExtractor } from '../../graph/python-adapter.js';
import type { FrameworkContext, FrameworkEdge, RoleTag } from '../types.js';
import type { NormalizedGraph } from '../../graph/types.js';

const NO_SIGNALS: DjangoSignals = {
  hasDjango: false,
  hasDrf: false,
  hasNinja: false,
  hasManagePy: false,
  hasSettings: false,
};

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// scoreDjango (pure)

describe('scoreDjango (pure)', () => {
  it('returns null with no signal (generic-Python fallthrough)', () => {
    expect(scoreDjango(NO_SIGNALS)).toBeNull();
    // manage.py alone (no settings, no dep) is NOT sufficient.
    expect(scoreDjango({ ...NO_SIGNALS, hasManagePy: true })).toBeNull();
    // settings alone is not either.
    expect(scoreDjango({ ...NO_SIGNALS, hasSettings: true })).toBeNull();
  });

  it('detects Django on the django dep', () => {
    const m = scoreDjango({ ...NO_SIGNALS, hasDjango: true });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('django');
    expect(m!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(m!.metadata?.drf).toBe(false);
    expect(m!.metadata?.ninja).toBe(false);
  });

  it('raises confidence with manage.py + DRF/Ninja and records them in metadata', () => {
    const m = scoreDjango({ hasDjango: true, hasDrf: true, hasNinja: false, hasManagePy: true, hasSettings: true });
    expect(m!.confidence).toBeGreaterThan(0.85);
    expect(m!.metadata?.drf).toBe(true);
  });

  it('detects a dep-free project via manage.py + settings (lower confidence)', () => {
    const m = scoreDjango({ ...NO_SIGNALS, hasManagePy: true, hasSettings: true });
    expect(m).not.toBeNull();
    expect(m!.confidence).toBeCloseTo(0.7);
  });

  it('passes rootPath through', () => {
    const m = scoreDjango({ ...NO_SIGNALS, hasDjango: true }, 'backend');
    expect(m!.rootPath).toBe('backend');
  });
});

// ---------------------------------------------------------------------------
// detect() over real fixtures

describe('djangoAdapter.detect (fs fixtures)', () => {
  let pyproject: string;
  let requirements: string;
  let depFree: string;
  let plainPy: string;
  let tsRepo: string;

  beforeAll(() => {
    pyproject = mkdtempSync(join(tmpdir(), 'bt-django-toml-'));
    writeFileSync(
      join(pyproject, 'pyproject.toml'),
      ['[project]', 'name = "svc"', 'dependencies = [', '  "Django>=5.0",', '  "psycopg2",', ']'].join('\n'),
    );

    requirements = mkdtempSync(join(tmpdir(), 'bt-django-req-'));
    writeFileSync(
      join(requirements, 'requirements.txt'),
      ['# app deps', 'django==5.0.6', 'djangorestframework>=3.15', 'django-ninja>=1.0'].join('\n'),
    );
    writeFileSync(join(requirements, 'manage.py'), '# django launcher\n');

    // Dep-free: no manifest naming django, but manage.py + a settings module.
    depFree = mkdtempSync(join(tmpdir(), 'bt-django-depfree-'));
    writeFileSync(join(depFree, 'manage.py'), '# django launcher\n');
    mkdirSync(join(depFree, 'proj'), { recursive: true });
    writeFileSync(join(depFree, 'proj', 'settings.py'), 'DEBUG = True\n');

    plainPy = mkdtempSync(join(tmpdir(), 'bt-django-plain-'));
    writeFileSync(join(plainPy, 'pyproject.toml'), '[project]\nname = "x"\ndependencies = ["requests>=2", "click"]\n');

    tsRepo = mkdtempSync(join(tmpdir(), 'bt-django-ts-'));
    writeFileSync(join(tsRepo, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '18' } }));
  });

  afterAll(() => {
    for (const d of [pyproject, requirements, depFree, plainPy, tsRepo]) rmSync(d, { recursive: true, force: true });
  });

  it('detects Django from pyproject PEP 621 dependencies', async () => {
    const m = await djangoAdapter.detect({ repoDir: pyproject });
    expect(m).not.toBeNull();
    expect(m!.adapter).toBe('django');
    expect(m!.metadata?.drf).toBe(false);
  });

  it('detects Django from requirements.txt (and DRF + Ninja)', async () => {
    const m = await djangoAdapter.detect({ repoDir: requirements });
    expect(m).not.toBeNull();
    expect(m!.metadata?.drf).toBe(true);
    expect(m!.metadata?.ninja).toBe(true);
  });

  it('detects a dep-free project via manage.py + settings module', async () => {
    const m = await djangoAdapter.detect({ repoDir: depFree });
    expect(m).not.toBeNull();
    expect(m!.confidence).toBeCloseTo(0.7);
  });

  it('does NOT detect a non-Django Python repo', async () => {
    expect(await djangoAdapter.detect({ repoDir: plainPy })).toBeNull();
  });

  it('does NOT detect a TS repo (no Python manifest / manage.py)', async () => {
    expect(await djangoAdapter.detect({ repoDir: tsRepo })).toBeNull();
  });

  it('detects a NESTED Django backend and scopes rootPath to it', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'bt-django-nested-'));
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'web' }));
    mkdirSync(join(nested, 'backend'), { recursive: true });
    writeFileSync(join(nested, 'backend', 'requirements.txt'), 'django>=5\n');
    try {
      const m = await djangoAdapter.detect({ repoDir: nested });
      expect(m).not.toBeNull();
      expect(m!.rootPath).toBe('backend');
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('gatherDjangoSignals reads deps + file existence from disk', () => {
    const s = gatherDjangoSignals(requirements);
    expect(s.hasDjango).toBe(true);
    expect(s.hasDrf).toBe(true);
    expect(s.hasNinja).toBe(true);
    expect(s.hasManagePy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Analysis hooks over a real Django + DRF + Ninja + signals fixture

describe('djangoAdapter analysis (groupingPrior / syntheticEdges / roleTags)', () => {
  let dir: string;
  let graph: NormalizedGraph;
  let ctx: FrameworkContext;
  let groups: Awaited<ReturnType<NonNullable<typeof djangoAdapter.groupingPrior>>>['groups'];
  let edges: FrameworkEdge[];
  let roles: Map<string, RoleTag>;

  const edgeKey = (e: FrameworkEdge) => `${e.source}→${e.target}:${e.kind}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bt-django-app-'));

    // Project config package (NOT an app — no apps.py/models.py).
    write(dir, 'mysite/__init__.py', '');
    write(dir, 'mysite/settings.py', "INSTALLED_APPS = ['users', 'orders', 'api']\n");
    write(dir, 'mysite/urls.py', [
      'from django.urls import path, include',
      'urlpatterns = [',
      "    path('users/', include('users.urls')),",
      "    path('orders/', include('orders.urls')),",
      "    path('api/', include(('api.urls', 'api'))),", // tuple (app-namespacing) form

      ']',
    ].join('\n'));

    // users app — AppConfig w/ verbose_name, a model, a class-based view.
    write(dir, 'users/__init__.py', '');
    write(dir, 'users/apps.py', [
      'from django.apps import AppConfig',
      'class UsersConfig(AppConfig):',
      "    name = 'users'",
      "    verbose_name = 'User Accounts'",
    ].join('\n'));
    write(dir, 'users/models.py', [
      'from django.db import models',
      'class User(models.Model):',
      '    name = models.CharField(max_length=100)',
    ].join('\n'));
    write(dir, 'users/views.py', [
      'from django.views.generic import ListView',
      'from users.models import User',
      'class UserListView(ListView):',
      '    model = User',
      'def profile(request):',
      '    return None',
    ].join('\n'));
    write(dir, 'users/urls.py', [
      'from django.urls import path',
      'from users import views',
      'urlpatterns = [',
      "    path('', views.UserListView.as_view()),",
      "    path('me/', views.profile),",
      ']',
    ].join('\n'));

    // orders app — a model with a cross-app FK + a same-app string FK, a function
    // view, a management command, a custom Signal + receivers + a send site.
    write(dir, 'orders/__init__.py', '');
    write(dir, 'orders/apps.py', [
      'from django.apps import AppConfig',
      'class OrdersConfig(AppConfig):',
      "    name = 'orders'",
    ].join('\n'));
    write(dir, 'orders/models.py', [
      'from django.db import models',
      'from users.models import User',
      'class Order(models.Model):',
      '    buyer = models.ForeignKey(User, on_delete=models.CASCADE)',
      "    parent = models.ForeignKey('Order', null=True, on_delete=models.CASCADE)",
    ].join('\n'));
    write(dir, 'orders/views.py', [
      'from django.http import JsonResponse',
      'from orders.models import Order',
      'def list_orders(request):',
      '    return JsonResponse({})',
    ].join('\n'));
    write(dir, 'orders/urls.py', [
      'from django.urls import path',
      'from orders import views',
      "urlpatterns = [path('', views.list_orders)]",
    ].join('\n'));
    write(dir, 'orders/signals.py', ['from django.dispatch import Signal', 'order_shipped = Signal()'].join('\n'));
    write(dir, 'orders/receivers.py', [
      'from django.dispatch import receiver',
      'from django.db.models.signals import post_save',
      'from orders.signals import order_shipped',
      'from orders.models import Order',
      '@receiver(order_shipped)',
      'def on_shipped(sender, **kwargs):',
      '    return None',
      '@receiver(post_save, sender=Order)',
      'def on_order_save(sender, **kwargs):',
      '    return None',
    ].join('\n'));
    write(dir, 'orders/emit.py', [
      'from orders.signals import order_shipped',
      'def ship():',
      '    order_shipped.send(sender=None)',
    ].join('\n'));
    write(dir, 'orders/management/__init__.py', '');
    write(dir, 'orders/management/commands/__init__.py', '');
    write(dir, 'orders/management/commands/process_orders.py', [
      'from django.core.management.base import BaseCommand',
      'class Command(BaseCommand):',
      '    def handle(self, *args, **options):',
      '        pass',
    ].join('\n'));

    // api package — DRF router registering a ViewSet + a serializer (NOT a model).
    write(dir, 'api/__init__.py', '');
    write(dir, 'api/serializers.py', [
      'from rest_framework import serializers',
      'class OrderSerializer(serializers.ModelSerializer):',
      '    pass',
    ].join('\n'));
    write(dir, 'api/viewsets.py', [
      'from rest_framework.viewsets import ModelViewSet',
      'from orders.models import Order',
      'class OrderViewSet(ModelViewSet):',
      '    queryset = Order.objects.all()',
    ].join('\n'));
    write(dir, 'api/urls.py', [
      'from rest_framework.routers import DefaultRouter',
      'from api.viewsets import OrderViewSet',
      'router = DefaultRouter()',
      "router.register('orders', OrderViewSet)",
      'urlpatterns = router.urls',
    ].join('\n'));

    // Django-Ninja router with an operation decorator.
    write(dir, 'ninja_app/__init__.py', '');
    write(dir, 'ninja_app/api.py', [
      'from ninja import Router',
      'router = Router()',
      "@router.get('/ping')",
      'def ping(request):',
      "    return {'ok': True}",
    ].join('\n'));

    graph = await new PythonExtractor().extract(dir);
    ctx = {
      repoDir: dir,
      rootPath: '',
      match: { adapter: 'django', confidence: 1, rootPath: '', metadata: { drf: true, ninja: true } },
      graph,
      cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
    };
    ({ groups } = await djangoAdapter.groupingPrior!(ctx));
    edges = await djangoAdapter.syntheticEdges!(ctx);
    roles = await djangoAdapter.roleTags!(ctx);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('groups each Django app into its own named subsystem (the headline)', () => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    // users app labelled from its AppConfig verbose_name; orders from the dir name.
    expect(byId.get('users')?.label).toBe('User Accounts');
    expect(byId.get('orders')?.label).toBe('Orders');
    // The app owns every file under it (incl. the nested management command).
    expect(byId.get('users')?.fileIds).toEqual(expect.arrayContaining(['users/models.py', 'users/apps.py', 'users/views.py', 'users/urls.py']));
    expect(byId.get('orders')?.fileIds).toEqual(
      expect.arrayContaining(['orders/models.py', 'orders/management/commands/process_orders.py', 'orders/signals.py']),
    );
    // The project-config package + the non-app api/ninja packages are NOT apps.
    expect(byId.has('mysite')).toBe(false);
    expect(byId.has('api')).toBe(false);
    expect(byId.has('ninja-app')).toBe(false);
  });

  it('tags roles onto locked MODULE_KINDS (gateway/service/job)', () => {
    expect(roles.get('users/models.py')).toMatchObject({ role: 'model', kind: 'service' });
    expect(roles.get('orders/models.py')).toMatchObject({ role: 'model', kind: 'service' });
    expect(roles.get('users/views.py')).toMatchObject({ role: 'view', kind: 'gateway' });
    expect(roles.get('orders/views.py')).toMatchObject({ role: 'view', kind: 'gateway' });
    expect(roles.get('api/viewsets.py')).toMatchObject({ role: 'view', kind: 'gateway' }); // DRF ViewSet
    expect(roles.get('ninja_app/api.py')).toMatchObject({ role: 'view', kind: 'gateway' }); // Ninja op
    expect(roles.get('orders/management/commands/process_orders.py')).toMatchObject({ role: 'command', kind: 'job' });
    expect(roles.get('users/apps.py')).toMatchObject({ role: 'app-config', kind: 'service' });
    // A DRF serializer is neither a model nor a view — no role (no false positive).
    expect(roles.get('api/serializers.py')).toBeUndefined();
    // Every role kind is a locked value — never a new Module-kind.
    for (const tag of roles.values()) {
      expect(['gateway', 'service', 'job']).toContain(tag.kind);
    }
  });

  it('emits URLconf route + include edges (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('mysite/urls.py→users/urls.py:calls'); // include('users.urls')
    expect(keys).toContain('mysite/urls.py→orders/urls.py:calls');
    expect(keys).toContain('mysite/urls.py→api/urls.py:calls');
    expect(keys).toContain('users/urls.py→users/views.py:calls'); // path(..., views.X.as_view())
    expect(keys).toContain('orders/urls.py→orders/views.py:calls');
  });

  it('emits model relationship edges between model modules (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    // Order.buyer = ForeignKey(User) → the two model modules.
    expect(keys).toContain('orders/models.py→users/models.py:calls');
    // Order.parent = ForeignKey('Order') is a self-reference → no self-edge.
    expect(keys).not.toContain('orders/models.py→orders/models.py:calls');
  });

  it('emits a DRF router.register(viewset) edge (kind calls)', () => {
    const keys = new Set(edges.map(edgeKey));
    expect(keys).toContain('api/urls.py→api/viewsets.py:calls');
  });

  it('emits Django signal pub/sub edges', () => {
    const keys = new Set(edges.map(edgeKey));
    // @receiver(order_shipped) → subscribes to the first-party Signal module.
    expect(keys).toContain('orders/receivers.py→orders/signals.py:subscribes');
    // order_shipped.send(...) → publishes to the Signal module.
    expect(keys).toContain('orders/emit.py→orders/signals.py:publishes');
    // @receiver(post_save, sender=Order) → the Order model publishes to the receiver.
    expect(keys).toContain('orders/models.py→orders/receivers.py:publishes');
  });

  it('emits only 8-verb edge kinds', () => {
    const allowed = new Set(['calls', 'reads', 'writes', 'publishes', 'subscribes', 'webhook-from', 'deploys-to', 'stores-in']);
    for (const e of edges) expect(allowed).toContain(e.kind);
  });

  it('is deterministic across two runs (stable ids + ordering)', async () => {
    const g2 = (await djangoAdapter.groupingPrior!(ctx)).groups;
    const e2 = await djangoAdapter.syntheticEdges!(ctx);
    const r2 = await djangoAdapter.roleTags!(ctx);
    expect(g2).toEqual(groups);
    expect(e2.map(edgeKey)).toEqual(edges.map(edgeKey));
    expect([...r2.keys()].sort()).toEqual([...roles.keys()].sort());
  });
});
