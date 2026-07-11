// Azure InfraAdapter (v0).
//
// Multi-config cluster adapter. Parses:
//   • ARM JSON templates      (`$schema` deploymentTemplate or Microsoft.* resources[])
//   • Bicep (light)           (regex-only declarations; full DSL evaluation DEFERRED)
//   • Azure Functions         (function.json / host.json)
//   • AKS / k8s manifests    (Deployment / Service / Ingress YAML)
//
// App Service slot config beyond presence is DEFERRED.
//
// Node kinds emitted:
//   worker         — Microsoft.Web/sites (App), MS Functions, k8s Deployment,
//                    Azure Function (from function.json)
//   queue          — Microsoft.ServiceBus/*, Microsoft.EventHub/*,
//                    Microsoft.EventGrid/*, Storage Queues
//   datastore      — Microsoft.Storage/*, Microsoft.Sql/*, Microsoft.DocumentDB/*,
//                    Microsoft.Cache/Redis, Microsoft.DBfor*, Microsoft.DBforMySQL/*,
//                    Microsoft.DBforPostgreSQL/*
//   secret-store   — Microsoft.KeyVault/vaults, Microsoft.AppConfiguration/*
//   container      — Microsoft.ContainerService/*, Microsoft.ContainerInstance/*
//   cdn            — Microsoft.Cdn/*, Microsoft.FrontDoor/*,
//                    Microsoft.Network/frontDoors
//   external-api   — Microsoft.CognitiveServices/* (Paid AI)
//   static-site    — Microsoft.Web/staticSites
//
// classificationsNeeded:
//   One per ARM/Bicep resource. provider `azure/arm` — shares the azure
//   taxonomy with Terraform's `azurerm_*` entries (same LLM classify cache).
//
// Edges:
//   calls       — ARM rawText cross-references (resourceId / dependsOn /
//                 symbolic name), ARM → k8s AKS cluster, Service→Deployment
//                 routing, Ingress→Service routing
//   subscribes  — Azure Function with queueTrigger / serviceBusTrigger binding
//   writes      — Azure Function with queue / blob / cosmosDB output binding
//   stores-in   — Azure Function with cosmosDB trigger / blob output
//
// v0 scope notes (all DEFERRED):
//   • Full Bicep DSL expression evaluation (parameters, variables, `if()`)
//   • App Service deployment slot config (beyond structural node presence)
//   • Module recursion for Bicep module declarations
//   • Cross-manifest k8s label matching beyond selector name alignment
//   • Azure Policy / Management Group / Monitor resources (emit with heuristic kind)

import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import type {
  InfraAdapter,
  InfraEdge,
  InfraGraph,
  InfraNode,
  ClassificationRef,
} from '../types.js';
import type { InfraModuleKind } from '../../types.js';
import { walkRepo } from '../walk.js';
import { workloadSourceRoots } from '../k8s/index.js';
import { buildDockerfileIndex, resolveImageToSourceRoots, type DockerfileIndex } from '../image-resolve.js';
import {
  parseArmTemplate,
  parseBicep,
  parseFunctionJson,
  parseHostJson,
  parseAksYaml,
  isArmTemplate,
  type ArmResource,
  type BicepResource,
  type K8sManifest,
  type AzFuncFunctionJson,
} from './azure-parse.js';

// ---------------------------------------------------------------------------
// Filesystem walk

const AZURE_SKIP_DIRS = [
  'node_modules',
  '.git',
  'dist',
  '.wrangler',
  '.terraform',
  '.next',
  'build',
  'coverage',
  'vendor',
  '__pycache__',
];

interface AzureFiles {
  arm: string[];
  bicep: string[];
  functionJson: string[]; // each is a function.json path
  hostJson: string[]; // each is a host.json path
  aksYaml: string[]; // *.yaml / *.yml that might be k8s
}

function findAzureFiles(repoDir: string): AzureFiles {
  const result: AzureFiles = { arm: [], bicep: [], functionJson: [], hostJson: [], aksYaml: [] };
  walkRepo(repoDir, {
    skipDirs: AZURE_SKIP_DIRS,
    onFile: (abs, e) => {
      if (e.name.endsWith('.bicep')) {
        result.bicep.push(abs);
      } else if (e.name === 'function.json') {
        result.functionJson.push(abs);
      } else if (e.name === 'host.json') {
        result.hostJson.push(abs);
      } else if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) {
        result.aksYaml.push(abs);
      } else if (e.name.endsWith('.json') && e.name !== 'function.json' && e.name !== 'host.json') {
        result.arm.push(abs);
      }
    },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Kind heuristics — ARM/Bicep resource types → InfraModuleKind
//
// Microsoft resource type namespaces, most-specific first. The LLM cache
// (classifyResourceTypes) upgrades `inferred` nodes after extraction; these
// rules keep the topology usable under --no-llm and during the classify gap.

interface KindRule {
  re: RegExp;
  kind: InfraModuleKind;
}

const ARM_KIND_RULES: KindRule[] = [
  // Functions / App Service compute
  { re: /^Microsoft\.Web\/sites\/functions$/i, kind: 'worker' },
  { re: /^Microsoft\.Web\/sites$/i, kind: 'worker' },
  { re: /^Microsoft\.Web\/staticSites$/i, kind: 'static-site' },
  { re: /^Microsoft\.Web\/serverfarms$/i, kind: 'worker' }, // App Service plan — compute host
  // Azure Functions standalone resource type (legacy / early naming)
  { re: /^Microsoft\.Functions\//i, kind: 'worker' },
  // Messaging / eventing
  { re: /^Microsoft\.ServiceBus\//i, kind: 'queue' },
  { re: /^Microsoft\.EventHub\//i, kind: 'queue' },
  { re: /^Microsoft\.EventGrid\//i, kind: 'queue' },
  // Container services
  { re: /^Microsoft\.ContainerService\//i, kind: 'container' },
  { re: /^Microsoft\.ContainerInstance\//i, kind: 'container' },
  { re: /^Microsoft\.ContainerRegistry\//i, kind: 'container' },
  // Storage / datastores
  { re: /^Microsoft\.Storage\//i, kind: 'datastore' },
  { re: /^Microsoft\.Sql\//i, kind: 'datastore' },
  { re: /^Microsoft\.DocumentDB\//i, kind: 'datastore' }, // Cosmos DB
  { re: /^Microsoft\.Cache\/Redis/i, kind: 'datastore' },
  { re: /^Microsoft\.DBforMySQL\//i, kind: 'datastore' },
  { re: /^Microsoft\.DBforPostgreSQL\//i, kind: 'datastore' },
  { re: /^Microsoft\.DBforMariaDB\//i, kind: 'datastore' },
  { re: /^Microsoft\.Synapse\//i, kind: 'datastore' },
  { re: /^Microsoft\.DataFactory\//i, kind: 'datastore' },
  // Secret / config stores
  { re: /^Microsoft\.KeyVault\//i, kind: 'secret-store' },
  { re: /^Microsoft\.AppConfiguration\//i, kind: 'secret-store' },
  // CDN / edge
  { re: /^Microsoft\.Cdn\//i, kind: 'cdn' },
  { re: /^Microsoft\.Network\/frontDoors/i, kind: 'cdn' },
  { re: /^Microsoft\.FrontDoor\//i, kind: 'cdn' },
  // Paid AI services
  { re: /^Microsoft\.CognitiveServices\//i, kind: 'external-api' },
  { re: /^Microsoft\.MachineLearning\//i, kind: 'external-api' },
  { re: /^Microsoft\.MachineLearningServices\//i, kind: 'external-api' },
  // Search
  { re: /^Microsoft\.Search\//i, kind: 'external-api' },
];

function heuristicArmKind(
  resourceType: string,
  armKind?: string,
): { kind: InfraModuleKind } {
  for (const rule of ARM_KIND_RULES) {
    if (rule.re.test(resourceType)) {
      // Microsoft.Web/sites with kind='functionapp' stays 'worker' — same Backthread
      // module kind as a plain App Service site.  We don't demote or re-classify;
      // the distinction is surfaced in node metadata (armKind) so the LLM
      // classifier can annotate it further.  Both are compute, both are worker.
      void armKind; // acknowledged — no kind override needed for current rules
      return { kind: rule.kind };
    }
  }
  return { kind: 'datastore' }; // least-bad fallback (see Terraform adapter rationale)
}

// ---------------------------------------------------------------------------
// Node-id helpers (adapter-local; registry prefixes `azure:`)

const armNodeId = (type: string, name: string) =>
  `arm:${type.replace(/\s+/g, '_')}/${name}`;
const bicepNodeId = (symbolicName: string) => `bicep:${symbolicName}`;
const funcNodeId = (fnName: string) => `func:${fnName}`;
const k8sDeploymentId = (name: string) => `k8s:deployment:${name}`;
const k8sServiceId = (name: string) => `k8s:service:${name}`;

// ---------------------------------------------------------------------------
// Source-root helpers.

/** Normalize a repo-relative path: backslashes→/, collapse `.`/`./`, strip trailing `/`. */
function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
}

/**
 * Resolve container image refs out of an ARM/Bicep resource's raw text (ARM
 * `"image": "…"` JSON or Bicep `image: '…'`) via the  resolver. Only
 * plain literal refs — an ARM/Bicep expression (`[concat(…)]`, `${…}`,
 * `resourceId(…)`) is skipped (unresolvable → honest "Other", never guess).
 */
function azureImageRoots(rawText: string, index?: DockerfileIndex): string[] {
  if (!index) return [];
  const roots = new Set<string>();
  const re = /(?:"image"|\bimage)\s*:\s*['"]([^'"]+)['"]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawText)) !== null) {
    const v = m[1];
    if (!v || /[[\]${}()]/.test(v)) continue; // an expression, not a literal image
    for (const r of resolveImageToSourceRoots(v, index)) roots.add(r);
  }
  return [...roots].sort();
}

// ---------------------------------------------------------------------------
// Pure graph builder

export interface AzureInputs {
  armResources: ArmResource[];
  bicepResources: BicepResource[];
  functionJsons: AzFuncFunctionJson[];
  k8sManifests: K8sManifest[];
}

export function buildAzureGraph(inputs: AzureInputs, root: string, dockerfileIndex?: DockerfileIndex): InfraGraph {
  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];
  const classificationsNeeded: ClassificationRef[] = [];

  const seen = new Set<string>(); // dedup edges: `${source}→${target}→${kind}`
  const addNode = (n: InfraNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };
  const addEdge = (e: InfraEdge) => {
    const key = `${e.source}→${e.target}→${e.kind}`;
    if (e.source === e.target) return;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(e);
  };

  // -------------------------------------------------------------------------
  // 1. ARM resources

  for (const r of inputs.armResources) {
    const id = armNodeId(r.type, r.name);
    const { kind } = heuristicArmKind(r.type, r.armKind);
    // container resources (Container Apps/Instances) reference an
    // image; resolve it to a build context.
    const roots = /container/i.test(r.type) ? azureImageRoots(r.rawText, dockerfileIndex) : [];
    addNode({
      id,
      label: r.name || r.type,
      kind,
      provenance: 'inferred', // upgraded to llm-classified by classify step
      metadata: {
        provider: 'azure/arm',
        resourceType: r.type,
        ...(r.armKind !== undefined ? { armKind: r.armKind } : {}),
      },
      ...(roots.length ? { sourceRoots: roots } : {}),
    });
    classificationsNeeded.push({
      provider: 'azure/arm',
      resourceType: r.type,
      forNodeId: id,
    });
  }

  // ARM cross-resource edges: scan each resource's rawText for references to
  // other resources' names. Uses `calls` (structural dependency, honest verb
  // without knowing the actual runtime relationship — mirrors Terraform adapter).
  for (const src of inputs.armResources) {
    const srcId = armNodeId(src.type, src.name);
    for (const tgt of inputs.armResources) {
      if (src === tgt) continue;
      const tgtId = armNodeId(tgt.type, tgt.name);
      if (armTextReferences(src.rawText, tgt)) {
        addEdge({ source: srcId, target: tgtId, kind: 'calls', metadata: { via: 'arm-ref' } });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Bicep resources (light regex extraction)

  for (const r of inputs.bicepResources) {
    if (r.isModule) {
      // Module declarations: emit as worker (they wrap compute), provenance inferred.
      // We don't know the type from the path — no classificationsNeeded emitted.
      addNode({
        id: bicepNodeId(r.symbolicName),
        label: r.symbolicName,
        kind: 'worker',
        provenance: 'inferred',
        metadata: { provider: 'azure/bicep', bicepPath: r.type, isModule: true },
      });
      continue;
    }
    const id = bicepNodeId(r.symbolicName);
    const { kind } = heuristicArmKind(r.type);
    const roots = /container/i.test(r.type) ? azureImageRoots(r.rawText, dockerfileIndex) : [];
    addNode({
      id,
      label: r.symbolicName,
      kind,
      provenance: 'inferred',
      metadata: {
        provider: 'azure/arm', // intentionally azure/arm — same LLM classify cache
        resourceType: r.type,
        apiVersion: r.apiVersion,
      },
      ...(roots.length ? { sourceRoots: roots } : {}),
    });
    classificationsNeeded.push({
      provider: 'azure/arm',
      resourceType: r.type,
      forNodeId: id,
    });
  }

  // Bicep cross-resource edges (symbolic name references in rawText).
  for (const src of inputs.bicepResources) {
    const srcId = bicepNodeId(src.symbolicName);
    for (const tgt of inputs.bicepResources) {
      if (src === tgt) continue;
      const tgtId = bicepNodeId(tgt.symbolicName);
      if (rawTextReferencesSymbol(src.rawText, tgt.symbolicName)) {
        addEdge({ source: srcId, target: tgtId, kind: 'calls', metadata: { via: 'bicep-ref' } });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Azure Functions

  for (const fn of inputs.functionJsons) {
    const fnId = funcNodeId(fn.functionName);

    // Every function → worker node (provenance: declared — function.json IS the declaration)
    // the function's folder (holding function.json) is its source root.
    const fnRoots = fn.sourceDir ? [normalizeRoot(fn.sourceDir)].filter((d) => d.length > 0) : [];
    addNode({
      id: fnId,
      label: fn.functionName,
      kind: 'worker',
      provenance: 'declared',
      metadata: { provider: 'azure/functions', source: 'function.json' },
      ...(fnRoots.length ? { sourceRoots: fnRoots } : {}),
    });

    // Bindings → edges
    for (const binding of fn.bindings) {
      const bType = binding.type.toLowerCase();

      if (bType === 'httptrigger' || bType === 'http') {
        // httpTrigger = this function IS an HTTP endpoint — no structural edge needed.
        // http output binding = response — also no separate node.
        continue;
      }

      if (bType === 'queuetrigger' || bType === 'servicebustrigger' || bType === 'eventhubstrigger') {
        // This function SUBSCRIBES to a queue/topic.
        const resourceName =
          binding.queueName ?? binding.topicName ?? binding.connection ?? bType;
        const queueId = `queue:func-queue:${resourceName}`;
        addNode({
          id: queueId,
          label: resourceName,
          kind: 'queue',
          provenance: 'inferred',
          metadata: { provider: 'azure/functions', bindingType: binding.type },
        });
        addEdge({
          source: fnId,
          target: queueId,
          kind: 'subscribes',
          metadata: { binding: binding.name, bindingType: binding.type },
        });
        continue;
      }

      if (bType === 'timertrigger') {
        // Timer trigger: no structural target node — cron schedule.
        continue;
      }

      if (bType === 'blobtrigger') {
        // Blob trigger: the function reads from storage.
        const resourceName = binding.connection ?? 'blob-storage';
        const blobId = `datastore:func-blob:${resourceName}`;
        addNode({
          id: blobId,
          label: resourceName,
          kind: 'datastore',
          provenance: 'inferred',
          metadata: { provider: 'azure/functions', bindingType: 'blobTrigger' },
        });
        addEdge({
          source: fnId,
          target: blobId,
          kind: 'reads',
          metadata: { binding: binding.name, bindingType: binding.type },
        });
        continue;
      }

      if (bType === 'cosmosdbtrigger') {
        // CosmosDB trigger: subscribes to change feed → treat as reads from datastore.
        const resourceName = binding.connection ?? 'cosmos-db';
        const cosmosId = `datastore:func-cosmos:${resourceName}`;
        addNode({
          id: cosmosId,
          label: resourceName,
          kind: 'datastore',
          provenance: 'inferred',
          metadata: { provider: 'azure/functions', bindingType: 'cosmosDBTrigger' },
        });
        addEdge({
          source: fnId,
          target: cosmosId,
          kind: 'reads',
          metadata: { binding: binding.name, bindingType: binding.type },
        });
        continue;
      }

      // Output bindings (direction === 'out')
      if (binding.direction === 'out') {
        if (bType === 'queue' || bType === 'servicebus' || bType === 'eventhub') {
          const resourceName =
            binding.queueName ?? binding.topicName ?? binding.connection ?? bType;
          const queueId = `queue:func-queue:${resourceName}`;
          addNode({
            id: queueId,
            label: resourceName,
            kind: 'queue',
            provenance: 'inferred',
            metadata: { provider: 'azure/functions', bindingType: binding.type },
          });
          addEdge({
            source: fnId,
            target: queueId,
            kind: 'writes',
            metadata: { binding: binding.name, bindingType: binding.type },
          });
        } else if (bType === 'blob' || bType === 'table') {
          const resourceName = binding.connection ?? 'blob-storage';
          const blobId = `datastore:func-blob:${resourceName}`;
          addNode({
            id: blobId,
            label: resourceName,
            kind: 'datastore',
            provenance: 'inferred',
            metadata: { provider: 'azure/functions', bindingType: binding.type },
          });
          addEdge({
            source: fnId,
            target: blobId,
            kind: 'stores-in',
            metadata: { binding: binding.name, bindingType: binding.type },
          });
        } else if (bType === 'cosmosdb') {
          const resourceName = binding.connection ?? 'cosmos-db';
          const cosmosId = `datastore:func-cosmos:${resourceName}`;
          addNode({
            id: cosmosId,
            label: resourceName,
            kind: 'datastore',
            provenance: 'inferred',
            metadata: { provider: 'azure/functions', bindingType: 'cosmosDB' },
          });
          addEdge({
            source: fnId,
            target: cosmosId,
            kind: 'stores-in',
            metadata: { binding: binding.name, bindingType: binding.type },
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. AKS / k8s manifests

  const k8sDeployments = new Map<string, K8sManifest>();
  const k8sServices = new Map<string, K8sManifest>();

  for (const manifest of inputs.k8sManifests) {
    const kind = manifest.kind;
    if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet') {
      const id = k8sDeploymentId(manifest.name);
      // attribute the AKS workload's code via its container image(s).
      const roots = dockerfileIndex ? workloadSourceRoots(manifest.rawObj, dockerfileIndex) : [];
      addNode({
        id,
        label: manifest.name,
        kind: 'container',
        provenance: 'declared',
        metadata: {
          provider: 'azure/aks',
          k8sKind: kind,
          namespace: manifest.namespace,
        },
        ...(roots.length ? { sourceRoots: roots } : {}),
      });
      k8sDeployments.set(manifest.name, manifest);
    } else if (kind === 'Service') {
      k8sServices.set(manifest.name, manifest);
      // Service itself is routing metadata — not a separate node; becomes edges below.
    } else if (kind === 'Ingress') {
      // Ingress → service → deployment chain.
      for (const backend of manifest.ingressBackends ?? []) {
        const svc = k8sServices.get(backend);
        if (svc?.selector) {
          // Find a Deployment that matches the selector (simple name heuristic).
          for (const [depName] of k8sDeployments) {
            if (Object.values(svc.selector).some((v) => v === depName || depName.startsWith(v))) {
              addEdge({
                source: k8sDeploymentId(manifest.name + '-ingress'),
                target: k8sDeploymentId(depName),
                kind: 'calls',
                metadata: { via: 'ingress→service→deployment' },
              });
            }
          }
        }
      }
    }
  }

  // Service routing: a Service with selector → calls the matching Deployment.
  for (const [svcName, svc] of k8sServices) {
    if (!svc.selector) continue;
    for (const [depName] of k8sDeployments) {
      // Heuristic: if the deployment name matches the service name or any selector value.
      if (
        depName === svcName ||
        Object.values(svc.selector).some((v) => v === depName || depName.startsWith(v))
      ) {
        // A Service routes TO a Deployment — express as `calls`.
        addEdge({
          source: k8sServiceId(svcName),
          target: k8sDeploymentId(depName),
          kind: 'calls',
          metadata: { via: 'k8s-service-selector' },
        });
      }
    }
  }

  // ARM → AKS cluster: ARM ContainerService/managedClusters resources `calls`
  // k8s Deployment nodes found in the same repo — the ARM template manages them.
  const armAksNodes = [...nodes.values()].filter(
    (n) => n.kind === 'container' && n.provenance === 'inferred',
  );
  const aksDeploymentNodes = [...nodes.values()].filter(
    (n) => n.kind === 'container' && n.provenance === 'declared',
  );
  if (armAksNodes.length > 0 && aksDeploymentNodes.length > 0) {
    for (const aksArm of armAksNodes) {
      for (const dep of aksDeploymentNodes) {
        addEdge({ source: aksArm.id, target: dep.id, kind: 'calls', metadata: { via: 'aks-manages' } });
      }
    }
  }

  return {
    root,
    adapter: 'azure',
    nodes: [...nodes.values()],
    edges,
    classificationsNeeded,
  };
}

// ---------------------------------------------------------------------------
// Reference scanning helpers

/**
 * Determine whether an ARM resource's rawText references the target — by name,
 * resourceId() call, or dependsOn. Bias: MISS over INVENT (same as Terraform).
 */
function armTextReferences(rawText: string, target: ArmResource): boolean {
  if (!target.name) return false;
  // Look for the name outside of description/comments heuristic:
  // In JSON rawText the name always appears as a JSON string value `"<name>"`
  // so we require quote delimiters which greatly reduces prose false positives.
  // Also look for resourceId references that include the type or name.
  const quotedName = `"${target.name}"`;
  const typeRef = target.type.toLowerCase();
  // Only fire if either the quoted name appears somewhere meaningful or
  // a resourceId pattern with the type shows up.
  if (rawText.includes(quotedName)) {
    // Additional guard: the name reference must not only appear as the resource's
    // own `"name"` key value — but we can't easily avoid that without a full JSON
    // walk. Accept the false positive rate as acceptable for v0 (same as TF adapter).
    return true;
  }
  // resourceId("Microsoft.X/Y", ...) references.
  if (rawText.toLowerCase().includes(`resourceid("${typeRef}`)) return true;
  return false;
}

/**
 * Whether rawText references the Bicep symbolic name as a traversal.
 * Requires the name to appear at a word boundary (not as a substring of
 * another identifier).
 */
function rawTextReferencesSymbol(rawText: string, symbolicName: string): boolean {
  if (!symbolicName) return false;
  // Bicep references look like `symbolicName.property` or `${symbolicName.x}`.
  const re = new RegExp(`(?<![\\w])${symbolicName}(?=\\.)`, '');
  return re.test(rawText);
}

// ---------------------------------------------------------------------------
// Detect helpers: identify Azure-bearing files without reading them

function looksLikeArmTemplate(text: string): boolean {
  const parsed = tryParseJson(text);
  if (parsed === null) return false;
  return isArmTemplate(parsed);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// InfraAdapter

/** Detect: true if the repo contains at least one recognizable Azure surface. */
async function detectAzure(repoDir: string): Promise<boolean> {
  const files = findAzureFiles(repoDir);
  if (files.bicep.length > 0) return true;
  if (files.functionJson.length > 0) return true;
  // Check for ARM templates among JSON files (don't read all JSON — check a few).
  for (const file of files.arm.slice(0, 20)) {
    try {
      const text = readFileSync(file, 'utf8');
      if (looksLikeArmTemplate(text)) return true;
    } catch {
      // skip unreadable
    }
  }
  // Check for k8s manifests among YAML files (check a few).
  for (const file of files.aksYaml.slice(0, 20)) {
    try {
      const text = readFileSync(file, 'utf8');
      const docs = parseAksYaml(text);
      if (docs.length > 0) return true;
    } catch {
      // skip
    }
  }
  return false;
}

/** Extract: walk all Azure-relevant files and build the InfraGraph. */
async function extractAzure(repoDir: string): Promise<InfraGraph> {
  const files = findAzureFiles(repoDir);
  const inputs: AzureInputs = {
    armResources: [],
    bicepResources: [],
    functionJsons: [],
    k8sManifests: [],
  };

  // ARM JSON
  for (const file of files.arm) {
    try {
      const text = readFileSync(file, 'utf8');
      const resources = parseArmTemplate(text);
      if (resources.length > 0) inputs.armResources.push(...resources);
    } catch (err) {
      console.warn(
        `  [azure] skipping unparseable ${relative(repoDir, file)}: ${(err as Error).message}`,
      );
    }
  }

  // Bicep
  for (const file of files.bicep) {
    try {
      const text = readFileSync(file, 'utf8');
      inputs.bicepResources.push(...parseBicep(text));
    } catch (err) {
      console.warn(
        `  [azure] skipping unparseable ${relative(repoDir, file)}: ${(err as Error).message}`,
      );
    }
  }

  // Azure Functions
  for (const file of files.functionJson) {
    try {
      const text = readFileSync(file, 'utf8');
      // Function name = parent directory name.
      const fnDirAbs = file.slice(0, -'/function.json'.length);
      const fnName = basename(fnDirAbs);
      const parsed = parseFunctionJson(text, fnName);
      if (parsed) {
        // the function's folder (repo-relative) is its source root.
        parsed.sourceDir = (relative(repoDir, fnDirAbs) || '').split('\\').join('/');
        inputs.functionJsons.push(parsed);
      }
    } catch (err) {
      console.warn(
        `  [azure] skipping unparseable ${relative(repoDir, file)}: ${(err as Error).message}`,
      );
    }
  }

  // host.json presence is a detect signal only; we don't need to parse it for topology.
  for (const file of files.hostJson) {
    try {
      parseHostJson(readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn(
        `  [azure] skipping unparseable ${relative(repoDir, file)}: ${(err as Error).message}`,
      );
    }
  }

  // AKS YAML
  for (const file of files.aksYaml) {
    try {
      const text = readFileSync(file, 'utf8');
      const manifests = parseAksYaml(text);
      inputs.k8sManifests.push(...manifests);
    } catch (err) {
      console.warn(
        `  [azure] skipping unparseable ${relative(repoDir, file)}: ${(err as Error).message}`,
      );
    }
  }

  // Dockerfile index for AKS workload image→source attribution.
  return buildAzureGraph(inputs, repoDir, buildDockerfileIndex(repoDir));
}

export const azureAdapter: InfraAdapter = {
  name: 'azure',
  detect: detectAzure,
  extract: extractAzure,
};
