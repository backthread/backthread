// Railway config parsers + env-ref extraction.
//
// Railway is convention-over-configuration: the canonical source of truth is
// railway.json / railway.toml (if present), nixpacks.toml (build config), and
// Procfile (legacy process declaration). package.json is used as a fallback
// signal for framework detection.
//
// This file provides PURE parsing functions — no fs IO, no side effects.
// railway.ts owns the IO layer; railway.test.ts / railway-parse.test.ts own
// the testing.
//
// Railway env-var template syntax for inter-resource references:
//   ${{Postgres.DATABASE_URL}}    → plugin named "Postgres"
//   ${{Redis.URL}}                → plugin named "Redis"
//   ${{MongoDB.MONGODB_URL}}      → plugin named "MongoDB"
//   ${{api.RAILWAY_PRIVATE_URL}}  → another service named "api"
//
// Plugins are managed datastores provisioned by Railway (Postgres, Redis,
// MongoDB, MySQL). Services are other containers in the same project.
//
// Env-ref detection regex: \$\{\{([^.}]+)\.([^}]+)\}\}
//   group 1 = the referent name (plugin or service id, case-insensitive match
//             against known plugin names)
//   group 2 = the env var being interpolated

import { parseJsonc, parseTomlSubset } from '../cloudflare/wrangler-parse.js';

export type { WranglerTree as RailwayTree } from '../cloudflare/wrangler-parse.js';
import type { WranglerTree as RailwayTree } from '../cloudflare/wrangler-parse.js';

// ---------------------------------------------------------------------------
// Parsed Railway config shape.

export interface RailwayService {
  /** Canonical service name (from config or inferred). */
  name: string;
  /** Builder / Nixpacks / Dockerfile / … */
  builder?: string;
  /** Explicit build command if declared. */
  buildCommand?: string;
  /** Explicit start command if declared. */
  startCommand?: string;
  /** Source directory (monorepo sub-path). */
  source?: string;
  /** Health-check path, if configured. */
  healthcheck?: string;
  /** Raw env declarations map (may contain ref templates). */
  envVars?: Record<string, string>;
}

export interface RailwayConfig {
  /** All services found. Single-service repos have exactly one entry. */
  services: RailwayService[];
  /** Project-level env declarations (from top-level `envVars`/`env` block). */
  projectEnvVars?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Known Railway plugin names — these are managed datastores, not user services.
// Match case-insensitively.
const PLUGIN_NAMES = new Set(['postgres', 'redis', 'mongodb', 'mongo', 'mysql', 'mssql', 'rabbitmq']);

export interface EnvRef {
  /** The referent name as it appears in the template (original casing). */
  name: string;
  /** Lowercased for comparison. */
  nameLower: string;
  /** True if this name matches a known Railway plugin. */
  isPlugin: boolean;
  /** The env var key being interpolated. */
  varKey: string;
  /** Original template string, e.g. `${{Postgres.DATABASE_URL}}`. */
  raw: string;
}

const ENV_REF_RE = /\$\{\{([^.}]+)\.([^}]+)\}\}/g;

/** Extract all `${{Name.VAR}}` references from a block of text. */
export function extractEnvRefs(text: string): EnvRef[] {
  const refs: EnvRef[] = [];
  let m: RegExpExecArray | null;
  ENV_REF_RE.lastIndex = 0;
  while ((m = ENV_REF_RE.exec(text)) !== null) {
    const name = m[1];
    const varKey = m[2];
    const nameLower = name.toLowerCase();
    refs.push({ name, nameLower, isPlugin: PLUGIN_NAMES.has(nameLower), varKey, raw: m[0] });
  }
  return refs;
}

/** Collect all env-var references from a config's services + project level. */
export function extractConfigRefs(config: RailwayConfig): EnvRef[] {
  const allText: string[] = [];
  for (const svc of config.services) {
    if (svc.envVars) allText.push(JSON.stringify(svc.envVars));
  }
  if (config.projectEnvVars) allText.push(JSON.stringify(config.projectEnvVars));
  return extractEnvRefs(allText.join('\n'));
}

// ---------------------------------------------------------------------------
// railway.json / railway.toml parser.
//
// Railway's JSON schema has two shapes:
//   1. Multi-service (monorepo): top-level `services` map/array
//   2. Single-service: top-level keys are the service config directly
//
// TOML shape mirrors the JSON shape (same key names under `[service]` tables).

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function recordOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
    // Railway env also supports integers/booleans — coerce to string
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val);
  }
  return Object.keys(out).length ? out : undefined;
}

function parseServiceBlock(obj: RailwayTree, fallbackName: string): RailwayService {
  // Build config may nest under a "build" or "deploy" sub-key in JSON, or be
  // flat (toml). Try both shapes.
  const build = (obj.build && typeof obj.build === 'object' ? obj.build : obj) as RailwayTree;
  const deploy = (obj.deploy && typeof obj.deploy === 'object' ? obj.deploy : obj) as RailwayTree;

  return {
    name: strOf(obj.name) ?? strOf(obj.serviceName) ?? fallbackName,
    builder: strOf(build.builder) ?? strOf(obj.builder),
    buildCommand: strOf(build.buildCommand) ?? strOf(obj.buildCommand),
    startCommand: strOf(deploy.startCommand) ?? strOf(obj.startCommand),
    source: strOf(obj.source) ?? strOf(obj.sourceDir) ?? strOf(obj.rootDirectory),
    healthcheck: strOf(deploy.healthcheckPath) ?? strOf(obj.healthcheckPath),
    envVars: recordOf(obj.variables) ?? recordOf(obj.envVars) ?? recordOf(obj.env),
  };
}

/** Parse a railway.json or railway.toml (auto-detected by filename suffix). */
export function parseRailwayConfig(text: string, filename: string): RailwayConfig {
  const tree: RailwayTree = /\.toml$/i.test(filename)
    ? parseTomlSubset(text)
    : parseJsonc(text);

  const services: RailwayService[] = [];

  // Multi-service JSON: `{ "services": { "api": { ... }, "worker": { ... } } }`
  // or `{ "services": [ { "name": "api", ... } ] }`
  if (tree.services) {
    if (Array.isArray(tree.services)) {
      for (const s of tree.services as RailwayTree[]) {
        if (s && typeof s === 'object') {
          services.push(parseServiceBlock(s as RailwayTree, `service-${services.length + 1}`));
        }
      }
    } else if (typeof tree.services === 'object') {
      for (const [svcName, svcObj] of Object.entries(tree.services as Record<string, unknown>)) {
        if (svcObj && typeof svcObj === 'object') {
          const svc = parseServiceBlock(svcObj as RailwayTree, svcName);
          // If the block doesn't name itself, use the map key.
          if (svc.name === svcName || !svc.name) svc.name = svcName;
          services.push(svc);
        }
      }
    }
  }

  // Single-service: the root IS the service config.
  if (services.length === 0) {
    const svc = parseServiceBlock(tree, 'app');
    services.push(svc);
  }

  const projectEnvVars = recordOf(tree.variables) ?? recordOf(tree.envVars) ?? recordOf(tree.env);

  return { services, projectEnvVars };
}

// ---------------------------------------------------------------------------
// nixpacks.toml parser.
//
// nixpacks.toml drives the Nixpacks builder. We extract the start/build
// commands and any declared providers (node, python, rust …) so we can label
// the service node's metadata with the detected runtime.
//
// Relevant keys: `[phases.build]` cmd, `[phases.start]` cmd, `providers`.

export interface NixpacksConfig {
  buildCmd?: string;
  startCmd?: string;
  providers?: string[];
}

export function parseNixpacksConfig(text: string): NixpacksConfig {
  const tree = parseTomlSubset(text);

  // Phases: `[phases.build]` / `[phases.start]` in toml.
  // After parseTomlSubset, these land as tree.phases.build / tree.phases.start.
  const phases = tree.phases as RailwayTree | undefined;
  const buildPhase = phases?.build as RailwayTree | undefined;
  const startPhase = phases?.start as RailwayTree | undefined;

  const buildCmd = strOf(buildPhase?.cmd) ?? strOf(tree.buildCommand);
  const startCmd = strOf(startPhase?.cmd) ?? strOf(tree.startCommand);

  // Providers can be `providers = ["node"]` at top level.
  const rawProviders = tree.providers;
  const providers = Array.isArray(rawProviders)
    ? rawProviders.filter((p): p is string => typeof p === 'string')
    : undefined;

  return { buildCmd, startCmd, providers };
}

// ---------------------------------------------------------------------------
// Procfile parser (Heroku / Railway legacy).
//
// Format: `<process_type>: <command>`
// We look for `web:` and `worker:` process types.

export interface ProcfileEntry {
  process: string;
  command: string;
}

export function parseProcfile(text: string): ProcfileEntry[] {
  const entries: ProcfileEntry[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const process = line.slice(0, colon).trim();
    const command = line.slice(colon + 1).trim();
    if (process && command) entries.push({ process, command });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// package.json framework detector (lightweight — no full parse needed).
// Returns a short label: 'next' | 'remix' | 'vite' | 'express' | etc.

const FRAMEWORK_DEPS: Array<[RegExp, string]> = [
  [/^next$/, 'next'],
  [/^remix/, 'remix'],
  [/^@remix-run\//, 'remix'],
  [/^nuxt/, 'nuxt'],
  [/^@nuxtjs\//, 'nuxt'],
  [/^gatsby$/, 'gatsby'],
  [/^astro$/, 'astro'],
  [/^@sveltejs\/kit/, 'sveltekit'],
  [/^svelte$/, 'svelte'],
  [/^@angular\/core/, 'angular'],
  [/^fastify$/, 'fastify'],
  [/^express$/, 'express'],
  [/^hono$/, 'hono'],
  [/^koa$/, 'koa'],
  [/^nestjs$|^@nestjs\/core/, 'nestjs'],
];

export function detectFramework(packageJsonText: string): string | undefined {
  let parsed: RailwayTree;
  try {
    parsed = parseJsonc(packageJsonText);
  } catch {
    return undefined;
  }
  const deps = {
    ...((parsed.dependencies ?? {}) as Record<string, unknown>),
    ...((parsed.devDependencies ?? {}) as Record<string, unknown>),
  };
  for (const [re, label] of FRAMEWORK_DEPS) {
    if (Object.keys(deps).some((k) => re.test(k))) return label;
  }
  return undefined;
}
