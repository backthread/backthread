// the Render InfraAdapter (v0).
//
// Surfaces the Render PaaS deployment topology from `render.yaml` (the
// Render Blueprint Spec). Entirely declared provenance — render.yaml names
// every service, database, and Redis instance explicitly. No LLM needed
// (classificationsNeeded: []).
//
// Kind mapping (locked 8-kind InfraModuleKind enum — never weaken):
//   render.yaml services[].type:
//     web / pserv / worker / cron → `worker`  (serverless/long-running compute)
//     static                      → `static-site`
//   render.yaml databases[]       → `datastore` (managed Postgres)
//   render.yaml redis[]            → `datastore` (managed Redis/KeyValue)
//
// Edge taxonomy (8-verb EdgeKind — FORBIDDEN: imports/depends-on/uses):
//   service → datastore   : stores-in   (via envVars[].fromDatabase)
//   service → service     : calls       (via envVars[].fromService)
//
// v0 scope:
//   * envVars with fromDatabase → edge service `stores-in` the named datastore.
//   * envVars with fromService  → edge service `calls` the named peer service.
//   * Dockerfile presence noted in metadata only.
//   * package.json buildCommand noted in metadata only.
//   * PaaS model is tight/static — no LLM needed.

import { readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { findFiles } from '../walk.js';
import { parseRenderConfig, type RenderConfig, type RenderService } from './render-parse.js';

/**
 * Locate every `render.yaml` in the repo (bounded recursive walk).
 * render.yaml is almost always at the repo root, but monorepos can have one
 * per sub-project, so we walk the full tree.
 */
function findRenderConfigs(repoDir: string): string[] {
  return findFiles(repoDir, (_abs, e) => e.name === 'render.yaml' || e.name === 'render.yml', { maxDepth: 5 });
}

// ---------------------------------------------------------------------------
// Source-root helpers. Repo-relative, normalized — same idiom as
// netlify.ts / compose.ts.

/** Normalize a repo-relative path: backslashes→/, collapse `.`/`./`, strip trailing `/`. */
function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
}

/** The repo-relative directory of a repo-relative file path ('' = repo root). */
function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
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
 * a Render service's source root, resolved repo-relative against the
 * render.yaml dir. Priority: explicit `rootDir` (the monorepo base dir) → Docker
 * `dockerContext` → the dir of `dockerfilePath` → the render.yaml dir itself.
 * Returns '' (→ no source root) when the best signal is the bare repo root, so a
 * root-level service never becomes a catch-all swallowing its siblings.
 */
function serviceSourceRoot(svc: RenderService, configDir: string): string {
  if (svc.rootDir) return resolveRel(configDir, svc.rootDir);
  if (svc.dockerContext) return resolveRel(configDir, svc.dockerContext);
  if (svc.dockerfilePath) return dirOf(resolveRel(configDir, svc.dockerfilePath));
  return normalizeRoot(configDir);
}

// ---------------------------------------------------------------------------
// Node-id helpers (adapter-local; registry prefixes `render:` at merge time).

const serviceId = (name: string) => `service:${name}`;
const databaseId = (name: string) => `database:${name}`;
const redisId = (name: string) => `redis:${name}`;

// ---------------------------------------------------------------------------
// Dockerfile probe — existence check only (like fly.ts).

function findDockerfile(repoDir: string, configFile: string): string | undefined {
  // Look adjacent to the render.yaml first, then at repo root.
  const configDir = dirname(configFile);
  for (const candidate of [join(configDir, 'Dockerfile'), join(repoDir, 'Dockerfile')]) {
    if (existsSync(candidate)) return relative(repoDir, candidate);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Read package.json build command (metadata only, no graph impact).

function readPackageJsonBuild(repoDir: string): string | undefined {
  const pkgPath = join(repoDir, 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    const scripts = pkg.scripts;
    if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
      return typeof (scripts as Record<string, unknown>).build === 'string'
        ? ((scripts as Record<string, unknown>).build as string)
        : undefined;
    }
  } catch {
    /* not parseable — skip */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pure graph builder — takes already-parsed RenderConfig + metadata, emits InfraGraph.
// Separated from the fs walk so it can be unit-tested without a real repo dir.

export interface RenderConfigEntry {
  config: RenderConfig;
  file: string;
  dockerfilePath?: string;
  packageJsonBuild?: string;
}

export function buildRenderGraph(configs: RenderConfigEntry[], root: string): InfraGraph {
  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];

  const addNode = (n: InfraNode) => {
    // First declaration wins (same pattern as cloudflare.ts).
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  // Two-pass approach: emit all nodes first, then emit edges.
  // This ensures that when service A references service B via fromService,
  // B's full node (with metadata) is already registered — no placeholder
  // needed, no risk of the placeholder winning the "first declaration" race.

  for (const { config, file, dockerfilePath, packageJsonBuild } of configs) {
    const rel = relative(root, file) || file;

    // -------------------------------------------------------------------
    // Pass 1a: Database nodes (managed Postgres).

    for (const db of config.databases) {
      addNode({
        id: databaseId(db.name),
        label: db.name,
        kind: 'datastore',
        provenance: 'declared',
        metadata: {
          provider: 'render',
          subtype: 'postgres',
          plan: db.plan,
          region: db.region,
          postgresMajorVersion: db.postgresMajorVersion,
          databaseName: db.databaseName,
          user: db.user,
          config: rel,
        },
      });
    }

    // -------------------------------------------------------------------
    // Pass 1b: Redis nodes (managed Redis / KeyValue).

    for (const r of config.redis) {
      addNode({
        id: redisId(r.name),
        label: r.name,
        kind: 'datastore',
        provenance: 'declared',
        metadata: {
          provider: 'render',
          subtype: 'redis',
          plan: r.plan,
          region: r.region,
          config: rel,
        },
      });
    }

    // -------------------------------------------------------------------
    // Pass 1c: Service nodes.
    //    web / worker / cron / pserv → `worker`
    //    static → `static-site`

    const configDir = dirOf(rel);

    for (const svc of config.services) {
      const id = serviceId(svc.name);
      const isStatic = svc.type === 'static';

      // per-service source root from rootDir / dockerContext /
      // dockerfilePath / the render.yaml dir; dropped if it resolves to the bare
      // repo root (no catch-all). Datastores (Postgres/Redis) run no code → none.
      const srcRoot = serviceSourceRoot(svc, configDir);

      addNode({
        id,
        label: svc.name,
        kind: isStatic ? 'static-site' : 'worker',
        provenance: 'declared',
        metadata: {
          provider: 'render',
          serviceType: svc.rawType,
          runtime: svc.runtime,
          plan: svc.plan,
          branch: svc.branch,
          autoDeploy: svc.autoDeploy,
          buildCommand: svc.buildCommand ?? packageJsonBuild,
          startCommand: svc.startCommand,
          ...(dockerfilePath ? { dockerfile: dockerfilePath } : {}),
          config: rel,
        },
        ...(srcRoot ? { sourceRoots: [srcRoot] } : {}),
      });
    }
  }

  // -------------------------------------------------------------------
  // Pass 2: Edges from envVars (all nodes are registered, no placeholders needed).

  for (const { config, file } of configs) {
    const rel = relative(root, file) || file;

    for (const svc of config.services) {
      const id = serviceId(svc.name);

      for (const ev of svc.envVars) {
        // fromDatabase → service stores-in the named database (Postgres or Redis).
        if (ev.fromDatabase?.name) {
          const dbName = ev.fromDatabase.name;
          const isPostgres = config.databases.some((d) => d.name === dbName);
          const isRedis = config.redis.some((r) => r.name === dbName);

          let targetId: string;
          if (isPostgres) {
            targetId = databaseId(dbName);
          } else if (isRedis) {
            targetId = redisId(dbName);
          } else {
            // Name doesn't match any declared datastore in this config.
            // Emit a minimal placeholder so the edge endpoint is never phantom.
            // (Could be declared in a sibling config or added manually later.)
            targetId = databaseId(dbName);
            if (!nodes.has(targetId)) {
              addNode({
                id: targetId,
                label: dbName,
                kind: 'datastore',
                provenance: 'declared',
                metadata: { provider: 'render', subtype: 'postgres', config: rel, placeholder: true },
              });
            }
          }
          edges.push({
            source: id,
            target: targetId,
            kind: 'stores-in',
            metadata: { envKey: ev.key, property: ev.fromDatabase.property, config: rel },
          });
        }

        // fromService → service calls the named peer service.
        if (ev.fromService?.name) {
          const peerId = serviceId(ev.fromService.name);
          // If the peer isn't already in the node map (it's in a different config
          // file or declared only here), add a minimal placeholder so the edge
          // endpoint resolves post-merge (same approach as cloudflare.ts service bindings).
          if (!nodes.has(peerId)) {
            addNode({
              id: peerId,
              label: ev.fromService.name,
              kind: 'worker',
              provenance: 'declared',
              metadata: { provider: 'render', config: rel },
            });
          }
          edges.push({
            source: id,
            target: peerId,
            kind: 'calls',
            metadata: { envKey: ev.key, property: ev.fromService.property, config: rel },
          });
        }
      }
    }
  }

  return {
    root,
    adapter: 'render',
    nodes: [...nodes.values()],
    edges,
    classificationsNeeded: [], // Render's PaaS model is tight/static — no LLM needed
  };
}

// ---------------------------------------------------------------------------
// Adapter

export const renderAdapter: InfraAdapter = {
  name: 'render',

  async detect(repoDir: string): Promise<boolean> {
    // Cheap: just check if render.yaml exists anywhere (bounded walk).
    return findRenderConfigs(repoDir).length > 0;
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const files = findRenderConfigs(repoDir);
    const entries: RenderConfigEntry[] = [];
    const packageJsonBuild = readPackageJsonBuild(repoDir);

    for (const file of files) {
      try {
        const text = readFileSync(file, 'utf8');
        const config = parseRenderConfig(text);
        const dockerfilePath = findDockerfile(repoDir, file);
        entries.push({ config, file, dockerfilePath, packageJsonBuild });
      } catch (err) {
        // A single malformed config shouldn't sink the whole infra layer.
        console.warn(`  [render] skipping unparseable ${file}: ${String(err)}`);
      }
    }

    return buildRenderGraph(entries, repoDir);
  },
};

// ---------------------------------------------------------------------------
// Re-export the pure builder for testing without fs IO.
// (The adapter's extract() is exercised via the fs-backed detect+extract tests.)
