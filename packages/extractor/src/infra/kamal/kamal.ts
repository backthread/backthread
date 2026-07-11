// the Kamal InfraAdapter (net-new infra coverage, child of ).
//
// Kamal (Basecamp/DHH) builds a Docker image from your repo and deploys it to
// VPS hosts (the Rails-world Heroku-replacement). It's image-referencing, so it
// reuses the  image→source resolver, and self-hosted-container-shaped, so
// it reuses the docker-compose image-role token map for its accessories.
//
// Kind mapping (locked 8-kind InfraModuleKind enum — map onto it, never weaken):
//   the app `service` (built + deployed)        → container  (your code, an image)
//   accessories, by image role (compose map):
//     postgres/mysql/mongo/redis/…              → datastore
//     kafka/rabbitmq/nats/…                     → queue
//     anything else                             → container
//
// sourceRoots, in precedence order (deterministic, no LLM):
//   1. `builder.context` — the explicit build-context dir (direct source).
//   2. `builder.dockerfile` — its dir (direct source).
//   3. else `image:` → the  resolver (image → in-repo Dockerfile build
//      context). A repo-root build context ('' — the common root-Dockerfile
//      monolith) is dropped: per the locked rule we NEVER emit a bare repo-root
//      (it'd swallow siblings), so that code honestly stays "Other (not deployed)."
// Accessories pull prebuilt images → they run no code of yours → no source root.
//
// Edges: app → accessory, verb by accessory kind (datastore→stores-in,
// queue→publishes, else calls) — the docker-compose precedent.
//
// Zone label: "Kamal" (PROVIDER_ZONE_LABEL['kamal'] in assemble/zones.ts).
// Config-only (reads config/deploy.yml + the repo's Dockerfiles, not app source);
// the relevance gate catches config/deploy*.yml. Deterministic, no LLM.

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { findFiles } from '../walk.js';
import { classifyImage } from '../compose/compose.js';
import { buildDockerfileIndex, resolveImageToSourceRoots, type DockerfileIndex } from '../image-resolve.js';
import { parseKamalConfig, type KamalConfig } from './kamal-parse.js';

// `config/deploy.yml` + env-destination variants (`config/deploy.production.yml`),
// path-scoped (a bare `deploy.yml` basename is too generic — CI files use it).
const KAMAL_CONFIG_RE = /(^|\/)config\/deploy(\.[A-Za-z0-9_-]+)?\.ya?ml$/;
/** The base config (no env suffix) — preferred when several variants exist. */
const KAMAL_BASE_RE = /(^|\/)config\/deploy\.ya?ml$/;

// ---------------------------------------------------------------------------
// Path helpers (repo-relative, normalized) — same idiom as compose.ts/sst.ts.

function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
}
function dirOfPath(relPath: string): string {
  const n = normalizeRoot(relPath);
  const i = n.lastIndexOf('/');
  return i === -1 ? '' : n.slice(0, i);
}

// ---------------------------------------------------------------------------
// Node-id helpers (adapter-local; registry prefixes `kamal:` at merge time).

const appId = (service: string) => `app:${service}`;
const accessoryId = (name: string) => `accessory:${name}`;

// ---------------------------------------------------------------------------
// the app's deployment-target source roots.

/**
 * The repo-relative source roots the Kamal app deploys. builder.context /
 * builder.dockerfile are DIRECT signals (preferred); else the image ref is run
 * through the  resolver. Repo-root resolutions are dropped (never a
 * catch-all). Pure (the resolver index is injected). Deterministic + sorted.
 */
export function kamalAppSourceRoots(config: KamalConfig, dockerfileIndex?: DockerfileIndex): string[] {
  const roots = new Set<string>();

  // 1 + 2 — direct builder signals (a `.`/repo-root context normalizes to '' and
  // is dropped, falling through to the resolver).
  const context = config.builder?.context ? normalizeRoot(config.builder.context) : '';
  if (context) roots.add(context);
  const dfDir = config.builder?.dockerfile ? dirOfPath(config.builder.dockerfile) : '';
  if (dfDir) roots.add(dfDir);

  // 3 — no direct signal → resolve the image to an in-repo Dockerfile context.
  if (roots.size === 0 && config.image && dockerfileIndex) {
    for (const r of resolveImageToSourceRoots(config.image, dockerfileIndex)) roots.add(r);
  }

  return [...roots].sort();
}

// ---------------------------------------------------------------------------
// Pure graph builder. Parsed config + the Dockerfile index injected so it's
// unit-testable with no real repo (the compose/render split).

/** Edge verb for an app→accessory dependency, by the accessory's kind. */
function accessoryVerb(kind: InfraNode['kind']): InfraEdge['kind'] {
  if (kind === 'datastore') return 'stores-in';
  if (kind === 'queue') return 'publishes';
  return 'calls';
}

export function buildKamalGraph(
  args: { config: KamalConfig; configFile: string; dockerfileIndex?: DockerfileIndex },
  root: string,
): InfraGraph {
  const { config, configFile, dockerfileIndex } = args;
  const nodes: InfraNode[] = [];
  const edges: InfraEdge[] = [];

  // The app service → a container (it runs YOUR code, built from a Dockerfile).
  const appName = config.service ?? 'app';
  const id = appId(appName);
  const roots = kamalAppSourceRoots(config, dockerfileIndex);
  nodes.push({
    id,
    label: appName,
    kind: 'container',
    provenance: 'declared',
    metadata: { provider: 'kamal', config: configFile, ...(config.image ? { image: config.image } : {}) },
    ...(roots.length ? { sourceRoots: roots } : {}),
  });

  // Accessories → classified by image role; pulled images run no code → no source.
  for (const acc of config.accessories) {
    const kind = acc.image ? classifyImage(acc.image) : 'container';
    const accId = accessoryId(acc.name);
    nodes.push({
      id: accId,
      label: acc.name,
      kind,
      provenance: 'declared',
      metadata: { provider: 'kamal', config: configFile, ...(acc.image ? { image: acc.image } : {}) },
    });
    edges.push({ source: id, target: accId, kind: accessoryVerb(kind), metadata: { via: 'kamal-accessory' } });
  }

  return { root, adapter: 'kamal', nodes, edges, classificationsNeeded: [] };
}

// ---------------------------------------------------------------------------
// Adapter.

function findKamalConfigs(repoDir: string): string[] {
  // Match the REPO-RELATIVE path (not the absolute one) so the `config/deploy…`
  // path-scoping can't be skewed by the repo's checkout location — consistent
  // with extract()'s KAMAL_BASE_RE.test(rel(f)).
  return findFiles(
    repoDir,
    (abs) => KAMAL_CONFIG_RE.test((relative(repoDir, abs) || abs).split('\\').join('/')),
    { maxDepth: 5 },
  );
}

export const kamalAdapter: InfraAdapter = {
  name: 'kamal',

  async detect(repoDir: string): Promise<boolean> {
    if (existsSync(join(repoDir, 'config', 'deploy.yml')) || existsSync(join(repoDir, 'config', 'deploy.yaml'))) {
      return true;
    }
    if (findKamalConfigs(repoDir).length > 0) return true;
    // Secondary: the `.kamal/` dir (secrets/hooks) — present in a Kamal repo.
    return existsSync(join(repoDir, '.kamal'));
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const rel = (abs: string) => (relative(repoDir, abs) || abs).split('\\').join('/');
    const files = findKamalConfigs(repoDir);
    if (files.length === 0) {
      // detect() may have fired on `.kamal/` alone — nothing to parse.
      return { root: repoDir, adapter: 'kamal', nodes: [], edges: [], classificationsNeeded: [] };
    }
    // Prefer the base config/deploy.yml; env-destination variants override only
    // servers/env (not the app/accessory topology) — merging them is a v0 deferral.
    const base = files.find((f) => KAMAL_BASE_RE.test(rel(f))) ?? files[0];
    let config: KamalConfig;
    try {
      config = parseKamalConfig(readFileSync(base, 'utf8'));
    } catch (err) {
      console.warn(`  [kamal] skipping unparseable ${rel(base)}: ${(err as Error).message}`);
      return { root: repoDir, adapter: 'kamal', nodes: [], edges: [], classificationsNeeded: [] };
    }
    return buildKamalGraph({ config, configFile: rel(base), dockerfileIndex: buildDockerfileIndex(repoDir) }, repoDir);
  },
};
