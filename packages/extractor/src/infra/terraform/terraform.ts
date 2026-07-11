// the Terraform InfraAdapter (v0): the universal IaC unlock.
//
// One adapter covers AWS / GCP / Azure / Cloudflare / Vercel / fly for any repo
// that uses Terraform — no per-cloud adapter needed. It parses the HCL subset
// (hcl-parse.ts), emits a node per `resource`/`data` block, and lets 's
// classifyResourceTypes decide each node's kind + domain-risk (an
// `aws_lambda_function` is `worker`, an `aws_sqs_queue` is `queue`, …). That
// classification is CACHED per (provider, resourceType) in
// resource_type_classifications, so `aws_lambda_function` is labelled once and
// reused across every Terraform repo forever.
//
// This is the ONLY v0 adapter that emits `classificationsNeeded`: CF and
// Supabase have tight static binding models, but Terraform's `resource` space
// is open-ended, so the kind decision is exactly the cross-vendor judgement the
// LLM cache exists for. We still emit a deterministic heuristic kind +
// `inferred` provenance up front so a --no-llm run (or a classifier miss) still
// yields a usable topology; the classify step upgrades it to `llm-classified`.
//
// Cross-resource references (`${aws_lambda_function.api.arn}`) become edges,
// deterministically — the reference exists in the HCL or it doesn't.
//
// v0 scope: per-provider PLATFORM/zone nodes are deferred (the locked 8-kind
// InfraModuleKind enum has no "platform" kind; grouping belongs to 's ELK
// zones + parentId, not a forced enum value). Variable/tfvars resolution and
// `module {}` recursion are also deferred (tracked under ).

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode, ClassificationRef } from '../types.js';
import type { InfraModuleKind } from '../../types.js';
import { findFiles } from '../walk.js';
import { buildDockerfileIndex, resolveImageToSourceRoots, type DockerfileIndex } from '../image-resolve.js';
import { parseHcl, bodyReferences, referenceSurface, type HclBlock } from './hcl-parse.js';

const TF_SKIP_DIRS = ['node_modules', '.git', 'dist', '.wrangler', '.terraform', '.next', 'build'];

/** Find every `*.tf` file in the repo (bounded recursive walk). */
function findTfFiles(repoDir: string): string[] {
  return findFiles(repoDir, (_abs, e) => e.name.endsWith('.tf'), { skipDirs: TF_SKIP_DIRS, maxDepth: 8 });
}

// Map a resource-type prefix to its cloud, for the classify `provider` field.
const CLOUD_PREFIX: Array<[RegExp, string]> = [
  [/^aws_/, 'aws'],
  [/^google_/, 'google'],
  [/^azurerm_/, 'azure'],
  [/^azuread_/, 'azure'],
  [/^cloudflare_/, 'cloudflare'],
  [/^vercel_/, 'vercel'],
  [/^fly/, 'fly'],
  [/^render_/, 'render'],
  [/^digitalocean_/, 'digitalocean'],
];
function cloudFor(resourceType: string): string {
  for (const [re, cloud] of CLOUD_PREFIX) if (re.test(resourceType)) return cloud;
  // Fallback: the prefix before the first underscore (e.g. `kubernetes_x`).
  const us = resourceType.indexOf('_');
  return us > 0 ? resourceType.slice(0, us) : 'unknown';
}

// Deterministic fallback kind (used pre-classification / under --no-llm). The
// LLM cache is the authority when available; this just keeps the diagram sane
// without it. Substring rules, most-specific first.
const KIND_RULES: Array<[RegExp, InfraModuleKind]> = [
  [/lambda|function|cloud_run|cloudfunction|app_runner|fargate|ecs_task/, 'worker'],
  [/container|ecs_service|kubernetes|instance|compute|droplet|machine/, 'container'],
  [/sqs|pubsub|queue|kinesis|eventbridge|event_bus|kafka|sns/, 'queue'],
  [/dynamodb|rds|s3_bucket|bucket|database|_db|sql|spanner|firestore|bigtable|redis|elasticache|table|storage_bucket/, 'datastore'],
  [/secret|kms|vault|key_vault/, 'secret-store'],
  [/cloudfront|cdn|fastly/, 'cdn'],
  [/api_gateway|cdn_domain/, 'cdn'],
];
function heuristicKind(resourceType: string): InfraModuleKind {
  for (const [re, kind] of KIND_RULES) if (re.test(resourceType)) return kind;
  // PR #9 review: there is no neutral "unknown" member in the locked
  // InfraModuleKind enum (and adding one ripples through the cache CHECK
  // constraint, KIND_COLUMN, salience, icons — not worth it for a debug path).
  // `datastore` is the single most common infra resource, so it's the
  // least-bad heuristic guess — but it is NOT load-bearing: when the LLM runs
  // (the real pipeline always classifies), classifyResourceTypes overwrites
  // this kind; only a --no-llm run keeps it, and edges no longer depend on it
  // (see below). A future neutral kind is tracked under the  expansion.
  return 'datastore';
}

interface TfResource {
  nodeId: string; // adapter-local: `resource:<type>.<name>` | `data:<type>.<name>`
  refAddr: string; // HCL address: `<type>.<name>` | `data.<type>.<name>`
  resourceType: string;
  body: string;
  isData: boolean;
  dir: string; // repo-relative dir of the .tf file ( source-path base)
}

// ---------------------------------------------------------------------------
// source-root extraction (deterministic, no LLM).
//
// Two signals: (1) DIRECT source dirs declared in HCL (archive/lambda
// `source_dir`, lambda `filename`, docker `build { context }`) → that dir; and
// (2) image refs (`image = "…"`, docker `name = "…"`) → the  resolver.
// Unresolvable / interpolated → nothing (honest "Other").

/** Normalize a repo-relative path: backslashes→/, collapse `.`/`./`, strip trailing `/`. */
function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
}
/** The repo-relative directory of a repo-relative file path ('' = repo root). */
function dirOfPath(relPath: string): string {
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
 * Resolve an HCL path value (`source_dir`/`filename`/`context`) to a repo-relative
 * dir. Handles `${path.module}` (relative to the .tf file's dir) and `${path.root}`
 * (repo root). Returns '' when the value carries any OTHER `${…}` interpolation
 * (unresolvable → skip, never guess).
 */
function resolveTfPath(moduleDir: string, raw: string): string {
  let v = raw.trim();
  let base = moduleDir;
  if (v.includes('${path.root}')) base = '';
  v = v.replace(/\$\{path\.(module|root|cwd)\}/g, '');
  if (v.includes('${')) return ''; // an unresolved var/ref — don't guess
  v = v.replace(/^\/+/, '');
  return resolveRel(base, v);
}

/** All `attr = "VALUE"` (HCL) and `"attr": "VALUE"` (JSON-in-HCL) literal values. */
function attrValues(body: string, attr: string): string[] {
  const re = new RegExp(`(?:"${attr}"|\\b${attr})\\s*[=:]\\s*"([^"]+)"`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

/**
 * The repo-relative source roots a Terraform resource deploys. `dockerfileIndex`
 * (when present) powers the image→source resolver path. Pure.
 */
export function terraformSourceRoots(
  resourceType: string,
  body: string,
  moduleDir: string,
  dockerfileIndex?: DockerfileIndex,
): string[] {
  const roots = new Set<string>();
  const addDir = (d: string) => {
    const n = normalizeRoot(d);
    if (n) roots.add(n);
  };
  const isDocker = /docker/i.test(resourceType);
  const isLambdaish = /lambda|function/i.test(resourceType);

  // (1) Direct source dirs.
  for (const v of attrValues(body, 'source_dir')) addDir(resolveTfPath(moduleDir, v)); // archive_file / lambda
  if (isLambdaish) for (const v of attrValues(body, 'filename')) addDir(dirOfPath(resolveTfPath(moduleDir, v)));
  if (isDocker) for (const v of attrValues(body, 'context')) addDir(resolveTfPath(moduleDir, v)); // docker build context

  // (2) Image refs → resolver (literal refs only; interpolated → skip).
  if (dockerfileIndex) {
    const imageRefs = attrValues(body, 'image');
    if (isDocker) imageRefs.push(...attrValues(body, 'name')); // docker_image `name`
    for (const ref of imageRefs) {
      if (!ref || ref.includes('${')) continue;
      for (const r of resolveImageToSourceRoots(ref, dockerfileIndex)) roots.add(r);
    }
  }

  return [...roots].sort();
}

/**
 * Pure graph builder from parsed HCL blocks (one flattened list across files).
 */
export function buildTerraformGraph(blocks: HclBlock[], root: string, dockerfileIndex?: DockerfileIndex): InfraGraph {
  const resources: TfResource[] = [];
  for (const b of blocks) {
    if ((b.type === 'resource' || b.type === 'data') && b.labels.length >= 2) {
      const [resourceType, name] = b.labels;
      const isData = b.type === 'data';
      resources.push({
        nodeId: `${isData ? 'data' : 'resource'}:${resourceType}.${name}`,
        refAddr: `${isData ? 'data.' : ''}${resourceType}.${name}`,
        resourceType,
        body: b.body,
        isData,
        dir: b.dir ?? '',
      });
    }
  }

  const nodes: InfraNode[] = [];
  const classificationsNeeded: ClassificationRef[] = [];
  for (const r of resources) {
    const kind = heuristicKind(r.resourceType);
    // deployment-target source roots (direct dirs + image→resolver).
    const roots = terraformSourceRoots(r.resourceType, r.body, r.dir, dockerfileIndex);
    nodes.push({
      id: r.nodeId,
      label: r.refAddr,
      kind,
      provenance: 'inferred', // upgraded to llm-classified by the classify step
      metadata: { provider: cloudFor(r.resourceType), resourceType: r.resourceType, ...(r.isData ? { data: true } : {}) },
      ...(roots.length ? { sourceRoots: roots } : {}),
    });
    classificationsNeeded.push({
      provider: `terraform/${cloudFor(r.resourceType)}`,
      resourceType: r.resourceType,
      forNodeId: r.nodeId,
    });
  }

  // Cross-resource edges: a resource that references another's address depends
  // on it. The verb is ALWAYS `calls` (PR #9 review): an HCL reference is a
  // structural dependency, not a known read/write/publish — and deriving the
  // verb from the *heuristic* target kind was both a guess and stale (the LLM
  // rewrites kinds afterward, but the edge verb was never recomputed). `calls`
  // is the honest general structural verb (what coerceEdgeKind maps onto), so
  // it stays correct regardless of how classification later labels the target.
  // Matching runs over each source's reference SURFACE (string prose stripped)
  // so a resource named in a description doesn't invent a phantom edge.
  const surfaceById = new Map(resources.map((r) => [r.nodeId, referenceSurface(r.body)]));
  const edges: InfraEdge[] = [];
  const seen = new Set<string>();
  for (const src of resources) {
    const surface = surfaceById.get(src.nodeId)!;
    for (const tgt of resources) {
      if (src.nodeId === tgt.nodeId) continue;
      if (!bodyReferences(surface, tgt.refAddr)) continue;
      const key = `${src.nodeId}→${tgt.nodeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: src.nodeId, target: tgt.nodeId, kind: 'calls', metadata: { via: 'tf-ref' } });
    }
  }

  return { root, adapter: 'terraform', nodes, edges, classificationsNeeded };
}

export const terraformAdapter: InfraAdapter = {
  name: 'terraform',
  async detect(repoDir: string): Promise<boolean> {
    return findTfFiles(repoDir).length > 0;
  },
  async extract(repoDir: string): Promise<InfraGraph> {
    const blocks: HclBlock[] = [];
    for (const file of findTfFiles(repoDir)) {
      const dir = dirOfPath((relative(repoDir, file) || file).split('\\').join('/'));
      try {
        for (const b of parseHcl(readFileSync(file, 'utf8'))) {
          b.dir = dir; // module dir for source-path resolution
          blocks.push(b);
        }
      } catch (err) {
        console.warn(`  [terraform] skipping unparseable ${relative(repoDir, file)}: ${(err as Error).message}`);
      }
    }
    // Dockerfile index for image-referencing resources.
    return buildTerraformGraph(blocks, repoDir, buildDockerfileIndex(repoDir));
  },
};
