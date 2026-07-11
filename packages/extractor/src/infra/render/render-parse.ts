// render.yaml parser + typed shape extractor.
//
// render.yaml is YAML (not TOML, not JSONC), so we use the `yaml` package
// (already a devDependency). This module maps the raw YAML tree into a
// typed RenderConfig shape that render.ts consumes — keeping the parser
// logic and the graph builder cleanly separated (same pattern as
// fly-parse.ts ↔ fly.ts).
//
// Covered top-level sections:
//   services[]   — type: web | worker | cron | pserv | static
//     name, type, runtime, buildCommand, startCommand, plan, branch, autoDeploy
//     envVars[]  — fromDatabase, fromService, value, generateValue
//     routes[]   — for static sites
//   databases[]  — managed Postgres: name, plan, region, postgresMajorVersion
//   redis[]      — managed Redis/KeyValue: name, plan, region
//
// render.yaml reference:
//   https://docs.render.com/blueprint-spec

import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Typed structured shape

export type RenderServiceType = 'web' | 'worker' | 'cron' | 'pserv' | 'static';

export interface RenderEnvVar {
  key?: string;
  /** Literal string value. */
  value?: string;
  /** Auto-generated secret — treat as metadata only. */
  generateValue?: boolean;
  /** fromDatabase: { name: string; property: string } — the service reads from a db. */
  fromDatabase?: { name?: string; property?: string };
  /** fromService: { name: string; type: string; property: string } — reads a peer's prop. */
  fromService?: { name?: string; type?: string; property?: string };
}

export interface RenderService {
  name: string;
  type: RenderServiceType;
  /**
   * The original type string from the YAML, preserved verbatim.
   * Equals `type` for known service types; differs when an unrecognised type
   * caused the parser to fall back to 'web' so the metadata can record the
   * actual declared value rather than the fallback.
   */
  rawType: string;
  /** Runtime: node | python | ruby | go | rust | elixir | docker */
  runtime?: string;
  buildCommand?: string;
  startCommand?: string;
  /** Build plan tier. */
  plan?: string;
  /** The git branch to track. */
  branch?: string;
  autoDeploy?: boolean;
  /**
   * the monorepo base dir Render runs build/start from (the service's
   * source root). Repo-relative.
   */
  rootDir?: string;
  /** Docker runtime — path to the Dockerfile (its dir is the build context). */
  dockerfilePath?: string;
  /** Docker runtime — explicit build-context dir (overrides the Dockerfile's dir). */
  dockerContext?: string;
  envVars: RenderEnvVar[];
  /** Routes for static sites. */
  routes?: Array<{ type?: string; source?: string; destination?: string }>;
}

export interface RenderDatabase {
  /** Logical name used as the target for fromDatabase references. */
  name: string;
  plan?: string;
  region?: string;
  postgresMajorVersion?: number | string;
  databaseName?: string;
  user?: string;
}

export interface RenderRedis {
  name: string;
  plan?: string;
  region?: string;
}

export interface RenderConfig {
  services: RenderService[];
  databases: RenderDatabase[];
  redis: RenderRedis[];
}

// ---------------------------------------------------------------------------
// Helpers

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function numOrStr(v: unknown): number | string | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v) return v;
  return undefined;
}

function arr(tree: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const v = tree[key];
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const SERVICE_TYPES: RenderServiceType[] = ['web', 'worker', 'cron', 'pserv', 'static'];

function parseServiceType(v: unknown): RenderServiceType {
  const s = str(v);
  if (s && (SERVICE_TYPES as string[]).includes(s)) return s as RenderServiceType;
  if (s) console.warn('[render] unknown service type', s);
  return 'web'; // safe fallback
}

function parseEnvVar(raw: Record<string, unknown>): RenderEnvVar {
  const ev: RenderEnvVar = {};
  const key = str(raw.key);
  if (key) ev.key = key;
  const value = str(raw.value);
  if (value !== undefined) ev.value = value;
  const gen = bool(raw.generateValue);
  if (gen !== undefined) ev.generateValue = gen;

  // fromDatabase: { name, property }
  const fromDb = obj(raw.fromDatabase);
  if (fromDb) {
    ev.fromDatabase = { name: str(fromDb.name), property: str(fromDb.property) };
  }

  // fromService: { name, type, property }
  const fromSvc = obj(raw.fromService);
  if (fromSvc) {
    ev.fromService = {
      name: str(fromSvc.name),
      type: str(fromSvc.type),
      property: str(fromSvc.property),
    };
  }

  return ev;
}

function parseService(raw: Record<string, unknown>): RenderService | null {
  const name = str(raw.name);
  if (!name) return null; // name is load-bearing; skip nameless entries

  const rawType = str(raw.type) ?? 'web';
  const type = parseServiceType(raw.type);
  const envVars = arr(raw, 'envVars').map(parseEnvVar);
  const routes = arr(raw, 'routes').map((r) => ({
    type: str(r.type),
    source: str(r.source),
    destination: str(r.destination),
  }));

  return {
    name,
    type,
    rawType,
    runtime: str(raw.runtime),
    buildCommand: str(raw.buildCommand),
    startCommand: str(raw.startCommand),
    plan: str(raw.plan),
    branch: str(raw.branch),
    autoDeploy: bool(raw.autoDeploy),
    rootDir: str(raw.rootDir),
    dockerfilePath: str(raw.dockerfilePath),
    dockerContext: str(raw.dockerContext),
    envVars,
    routes: routes.length > 0 ? routes : undefined,
  };
}

function parseDatabase(raw: Record<string, unknown>): RenderDatabase | null {
  const name = str(raw.name);
  if (!name) return null;
  return {
    name,
    plan: str(raw.plan),
    region: str(raw.region),
    postgresMajorVersion: numOrStr(raw.postgresMajorVersion),
    databaseName: str(raw.databaseName),
    user: str(raw.user),
  };
}

function parseRedis(raw: Record<string, unknown>): RenderRedis | null {
  const name = str(raw.name);
  if (!name) return null;
  return {
    name,
    plan: str(raw.plan),
    region: str(raw.region),
  };
}

// ---------------------------------------------------------------------------
// Main parse function: raw YAML string → RenderConfig.
// Throws on YAML syntax errors (caller wraps in try/catch + warns).

export function parseRenderConfig(yamlText: string): RenderConfig {
  const raw = parseYaml(yamlText);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('render.yaml: top-level value must be a mapping');
  }
  const tree = raw as Record<string, unknown>;

  const services = arr(tree, 'services')
    .map(parseService)
    .filter((s): s is RenderService => s !== null);

  const databases = arr(tree, 'databases')
    .map(parseDatabase)
    .filter((d): d is RenderDatabase => d !== null);

  // Render uses both 'redis' (newer) and 'keyValueStores' (alias) in the spec.
  const redisRaw = [
    ...arr(tree, 'redis'),
    ...arr(tree, 'keyValueStores'),
  ];
  const redis = redisRaw
    .map(parseRedis)
    .filter((r): r is RenderRedis => r !== null);

  return { services, databases, redis };
}
