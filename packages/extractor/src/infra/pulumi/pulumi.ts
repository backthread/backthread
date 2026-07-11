// Pulumi InfraAdapter (v0, TypeScript programs only).
//
// Code-IaC counterpart to 's Terraform adapter. Sources:
//   • Pulumi.yaml          — project name + runtime
//   • Pulumi.<stack>.yaml  — stack config (read but not deeply parsed in v0)
//   • *.ts program files   — resource creation call sites (ts-morph)
//
// Approach mirrors Terraform exactly:
//   1. Emit one InfraNode per resource with a deterministic heuristic kind
//      (`inferred` provenance) so a --no-llm run yields a usable topology.
//   2. Emit one ClassificationRef per resource so 's classifyResourceTypes()
//      can upgrade each node to `llm-classified`. The `provider` key is
//      `pulumi/<providerSegment>` (e.g. `pulumi/aws`) — this intentionally
//      shares the classification CACHE with Terraform's open-ended resource
//      space: `aws.lambda.Function` (Pulumi) and `aws_lambda_function` (TF)
//      often resolve to the same cache row because  normalises
//      (provider, resourceType) pairs. The Terraform adapter uses `terraform/aws`
//      and we use `pulumi/aws` — different provider strings, but  dedupes
//      across them in a single bulk call so same-kind resources get consistent
//      InfraModuleKind labels globally.
//   3. Emit `calls` edges from cross-resource variable references: if resource
//      A's referencedIdentifiers (AST-extracted from constructor args) contains
//      resource B's varName, A→B is a structural dependency. `calls` is the
//      honest verb (same reasoning as Terraform's HCL-ref edges — we don't know
//      if it's a read or write without deeper analysis).
//
// Non-TS (Python/Go) deferral: when Pulumi.yaml declares `runtime: python` or
// `runtime: go`, v0 emits an empty but valid InfraGraph and logs a note. Phase-5
// multilingual work will add py-ast / go/parser walkers.

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode, ClassificationRef } from '../types.js';
import type { InfraModuleKind } from '../../types.js';
import { findFiles } from '../walk.js';
import { buildDockerfileIndex, resolveImageToSourceRoots, type DockerfileIndex } from '../image-resolve.js';
import { extractPulumiResources, parsePulumiProject, providerOf, type PulumiResource } from './pulumi-parse.js';

// ---------------------------------------------------------------------------
// FS walk config

const PULUMI_SKIP_DIRS = ['node_modules', '.git', 'dist', '.wrangler', '.next', 'build', 'coverage', '.pulumi'];

/**
 * Find every `*.ts` source file under repoDir (bounded recursive walk).
 *
 * Note (v0 known limitation): detect() only checks for Pulumi.yaml at the
 * repo root, while extract() walks recursively for TS sources. In a monorepo
 * where Pulumi projects live in subdirectories, detect() will miss them unless
 * the caller passes the subdirectory directly. This coarse mismatch is
 * acceptable at v0 and tracked for Phase-5 multilingual/monorepo work.
 */
function findPulumiFiles(repoDir: string): { tsFiles: string[] } {
  const tsFiles = findFiles(
    repoDir,
    (_abs, e) => e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts'),
    { skipDirs: PULUMI_SKIP_DIRS, maxDepth: 8 },
  );
  return { tsFiles };
}

// ---------------------------------------------------------------------------
// Heuristic kind mapping (mirrors Terraform's KIND_RULES)

const KIND_RULES: Array<[RegExp, InfraModuleKind]> = [
  // Compute / serverless (check before container — "Function", "CloudRun", "AppRunner", "Fargate", "EcsTask" are compute)
  [/[Ll]ambda|[Ff]unction|[Cc]loud[Rr]un|[Cc]loud[Ff]unction|[Aa]pp[Rr]unner|[Ff]argate|[Ee]cs[Tt]ask/, 'worker'],
  // Containers / machines (more generic; comes after the serverless check)
  [/[Cc]ontainer[Ii]nstance|[Ee]cs[Ss]ervice|[Kk]ubernetes|[Dd]roplet|[Ff]ly[Mm]achine|[Cc]omputeInstance/, 'container'],
  // Queues / pub-sub
  [/[Qq]ueue|[Ss][Qq][Ss]|[Pp]ub[Ss]ub|[Kk]inesis|[Ee]vent[Bb]us|[Ee]vent[Gg]rid|[Kk]afka|[Tt]opic/, 'queue'],
  // Persistent storage / databases
  [/[Bb]ucket|[Dd]ynamo|[Rr]ds[Ii]nstance|[Dd]atabase|[Ss]torage[Aa]ccount|[Ss][Qq][Ll]|[Ss]panner|[Ff]irestore|[Bb]ig[Tt]able|[Rr]edis|[Ee]lasticache|[Tt]able|[Bb]lob/, 'datastore'],
  // Secret / key management
  [/[Ss]ecret|[Kk][Mm][Ss]|[Vv]ault|[Kk]ey[Vv]ault/, 'secret-store'],
  // CDN
  [/[Cc]loud[Ff]ront|[Cc][Dd][Nn]|[Ff]astly/, 'cdn'],
  // Static sites
  [/[Ss]tatic[Ss]ite|[Ss]tatic[Ww]eb/, 'static-site'],
];

function heuristicKind(resourceType: string): InfraModuleKind {
  for (const [re, kind] of KIND_RULES) if (re.test(resourceType)) return kind;
  return 'datastore'; // least-bad fallback; same rationale as Terraform adapter
}

// ---------------------------------------------------------------------------
// source-root extraction (deterministic, no LLM).
//
// Pulumi asset/build paths are resolved relative to the program's CWD (the
// Pulumi.yaml dir = repoDir), so they're repo-root-relative — no per-file base
// needed. Two signals: DIRECT source (docker `build: { context }`,
// `FileArchive`/`FileAsset`/`AssetArchive("path")` code assets) and IMAGE refs
// (`image: "…"` → the  resolver). Read off the props-args text; literal
// strings only (a `${…}` template is unresolvable → skipped, never guessed).

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
/** An asset path → its source dir: a built artifact (.zip/.tar/.jar) → its dir; else the dir itself. */
function assetToDir(p: string): string {
  return /\.(zip|tar|tgz|tar\.gz|jar)$/i.test(p) ? dirOfPath(p) : normalizeRoot(p);
}
function literalValues(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * The repo-relative source roots a Pulumi resource deploys, from its props-args
 * text. `dockerfileIndex` (when present) powers the image→source resolver. Pure.
 */
export function pulumiSourceRoots(
  resourceType: string,
  argsText: string,
  dockerfileIndex?: DockerfileIndex,
): string[] {
  if (!argsText) return [];
  const roots = new Set<string>();
  const addDir = (d: string) => {
    if (d) roots.add(d);
  };
  const isDocker = /docker/i.test(resourceType);

  // (1) Direct source: FileArchive/FileAsset/AssetArchive("path") code assets.
  for (const v of literalValues(argsText, /(?:FileArchive|FileAsset|AssetArchive)\s*\(\s*["'`]([^"'`$]+)["'`]/g)) {
    addDir(assetToDir(v));
  }
  // docker build context.
  if (isDocker) {
    for (const v of literalValues(argsText, /context\s*:\s*["'`]([^"'`$]+)["'`]/g)) addDir(normalizeRoot(v));
  }

  // (2) Image refs → resolver (literal only; a `${…}` template is skipped by the
  // [^"'`$] class which refuses to match across an interpolation marker).
  if (dockerfileIndex) {
    for (const v of literalValues(argsText, /\bimage\s*:\s*["'`]([^"'`$]+)["'`]/g)) {
      for (const r of resolveImageToSourceRoots(v, dockerfileIndex)) roots.add(r);
    }
  }

  return [...roots].sort();
}

// ---------------------------------------------------------------------------
// TS runtime detection

const TS_RUNTIMES = new Set(['nodejs', 'typescript', 'typescript-v8', 'ts-node']);

function isTypescriptRuntime(runtime: string | undefined): boolean {
  if (!runtime) return true; // assume TS if unspecified (Pulumi.yaml omitted or v0 blank)
  return TS_RUNTIMES.has(runtime.toLowerCase());
}

// ---------------------------------------------------------------------------
// Pure graph builder

interface ResolvedResource {
  pulumiRes: PulumiResource;
  nodeId: string;
}

/**
 * Build an InfraGraph from already-extracted Pulumi resources.
 * Separated from the FS walk for unit-testability.
 */
export function buildPulumiGraph({
  resources,
  project,
  root,
  dockerfileIndex,
}: {
  resources: PulumiResource[];
  project?: { name?: string; runtime?: string };
  root: string;
  dockerfileIndex?: DockerfileIndex;
}): InfraGraph {
  const resolved: ResolvedResource[] = resources.map((r) => ({
    pulumiRes: r,
    nodeId: `resource:${r.refAddr}`,
  }));

  const nodes: InfraNode[] = [];
  const classificationsNeeded: ClassificationRef[] = [];

  for (const { pulumiRes, nodeId } of resolved) {
    const provider = providerOf(pulumiRes.resourceType);
    const kind = heuristicKind(pulumiRes.resourceType);
    // deployment-target source roots (code assets + build context +
    // image→resolver).
    const roots = pulumiSourceRoots(pulumiRes.resourceType, pulumiRes.argsText, dockerfileIndex);
    nodes.push({
      id: nodeId,
      label: `${pulumiRes.resourceType} (${pulumiRes.refAddr.split('.').pop() ?? ''})`,
      kind,
      provenance: 'inferred',
      metadata: {
        provider,
        resourceType: pulumiRes.resourceType,
        ...(pulumiRes.varName ? { varName: pulumiRes.varName } : {}),
        ...(project?.name ? { pulumiProject: project.name } : {}),
      },
      ...(roots.length ? { sourceRoots: roots } : {}),
    });
    classificationsNeeded.push({
      provider: `pulumi/${provider}`,
      resourceType: pulumiRes.resourceType,
      forNodeId: nodeId,
    });
  }

  // Cross-resource edges: resource A's referencedIdentifiers (AST-extracted
  // identifier names from constructor args, first arg stripped) contains
  // resource B's varName.
  //
  // Performance: build a Map<varName, nodeId> once, then for each source do a
  // plain Set/Map lookup per identifier — O(n·k) where k is average arg-refs,
  // no regex compilation at all. This also eliminates the phantom-edge class
  // entirely: string-literal content is never present in referencedIdentifiers
  // (ts-morph Identifier walk does not descend into StringLiteral nodes), so
  // a varName that appears only inside a name string (e.g. `topic` inside
  // `{ name: 'topic-handler' }`) can never produce an edge.
  const varToNodeId = new Map<string, string>();
  for (const { pulumiRes, nodeId } of resolved) {
    if (pulumiRes.varName) varToNodeId.set(pulumiRes.varName, nodeId);
  }

  const edges: InfraEdge[] = [];
  const seen = new Set<string>();

  for (const src of resolved) {
    for (const identName of src.pulumiRes.referencedIdentifiers) {
      const tgtNodeId = varToNodeId.get(identName);
      if (!tgtNodeId || tgtNodeId === src.nodeId) continue;
      const key = `${src.nodeId}→${tgtNodeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: src.nodeId, target: tgtNodeId, kind: 'calls', metadata: { via: 'pulumi-ref' } });
    }
  }

  return { root, adapter: 'pulumi', nodes, edges, classificationsNeeded };
}

// ---------------------------------------------------------------------------
// Adapter

export const pulumiAdapter: InfraAdapter = {
  name: 'pulumi',

  async detect(repoDir: string): Promise<boolean> {
    return existsSync(join(repoDir, 'Pulumi.yaml'));
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    // 1. Parse Pulumi.yaml (project root only — stack yamls are config, not topology)
    const pulumiYamlPath = join(repoDir, 'Pulumi.yaml');
    let project: { name?: string; runtime?: string } = {};
    try {
      project = parsePulumiProject(readFileSync(pulumiYamlPath, 'utf8'));
    } catch (err) {
      console.warn(`  [pulumi] could not read Pulumi.yaml: ${(err as Error).message}`);
    }

    // 2. Non-TS runtime → skip source extraction but emit valid empty graph
    if (!isTypescriptRuntime(project.runtime)) {
      console.warn(
        `  [pulumi] runtime "${project.runtime}" is not TypeScript — source extraction deferred to Phase-5. ` +
          `Emitting empty graph for project "${project.name ?? '(unknown)'}"`,
      );
      return { root: repoDir, adapter: 'pulumi', nodes: [], edges: [], classificationsNeeded: [] };
    }

    // 3. Walk TS files, extract resources
    const { tsFiles } = findPulumiFiles(repoDir);
    const allResources: PulumiResource[] = [];
    for (const file of tsFiles) {
      try {
        const text = readFileSync(file, 'utf8');
        const found = extractPulumiResources(text, relative(repoDir, file));
        allResources.push(...found);
      } catch (err) {
        console.warn(`  [pulumi] skipping unparseable ${relative(repoDir, file)}: ${(err as Error).message}`);
      }
    }

    // Dockerfile index for image-referencing resources (docker.Image,
    // ECS/CloudRun image refs).
    return buildPulumiGraph({
      resources: allResources,
      project,
      root: repoDir,
      dockerfileIndex: buildDockerfileIndex(repoDir),
    });
  },
};
