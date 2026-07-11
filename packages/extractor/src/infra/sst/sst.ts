// the SST InfraAdapter (net-new infra coverage, child of ).
//
// SST v3 ("Ion") is an AWS-targeting IaC framework for TS apps: `sst.config.ts`
// declares Functions, Services, static sites, buckets, queues, secrets, etc. as
// `new sst.aws.*(...)` call sites. This is the config-as-code sibling of the
// Pulumi adapter — it reuses the same ts-morph construct extraction (sst-parse.ts)
// and the same  image resolver for container image refs.
//
// Kind mapping (locked 8-kind InfraModuleKind enum — map onto it, never weaken):
//   Function / Cron / Api / AppSync        → worker       (serverless compute)
//   Nextjs / Astro / Remix / StaticSite /… → static-site  (built artifact on a CDN)
//   Service / Cluster / Task               → container    (ECS/Fargate workloads)
//   Bucket / Dynamo / Postgres / Aurora /… → datastore
//   Queue / SnsTopic / Bus / Realtime      → queue
//   Secret                                 → secret-store
//   Cdn / Router                           → cdn
// (NB: the epic ticket loosely grouped `Service` under worker/static-site; the
// locked enum has a dedicated `container` kind for exactly ECS/Fargate, so a
// Service maps to `container` — the more precise label, per the adapter discipline
// "map onto the enum correctly; fix the classifier, never weaken it.")
// An UNKNOWN `sst.*` construct (Vpc, Router-as-plumbing, a future type) emits NO
// node and is logged — graceful degradation with no catch-all guessed kind.
//
// sourceRoots, kind-aware + deterministic (literal strings only; a
// `${…}` interpolation is unresolvable → skipped, never guessed):
//   worker      → `handler:` / `job:` file path → its DIR
//   static-site → `path:` → that dir
//   container   → `image: { context }` / `dockerfile:` → its dir; a bare
//                 `image: "ref"` → the  resolver (image → in-repo Dockerfile
//                 build context). Unresolvable → none (honest "Other").
// A source root that resolves to the repo root ('') is dropped (never a catch-all).
//
// Edges: a construct that references another construct's variable (`link: [bucket]`,
// `{ cluster }`) → an edge, verb by the TARGET's kind (datastore→stores-in,
// queue→publishes, secret-store→reads, else calls) — the docker-compose precedent.
//
// Zone label: "SST" (PROVIDER_ZONE_LABEL['sst'] in assemble/zones.ts).
// Config-only (no scansSourcePath — it reads sst.config.ts, not app source; the
// relevance gate catches sst.config.* via diffTouchesInfra). Deterministic, no LLM.

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import type { InfraModuleKind } from '../../types.js';
import { buildDockerfileIndex, resolveImageToSourceRoots, type DockerfileIndex } from '../image-resolve.js';
import { extractSstConstructs, type SstConstruct } from './sst-parse.js';

const CONFIG_NAMES = ['sst.config.ts', 'sst.config.mjs', 'sst.config.js', 'sst.config.cjs'];

// ---------------------------------------------------------------------------
// Construct → InfraModuleKind. Match on the construct's last segment.

const KIND_RULES: Array<[RegExp, InfraModuleKind]> = [
  // Static sites / SSR frameworks (built artifact served from a CDN).
  [/^(?:Nextjs|Astro|Remix|SvelteKit|SolidStart|Nuxt|React|Vue|Angular|TanStackStart|StaticSite)$/, 'static-site'],
  // Serverless compute.
  [/^(?:Function|Cron|Api|ApiGatewayV2|ApiGatewayV1|AppSync)$/, 'worker'],
  // Long-running containers (ECS / Fargate).
  [/^(?:Service|Cluster|Task)$/, 'container'],
  // Persistent storage / databases.
  [/^(?:Bucket|Dynamo|Postgres|Aurora|Mysql|Database|Redis|Efs|OpenSearch|Vector)$/, 'datastore'],
  // Queues / pub-sub.
  [/^(?:Queue|SnsTopic|Topic|Bus|EventBus|Realtime)$/, 'queue'],
  // Secrets.
  [/^Secret$/, 'secret-store'],
  // CDN / edge routing.
  [/^(?:Cdn|Router)$/, 'cdn'],
];

/** The InfraModuleKind for an SST construct type, or null when unrecognized. */
export function sstKind(constructType: string): InfraModuleKind | null {
  for (const [re, kind] of KIND_RULES) if (re.test(constructType)) return kind;
  return null;
}

// ---------------------------------------------------------------------------
// Path helpers (repo-relative, normalized) — same idiom as pulumi.ts/compose.ts.

/** Normalize a repo-relative path: backslashes→/, collapse `.`/`./`, strip trailing `/`. */
function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
}
/** The repo-relative directory of a repo-relative file path ('' = repo root). */
function dirOfPath(relPath: string): string {
  const n = normalizeRoot(relPath);
  const i = n.lastIndexOf('/');
  return i === -1 ? '' : n.slice(0, i);
}
/** An SST handler `path/to/file.exportName` → the handler file's DIR. */
function handlerDir(handler: string): string {
  // Strip the trailing `.export` segment to recover the file path, then its dir.
  const file = handler.replace(/\.[^./]+$/, '');
  return dirOfPath(file);
}
/** Literal capture-group-1 matches of `re` over `text`. */
function literalValues(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------------------
// kind-aware deployment-target source roots (deterministic, no LLM).

/**
 * The repo-relative source roots an SST construct deploys, from its props-args
 * text. Kind-aware so a static-site's `path:` and a route's `path:` can't
 * cross-contaminate. `dockerfileIndex` powers the image→source resolver. Pure.
 */
export function sstSourceRoots(
  kind: InfraModuleKind,
  argsText: string,
  dockerfileIndex?: DockerfileIndex,
): string[] {
  if (!argsText) return [];
  const roots = new Set<string>();
  const add = (d: string) => {
    if (d) roots.add(d);
  };

  if (kind === 'worker') {
    // `handler: "src/api.handler"` / `job: "src/cron.handler"` → the file's dir.
    for (const v of literalValues(argsText, /\b(?:handler|job|function)\s*:\s*["'`]([^"'`$]+)["'`]/g)) {
      add(handlerDir(v));
    }
  } else if (kind === 'static-site') {
    // `path: "packages/web"` → that dir IS the site source.
    for (const v of literalValues(argsText, /\bpath\s*:\s*["'`]([^"'`$]+)["'`]/g)) {
      add(normalizeRoot(v));
    }
  } else if (kind === 'container') {
    // `image: { context: "packages/api" }` → the build-context dir.
    for (const v of literalValues(argsText, /\bcontext\s*:\s*["'`]([^"'`$]+)["'`]/g)) add(normalizeRoot(v));
    // `dockerfile: "packages/api/Dockerfile"` → its dir.
    for (const v of literalValues(argsText, /\bdockerfile\s*:\s*["'`]([^"'`$]+)["'`]/g)) add(dirOfPath(v));
    // A bare `image: "myorg/api:1"` (string) → the  resolver. `image: {` has
    // no quote after the colon, so this regex only matches the string form.
    if (dockerfileIndex) {
      for (const v of literalValues(argsText, /\bimage\s*:\s*["'`]([^"'`$]+)["'`]/g)) {
        for (const r of resolveImageToSourceRoots(v, dockerfileIndex)) roots.add(r);
      }
    }
  }

  return [...roots].sort();
}

// ---------------------------------------------------------------------------
// Pure graph builder. ts-morph-extracted constructs injected so it's
// unit-testable with no real repo (the pulumi/netlify split).

/** Edge verb for a reference whose TARGET has `kind` (the docker-compose mapping). */
function edgeVerb(targetKind: InfraModuleKind): InfraEdge['kind'] {
  if (targetKind === 'datastore') return 'stores-in';
  if (targetKind === 'queue') return 'publishes';
  if (targetKind === 'secret-store') return 'reads';
  return 'calls';
}

export function buildSstGraph({
  constructs,
  root,
  dockerfileIndex,
}: {
  constructs: SstConstruct[];
  root: string;
  dockerfileIndex?: DockerfileIndex;
}): InfraGraph {
  const nodes: InfraNode[] = [];
  const kindByVar = new Map<string, InfraModuleKind>();
  const nodeIdByVar = new Map<string, string>();
  // Keep only classifiable constructs; remember each one's resolved kind so edges
  // can pick the right verb and so a ref to an unknown construct emits no edge.
  const kept: Array<{ c: SstConstruct; kind: InfraModuleKind; nodeId: string }> = [];

  for (const c of constructs) {
    const kind = sstKind(c.constructType);
    if (!kind) {
      console.warn(`  [sst] skipping unrecognized construct '${c.construct}' (no InfraModuleKind mapping)`);
      continue;
    }
    const nodeId = `resource:${c.refAddr}`;
    kept.push({ c, kind, nodeId });
    if (c.varName) {
      kindByVar.set(c.varName, kind);
      nodeIdByVar.set(c.varName, nodeId);
    }
  }

  for (const { c, kind, nodeId } of kept) {
    const roots = sstSourceRoots(kind, c.argsText, dockerfileIndex);
    const label = c.name && !c.name.includes(':') ? c.name : c.constructType;
    nodes.push({
      id: nodeId,
      label,
      kind,
      provenance: 'declared',
      metadata: { provider: 'sst', construct: c.construct, ...(c.varName ? { varName: c.varName } : {}) },
      ...(roots.length ? { sourceRoots: roots } : {}),
    });
  }

  // Edges: a construct's referenced identifiers that name another construct's var.
  // ts-morph identifier extraction never descends into string literals, so a name
  // string can't invent a phantom edge (the pulumi-ref reasoning).
  const edges: InfraEdge[] = [];
  const seen = new Set<string>();
  for (const { c, nodeId } of kept) {
    for (const ident of c.referencedIdentifiers) {
      const tgt = nodeIdByVar.get(ident);
      if (!tgt || tgt === nodeId) continue;
      const key = `${nodeId}→${tgt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: nodeId, target: tgt, kind: edgeVerb(kindByVar.get(ident)!), metadata: { via: 'sst-link' } });
    }
  }

  return { root, adapter: 'sst', nodes, edges, classificationsNeeded: [] };
}

// ---------------------------------------------------------------------------
// Adapter.

function findConfig(repoDir: string): string | undefined {
  for (const name of CONFIG_NAMES) {
    const p = join(repoDir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export const sstAdapter: InfraAdapter = {
  name: 'sst',

  async detect(repoDir: string): Promise<boolean> {
    return findConfig(repoDir) !== undefined;
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const configPath = findConfig(repoDir);
    if (!configPath) return { root: repoDir, adapter: 'sst', nodes: [], edges: [], classificationsNeeded: [] };
    let constructs: SstConstruct[] = [];
    try {
      constructs = extractSstConstructs(readFileSync(configPath, 'utf8'), relative(repoDir, configPath));
    } catch (err) {
      console.warn(`  [sst] could not parse ${relative(repoDir, configPath)}: ${(err as Error).message}`);
    }
    // The image resolver needs the repo's Dockerfile index (Service image refs).
    return buildSstGraph({ constructs, root: repoDir, dockerfileIndex: buildDockerfileIndex(repoDir) });
  },
};
