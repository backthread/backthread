// the Firebase InfraAdapter.
//
// Firebase is the other dominant BaaS alongside Supabase (#3 at ~13% adoption,
// 2025 SO survey) — heavy in mobile + AI-coded apps. This surfaces a Firebase
// deployment from `firebase.json`: Hosting, Cloud Functions, and the managed
// data services (Firestore / Realtime Database / Cloud Storage) — plus Firebase
// Auth, which has no `firebase.json` key and is therefore evidence-gated on a
// source grep (mirroring the Supabase adapter's Auth/Storage/Realtime gating).
//
// Kind mapping (locked 8-kind InfraModuleKind enum — map onto it, never weaken):
//   Hosting              → static-site
//   Cloud Functions      → worker
//   Firestore / RTDB     → datastore
//   Cloud Storage        → datastore
//   Firebase Auth        → external-api  (a managed identity service you call)
//
// sourceRoots:
//   * Cloud Functions → `functions.source` (default `functions`) — clean: that dir
//     IS the deployed code (mirrors the Supabase-functions pattern).
//   * Hosting → `src/` if it exists (the SPA convention). `hosting.public` is the
//     build OUTPUT dir (e.g. `dist`/`build`), not source, so it's metadata only —
//     never a source root (same call as the Netlify adapter's publish-vs-base).
//
// Evidence-gated, never hallucinated: a data-service node is emitted when
// firebase.json declares it OR a source grep proves the SDK is used (so a
// hosting-only firebase.json that still uses Firestore/Auth from the client SDK
// is captured). Auth is source-grep-only (no config key).
//
// Zone label: "Firebase" (PROVIDER_ZONE_LABEL['firebase'] in zones.ts).

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { walkRepo } from '../walk.js';

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// ---------------------------------------------------------------------------
// Path helpers.

function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

function resolveRel(baseDir: string, rel: string): string {
  const parts = (baseDir ? baseDir.split('/') : []).concat(rel.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// ---------------------------------------------------------------------------
// Typed config extracted from firebase.json.

export interface FirebaseHosting {
  /** The deploy/output dir (metadata; NOT a source root). */
  public?: string;
  /** Site / target name (disambiguates multi-site hosting). */
  name?: string;
  /** True iff any rewrite routes to a Cloud Function. */
  rewritesToFunction: boolean;
}

export interface FirebaseFunctions {
  /** The functions source dir (default `functions`). */
  source: string;
  /** Optional codebase name (multi-codebase setups). */
  codebase?: string;
}

export interface FirebaseConfig {
  hosting: FirebaseHosting[];
  functions: FirebaseFunctions[];
  hasFirestore: boolean;
  hasDatabase: boolean;
  hasStorage: boolean;
}

export interface FirebaseUsage {
  usesAuth: boolean;
  usesFirestore: boolean;
  usesDatabase: boolean;
  usesStorage: boolean;
}

function parseHosting(raw: unknown): FirebaseHosting {
  const h = rec(raw) ?? {};
  const rewrites = Array.isArray(h.rewrites) ? h.rewrites : [];
  // Only `function:` rewrites signal a Hosting→Functions edge. A `run:` rewrite
  // targets a Cloud Run service (which we don't model yet), so counting it here
  // would draw a mislabeled edge to Cloud Functions.
  const rewritesToFunction = rewrites.some((r) => typeof rec(r)?.function === 'string');
  return {
    public: str(h.public),
    name: str(h.site) ?? str(h.target),
    rewritesToFunction,
  };
}

function parseFunctions(raw: unknown): FirebaseFunctions {
  const f = rec(raw) ?? {};
  return { source: str(f.source) ?? 'functions', codebase: str(f.codebase) };
}

/** Pure: a parsed firebase.json object → the typed FirebaseConfig. */
export function parseFirebaseConfig(json: unknown): FirebaseConfig {
  const root = rec(json) ?? {};
  return {
    hosting: asArray(root.hosting as unknown).map(parseHosting),
    functions: asArray(root.functions as unknown).map(parseFunctions),
    hasFirestore: 'firestore' in root,
    hasDatabase: 'database' in root,
    hasStorage: 'storage' in root,
  };
}

// ---------------------------------------------------------------------------
// Source grep — evidence for the SDK-used data services + Auth (no config key).

const USAGE_PREFILTER = 'firebase';

/** Parse one source file's Firebase SDK usage. */
export function parseFirebaseUsage(content: string): FirebaseUsage {
  return {
    usesAuth: /firebase(-admin)?\/auth|getAuth\s*\(/.test(content),
    usesFirestore: /firebase(-admin)?\/firestore|getFirestore\s*\(/.test(content),
    usesDatabase: /firebase(-admin)?\/database|getDatabase\s*\(/.test(content),
    usesStorage: /firebase(-admin)?\/storage|getStorage\s*\(/.test(content),
  };
}

function mergeUsage(scans: FirebaseUsage[]): FirebaseUsage {
  return {
    usesAuth: scans.some((s) => s.usesAuth),
    usesFirestore: scans.some((s) => s.usesFirestore),
    usesDatabase: scans.some((s) => s.usesDatabase),
    usesStorage: scans.some((s) => s.usesStorage),
  };
}

function grepUsage(repoDir: string): FirebaseUsage {
  const scans: FirebaseUsage[] = [];
  walkRepo(repoDir, {
    onFile: (abs, e) => {
      if (!SOURCE_EXT.test(e.name)) return;
      let content: string;
      try {
        content = readFileSync(abs, 'utf8');
      } catch {
        return;
      }
      if (!content.includes(USAGE_PREFILTER)) return; // cheap pre-filter
      scans.push(parseFirebaseUsage(content));
    },
  });
  return mergeUsage(scans);
}

// ---------------------------------------------------------------------------
// Node-id helpers (adapter-local; registry prefixes `firebase:`).

const hostingId = (name: string) => `hosting:${name}`;
const functionsId = (name: string) => `functions:${name}`;
const FIRESTORE_ID = 'firestore';
const DATABASE_ID = 'database';
const STORAGE_ID = 'storage';
const AUTH_ID = 'auth';

// ---------------------------------------------------------------------------
// Pure graph builder. fs facts (does src/ exist) + usage are injected so the
// builder is unit-testable without a real repo.

export function buildFirebaseGraph(args: {
  config: FirebaseConfig;
  usage: FirebaseUsage;
  configDir: string;
  /** Does `<configDir>/src` exist? (hosting source-root fallback) */
  srcExists: boolean;
  configFile: string;
  root: string;
}): InfraGraph {
  const { config, usage, configDir, srcExists, configFile, root } = args;
  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];
  const addNode = (n: InfraNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  // --- Hosting --------------------------------------------------------------
  const siteIds: string[] = [];
  config.hosting.forEach((h, i) => {
    const name = h.name ?? (config.hosting.length > 1 ? `site-${i}` : 'hosting');
    const id = hostingId(name);
    const srcRoot = srcExists ? resolveRel(configDir, 'src') : '';
    addNode({
      id,
      label: h.name ? `${h.name} (Firebase Hosting)` : 'Firebase Hosting',
      kind: 'static-site',
      provenance: 'declared',
      metadata: { provider: 'firebase', config: configFile, ...(h.public ? { public: h.public } : {}) },
      ...(srcRoot ? { sourceRoots: [srcRoot] } : {}),
    });
    siteIds.push(id);
  });

  // --- Cloud Functions ------------------------------------------------------
  const functionIds: string[] = [];
  config.functions.forEach((f, i) => {
    const name = f.codebase ?? (config.functions.length > 1 ? `functions-${i}` : 'functions');
    const id = functionsId(name);
    const r = resolveRel(configDir, f.source);
    addNode({
      id,
      label: 'Cloud Functions',
      kind: 'worker',
      provenance: 'declared',
      metadata: { provider: 'firebase', config: configFile, source: f.source, ...(f.codebase ? { codebase: f.codebase } : {}) },
      ...(r ? { sourceRoots: [r] } : {}),
    });
    functionIds.push(id);
  });

  // Hosting → Functions edge when a rewrite routes to a function.
  if (config.hosting.some((h) => h.rewritesToFunction) && functionIds.length) {
    // A rewrite names a function, not a codebase; with multiple codebases we
    // attach to the first (a reasonable approximation — precise function→codebase
    // resolution would need to read each codebase's exports).
    for (const sid of siteIds) {
      edges.push({ source: sid, target: functionIds[0], kind: 'calls', metadata: { via: 'hosting-rewrite', config: configFile } });
    }
  }

  // --- Managed data services (config-declared OR source-grep-proven) --------
  const dataServices: Array<[string, string, boolean]> = [
    [FIRESTORE_ID, 'Cloud Firestore', config.hasFirestore || usage.usesFirestore],
    [DATABASE_ID, 'Realtime Database', config.hasDatabase || usage.usesDatabase],
    [STORAGE_ID, 'Cloud Storage', config.hasStorage || usage.usesStorage],
  ];
  for (const [id, label, present] of dataServices) {
    if (!present) continue;
    const node: InfraNode = {
      id,
      label,
      kind: 'datastore',
      provenance: 'declared',
      metadata: { provider: 'firebase', config: configFile },
    };
    addNode(node);
  }

  // --- Firebase Auth (source-grep-only — no firebase.json key) --------------
  if (usage.usesAuth) {
    addNode({
      id: AUTH_ID,
      label: 'Firebase Auth',
      kind: 'external-api',
      provenance: 'declared',
      metadata: { provider: 'firebase' },
    });
  }

  return { root, adapter: 'firebase', nodes: [...nodes.values()], edges, classificationsNeeded: [] };
}

// ---------------------------------------------------------------------------
// fs helpers.

function findFirebaseConfig(repoDir: string): string | undefined {
  const direct = join(repoDir, 'firebase.json');
  if (existsSync(direct)) return direct;
  return undefined;
}

function hasFirebaseLayout(repoDir: string): boolean {
  return existsSync(join(repoDir, 'firebase.json')) || existsSync(join(repoDir, '.firebaserc'));
}

// ---------------------------------------------------------------------------
// Adapter.

export const firebaseAdapter: InfraAdapter = {
  name: 'firebase',

  async detect(repoDir: string): Promise<boolean> {
    return hasFirebaseLayout(repoDir);
  },

  // Greps app source for the Firebase SDK (Auth/Firestore/Storage/RTDB usage),
  // so a source-only change can change the infra graph and MUST force a
  // re-extract in the diff-driven hosted walk (same contract as the Supabase
  // adapter — see relevance.ts).
  scansSourcePath(path: string): boolean {
    return SOURCE_EXT.test(path);
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const configPath = findFirebaseConfig(repoDir);
    let config: FirebaseConfig = { hosting: [], functions: [], hasFirestore: false, hasDatabase: false, hasStorage: false };
    let configFile = '(firebase convention)';
    if (configPath) {
      configFile = (relative(repoDir, configPath) || configPath).split('\\').join('/');
      try {
        config = parseFirebaseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
      } catch (err) {
        console.warn(`  [firebase] skipping unparseable ${configPath}: ${(err as Error).message}`);
      }
    }
    const configDir = configPath ? dirOf(configFile) : '';
    return buildFirebaseGraph({
      config,
      usage: grepUsage(repoDir),
      configDir,
      srcExists: existsSync(join(repoDir, configDir, 'src')),
      configFile,
      root: repoDir,
    });
  },
};
