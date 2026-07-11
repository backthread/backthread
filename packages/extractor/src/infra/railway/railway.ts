// the Railway InfraAdapter (v0).
//
// Railway is a PaaS (Platform-as-a-Service) that deploys containerized services
// and managed plugins (Postgres, Redis, MongoDB, MySQL). This adapter reads the
// Railway project config files and emits the deployment topology entirely from
// declared configuration — no LLM, no inference.
//
// Sources (in priority order):
//   1. railway.json / railway.toml — canonical project + service config
//   2. nixpacks.toml               — Nixpacks build config (provider / cmds)
//   3. Procfile                    — legacy Heroku-compat process declarations
//   4. package.json                — framework detection fallback
//
// detect(): positive if railway.json OR railway.toml OR nixpacks.toml exists.
//   Procfile alone is NOT sufficient (ambiguous with Heroku / bare Nixpacks).
//
// Emits:
//   Nodes:
//     - One `worker` node per service declared in railway.json/toml (or one per
//       Procfile process type if no railway config exists but nixpacks.toml does)
//     - One `datastore` node per Railway plugin referenced via ${{Plugin.*}} env
//       vars (Postgres / Redis / MongoDB / MySQL)
//   Edges:
//     - service `stores-in` plugin (from ${{Plugin.*}} env refs)
//     - service `calls` other-service (from ${{OtherService.*}} env refs)
//
// All nodes: provenance = 'declared', classificationsNeeded = [].
// metadata < ~500 bytes per node (no raw file content).

import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { walkRepo } from '../walk.js';
import {
  parseRailwayConfig,
  parseNixpacksConfig,
  parseProcfile,
  detectFramework,
  extractEnvRefs,
  type RailwayConfig,
  type NixpacksConfig,
  type ProcfileEntry,
} from './railway-parse.js';

const RAILWAY_SKIP_DIRS = ['node_modules', '.git', 'dist', '.next', 'build', 'coverage', '.nixpacks'];

// ---------------------------------------------------------------------------
// Source-root helpers. Repo-relative, normalized.

/** Normalize a repo-relative path: backslashes→/, collapse `.`/`./`, strip trailing `/`. */
function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
}

/** Resolve `rel` (may contain `./`/`../`) against repo-relative `baseDir` → normalized. */
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

/**
 * a Railway service's source root. A service's `source`/`rootDirectory`
 * (monorepo sub-path) resolved against the build-context dir is the source root;
 * otherwise the build-context dir itself (where railway.json / nixpacks.toml /
 * Procfile lives = where Nixpacks/Dockerfile builds run). Returns '' (→ no source
 * root) when that's the bare repo root, so a service never becomes a catch-all
 * swallowing its siblings.
 */
function serviceSourceRoot(source: string | undefined, buildContextDir: string): string {
  const base = normalizeRoot(buildContextDir);
  return source ? resolveRel(base, source) : base;
}

// Procfile process types that represent long-running services worth diagramming.
// One-shot types (release, postdeploy, etc.) are transient — they run once per
// deploy and must NOT appear as service nodes in the architecture diagram.
const LONG_RUNNING_PROCESS_TYPES = new Set(['web', 'worker']);

// ---------------------------------------------------------------------------
// File finders.

function listDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const RAILWAY_CONFIG_NAMES = ['railway.json', 'railway.toml'];
const NIXPACKS_NAMES = ['nixpacks.toml'];
const PROCFILE_NAMES = ['Procfile'];

interface FoundFiles {
  railwayConfig?: string; // path to railway.json or railway.toml
  nixpacksConfig?: string;
  procfile?: string;
  packageJson?: string; // nearest root-level package.json
}

/** Shallow root-only scan — used by detect() which must be cheap. */
function findRailwayFilesShallow(repoDir: string): FoundFiles {
  const result: FoundFiles = {};
  for (const e of listDir(repoDir)) {
    if (!e.isFile()) continue;
    if (!result.railwayConfig && RAILWAY_CONFIG_NAMES.includes(e.name)) {
      result.railwayConfig = join(repoDir, e.name);
    }
    if (!result.nixpacksConfig && NIXPACKS_NAMES.includes(e.name)) {
      result.nixpacksConfig = join(repoDir, e.name);
    }
    if (!result.procfile && PROCFILE_NAMES.includes(e.name)) {
      result.procfile = join(repoDir, e.name);
    }
    if (!result.packageJson && e.name === 'package.json') {
      result.packageJson = join(repoDir, e.name);
    }
  }
  return result;
}

/** Full scan (root + bounded deep walk) — used by extract() only. */
function findRailwayFiles(repoDir: string): FoundFiles {
  // Root-level scan first (most configs live at root).
  const result = findRailwayFilesShallow(repoDir);

  // If neither railway config nor nixpacks.toml found at root, do a bounded
  // walk so monorepos with configs in sub-directories are still detected.
  // nixpacks.toml is included here: a nested nixpacks.toml is a valid Railway
  // signal for monorepos, same as a nested railway.json/toml.
  if (!result.railwayConfig && !result.nixpacksConfig) {
    walkRepo(repoDir, {
      skipDirs: RAILWAY_SKIP_DIRS,
      maxDepth: 5,
      onFile: (abs, e) => {
        if (!result.railwayConfig && RAILWAY_CONFIG_NAMES.includes(e.name)) {
          result.railwayConfig = abs;
        } else if (!result.nixpacksConfig && NIXPACKS_NAMES.includes(e.name)) {
          // nixpacks.toml alone is slightly fuzzy (Nixpacks is also used by
          // Render, Netlify, and bare Nixpacks CLIs), but acceptable for v0
          // because the Terraform adapter is the registered fallback for
          // cloud-infra configs and will override this signal when present.
          result.nixpacksConfig = abs;
        }
      },
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Canonical display names for known plugins.
const PLUGIN_LABELS: Record<string, string> = {
  postgres: 'Railway Postgres',
  mysql: 'Railway MySQL',
  mongodb: 'Railway MongoDB',
  mongo: 'Railway MongoDB',
  mssql: 'Railway MSSQL',
  redis: 'Railway Redis',
  rabbitmq: 'Railway RabbitMQ',
};

// ---------------------------------------------------------------------------
// Pure graph builder — takes already-parsed inputs, emits the InfraGraph.

export interface RailwayInputs {
  railwayConfig: RailwayConfig | null;
  nixpacks: NixpacksConfig | null;
  procfile: ProcfileEntry[];
  framework: string | undefined;
  /** Repo-relative path of the railway config file (for metadata). */
  railwayConfigFile: string | undefined;
  /**
   * repo-relative dir the build runs from (the dir of the
   * railway/nixpacks/Procfile config) — the source-root base. '' / undefined =
   * repo root.
   */
  buildContextDir?: string;
}

export function buildRailwayGraph(inputs: RailwayInputs, root: string): InfraGraph {
  const { railwayConfig, nixpacks, procfile, framework, railwayConfigFile } = inputs;
  const buildContextDir = inputs.buildContextDir ?? '';

  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];

  const addNode = (n: InfraNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  // -------------------------------------------------------------------------
  // 1. Service nodes from railway config or Procfile fallback.

  const serviceIds: string[] = []; // adapter-local ids, in declaration order

  if (railwayConfig && railwayConfig.services.length > 0) {
    for (const svc of railwayConfig.services) {
      const id = `service:${svc.name}`;
      serviceIds.push(id);

      const meta: Record<string, unknown> = {
        ...(railwayConfigFile ? { config: railwayConfigFile } : {}),
        ...(svc.builder ? { builder: svc.builder } : {}),
        ...(svc.buildCommand ? { buildCommand: svc.buildCommand } : {}),
        ...(svc.startCommand ? { startCommand: svc.startCommand } : {}),
        ...(svc.source ? { source: svc.source } : {}),
        ...(framework ? { framework } : {}),
        ...(nixpacks?.providers?.length ? { nixpacksProviders: nixpacks.providers } : {}),
      };

      // per-service source root from its source/rootDirectory.
      const srcRoot = serviceSourceRoot(svc.source, buildContextDir);

      addNode({
        id,
        label: svc.name,
        kind: 'worker',
        provenance: 'declared',
        metadata: meta,
        ...(srcRoot ? { sourceRoots: [srcRoot] } : {}),
      });
    }
  } else if (procfile.length > 0) {
    // No railway config, but nixpacks.toml confirmed Railway provenance.
    // Only emit long-running process types (web, worker); one-shot types like
    // release: (db migrations) and postdeploy: are transient and must not
    // appear as service nodes in the architecture diagram.
    for (const entry of procfile) {
      if (!LONG_RUNNING_PROCESS_TYPES.has(entry.process)) continue;
      const id = `service:${entry.process}`;
      serviceIds.push(id);
      // Procfile processes share the build-context dir (no per-process
      // source field); drop the bare repo root.
      const srcRoot = serviceSourceRoot(undefined, buildContextDir);
      addNode({
        id,
        label: entry.process,
        kind: 'worker',
        provenance: 'declared',
        metadata: {
          startCommand: entry.command,
          ...(framework ? { framework } : {}),
          ...(nixpacks?.providers?.length ? { nixpacksProviders: nixpacks.providers } : {}),
        },
        ...(srcRoot ? { sourceRoots: [srcRoot] } : {}),
      });
    }
  } else {
    // Minimal fallback: a single "app" service (nixpacks-only project with no
    // Procfile — common for simple Next.js / Express apps).
    const id = 'service:app';
    serviceIds.push(id);
    // the sole nixpacks/Procfile-less app builds from the build-context
    // dir; drop the bare repo root (root project → honest "Other").
    const srcRoot = serviceSourceRoot(undefined, buildContextDir);
    addNode({
      id,
      label: 'app',
      kind: 'worker',
      provenance: 'declared',
      metadata: {
        ...(nixpacks?.startCmd ? { startCommand: nixpacks.startCmd } : {}),
        ...(nixpacks?.buildCmd ? { buildCommand: nixpacks.buildCmd } : {}),
        ...(framework ? { framework } : {}),
        ...(nixpacks?.providers?.length ? { nixpacksProviders: nixpacks.providers } : {}),
      },
      ...(srcRoot ? { sourceRoots: [srcRoot] } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // 2. Plugin + inter-service edges from env-var references.
  //
  // We scan env vars from the railway config (per-service + project-level) and
  // also any "sample env" strings present in nixpacks metadata.

  // Collect all env-ref text from config.
  let _allEnvText = '';
  if (railwayConfig) {
    for (const svc of railwayConfig.services) {
      if (svc.envVars) _allEnvText += JSON.stringify(svc.envVars) + '\n';
    }
    if (railwayConfig.projectEnvVars) _allEnvText += JSON.stringify(railwayConfig.projectEnvVars);
  }

  // Build a set of known service names (lowercased) for service-ref detection.
  const knownServiceNames = new Set(
    (railwayConfig?.services ?? []).map((s) => s.name.toLowerCase()),
  );
  // For single-service fallback, serviceIds[0] is "service:app" — don't emit
  // self-referencing edges.

  // Map from plugin nameLower → plugin node id.
  const pluginIdByName = new Map<string, string>();
  // Map from ref nameLower → source serviceId that owns the env.
  // We model: if ANY service references a plugin/service, all services do
  // (project-level env is project-wide; per-service env is that service's).
  // For simplicity in v0, emit one edge per (referencing-service, target) pair
  // if per-service data is available, or one edge per (first-service, target)
  // if only project-level is available.

  // Per-service env refs for fine-grained edges.
  if (railwayConfig) {
    for (let i = 0; i < railwayConfig.services.length; i++) {
      const svc = railwayConfig.services[i];
      const srcId = `service:${svc.name}`;
      const svcEnvText = svc.envVars ? JSON.stringify(svc.envVars) : '';
      const svcRefs = extractEnvRefs(svcEnvText);

      for (const ref of svcRefs) {
        if (ref.isPlugin) {
          // Emit plugin datastore node.
          const pluginId = `plugin:${ref.nameLower}`;
          pluginIdByName.set(ref.nameLower, pluginId);
          const label = PLUGIN_LABELS[ref.nameLower] ?? `Railway ${ref.name}`;
          addNode({
            id: pluginId,
            label,
            kind: 'datastore',
            provenance: 'declared',
            metadata: { provider: 'railway', plugin: ref.nameLower },
          });
          // Edge: service stores-in plugin.
          edges.push({ source: srcId, target: pluginId, kind: 'stores-in', metadata: { via: 'env-ref', ref: ref.raw } });
        } else if (knownServiceNames.has(ref.nameLower)) {
          // Inter-service ref: service calls another service.
          const tgtId = `service:${ref.name}`;
          // Don't self-reference.
          if (tgtId !== srcId) {
            edges.push({ source: srcId, target: tgtId, kind: 'calls', metadata: { via: 'env-ref', ref: ref.raw } });
          }
        }
      }
    }
  }

  // Project-level env refs — attach to first service (or sole service).
  if (railwayConfig?.projectEnvVars && serviceIds.length > 0) {
    const projectText = JSON.stringify(railwayConfig.projectEnvVars);
    const projectRefs = extractEnvRefs(projectText);
    const defaultSrc = serviceIds[0];

    for (const ref of projectRefs) {
      if (ref.isPlugin) {
        const pluginId = `plugin:${ref.nameLower}`;
        if (!pluginIdByName.has(ref.nameLower)) {
          pluginIdByName.set(ref.nameLower, pluginId);
          const label = PLUGIN_LABELS[ref.nameLower] ?? `Railway ${ref.name}`;
          addNode({
            id: pluginId,
            label,
            kind: 'datastore',
            provenance: 'declared',
            metadata: { provider: 'railway', plugin: ref.nameLower },
          });
        }
        // Only add edge if not already emitted from per-service scan.
        const alreadyEmitted = edges.some((e) => e.source === defaultSrc && e.target === pluginId && e.kind === 'stores-in');
        if (!alreadyEmitted) {
          edges.push({ source: defaultSrc, target: pluginId, kind: 'stores-in', metadata: { via: 'env-ref', ref: ref.raw } });
        }
      }
    }
  }

  // Deduplicate edges (same source + target + kind).
  const edgeKey = new Set<string>();
  const dedupedEdges: InfraEdge[] = [];
  for (const e of edges) {
    const k = `${e.source}→${e.target}:${e.kind}`;
    if (!edgeKey.has(k)) {
      edgeKey.add(k);
      dedupedEdges.push(e);
    }
  }

  return {
    root,
    adapter: 'railway',
    nodes: [...nodes.values()],
    edges: dedupedEdges,
    classificationsNeeded: [], // PaaS tight static model — no LLM needed
  };
}

// ---------------------------------------------------------------------------
// The InfraAdapter.

export const railwayAdapter: InfraAdapter = {
  name: 'railway',

  async detect(repoDir: string): Promise<boolean> {
    // Cheap root-only existence check — the InfraAdapter contract says detect()
    // runs for every adapter on every repo, so no deep walk here.
    // Positive if railway.json / railway.toml / nixpacks.toml exists at root.
    // Procfile alone is ambiguous with Heroku and is NOT sufficient.
    const files = findRailwayFilesShallow(repoDir);
    return !!(files.railwayConfig || files.nixpacksConfig);
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const found = findRailwayFiles(repoDir);

    let railwayConfig: RailwayConfig | null = null;
    let nixpacks: NixpacksConfig | null = null;
    let procfile: ProcfileEntry[] = [];
    let framework: string | undefined;
    let railwayConfigFile: string | undefined;

    if (found.railwayConfig) {
      railwayConfigFile = relative(repoDir, found.railwayConfig) || found.railwayConfig;
      try {
        railwayConfig = parseRailwayConfig(
          readFileSync(found.railwayConfig, 'utf8'),
          found.railwayConfig,
        );
      } catch (err) {
        console.warn(`  [railway] skipping unparseable ${railwayConfigFile}: ${(err as Error).message}`);
      }
    }

    if (found.nixpacksConfig) {
      try {
        nixpacks = parseNixpacksConfig(readFileSync(found.nixpacksConfig, 'utf8'));
      } catch (err) {
        console.warn(`  [railway] skipping unparseable nixpacks.toml: ${(err as Error).message}`);
      }
    }

    if (found.procfile) {
      try {
        procfile = parseProcfile(readFileSync(found.procfile, 'utf8'));
      } catch {
        // Non-fatal — Procfile is optional.
      }
    }

    if (found.packageJson) {
      try {
        framework = detectFramework(readFileSync(found.packageJson, 'utf8'));
      } catch {
        // Non-fatal.
      }
    }

    // the build runs from the dir of the primary config file (railway
    // config > nixpacks > Procfile). For a monorepo with a nested config that's
    // the sub-project dir; for a root-level project it's '' (→ no catch-all).
    const primaryConfig = found.railwayConfig ?? found.nixpacksConfig ?? found.procfile;
    const buildContextDir = primaryConfig
      ? (relative(repoDir, primaryConfig).replace(/\\/g, '/').split('/').slice(0, -1).join('/'))
      : '';

    return buildRailwayGraph(
      { railwayConfig, nixpacks, procfile, framework, railwayConfigFile, buildContextDir },
      repoDir,
    );
  },
};
