// AWS-native cluster InfraAdapter (v0).
//
// Covers: CloudFormation YAML/JSON, SAM templates (AWS::Serverless::*),
// Serverless Framework (serverless.yml/yaml), and synthesized CDK output
// (cdk.out/*.template.json — which is plain CFN JSON, so it's handled
// automatically by parseCfnTemplate).
//
// DEFERRED (tracked under  expansion):
//   * Raw ECS task-def JSON — no declarative resource map, topology requires
//     ecs-compose or task-def relationship analysis, not a single template.
//   * Elastic Beanstalk .elasticbeanstalk/config.yml — describes deployment
//     environment, not the application topology. Worth a separate adapter when
//     EB repos appear in the corpus.
//   * CDK TypeScript source — synthesized cdk.out/*.template.json is CFN JSON
//     and IS handled here. Raw CDK source (constructs) would need CDK API
//     analysis; the synthesized output is the authoritative topology.
//
// Architecture mirrors terraform.ts:
//   - Open-ended AWS resource types → heuristic `inferred` kind.
//   - Per-resource `classificationsNeeded` entry (provider: 'aws/cloudformation').
//     This SHARES the aws taxonomy with terraform (provider prefix 'aws/...' on
//     both sides is intentional: the  cache key is (provider, resourceType),
//     so an `aws_lambda_function` from Terraform and an `AWS::Lambda::Function`
//     from CFN use DIFFERENT keys — they're different type namespaces).
//   - Cross-resource edges via reference-surface scan (Ref/GetAtt/DependsOn/Sub).
//
// Node ids are adapter-local; the registry prefixes 'aws:' at merge time.

import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode, ClassificationRef } from '../types.js';
import type { InfraModuleKind } from '../../types.js';
import { walkRepo } from '../walk.js';
import { buildDockerfileIndex, resolveImageToSourceRoots, type DockerfileIndex } from '../image-resolve.js';
import { parseCfnTemplate, parseServerlessConfig, isCfnTemplate, type CfnResource } from './aws-parse.js';

// ---------------------------------------------------------------------------
// Source-root extraction. Deterministic, no LLM.
//   * SAM/Lambda `CodeUri` (a local dir/zip) → that dir.
//   * ECS task-def container `Image` → the  resolver.
// CodeUri resolves against the template's dir; an s3:// CodeUri or a `${…}`
// intrinsic is unresolvable → skipped (honest "Other", never guess).

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
/** Resolve `rel` against repo-relative `baseDir` → normalized. */
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
/** A CodeUri path → its source dir: a built artifact (.zip/.jar) → its dir; else the dir itself. */
function codeUriToDir(p: string): string {
  return /\.(zip|jar)$/i.test(p) ? dirOfPath(p) : normalizeRoot(p);
}

function awsSourceRoots(rawText: string, moduleDir: string, index?: DockerfileIndex): string[] {
  const roots = new Set<string>();
  // (1) SAM/Lambda CodeUri (skip s3:// remote packages + ${…} intrinsics).
  const codeUriRe = /"CodeUri"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = codeUriRe.exec(rawText)) !== null) {
    const v = m[1];
    if (/^s3:\/\//i.test(v) || v.includes('${')) continue;
    const d = codeUriToDir(resolveRel(moduleDir, v));
    if (d) roots.add(d);
  }
  // (2) ECS task-def (and any) container Image refs → resolver.
  if (index) {
    const imageRe = /"Image"\s*:\s*"([^"]+)"/g;
    while ((m = imageRe.exec(rawText)) !== null) {
      const v = m[1];
      if (v.includes('${')) continue;
      for (const r of resolveImageToSourceRoots(v, index)) roots.add(r);
    }
  }
  return [...roots].sort();
}

// ---------------------------------------------------------------------------
// File discovery constants.

// `cdk.out` is deliberately NOT skipped — it holds synthesized CFN JSON we want.
const AWS_SKIP_DIRS = ['node_modules', '.git', 'dist', '.wrangler', '.next', 'build', 'coverage', '__pycache__', '.venv', 'vendor'];

// Names that always denote a Serverless Framework config.
const SERVERLESS_CONFIG_NAMES = new Set(['serverless.yml', 'serverless.yaml']);

// Names that are candidate CFN template files (heuristic; we check content).
const TEMPLATE_NAMES = new Set([
  'template.yaml', 'template.yml', 'template.json',
  'cloudformation.yaml', 'cloudformation.yml', 'cloudformation.json',
  'sam.yaml', 'sam.yml', 'sam.json',
  'stack.yaml', 'stack.yml', 'stack.json',
]);

interface FoundFile {
  abs: string;
  kind: 'cfn' | 'serverless';
}

/**
 * Walk the repo and collect AWS template files.
 * - Always descend into cdk.out/ to pick up *.template.json (it's not in
 *   AWS_SKIP_DIRS, so the shared walker descends it like any other dir).
 * - Skip AWS_SKIP_DIRS otherwise.
 * - Returns files sorted by absolute path (localeCompare) so first-wins
 *   deduplication is deterministic across machines and CI.
 */
function findAwsTemplates(repoDir: string): FoundFile[] {
  const found: FoundFile[] = [];

  walkRepo(repoDir, {
    skipDirs: AWS_SKIP_DIRS,
    onFile: (abs, e) => {
      const name = e.name;
      if (SERVERLESS_CONFIG_NAMES.has(name)) {
        found.push({ abs, kind: 'serverless' });
        return;
      }
      // `inCdkOut`: true iff any ancestor directory of this file is `cdk.out`.
      // (The legacy walk threaded a flag set on entering cdk.out; recovering it
      // from the path is equivalent and keeps the shared walker stateless.)
      const inCdkOut = relative(repoDir, abs).split(sep).slice(0, -1).includes('cdk.out');
      if (inCdkOut && name.endsWith('.template.json')) {
        // Synthesized CDK output — always CFN JSON.
        found.push({ abs, kind: 'cfn' });
      } else if (TEMPLATE_NAMES.has(name)) {
        // Check content before committing — avoid false positives.
        // We'll verify in the extraction loop.
        found.push({ abs, kind: 'cfn' });
      }
    },
  });

  // Sort by absolute path so first-wins deduplication is deterministic.
  found.sort((a, b) => a.abs.localeCompare(b.abs));
  return found;
}

// ---------------------------------------------------------------------------
// Kind heuristic (mirrors terraform.ts KIND_RULES; adapted for CFN type names).
// The LLM cache is the authority; this ensures a usable topology under
// --no-llm. Most-specific rules listed first.

const CFN_KIND_RULES: Array<[RegExp, InfraModuleKind]> = [
  // Compute / function
  [/AWS::Lambda::|AWS::Serverless::Function/, 'worker'],
  [/AWS::AppRunner::|AWS::Batch::|AWS::ECS::TaskDefinition/, 'worker'],
  // Container / ECS service
  [/AWS::ECS::Service|AWS::EC2::Instance|AWS::ElasticBeanstalk::/, 'container'],
  // Queue / event bus
  [/AWS::SQS::|AWS::SNS::|AWS::Kinesis::|AWS::EventBridge::|AWS::Events::/, 'queue'],
  // Datastore
  [/AWS::DynamoDB::Table|AWS::Serverless::SimpleTable|AWS::RDS::/, 'datastore'],
  [/AWS::S3::Bucket/, 'datastore'],
  [/AWS::ElastiCache::|AWS::DAX::/, 'datastore'],
  // Secret store / KMS
  [/AWS::SecretsManager::|AWS::KMS::|AWS::SSM::Parameter/, 'secret-store'],
  // CDN / distribution
  [/AWS::CloudFront::/, 'cdn'],
  // API gateway — no `gateway` kind in enum; map to `worker` (least-bad)
  [/AWS::ApiGateway::|AWS::ApiGatewayV2::|AWS::Serverless::Api|AWS::Serverless::HttpApi/, 'worker'],
];

function heuristicKind(resourceType: string): { kind: InfraModuleKind } {
  for (const [re, kind] of CFN_KIND_RULES) {
    if (re.test(resourceType)) {
      return { kind };
    }
  }
  // Unknown type → datastore fallback (same rationale as terraform.ts).
  return { kind: 'datastore' };
}

// ---------------------------------------------------------------------------
// Reference extraction via parsed object walk.
//
// CFN references between resources use:
//   - { Ref: LogicalId }              → we expect the string value to equal a logicalId
//   - { Fn::GetAtt: [LId, Attr] }     → first array element is the logicalId
//   - DependsOn: LogicalId | [LId…]   → string or array of strings
//   - { Fn::Sub: "${LogicalId.Attr}" }→ placeholder in the Sub string
//
// We walk the parsed JS object once per resource, collecting every logicalId
// that appears as a Ref value, first element of Fn::GetAtt, DependsOn entry,
// or ${…} placeholder in Fn::Sub strings. This is O(R) (one walk per
// resource, not O(R²) re-compilation per pair) and eliminates the substring
// phantom-edge risk from the old rawText approach.

function extractRefs(value: unknown, knownIds: Set<string>, out: Set<string>): void {
  if (typeof value === 'string') {
    // Case A: YAML-resolved scalar string.
    //   !Ref OrdersTable         → the string "OrdersTable"  (exact match)
    //   !GetAtt AssetsBucket.Arn → the string "AssetsBucket.Arn"  (id.attr)
    //   !Sub "${OrdersTable.Arn}/..." → check ${…} placeholders below
    // Check exact match first (covers !Ref).
    if (knownIds.has(value)) {
      out.add(value);
      return;
    }
    // Check for id.attr form (covers !GetAtt resolved as scalar string).
    const dotIdx = value.indexOf('.');
    if (dotIdx > 0) {
      const prefix = value.slice(0, dotIdx);
      if (knownIds.has(prefix)) out.add(prefix);
    }
    // Check for ${LogicalId} / ${LogicalId.Attr} placeholders in Sub strings.
    const placeholderRe = /\$\{([A-Za-z0-9]+)(?:\.[^}]*)?\}/g;
    let m: RegExpExecArray | null;
    while ((m = placeholderRe.exec(value)) !== null) {
      if (knownIds.has(m[1])) out.add(m[1]);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) extractRefs(item, knownIds, out);
    return;
  }
  // Case B: JSON-form object with explicit CFN intrinsic function keys.
  const obj = value as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'Ref' && typeof val === 'string') {
      if (knownIds.has(val)) out.add(val);
    } else if (key === 'Fn::GetAtt' && Array.isArray(val) && val.length >= 1 && typeof val[0] === 'string') {
      if (knownIds.has(val[0])) out.add(val[0]);
    } else if (key === 'DependsOn') {
      const deps = Array.isArray(val) ? val : [val];
      for (const d of deps) {
        if (typeof d === 'string' && knownIds.has(d)) out.add(d);
      }
    } else if (key === 'Fn::Sub' && typeof val === 'string') {
      const placeholderRe = /\$\{([A-Za-z0-9]+)(?:\.[^}]*)?\}/g;
      let m: RegExpExecArray | null;
      while ((m = placeholderRe.exec(val)) !== null) {
        if (knownIds.has(m[1])) out.add(m[1]);
      }
    } else {
      extractRefs(val, knownIds, out);
    }
  }
}

/**
 * Build a map from each resource's nodeId to the set of nodeIds it references,
 * by walking the parsed object of each resource's rawText.
 *
 * We match against logicalIds (plain names in rawText like "OrdersTable"),
 * then translate back to nodeIds via the logicalId→nodeId map.
 *
 * Returns Map<srcNodeId, Set<tgtNodeId>>.
 */
function buildRefMap(
  resources: Array<{ nodeId: string; logicalId: string; rawText: string }>,
): Map<string, Set<string>> {
  // Index logicalId → nodeId for translation after matching.
  const logicalToNode = new Map<string, string>(resources.map((r) => [r.logicalId, r.nodeId]));
  // All logicalIds as a set for O(1) membership checks inside extractRefs.
  const allLogicalIds = new Set(resources.map((r) => r.logicalId));

  // Index nodeId → parsed rawText object.
  const parsed = new Map<string, unknown>();
  for (const { nodeId, rawText } of resources) {
    try {
      parsed.set(nodeId, JSON.parse(rawText));
    } catch {
      parsed.set(nodeId, null);
    }
  }

  const result = new Map<string, Set<string>>();
  for (const { nodeId, logicalId } of resources) {
    // Collect referenced logicalIds (not nodeIds) — rawText contains plain names.
    const otherLogicalIds = new Set([...allLogicalIds].filter((id) => id !== logicalId));
    const refLogicalIds = new Set<string>();
    extractRefs(parsed.get(nodeId), otherLogicalIds, refLogicalIds);

    // Translate logicalId references → nodeIds.
    const refNodeIds = new Set<string>();
    for (const refLogicalId of refLogicalIds) {
      const refNodeId = logicalToNode.get(refLogicalId);
      if (refNodeId) refNodeIds.add(refNodeId);
    }
    result.set(nodeId, refNodeIds);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Node ID helpers.
//
// Serverless Framework `functions:` entries get ids in the `fn:<name>` namespace
// to avoid collisions with PascalCase CFN logical IDs from the same template's
// `resources.Resources` block (e.g. a function named `Api` would otherwise collide
// with a CFN resource `Api`).

function nodeIdForResource(r: CfnResource): string {
  return r.source === 'serverless-fn' ? `fn:${r.logicalId}` : `resource:${r.logicalId}`;
}

// ---------------------------------------------------------------------------
// Pure graph builder.

export function buildAwsGraph(templates: CfnResource[], root: string, dockerfileIndex?: DockerfileIndex): InfraGraph {
  const nodes: InfraNode[] = [];
  const classificationsNeeded: ClassificationRef[] = [];

  for (const r of templates) {
    const { kind } = heuristicKind(r.type);
    const nodeId = nodeIdForResource(r);
    // CodeUri / container Image → source roots.
    const roots = awsSourceRoots(r.rawText, r.dir ?? '', dockerfileIndex);
    nodes.push({
      id: nodeId,
      label: `${r.logicalId} (${r.type})`,
      kind,
      provenance: 'inferred',
      metadata: {
        provider: 'aws/cloudformation',
        resourceType: r.type,
      },
      ...(roots.length ? { sourceRoots: roots } : {}),
    });
    classificationsNeeded.push({
      provider: 'aws/cloudformation',
      resourceType: r.type,
      forNodeId: nodeId,
    });
  }

  // Cross-resource edges: walk each resource's parsed rawText for Ref /
  // Fn::GetAtt / DependsOn / Fn::Sub references to other resources' nodeIds.
  // Using a pre-built ref-map is O(R) rather than O(R²) and avoids false
  // positives from substring matches in the old rawText regex approach.
  const edges: InfraEdge[] = [];
  const seenEdges = new Set<string>();

  const resourcesWithNodeIds = templates.map((r) => ({
    nodeId: nodeIdForResource(r),
    logicalId: r.logicalId,
    rawText: r.rawText,
  }));
  const refMap = buildRefMap(resourcesWithNodeIds);

  for (const [srcId, refs] of refMap) {
    for (const tgtId of refs) {
      if (srcId === tgtId) continue;
      const key = `${srcId}→${tgtId}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({
        source: srcId,
        target: tgtId,
        kind: 'calls',
        metadata: { via: 'cfn-ref' },
      });
    }
  }

  return { root, adapter: 'aws', nodes, edges, classificationsNeeded };
}

// ---------------------------------------------------------------------------
// Adapter: detect + extract.

export const awsAdapter: InfraAdapter = {
  name: 'aws',

  async detect(repoDir: string): Promise<boolean> {
    return findAwsTemplates(repoDir).length > 0;
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    const found = findAwsTemplates(repoDir); // already sorted by abs path
    const allResources: CfnResource[] = [];
    // Track (templateFile, logicalId) pairs to deduplicate within a single
    // template. Sibling stacks (dev/prod, per-service templates) legitimately
    // reuse logical IDs like `Api` or `Table` — those are DISTINCT resources
    // and must all be included; only within one template file is a duplicate
    // logicalId a no-op (CFN itself forbids duplicate keys in a Resources map).
    const seenPerFile = new Map<string, Set<string>>();

    for (const { abs, kind } of found) {
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch (err) {
        console.warn(`  [aws] skipping unreadable ${relative(repoDir, abs)}: ${(err as Error).message}`);
        continue;
      }

      // For candidate CFN files (not serverless), verify content before parsing.
      if (kind === 'cfn' && !abs.endsWith('.template.json') && !isCfnTemplate(text)) {
        // The file exists in a template-named location but isn't actually a CFN
        // template — skip silently (e.g. a plain JSON config named template.json).
        continue;
      }

      let resources: CfnResource[];
      try {
        if (kind === 'serverless') {
          resources = parseServerlessConfig(text);
        } else {
          resources = parseCfnTemplate(text);
        }
      } catch (err) {
        console.warn(`  [aws] skipping unparseable ${relative(repoDir, abs)}: ${(err as Error).message}`);
        continue;
      }

      // Dedupe within this file only. The nodeId incorporates source ('fn:'
      // vs 'resource:') so a serverless-fn and a CFN resource with the same
      // bare name won't collide globally either.
      const fileSeenIds = seenPerFile.get(abs) ?? new Set<string>();
      seenPerFile.set(abs, fileSeenIds);

      // stamp the template's repo-relative dir for CodeUri resolution.
      const fileDir = dirOfPath((relative(repoDir, abs) || abs).split('\\').join('/'));

      for (const r of resources) {
        const nodeId = nodeIdForResource(r);
        if (!fileSeenIds.has(nodeId)) {
          fileSeenIds.add(nodeId);
          allResources.push({ ...r, dir: fileDir });
        }
      }
    }

    // Dockerfile index for ECS image refs.
    return buildAwsGraph(allResources, repoDir, buildDockerfileIndex(repoDir));
  },
};
