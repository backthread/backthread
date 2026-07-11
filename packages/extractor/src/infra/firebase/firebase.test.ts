// Firebase adapter tests.
//
// parseFirebaseConfig / parseFirebaseUsage / buildFirebaseGraph are pure; the
// adapter's detect/extract run against a real tmp dir. Mirrors cloudflare.test.ts.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFirebaseGraph,
  firebaseAdapter,
  parseFirebaseConfig,
  parseFirebaseUsage,
  type FirebaseUsage,
} from './firebase.js';

const NO_USAGE: FirebaseUsage = { usesAuth: false, usesFirestore: false, usesDatabase: false, usesStorage: false };

const FIREBASE_JSON = {
  hosting: { public: 'dist', rewrites: [{ source: '**', function: 'ssr' }] },
  functions: { source: 'functions', runtime: 'nodejs20' },
  firestore: { rules: 'firestore.rules' },
  storage: { rules: 'storage.rules' },
};

describe('parseFirebaseConfig', () => {
  it('normalizes hosting + functions (object form) and reads the data-service keys', () => {
    const cfg = parseFirebaseConfig(FIREBASE_JSON);
    expect(cfg.hosting).toHaveLength(1);
    expect(cfg.hosting[0].public).toBe('dist');
    expect(cfg.hosting[0].rewritesToFunction).toBe(true);
    expect(cfg.functions[0].source).toBe('functions');
    expect(cfg.hasFirestore).toBe(true);
    expect(cfg.hasStorage).toBe(true);
    expect(cfg.hasDatabase).toBe(false);
  });

  it('handles the array form of hosting + functions (multi-site / multi-codebase)', () => {
    const cfg = parseFirebaseConfig({
      hosting: [{ site: 'web', public: 'apps/web/dist' }, { site: 'admin', public: 'apps/admin/dist' }],
      functions: [{ source: 'fns/api', codebase: 'api' }, { source: 'fns/jobs', codebase: 'jobs' }],
    });
    expect(cfg.hosting.map((h) => h.name)).toEqual(['web', 'admin']);
    expect(cfg.functions.map((f) => f.codebase)).toEqual(['api', 'jobs']);
  });

  it('defaults the functions source to "functions" when absent', () => {
    expect(parseFirebaseConfig({ functions: {} }).functions[0].source).toBe('functions');
  });

  it('only `function:` rewrites flag rewritesToFunction (a `run:` rewrite does not)', () => {
    expect(parseFirebaseConfig({ hosting: { rewrites: [{ source: '**', function: 'ssr' }] } }).hosting[0].rewritesToFunction).toBe(true);
    expect(parseFirebaseConfig({ hosting: { rewrites: [{ source: '**', run: { serviceId: 'svc' } }] } }).hosting[0].rewritesToFunction).toBe(false);
  });
});

describe('parseFirebaseUsage', () => {
  it('detects each SDK surface', () => {
    expect(parseFirebaseUsage('import { getAuth } from "firebase/auth";').usesAuth).toBe(true);
    expect(parseFirebaseUsage('const db = getFirestore(app);').usesFirestore).toBe(true);
    expect(parseFirebaseUsage('import "firebase-admin/storage";').usesStorage).toBe(true);
    expect(parseFirebaseUsage('getDatabase(app)').usesDatabase).toBe(true);
    expect(parseFirebaseUsage('const x = 1;').usesAuth).toBe(false);
  });
});

describe('buildFirebaseGraph', () => {
  const graph = buildFirebaseGraph({
    config: parseFirebaseConfig(FIREBASE_JSON),
    usage: NO_USAGE,
    configDir: '',
    srcExists: true,
    configFile: 'firebase.json',
    root: '/repo',
  });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  it('emits hosting (static-site) with src/ as source root (NOT the public/output dir)', () => {
    const h = byId.get('hosting:hosting');
    expect(h?.kind).toBe('static-site');
    expect(h?.sourceRoots).toEqual(['src']);
    expect(h?.metadata?.public).toBe('dist'); // recorded as metadata only
  });

  it('emits Cloud Functions (worker) with functions.source as source root', () => {
    const f = byId.get('functions:functions');
    expect(f?.kind).toBe('worker');
    expect(f?.sourceRoots).toEqual(['functions']);
  });

  it('emits Firestore + Storage datastores from the config keys', () => {
    expect(byId.get('firestore')?.kind).toBe('datastore');
    expect(byId.get('storage')?.kind).toBe('datastore');
    expect(byId.get('database')).toBeUndefined(); // not declared, not used
  });

  it('does NOT emit Auth without source evidence (no firebase.json key for it)', () => {
    expect(byId.get('auth')).toBeUndefined();
  });

  it('hosting calls functions when a rewrite routes to a function', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'hosting:hosting', target: 'functions:functions', kind: 'calls' }),
    );
  });

  it('all declared, no classifications needed (no LLM)', () => {
    expect(graph.classificationsNeeded).toEqual([]);
  });
});

describe('buildFirebaseGraph — evidence gating + fallbacks', () => {
  it('emits Auth + Firestore from source usage even when firebase.json omits them', () => {
    const graph = buildFirebaseGraph({
      config: parseFirebaseConfig({ hosting: { public: 'dist' } }), // hosting-only config
      usage: { usesAuth: true, usesFirestore: true, usesDatabase: false, usesStorage: false },
      configDir: '',
      srcExists: false,
      configFile: 'firebase.json',
      root: '/repo',
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('auth')?.kind).toBe('external-api');
    expect(byId.get('firestore')?.kind).toBe('datastore');
  });

  it('hosting has NO source root when src/ is absent (public is output, never a root)', () => {
    const graph = buildFirebaseGraph({
      config: parseFirebaseConfig({ hosting: { public: 'build' } }),
      usage: NO_USAGE,
      configDir: '',
      srcExists: false,
      configFile: 'firebase.json',
      root: '/repo',
    });
    expect(graph.nodes.find((n) => n.id === 'hosting:hosting')?.sourceRoots).toBeUndefined();
  });

  it('scopes multi-codebase functions by codebase name + resolves source against configDir', () => {
    const graph = buildFirebaseGraph({
      config: parseFirebaseConfig({
        functions: [{ source: 'fns/api', codebase: 'api' }, { source: 'fns/jobs', codebase: 'jobs' }],
      }),
      usage: NO_USAGE,
      configDir: 'backend',
      srcExists: false,
      configFile: 'backend/firebase.json',
      root: '/repo',
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('functions:api')?.sourceRoots).toEqual(['backend/fns/api']);
    expect(byId.get('functions:jobs')?.sourceRoots).toEqual(['backend/fns/jobs']);
  });
});

describe('firebaseAdapter detect + extract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-firebase-'));
    mkdirSync(join(dir, 'functions', 'src'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify(FIREBASE_JSON));
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'marola-prod' } }));
    // a client source file that uses Firebase Auth → gates the Auth node
    writeFileSync(join(dir, 'src', 'login.ts'), 'import { getAuth } from "firebase/auth";\nexport const a = getAuth();');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects firebase.json', async () => {
    expect(await firebaseAdapter.detect(dir)).toBe(true);
  });

  it('extracts hosting + functions + firestore/storage + (grep-gated) auth', async () => {
    const graph = await firebaseAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('hosting:hosting');
    expect(ids).toContain('functions:functions');
    expect(ids).toContain('firestore');
    expect(ids).toContain('storage');
    expect(ids).toContain('auth'); // proven by the src/login.ts grep
  });

  it('scansSourcePath flags source files (forces re-extract on app-source change)', () => {
    expect(firebaseAdapter.scansSourcePath!('src/login.ts')).toBe(true);
    expect(firebaseAdapter.scansSourcePath!('README.md')).toBe(false);
  });

  it('does not detect a repo with no Firebase signal', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-firebase-empty-'));
    try {
      expect(await firebaseAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
