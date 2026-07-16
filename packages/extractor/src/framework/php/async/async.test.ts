// The async adapter — Laravel Queues + Symfony Messenger jobs/handlers + dispatch edges.

import { describe, it, expect, afterEach } from '../../../testkit.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { asyncAdapter, gatherAsyncSignals, scoreAsync } from './async.js';
import type { FrameworkContext, FrameworkDetectContext } from '../../types.js';
import type { NormalizedGraph } from '../../../graph/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function asyncRepo(files: Record<string, string>): Promise<FrameworkContext> {
  const dir = await mkdtemp(join(tmpdir(), 'bt-php-async-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const graph: NormalizedGraph = {
    root: dir,
    files: Object.keys(files)
      .filter((f) => f.endsWith('.php'))
      .map((id) => ({ id, loc: 1, language: 'php' })),
    edges: [],
    externals: [],
  };
  return {
    repoDir: dir,
    rootPath: '',
    graph,
    match: { adapter: 'php-async', confidence: 0.8, rootPath: '' },
    cluster: { fileModuleMap: {}, moduleIds: new Set<string>() },
  } as FrameworkContext;
}

const edgeKey = (e: { source: string; target: string }): string => `${e.source}→${e.target}`;

describe('php-async detect', () => {
  it('scores on Laravel-queue or Messenger deps, null otherwise', () => {
    expect(scoreAsync({ hasLaravelQueue: true, hasMessenger: false })?.adapter).toBe('php-async');
    expect(scoreAsync({ hasLaravelQueue: false, hasMessenger: true })?.adapter).toBe('php-async');
    expect(scoreAsync({ hasLaravelQueue: false, hasMessenger: false })).toBeNull();
  });
  it('detects illuminate/queue + symfony/messenger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-'));
    dirs.push(dir);
    await writeFile(join(dir, 'composer.json'), JSON.stringify({ require: { 'symfony/messenger': '^7.0' } }));
    expect(gatherAsyncSignals(dir).hasMessenger).toBe(true);
  });
});

const LARAVEL_COMPOSER = JSON.stringify({
  autoload: { 'psr-4': { 'App\\': 'app/' } },
  require: { 'laravel/framework': '^11.0' },
});

describe('php-async — Laravel Queues', () => {
  it('tags ShouldQueue jobs job + draws dispatch/publishes edges (free, static, chained)', async () => {
    const ctx = await asyncRepo({
      'composer.json': LARAVEL_COMPOSER,
      'app/Jobs/SendMail.php':
        '<?php\nnamespace App\\Jobs;\nuse Illuminate\\Contracts\\Queue\\ShouldQueue;\nclass SendMail implements ShouldQueue {}\n',
      'app/Jobs/SyncOrders.php':
        '<?php\nnamespace App\\Jobs;\nuse Illuminate\\Contracts\\Queue\\ShouldQueue;\nclass SyncOrders implements ShouldQueue {}\n',
      'app/Http/Controllers/OrderController.php':
        '<?php\nnamespace App\\Http\\Controllers;\nuse App\\Jobs\\SendMail;\nuse App\\Jobs\\SyncOrders;\nclass OrderController {\n  public function store() {\n    dispatch(new SendMail());\n    SyncOrders::dispatch()->onQueue(\'orders\');\n  }\n}\n',
    });
    const [roles, edges] = await Promise.all([asyncAdapter.roleTags!(ctx), asyncAdapter.syntheticEdges!(ctx)]);
    expect(roles.get('app/Jobs/SendMail.php')).toMatchObject({ role: 'job', kind: 'job' });
    expect(roles.get('app/Jobs/SyncOrders.php')).toMatchObject({ role: 'job', kind: 'job' });
    const keys = edges.map(edgeKey);
    expect(keys).toContain('app/Http/Controllers/OrderController.php→app/Jobs/SendMail.php'); // free dispatch(new J())
    expect(keys).toContain('app/Http/Controllers/OrderController.php→app/Jobs/SyncOrders.php'); // J::dispatch()->onQueue()
    expect(edges.every((e) => e.kind === 'publishes')).toBe(true);
  });
});

const SYMFONY_COMPOSER = JSON.stringify({
  autoload: { 'psr-4': { 'App\\': 'src/' } },
  require: { 'symfony/messenger': '^7.0' },
});

describe('php-async — Laravel Queues (transitive ShouldQueue via app/Jobs)', () => {
  it('detects a job that inherits ShouldQueue from a base class + links a custom-facade dispatch', async () => {
    const ctx = await asyncRepo({
      'composer.json': LARAVEL_COMPOSER,
      // The base implements ShouldQueue; the concrete job just extends it.
      'app/Jobs/QueuedJob.php':
        '<?php\nnamespace App\\Jobs;\nuse Illuminate\\Contracts\\Queue\\ShouldQueue;\nabstract class QueuedJob implements ShouldQueue {}\n',
      'app/Jobs/ScrobbleJob.php': '<?php\nnamespace App\\Jobs;\nclass ScrobbleJob extends QueuedJob {}\n',
      'app/Http/Controllers/ScrobbleController.php':
        '<?php\nnamespace App\\Http\\Controllers;\nuse App\\Jobs\\ScrobbleJob;\nuse App\\Facades\\Dispatcher;\nclass ScrobbleController {\n  public function store() { Dispatcher::dispatch(new ScrobbleJob()); }\n}\n',
    });
    const [roles, edges] = await Promise.all([asyncAdapter.roleTags!(ctx), asyncAdapter.syntheticEdges!(ctx)]);
    // The subclass has no direct `implements ShouldQueue`, but lives in app/Jobs/.
    expect(roles.get('app/Jobs/ScrobbleJob.php')).toMatchObject({ role: 'job', kind: 'job' });
    // A `new J()` first-arg dispatch resolves regardless of the (custom-facade) receiver.
    expect(edges.map(edgeKey)).toContain('app/Http/Controllers/ScrobbleController.php→app/Jobs/ScrobbleJob.php');
  });
});

describe('php-async — Symfony Messenger', () => {
  it('tags handlers job (attribute + __invoke) + draws $bus->dispatch publishes edges', async () => {
    const ctx = await asyncRepo({
      'composer.json': SYMFONY_COMPOSER,
      'src/Message/SendSms.php': '<?php\nnamespace App\\Message;\nclass SendSms {}\n',
      'src/MessageHandler/SendSmsHandler.php':
        '<?php\nnamespace App\\MessageHandler;\nuse App\\Message\\SendSms;\nuse Symfony\\Component\\Messenger\\Attribute\\AsMessageHandler;\n#[AsMessageHandler]\nclass SendSmsHandler {\n  public function __invoke(SendSms $message): void {}\n}\n',
      'src/Controller/SmsController.php':
        '<?php\nnamespace App\\Controller;\nuse App\\Message\\SendSms;\nuse Symfony\\Component\\Messenger\\MessageBusInterface;\nclass SmsController {\n  public function send(MessageBusInterface $bus) {\n    $bus->dispatch(new SendSms());\n  }\n}\n',
    });
    const [roles, edges] = await Promise.all([asyncAdapter.roleTags!(ctx), asyncAdapter.syntheticEdges!(ctx)]);
    expect(roles.get('src/MessageHandler/SendSmsHandler.php')).toMatchObject({ role: 'handler', kind: 'job' });
    // $bus->dispatch(new SendSms()) matched to the handler by the message class.
    expect(edges.map(edgeKey)).toContain('src/Controller/SmsController.php→src/MessageHandler/SendSmsHandler.php');
    expect(edges.every((e) => e.kind === 'publishes')).toBe(true);
  });
});

describe('php-async — co-firing + degrade', () => {
  it('detects both systems when both deps present', () => {
    expect(scoreAsync({ hasLaravelQueue: true, hasMessenger: true })?.metadata).toMatchObject({
      systems: ['laravel-queue', 'symfony-messenger'],
    });
  });
  it('does not draw an edge for a dispatch to a non-job target', async () => {
    const ctx = await asyncRepo({
      'composer.json': LARAVEL_COMPOSER,
      'app/Http/Controllers/X.php':
        '<?php\nnamespace App\\Http\\Controllers;\nuse App\\Support\\NotAJob;\nclass X {\n  public function y() { dispatch(new NotAJob()); }\n}\n',
    });
    const edges = await asyncAdapter.syntheticEdges!(ctx);
    expect(edges.length).toBe(0);
  });
});
