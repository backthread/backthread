// the Fly.io InfraAdapter (v0).
//
// Surfaces the Fly.io deployment topology from `fly.toml` (and optionally a
// Dockerfile and `.fly/` overlays). Entirely declared provenance — fly.toml
// names every Machine and Volume explicitly; no LLM needed (classificationsNeeded: []).
//
// Kind mapping (locked 8-kind InfraModuleKind enum — never weaken):
//   Fly Machine / process group → container  (Docker container running on Firecracker)
//   Fly Volume (mount source)   → datastore  (persistent block storage)
//
// Edge taxonomy (8-verb EdgeKind — FORBIDDEN: imports/depends-on/uses):
//   container → datastore : stores-in   (from [[mounts]] source)
//   container → container : calls       (only if statically declared between processes)
//
// v0 scope:
//   * [processes] with N named processes → N container nodes (one per process).
//     Without [processes], a single container node labelled from `app`.
//   * [[mounts]] → one datastore node per unique `source` volume name;
//     each container that mounts it gets a `stores-in` edge.
//   * Machine-to-machine `calls` edges: only emitted when [processes] declares
//     a relationship — we do NOT invent edges that aren't statically declared.
//     (In practice fly.toml has no cross-process dependency field, so no `calls`
//     edges in the default implementation — see DoD note in .)
//   * Dockerfile presence → metadata.image on the app container node.
//   * regions / [[vm]] sizing / internal_port → metadata only.
//   * `.fly/` overlays are read if present but treated as additional fly.toml
//     fragments; they don't change the node/edge model.

import { readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { findFiles } from '../walk.js';
import { parseFlyConfig, type FlyConfig } from './fly-parse.js';

/**
 * Locate every `fly.toml` in the repo (bounded recursive walk).
 * Also picks up `.fly/fly.toml` overlays.
 */
function findFlyConfigs(repoDir: string): string[] {
  return findFiles(repoDir, (_abs, e) => e.name === 'fly.toml', { maxDepth: 5 });
}

// ---------------------------------------------------------------------------
// Source-root helper. Repo-relative, normalized.

/** Normalize a repo-relative path: backslashes→/, collapse `.`/`./`, strip trailing `/`. */
function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Node-id helpers (adapter-local; registry prefixes `fly:` at merge time).
//
// IDs are scoped by app name to prevent monorepo collisions:
//   single-process:  machine:<app>
//   multi-process:   machine:<app>/<process>
//   volume:          volume:<app>/<volumeName>

const machineId = (app: string, processName?: string) =>
  processName ? `machine:${app}/${processName}` : `machine:${app}`;
const volumeId = (app: string, volumeName: string) => `volume:${app}/${volumeName}`;

// ---------------------------------------------------------------------------
// Dockerfile probe — a quick existence check rather than a full parse.
//
// Resolution order:
//   1. build.dockerfile (if set) — resolved relative to config dir.
//   2. <configDir>/Dockerfile   — conventional adjacent location.
//   3. <repoRoot>/Dockerfile    — monorepo root fallback.
//
// Returns { path, isCustom } so the caller can surface `buildDockerfile` in
// metadata when a non-default path was explicitly declared in [build].

interface DockerfileResult {
  path: string;
  /** True when `build.dockerfile` named an explicit non-default path. */
  isCustom: boolean;
}

function findDockerfile(
  repoDir: string,
  configFile: string,
  buildDockerfile?: string,
): DockerfileResult | undefined {
  const configDir = dirname(configFile);

  // 1. Honour an explicit [build] dockerfile declaration.
  if (buildDockerfile) {
    const explicit = join(configDir, buildDockerfile);
    if (existsSync(explicit)) {
      return { path: relative(repoDir, explicit), isCustom: true };
    }
    // Declared but not found — still record the declared path so it isn't lost.
    return { path: buildDockerfile, isCustom: true };
  }

  // 2 + 3. Default probe locations.
  for (const candidate of [join(configDir, 'Dockerfile'), join(repoDir, 'Dockerfile')]) {
    if (existsSync(candidate)) return { path: relative(repoDir, candidate), isCustom: false };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pure graph builder — takes already-parsed FlyConfig + metadata, emits InfraGraph.

export interface FlyConfigEntry {
  config: FlyConfig;
  file: string;
  /**
   * @deprecated The builder now resolves the Dockerfile path itself using
   * `build.dockerfile` + the default probe. This field is ignored by
   * `buildFlyGraph`; kept for interface compatibility only.
   */
  dockerfilePath?: string;
}

export function buildFlyGraph(configs: FlyConfigEntry[], root: string): InfraGraph {
  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];

  const addNode = (n: InfraNode) => {
    // First declaration wins (same pattern as cloudflare.ts).
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  for (const { config, file } of configs) {
    const rel = relative(root, file) || file;
    const { appMissing, primary_region, build, processes, services, mounts, vms } = config;

    // -----------------------------------------------------------------------
    // Fix #5: stable app identifier.
    //
    // When `app` was missing/unparseable in the TOML, derive a fallback from
    // the config file path (e.g. "apps/api/fly.toml" → "apps/api") rather
    // than silently using a fixed constant ('app') that causes all anonymous
    // configs to merge into one node.
    const app: string = appMissing
      ? (relative(root, dirname(file)) || basename(dirname(file)) || 'unknown')
      : config.app;

    // -----------------------------------------------------------------------
    // Fix #4: Dockerfile resolution respects [build] dockerfile declaration.
    const dfResult = findDockerfile(root, file, build?.dockerfile);

    // -----------------------------------------------------------------------
    // the app's source root = Fly's build CONTEXT, which is the dir
    // that holds fly.toml (Fly's deploy cwd). The `[build].dockerfile` is just
    // the recipe path within that context, so the context — not the Dockerfile's
    // own dir — is what actually deploys (a `docker/Dockerfile.api` recipe still
    // builds the whole app dir). A `[build].image` (prebuilt) app runs no code of
    // ours → no source root (honest "Other"); image-only is deferred to the
    // resolver path, not Fly's primary in-repo-Dockerfile path. The bare
    // repo root ('') is never emitted — no catch-all swallowing sibling units.
    const configDir = normalizeRoot(relative(root, dirname(file)));
    const buildsFromSource = !build?.image;
    const appSourceRoots = buildsFromSource && configDir ? [configDir] : [];

    // -----------------------------------------------------------------------
    // 1. Determine container node(s).
    //
    // If [processes] is declared, one container per named process (e.g. `web`,
    // `worker`, `release`). Otherwise, a single container for the whole app.
    //
    // Fix #1 + #3: IDs are scoped by app name → machine:<app> (single-process)
    // or machine:<app>/<proc> (multi-process), preventing cross-app collisions.

    const processNames = Object.keys(processes);
    const containerIds: string[] = [];

    if (processNames.length > 0) {
      for (const pName of processNames) {
        // Fix #1: scope by app/proc
        const id = machineId(app, pName);
        containerIds.push(id);

        // vm sizing metadata for this process group
        const vmForProcess = vms.find((v) => v.processes?.includes(pName));
        const vmMeta = vmForProcess
          ? { vmSize: vmForProcess.size, vmMemory: vmForProcess.memory, vmCpuKind: vmForProcess.cpu_kind }
          : {};

        // service port metadata for this process group
        const svcForProcess = services.find((s) => s.processes?.includes(pName));
        const svcMeta = svcForProcess ? { internalPort: svcForProcess.internal_port } : {};

        addNode({
          id,
          label: `${app} / ${pName}`,
          kind: 'container',
          provenance: 'declared',
          metadata: {
            app,
            process: pName,
            command: processes[pName],
            config: rel,
            ...(primary_region ? { primaryRegion: primary_region } : {}),
            ...(dfResult ? { dockerfile: dfResult.path } : {}),
            // Fix #4: surface explicit build.dockerfile path under buildDockerfile key
            ...(dfResult?.isCustom ? { buildDockerfile: dfResult.path } : {}),
            ...(build?.image ? { image: build.image } : {}),
            ...vmMeta,
            ...svcMeta,
          },
          ...(appSourceRoots.length ? { sourceRoots: appSourceRoots } : {}),
        });
      }
    } else {
      // Single-process app.
      // Fix #3: use machineId(app) — same app-scoped form as multi-process
      const id = machineId(app);
      containerIds.push(id);

      const vmMeta = vms[0]
        ? { vmSize: vms[0].size, vmMemory: vms[0].memory, vmCpuKind: vms[0].cpu_kind }
        : {};

      const svcMeta = services[0] ? { internalPort: services[0].internal_port } : {};

      addNode({
        id,
        label: app,
        kind: 'container',
        provenance: 'declared',
        metadata: {
          app,
          config: rel,
          ...(primary_region ? { primaryRegion: primary_region } : {}),
          ...(dfResult ? { dockerfile: dfResult.path } : {}),
          // Fix #4: surface explicit build.dockerfile path under buildDockerfile key
          ...(dfResult?.isCustom ? { buildDockerfile: dfResult.path } : {}),
          ...(build?.image ? { image: build.image } : {}),
          ...vmMeta,
          ...svcMeta,
        },
        ...(appSourceRoots.length ? { sourceRoots: appSourceRoots } : {}),
      });
    }

    // -----------------------------------------------------------------------
    // 2. Volumes from [[mounts]].
    //
    // Fix #2: volume IDs are scoped by app (`volume:<app>/<name>`) because
    // Fly volumes are per-app — two apps with the same volume name are
    // distinct resources.

    for (const mount of mounts) {
      const volId = volumeId(app, mount.source);
      addNode({
        id: volId,
        label: mount.source,
        kind: 'datastore',
        provenance: 'declared',
        metadata: {
          provider: 'fly',
          app,
          volumeName: mount.source,
          destination: mount.destination,
          config: rel,
        },
      });

      // Determine which containers mount this volume.
      let mountingContainers: string[];
      if (mount.processes && mount.processes.length > 0) {
        // Mount scoped to specific process groups.
        // Fix #1: resolve process names using the app-scoped machineId
        mountingContainers = mount.processes
          .map((proc) => machineId(app, proc))
          .filter((id) => containerIds.includes(id));
      } else {
        // Mount shared across all containers in this config.
        mountingContainers = [...containerIds];
      }

      for (const cId of mountingContainers) {
        edges.push({
          source: cId,
          target: volId,
          kind: 'stores-in',
          metadata: { destination: mount.destination, config: rel },
        });
      }
    }

    // -----------------------------------------------------------------------
    // NOTE on Machine-to-machine `calls` edges:
    // fly.toml has no cross-process dependency declaration syntax. We do NOT
    // invent edges — "Only test edge kinds you actually emit". If a
    // future fly.toml extension adds a declared dependency field, add it here.
  }

  return {
    root,
    adapter: 'fly',
    nodes: [...nodes.values()],
    edges,
    classificationsNeeded: [], // Fly's model is tight + static — no LLM needed
  };
}

// ---------------------------------------------------------------------------
// Adapter

export const flyAdapter: InfraAdapter = {
  name: 'fly',

  async detect(repoDir: string): Promise<boolean> {
    // Cheap: just check if fly.toml exists anywhere (bounded walk).
    return findFlyConfigs(repoDir).length > 0;
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const files = findFlyConfigs(repoDir);
    const entries: FlyConfigEntry[] = [];

    for (const file of files) {
      try {
        const text = readFileSync(file, 'utf8');
        const config = parseFlyConfig(text);
        // Dockerfile resolution now happens inside buildFlyGraph (Fix #4),
        // so we no longer pre-compute dockerfilePath here.
        entries.push({ config, file });
      } catch (err) {
        // A single malformed config shouldn't sink the whole infra layer.
        console.warn(`  [fly] skipping unparseable ${file}: ${(err as Error).message}`);
      }
    }

    return buildFlyGraph(entries, repoDir);
  },
};
