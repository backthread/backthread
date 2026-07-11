// the DigitalOcean App Platform InfraAdapter.
//
// DigitalOcean is #4 at ~10.7% adoption (2025 SO survey). This surfaces a DO App
// Platform deployment from the **app spec** (`.do/app.yaml` / `.do/deploy.template.yaml`).
//
// ⚠️ Detection keys off the `.do/` DIR, NOT a bare `app.yaml` — `app.yaml` is also
// GCP App Engine's filename (our GCP adapter claims it). A DO spec has no top-level
// `runtime`/`apiVersion`, so GCP's parser returns nothing on it anyway (verified in
// the tests), but we still scope DO detection to `.do/` so the two never fight.
//
// Kind mapping (locked 8-kind InfraModuleKind enum — map onto it, never weaken;
// `service`/`job` are app-role ModuleKinds, NOT InfraModuleKinds, so an InfraNode
// can't carry them — the DO component type is preserved in metadata instead):
//   services    → worker      (source-build PaaS compute — same convention as Render/Fly)
//   workers     → worker
//   jobs        → worker      (run-to-completion; componentType: 'job' in metadata)
//   functions   → worker      (DO Functions)
//   static_sites→ static-site
//   databases   → datastore   (managed; no source)
//
// sourceRoots: each component's `source_dir` (repo-root-relative in the
// DO spec) → clean per-unit attribution. A `source_dir` of `/` (repo root) yields
// no source root (no catch-all). Databases carry none.
//
// Edges: a component whose `envs` reference a database bindable var (`${<db>.…}`)
// `stores-in` that database — the one declarative dependency the spec carries.
//
// Zone label: "DigitalOcean" (PROVIDER_ZONE_LABEL['digitalocean'] in zones.ts).

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { findFiles } from '../walk.js';

// ---------------------------------------------------------------------------
// Path helper.

function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}

// ---------------------------------------------------------------------------
// Typed app-spec shape.

export interface DoComponent {
  name: string;
  /** Repo-root-relative source dir (the deployed code). */
  sourceDir?: string;
  /** Database component names referenced via `${<name>.…}` bindable vars in envs. */
  dbRefs: string[];
}

export interface DoDatabase {
  name: string;
  engine?: string;
}

export interface DoAppSpec {
  name?: string;
  services: DoComponent[];
  staticSites: DoComponent[];
  workers: DoComponent[];
  jobs: DoComponent[];
  functions: DoComponent[];
  databases: DoDatabase[];
}

const DB_REF_RE = /\$\{([A-Za-z0-9_-]+)\./g;

function parseComponent(raw: Record<string, unknown>): DoComponent | null {
  const name = str(raw.name);
  if (!name) return null;
  const dbRefs = new Set<string>();
  for (const e of arr(raw.envs)) {
    const value = str(e.value);
    if (!value) continue;
    for (const m of value.matchAll(DB_REF_RE)) dbRefs.add(m[1]);
  }
  const c: DoComponent = { name, dbRefs: [...dbRefs] };
  const sourceDir = str(raw.source_dir);
  if (sourceDir) c.sourceDir = sourceDir;
  return c;
}

function parseDatabase(raw: Record<string, unknown>): DoDatabase | null {
  const name = str(raw.name);
  if (!name) return null;
  return { name, engine: str(raw.engine) };
}

/** Pure: a parsed DO app-spec object → the typed DoAppSpec. */
export function parseDoAppSpec(tree: unknown): DoAppSpec {
  const root = (tree && typeof tree === 'object' && !Array.isArray(tree) ? tree : {}) as Record<string, unknown>;
  const comp = (key: string) => arr(root[key]).map(parseComponent).filter((c): c is DoComponent => c !== null);
  return {
    name: str(root.name),
    services: comp('services'),
    staticSites: comp('static_sites'),
    workers: comp('workers'),
    jobs: comp('jobs'),
    functions: comp('functions'),
    databases: arr(root.databases).map(parseDatabase).filter((d): d is DoDatabase => d !== null),
  };
}

/**
 * Is this a DO App Platform spec? A spec has a top-level component array
 * (`services`/`static_sites`/`workers`/`jobs`/`functions`) or a `databases`
 * array. Used to confirm a `.do/*.yaml` really is an app spec (vs an unrelated
 * yaml that happens to live under `.do/`).
 */
export function looksLikeDoSpec(tree: unknown): boolean {
  const r = tree && typeof tree === 'object' && !Array.isArray(tree) ? (tree as Record<string, unknown>) : {};
  return ['services', 'static_sites', 'workers', 'jobs', 'functions', 'databases'].some((k) => Array.isArray(r[k]));
}

// ---------------------------------------------------------------------------
// Node-id helpers (adapter-local; registry prefixes `digitalocean:`).

const serviceId = (n: string) => `service:${n}`;
const staticId = (n: string) => `static:${n}`;
const workerId = (n: string) => `worker:${n}`;
const jobId = (n: string) => `job:${n}`;
const functionId = (n: string) => `function:${n}`;
const databaseId = (n: string) => `database:${n}`;

// ---------------------------------------------------------------------------
// Pure graph builder.

export function buildDigitalOceanGraph(spec: DoAppSpec, root: string, configFile: string): InfraGraph {
  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];
  const dbNames = new Set(spec.databases.map((d) => d.name));
  const addNode = (n: InfraNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  // A code-deploying component → a node (kind from the DO component type, mapped
  // onto InfraModuleKind) + its source_dir as the source root + db edges.
  const addComponent = (
    c: DoComponent,
    id: string,
    kind: InfraNode['kind'],
    componentType: string,
  ) => {
    const sr = c.sourceDir ? normalizeRoot(c.sourceDir) : '';
    addNode({
      id,
      label: c.name,
      kind,
      provenance: 'declared',
      metadata: { provider: 'digitalocean', config: configFile, componentType, ...(c.sourceDir ? { sourceDir: c.sourceDir } : {}) },
      ...(sr ? { sourceRoots: [sr] } : {}),
    });
    for (const ref of c.dbRefs) {
      if (dbNames.has(ref)) {
        edges.push({ source: id, target: databaseId(ref), kind: 'stores-in', metadata: { via: 'env-binding', config: configFile } });
      }
    }
  };

  for (const c of spec.services) addComponent(c, serviceId(c.name), 'worker', 'service');
  for (const c of spec.workers) addComponent(c, workerId(c.name), 'worker', 'worker');
  for (const c of spec.jobs) addComponent(c, jobId(c.name), 'worker', 'job');
  for (const c of spec.functions) addComponent(c, functionId(c.name), 'worker', 'function');
  for (const c of spec.staticSites) addComponent(c, staticId(c.name), 'static-site', 'static_site');

  for (const d of spec.databases) {
    addNode({
      id: databaseId(d.name),
      label: d.name,
      kind: 'datastore',
      provenance: 'declared',
      metadata: { provider: 'digitalocean', config: configFile, ...(d.engine ? { engine: d.engine } : {}) },
    });
  }

  return { root, adapter: 'digitalocean', nodes: [...nodes.values()], edges, classificationsNeeded: [] };
}

// ---------------------------------------------------------------------------
// fs discovery — `.do/*.y(a)ml` only (NOT bare app.yaml elsewhere).

function findDoSpecFiles(repoDir: string): string[] {
  return findFiles(
    repoDir,
    (abs) => {
      const rel = relative(repoDir, abs).split('\\').join('/');
      return /(^|\/)\.do\/[^/]+\.ya?ml$/.test(rel);
    },
    { maxDepth: 5 },
  );
}

// ---------------------------------------------------------------------------
// Adapter.

export const digitaloceanAdapter: InfraAdapter = {
  name: 'digitalocean',

  async detect(repoDir: string): Promise<boolean> {
    // A `.do/*.yaml` that actually parses as an app spec (component arrays).
    for (const file of findDoSpecFiles(repoDir)) {
      try {
        if (looksLikeDoSpec(parseYaml(readFileSync(file, 'utf8'), { logLevel: 'silent' }))) return true;
      } catch {
        /* unparseable → not a usable spec */
      }
    }
    return false;
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const files = findDoSpecFiles(repoDir);
    const specs: DoAppSpec[] = [];
    let configFile = '.do/app.yaml';
    for (const file of files) {
      try {
        const tree = parseYaml(readFileSync(file, 'utf8'), { logLevel: 'silent' });
        if (!looksLikeDoSpec(tree)) continue;
        specs.push(parseDoAppSpec(tree));
        configFile = (relative(repoDir, file) || file).split('\\').join('/');
      } catch (err) {
        console.warn(`  [digitalocean] skipping unparseable ${file}: ${(err as Error).message}`);
      }
    }
    // Merge multiple specs (rare) into one graph by concatenating their components.
    const merged: DoAppSpec = { services: [], staticSites: [], workers: [], jobs: [], functions: [], databases: [] };
    for (const s of specs) {
      merged.services.push(...s.services);
      merged.staticSites.push(...s.staticSites);
      merged.workers.push(...s.workers);
      merged.jobs.push(...s.jobs);
      merged.functions.push(...s.functions);
      merged.databases.push(...s.databases);
    }
    return buildDigitalOceanGraph(merged, repoDir, configFile);
  },
};
