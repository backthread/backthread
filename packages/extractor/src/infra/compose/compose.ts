// the docker-compose InfraAdapter.
//
// Surfaces the self-hosted container topology a Compose file declares — the
// shape of the typical ICP microservices repo (and marola's). Entirely
// `declared` provenance: the compose file literally names every service, its
// build context, and its dependencies. No LLM (classificationsNeeded: []).
//
// Kind mapping (locked 8-kind InfraModuleKind enum — map onto it, never weaken):
//   service with `build:`        → container   (your code, built from a context dir)
//   service with `image:` only:
//     postgres/mysql/mongo/redis/…→ datastore   (a pulled data store)
//     kafka/rabbitmq/nats/…       → queue       (a pulled message bus)
//     anything else               → container   (a self-hosted prebuilt workload)
//   service with neither          → container   (defensive; topology not lost)
//
// Edge taxonomy (8-verb EdgeKind — FORBIDDEN: imports/depends-on/uses):
//   depends_on a datastore → stores-in
//   depends_on a queue     → publishes   (compose can't tell produce vs consume; a
//                                          dependent typically produces — honest default)
//   depends_on else        → calls
//
// sourceRoots: for a `build:` service, the build CONTEXT dir is exactly
// "what this container deploys" — Docker sends that dir to the daemon. We resolve
// it repo-relative (against the compose file's location). An image-only service
// pulls a prebuilt image → runs no code of yours → no source root. A context that
// resolves to the repo root ('') is dropped (not a catch-all that swallows all code).
//
// Zone label: "Docker Compose" (PROVIDER_ZONE_LABEL['compose'] in zones.ts) — the
// honest "where it runs" = your own container host, not a cloud provider.
//
// v0 scope (deferred, tracked under ): shared-networks edges (too noisy —
// every service shares the default network); per-service Dockerfile COPY refinement
// of the source root (the build context dir is the documented, sufficient signal).

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { InfraModuleKind } from '../../types.js';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { findFiles } from '../walk.js';
import { parseComposeConfig, type ComposeConfig } from './compose-parse.js';

// A compose file basename: `docker-compose.yml`, `compose.yaml`,
// `docker-compose.prod.yml`, `compose.override.yaml`, … but NOT `composer.yaml`.
const COMPOSE_RE = /^(docker-compose|compose)(\.[A-Za-z0-9_-]+)?\.ya?ml$/i;

function findComposeFiles(repoDir: string): string[] {
  return findFiles(repoDir, (_abs, e) => COMPOSE_RE.test(e.name), { maxDepth: 5 });
}

// ---------------------------------------------------------------------------
// Path helpers (repo-relative, normalized). Compose `build.context` is relative
// to the compose file's own dir and may contain `./` and `../`.

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

// ---------------------------------------------------------------------------
// Image-role classification (image-only services). Heuristic on the image's base
// name (after the last `/`, before the `:tag`/`@digest`) — covers the common
// data-store / message-bus images so they render as the right kind instead of an
// undifferentiated container.

const DATASTORE_TOKENS = [
  'postgres', 'postgis', 'mysql', 'mariadb', 'mongo', 'redis', 'valkey', 'keydb',
  'memcached', 'elasticsearch', 'opensearch', 'clickhouse', 'cassandra', 'scylla',
  'cockroach', 'influxdb', 'neo4j', 'couchdb', 'rethinkdb', 'minio', 'timescale',
];
const QUEUE_TOKENS = [
  'rabbitmq', 'kafka', 'redpanda', 'nats', 'zookeeper', 'activemq', 'pulsar',
  'mosquitto', 'emqx',
];

function imageBase(image: string): string {
  const noTag = image.split('@')[0].split(':')[0];
  const parts = noTag.split('/');
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

// Exported so the Kamal adapter reuses the same image-role token map
// for classifying its accessory images (postgres→datastore, kafka→queue, …)
// instead of duplicating the token lists a third time.
export function classifyImage(image: string): InfraModuleKind {
  const base = imageBase(image);
  if (DATASTORE_TOKENS.some((t) => base.includes(t))) return 'datastore';
  if (QUEUE_TOKENS.some((t) => base.includes(t))) return 'queue';
  return 'container';
}

// ---------------------------------------------------------------------------
// Node-id helpers (adapter-local; registry prefixes `compose:` at merge time).

const serviceId = (name: string) => `service:${name}`;

// ---------------------------------------------------------------------------
// Pure graph builder — parsed configs (+ their repo-relative compose-file dir)
// → InfraGraph. Separated from the fs walk so it's unit-testable with no real repo.

export interface ComposeConfigEntry {
  config: ComposeConfig;
  /** Repo-relative path of the compose file (provenance + context base). */
  file: string;
}

export function buildComposeGraph(entries: ComposeConfigEntry[], root: string): InfraGraph {
  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];
  const kindByService = new Map<string, InfraModuleKind>();

  const addNode = (n: InfraNode) => {
    // First declaration wins (a service redefined by an override file keeps its
    // base node) — same pattern as cloudflare.ts / render.ts.
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  // Pass 1: nodes. Every service becomes a node; remember each service's kind so
  // pass-2 edges can pick the right verb.
  for (const { config, file } of entries) {
    const composeDir = dirOf(file);
    for (const svc of config.services) {
      const id = serviceId(svc.name);

      if (svc.build) {
        // Builds from source → a container that runs YOUR code. The build context
        // dir is the source root (dropped if it resolves to the repo root).
        const context = resolveRel(composeDir, svc.build.context);
        const node: InfraNode = {
          id,
          label: svc.name,
          kind: 'container',
          provenance: 'declared',
          metadata: {
            provider: 'compose',
            config: file,
            build: svc.build.context,
            ...(svc.build.dockerfile ? { dockerfile: svc.build.dockerfile } : {}),
            ...(svc.image ? { image: svc.image } : {}),
          },
          ...(context ? { sourceRoots: [context] } : {}),
        };
        addNode(node);
        if (!kindByService.has(svc.name)) kindByService.set(svc.name, 'container');
        continue;
      }

      // Image-only (or neither): pulled/prebuilt → classify by role, no source root.
      const kind: InfraModuleKind = svc.image ? classifyImage(svc.image) : 'container';
      addNode({
        id,
        label: svc.name,
        kind,
        provenance: 'declared',
        metadata: { provider: 'compose', config: file, ...(svc.image ? { image: svc.image } : {}) },
      });
      if (!kindByService.has(svc.name)) kindByService.set(svc.name, kind);
    }
  }

  // Pass 2: depends_on edges. Verb keyed by the TARGET's kind (now fully known).
  const edgeKeys = new Set<string>();
  for (const { config, file } of entries) {
    for (const svc of config.services) {
      for (const dep of svc.dependsOn) {
        if (!kindByService.has(dep)) continue; // dep not a declared service → skip
        const depKind = kindByService.get(dep)!;
        const kind: InfraEdge['kind'] =
          depKind === 'datastore' ? 'stores-in' : depKind === 'queue' ? 'publishes' : 'calls';
        const source = serviceId(svc.name);
        const target = serviceId(dep);
        const key = `${source}→${target}:${kind}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ source, target, kind, metadata: { via: 'depends_on', config: file } });
      }
    }
  }

  return {
    root,
    adapter: 'compose',
    nodes: [...nodes.values()],
    edges,
    classificationsNeeded: [], // compose's model maps statically — no LLM
  };
}

// ---------------------------------------------------------------------------
// Adapter.

export const dockerComposeAdapter: InfraAdapter = {
  name: 'compose',

  async detect(repoDir: string): Promise<boolean> {
    return findComposeFiles(repoDir).length > 0;
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const files = findComposeFiles(repoDir);
    const entries: ComposeConfigEntry[] = [];
    for (const file of files) {
      try {
        const config = parseComposeConfig(readFileSync(file, 'utf8'));
        entries.push({ config, file: (relative(repoDir, file) || file).split('\\').join('/') });
      } catch (err) {
        // A single malformed compose file shouldn't sink the whole infra layer.
        console.warn(`  [compose] skipping unparseable ${file}: ${(err as Error).message}`);
      }
    }
    return buildComposeGraph(entries, repoDir);
  },
};
