// the Cloudflare InfraAdapter (v0).
//
// First real implementation of the  InfraAdapter contract. Targets the
// dogfood stack (example-ingest-worker): reads every `wrangler.toml` /
// `wrangler.jsonc` in the repo and emits the CF deployment topology —
// Worker / Pages nodes, the Queues / KV / R2 / D1 / Container resources they
// bind, and the binding edges between them — entirely from declared config.
//
// Everything here is `declared` provenance: the config file literally names
// the resource and the binding. No LLM, no inference, no hallucination (the
// DoD). The only LLM-touched infra path is Terraform's open-ended `resource`
// blocks, which is why CF emits an empty `classificationsNeeded` — its
// binding model maps statically onto the InfraModuleKind taxonomy.
//
// v0 scope notes (tracked for the  expansion):
//   * `[env.*]` blocks are NOT split into per-environment graphs yet — we read
//     the top-level bindings only. Multi-env deployment-zones are a later
//     refinement (the ticket lists it as an option, not a requirement).
//   * Edge verbs are assigned by binding TYPE (a queue producer `publishes`, a
//     consumer `subscribes`, a datastore is `stores-in`), which is accurate
//     without needing the source-grep refinement the ticket lists as optional.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import { findFiles } from '../walk.js';
import { parseWranglerConfig, type WranglerTree } from './wrangler-parse.js';

const CONFIG_NAMES = ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'];

// deployment-target signals: which repo-relative source dirs each
// Cloudflare artifact deploys, so assemble can attribute code modules to the
// provider that runs them (instead of one "Application" lump).

/** The repo-relative directory of a repo-relative file path ('' = repo root). */
function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

/** Resolve `rel` (which may contain `./` and `../`) against repo-relative `baseDir`. */
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

/** The repo-relative path of the Dockerfile a `[[containers]]` `image` references
 * (resolved from the config file's own directory). */
export function dockerfilePathFor(configDir: string, image: string): string {
  return resolveRel(configDir, image);
}

/**
 * The COPY SOURCE tokens a Dockerfile names (build inputs that become the
 * container's code), normalized + repo-relative-shaped. Pure parse only — the
 * file-vs-dir question is NOT answered here (a token like `Makefile` or
 * `my.config` is ambiguous from the string alone), so the caller resolves each
 * token to a real source DIR against the repo (`copySourceToRoots`). Handles the
 * shell form (`COPY a b c dst`) and the JSON exec form (`COPY ["a","b","dst"]`);
 * skips heredocs (`COPY <<EOF`), build flags (`--from=`/`--chown=`), remote/URL
 * sources, and absolute paths. Globs are kept (resolved to their literal prefix).
 */
export function dockerfileCopySources(content: string): string[] {
  const out = new Set<string>();
  for (const raw of content.split('\n')) {
    const m = /^\s*COPY\s+(.+?)\s*$/i.exec(raw);
    if (!m) continue;
    const args = m[1];
    if (args.startsWith('<<')) continue; // heredoc form — no path sources
    let tokens: string[];
    if (args.startsWith('[')) {
      try {
        tokens = JSON.parse(args) as string[]; // JSON exec form
      } catch {
        continue; // malformed array → skip rather than emit garbage
      }
    } else {
      tokens = args.split(/\s+/).filter((t) => !t.startsWith('--'));
    }
    if (!Array.isArray(tokens) || tokens.length < 2) continue; // need ≥1 src + the dest
    for (const src of tokens.slice(0, -1)) {
      const norm = String(src).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      if (!norm || norm === '.' || norm.startsWith('/') || norm.includes('://')) continue;
      out.add(norm);
    }
  }
  return [...out];
}

/**
 * Resolve a Dockerfile's COPY source tokens to repo-relative source DIRS, statting
 * each against the real repo so a file contributes its dir and a directory
 * contributes itself (the string heuristic can't tell `Makefile` the file from
 * `worker` the dir). `contextDir` is the Docker build context — the Dockerfile's
 * own dir (repo-relative). A glob → its literal dir prefix; a missing path → a
 * best-effort extension guess. Root-level files (dir = '') are dropped, not turned
 * into a repo-root catch-all.
 */
export function copySourceToRoots(repoDir: string, contextDir: string, tokens: string[]): string[] {
  const roots = new Set<string>();
  for (const token of tokens) {
    let resolved: string;
    if (token.includes('*')) {
      // glob → the literal dir prefix before the first wildcard segment.
      const lit: string[] = [];
      for (const seg of token.split('/')) {
        if (seg.includes('*')) break;
        lit.push(seg);
      }
      resolved = resolveRel(contextDir, lit.join('/'));
      if (resolved) roots.add(resolved);
      continue;
    }
    resolved = resolveRel(contextDir, token);
    if (!resolved) continue;
    let dir: string;
    try {
      dir = statSync(join(repoDir, resolved)).isDirectory() ? resolved : dirOf(resolved);
    } catch {
      // missing (rare/error) → fall back to the extension heuristic.
      const last = resolved.slice(resolved.lastIndexOf('/') + 1);
      dir = last.includes('.') ? dirOf(resolved) : resolved;
    }
    if (dir) roots.add(dir);
  }
  return [...roots].sort();
}

const VITE_CONFIG_NAMES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.mts',
  'vite.config.cts',
];

/**
 * Detect a root Vite SPA (an `index.html` + a `vite.config.*` at the repo root).
 * Cloudflare-shop repos deploy this to Pages with no declarative config
 * (`wrangler pages deploy dist`), so it's the only signal for "src/** is the
 * frontend." Returns the deploy name (package.json name, scope stripped) or null.
 */
export function detectViteSpa(repoDir: string): { name: string } | null {
  if (!existsSync(join(repoDir, 'index.html'))) return null;
  if (!VITE_CONFIG_NAMES.some((c) => existsSync(join(repoDir, c)))) return null;
  let name = repoDir.split('/').filter(Boolean).pop() ?? 'web';
  try {
    const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name) name = pkg.name;
  } catch {
    /* no/invalid package.json — fall back to the dir name */
  }
  return { name: name.replace(/^@[^/]+\//, '') };
}

/** Locate every wrangler config in the repo (bounded recursive walk). */
function findWranglerConfigs(repoDir: string): string[] {
  return findFiles(repoDir, (_abs, e) => CONFIG_NAMES.includes(e.name), { maxDepth: 5 });
}

// ---------------------------------------------------------------------------
// Node-id helpers. Ids are adapter-local (the registry prefixes `cloudflare:`).
// Resource ids are keyed by their natural CF identity so two workers binding the
// same queue collapse onto one node instead of duplicating it.

const workerId = (name: string) => `worker:${name}`;
const pagesId = (name: string) => `pages:${name}`;
const queueId = (q: string) => `queue:${q}`;
const datastoreId = (kind: string, binding: string) => `${kind}:${binding}`;
const containerId = (cls: string) => `container:${cls}`;
const AI_ID = 'ai:workers-ai';

// Read an array-of-tables field defensively (could be absent or malformed).
function arr(tree: WranglerTree, key: string): WranglerTree[] {
  const v = tree[key];
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as WranglerTree[]) : [];
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Pure graph builder — takes already-parsed configs and emits the InfraGraph.
 * Separated from the fs walk so it can be unit-tested without a real repo dir.
 */
export function buildCloudflareGraph(
  configs: Array<{ tree: WranglerTree; file: string }>,
  root: string,
  // IO-derived inputs (resolved in extract() against the real repo; kept
  // out of the pure builder so it stays unit-testable without a real repo dir):
  // container source roots keyed by the Dockerfile's repo-relative path, and the
  // root Vite SPA (if any) → a Pages source unit.
  opts: { containerRoots?: Map<string, string[]>; viteSpa?: { name: string } | null } = {},
): InfraGraph {
  const containerRoots = opts.containerRoots ?? new Map<string, string[]>();
  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];
  const addNode = (n: InfraNode) => {
    // First declaration wins; later configs binding the same resource don't
    // clobber its metadata. (Within-adapter id collisions are a merge error,
    // so we dedupe here before the registry ever sees them.)
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };
  const addEdge = (e: InfraEdge) => edges.push(e);

  for (const { tree, file } of configs) {
    const rel = (relative(root, file) || file).split('\\').join('/');
    const configDir = dirOf(rel);
    const name = str(tree.name) ?? 'worker';
    const isPages = !!str(tree.pages_build_output_dir) || (!tree.main && !!tree.assets);
    const selfId = isPages ? pagesId(name) : workerId(name);
    addNode({
      id: selfId,
      label: name,
      kind: isPages ? 'static-site' : 'worker',
      provenance: 'declared',
      metadata: { config: rel, ...(str(tree.main) ? { main: str(tree.main) } : {}) },
      // the worker/pages deploys the code under its config dir. (Repo-root
      // configs yield '' → filtered out at unit-build, so they don't become a
      // catch-all that swallows everything.)
      ...(configDir ? { sourceRoots: [configDir] } : {}),
    });

    // Queues: producers publish, consumers subscribe.
    const queues = (tree.queues ?? {}) as WranglerTree;
    for (const p of arr(queues, 'producers')) {
      const q = str(p.queue);
      if (!q) continue;
      addNode({ id: queueId(q), label: q, kind: 'queue', provenance: 'declared', metadata: { binding: str(p.binding) } });
      addEdge({ source: selfId, target: queueId(q), kind: 'publishes', metadata: { binding: str(p.binding), config: rel } });
    }
    for (const c of arr(queues, 'consumers')) {
      const q = str(c.queue);
      if (!q) continue;
      addNode({ id: queueId(q), label: q, kind: 'queue', provenance: 'declared' });
      addEdge({ source: selfId, target: queueId(q), kind: 'subscribes', metadata: { config: rel } });
    }

    // KV / R2 / D1 → datastore nodes, the worker `stores-in` each.
    const datastores: Array<[string, string, (t: WranglerTree) => string | undefined]> = [
      ['kv_namespaces', 'kv', (t) => str(t.binding)],
      ['r2_buckets', 'r2', (t) => str(t.binding) ?? str(t.bucket_name)],
      ['d1_databases', 'd1', (t) => str(t.binding) ?? str(t.database_name)],
    ];
    for (const [key, kindTag, label] of datastores) {
      for (const d of arr(tree, key)) {
        const binding = str(d.binding) ?? label(d);
        if (!binding) continue;
        const id = datastoreId(kindTag, binding);
        addNode({
          id,
          label: label(d) ?? binding,
          kind: 'datastore',
          provenance: 'declared',
          metadata: { type: kindTag, binding, config: rel },
        });
        addEdge({ source: selfId, target: id, kind: 'stores-in', metadata: { binding, config: rel } });
      }
    }

    // Containers (Sandbox SDK / Firecracker microVM) — the worker `calls` them.
    for (const c of arr(tree, 'containers')) {
      const cls = str(c.class_name);
      if (!cls) continue;
      const image = str(c.image);
      // the container deploys the code its Dockerfile COPYs in. extract()
      // pre-resolved the build context to repo-relative source roots, keyed by the
      // Dockerfile's repo-relative path (resolved from `image` relative to this
      // config's dir). A registry-ref `image` won't resolve to a file → no entry →
      // no source roots (graceful: the container still renders, just unattributed).
      const sourceRoots = image ? containerRoots.get(dockerfilePathFor(configDir, image)) ?? [] : [];
      addNode({
        id: containerId(cls),
        label: cls,
        kind: 'container',
        provenance: 'declared',
        metadata: { image, instance_type: str(c.instance_type), config: rel },
        ...(sourceRoots.length ? { sourceRoots } : {}),
      });
      addEdge({ source: selfId, target: containerId(cls), kind: 'calls', metadata: { config: rel } });
    }

    // Service bindings → worker-to-worker calls. Emit the target worker node so
    // the edge endpoint resolves even if its own config isn't in this repo.
    for (const s of arr(tree, 'services')) {
      const svc = str(s.service);
      if (!svc) continue;
      addNode({ id: workerId(svc), label: svc, kind: 'worker', provenance: 'declared' });
      addEdge({ source: selfId, target: workerId(svc), kind: 'calls', metadata: { binding: str(s.binding), config: rel } });
    }

    // Workers AI binding → paid external inference service.
    const ai = tree.ai as WranglerTree | undefined;
    if (ai && typeof ai === 'object' && str(ai.binding)) {
      addNode({
        id: AI_ID,
        label: 'Workers AI',
        kind: 'external-api',
        provenance: 'declared',
        metadata: { binding: str(ai.binding), config: rel },
      });
      addEdge({ source: selfId, target: AI_ID, kind: 'calls', metadata: { config: rel } });
    }
  }

  // the root Vite SPA → a Pages frontend unit owning `src/**`. INFERRED,
  // not declared — there's no wrangler Pages config (CF-shop repos deploy the SPA
  // via `wrangler pages deploy dist`), so the Vite SPA + an active CF wrangler
  // graph is the signal. Source root is `src` (the Vite convention — NOT read from
  // vite.config) rather than the repo root, so it claims the frontend without
  // swallowing worker/ or scripts/. Skipped when a wrangler config already DECLARED
  // a Pages site (that's the authoritative frontend; don't add a phantom second).
  const hasDeclaredPages = [...nodes.values()].some((n) => n.kind === 'static-site');
  if (opts.viteSpa && !hasDeclaredPages) {
    addNode({
      id: pagesId(opts.viteSpa.name),
      label: opts.viteSpa.name,
      kind: 'static-site',
      provenance: 'inferred',
      sourceRoots: ['src'],
      metadata: { via: 'vite-spa' },
    });
  }

  return {
    root,
    adapter: 'cloudflare',
    nodes: [...nodes.values()],
    edges,
    classificationsNeeded: [], // CF's binding model maps statically — no LLM needed
  };
}

export const cloudflareAdapter: InfraAdapter = {
  name: 'cloudflare',
  async detect(repoDir: string): Promise<boolean> {
    return findWranglerConfigs(repoDir).length > 0;
  },
  async extract(repoDir: string): Promise<InfraGraph> {
    const files = findWranglerConfigs(repoDir);
    const configs: Array<{ tree: WranglerTree; file: string }> = [];
    for (const file of files) {
      try {
        configs.push({ tree: parseWranglerConfig(readFileSync(file, 'utf8'), file), file });
      } catch (err) {
        // A single malformed config shouldn't sink the whole infra layer.
        console.warn(`  [cloudflare] skipping unparseable ${file}: ${(err as Error).message}`);
      }
    }
    // IO: for each container's referenced Dockerfile, parse its COPY
    // sources and resolve them (against the real repo) to repo-relative source
    // roots; and detect the root Vite SPA. Keyed by the Dockerfile's repo-relative
    // path so the pure builder can look each container's roots up.
    const containerRoots = new Map<string, string[]>();
    for (const { tree, file } of configs) {
      const configDir = dirOf((relative(repoDir, file) || file).split('\\').join('/'));
      for (const c of arr(tree, 'containers')) {
        const image = str(c.image);
        if (!image) continue;
        const dfRel = dockerfilePathFor(configDir, image);
        if (!dfRel || containerRoots.has(dfRel)) continue;
        try {
          const abs = join(repoDir, dfRel);
          if (!existsSync(abs)) continue;
          const sources = dockerfileCopySources(readFileSync(abs, 'utf8'));
          containerRoots.set(dfRel, copySourceToRoots(repoDir, dirOf(dfRel), sources));
        } catch {
          /* unreadable Dockerfile → container stays unattributed (graceful) */
        }
      }
    }
    return buildCloudflareGraph(configs, repoDir, { containerRoots, viteSpa: detectViteSpa(repoDir) });
  },
};
