// fly.toml parser + structured shape extractor.
//
// fly.toml is TOML, so we REUSE `parseTomlSubset` from the Cloudflare adapter
// (no new dependency). This module's job is to map the raw parse tree into a
// typed FlyConfig shape that fly.ts consumes — keeping the parser logic and
// the graph builder cleanly separated (same pattern as wrangler-parse.ts ↔
// cloudflare.ts).
//
// Relevant fly.toml top-level sections covered here:
//   app            — string name
//   primary_region — string region code
//   [build]        — dockerfile / image
//   [env]          — environment vars (metadata only)
//   [[services]]   — internal_port, protocol, concurrency, http_checks
//   [[mounts]]     — source (volume name), destination
//   [[vm]]         — size, memory, cpu_kind
//   [processes]    — named process definitions (multi-process apps)

import { parseTomlSubset } from '../cloudflare/wrangler-parse.js';

// Re-export the TOML parser under a fly-specific alias so fly-parse.test.ts
// can import from this module without reaching into cloudflare/.
export { parseTomlSubset as parseFlyToml };

// ---------------------------------------------------------------------------
// Structured shape

export interface FlyService {
  internal_port?: number;
  protocol?: string;
  processes?: string[];
  /** Normalised from [[services]] concurrency block */
  concurrency?: { type?: string; hard_limit?: number; soft_limit?: number };
}

export interface FlyMount {
  /** Volume name — this is what becomes the datastore node id. */
  source: string;
  destination?: string;
  /** Optional process group this mount belongs to */
  processes?: string[];
}

export interface FlyVm {
  size?: string;
  memory?: string;
  cpu_kind?: string;
  processes?: string[];
}

export interface FlyBuild {
  dockerfile?: string;
  image?: string;
  builder?: string;
}

export interface FlyConfig {
  /** Value of the top-level `app` field. */
  app: string;
  /**
   * True when `app` was absent or unparseable in the TOML — signals to the
   * builder that it should derive a stable app name from the config file path
   * rather than trusting the value in `app`.
   */
  appMissing?: boolean;
  primary_region?: string;
  build?: FlyBuild;
  /** Key = process name, value = command string. Empty when no [processes] block. */
  processes: Record<string, string>;
  services: FlyService[];
  mounts: FlyMount[];
  vms: FlyVm[];
  /** Raw env map (for metadata). */
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function arr(tree: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const v = tree[key];
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// ---------------------------------------------------------------------------
// Map raw parse tree → FlyConfig

export function parseFlyConfig(tomlText: string): FlyConfig {
  const tree = parseTomlSubset(tomlText);

  const rawApp = str(tree.app);
  const appMissing = !rawApp;
  // Placeholder — builder replaces this when appMissing is true.
  const app = rawApp ?? '__missing__';
  const primary_region = str(tree.primary_region);

  // [build]
  const buildTree = obj(tree.build);
  const build: FlyBuild | undefined = buildTree
    ? {
        dockerfile: str(buildTree.dockerfile),
        image: str(buildTree.image),
        builder: str(buildTree.builder),
      }
    : undefined;

  // [processes]
  const processesTree = obj(tree.processes);
  const processes: Record<string, string> = {};
  if (processesTree) {
    for (const [k, v] of Object.entries(processesTree)) {
      if (typeof v === 'string') processes[k] = v;
    }
  }

  // [[services]]
  const services: FlyService[] = arr(tree, 'services').map((s) => {
    const concTree = obj(s.concurrency);
    return {
      internal_port: num(s.internal_port),
      protocol: str(s.protocol),
      processes: Array.isArray(s.processes)
        ? (s.processes as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined,
      concurrency: concTree
        ? {
            type: str(concTree.type),
            hard_limit: num(concTree.hard_limit),
            soft_limit: num(concTree.soft_limit),
          }
        : undefined,
    };
  });

  // [[mounts]]
  const mounts: FlyMount[] = arr(tree, 'mounts').flatMap((m) => {
    const source = str(m.source);
    if (!source) return [];
    const mount: FlyMount = {
      source,
      destination: str(m.destination),
      processes: Array.isArray(m.processes)
        ? (m.processes as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined,
    };
    return [mount];
  });

  // [[vm]]
  const vms: FlyVm[] = arr(tree, 'vm').map((v) => ({
    size: str(v.size),
    memory: str(v.memory),
    cpu_kind: str(v.cpu_kind),
    processes: Array.isArray(v.processes)
      ? (v.processes as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined,
  }));

  // [env]
  const envTree = obj(tree.env);
  const env: Record<string, string> | undefined = envTree
    ? Object.fromEntries(
        Object.entries(envTree)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => [k, v as string]),
      )
    : undefined;

  return { app, ...(appMissing ? { appMissing: true } : {}), primary_region, build, processes, services, mounts, vms, env };
}
