// azure adapter tests.
//
// Drives buildAzureGraph over inline fixtures representing a real Azure app:
//   - ARM template: Microsoft.Web/sites + Microsoft.Sql/servers +
//                   Microsoft.ServiceBus/namespaces + Microsoft.KeyVault/vaults
//   - Azure Function: queueTrigger (subscribes) + cosmosDB output (stores-in)
//   - AKS: Deployment + Service
// Covers: detect() hit + miss, node kinds, ALL edge kinds (calls, subscribes,
// stores-in, writes), classificationsNeeded (azure/arm taxonomy), malformed.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAzureGraph, azureAdapter, type AzureInputs } from './azure.js';
import { parseArmTemplate, parseBicep, parseFunctionJson, parseAksYaml } from './azure-parse.js';

// ---------------------------------------------------------------------------
// Fixtures

const ARM_FIXTURE = JSON.stringify({
  $schema:
    'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  contentVersion: '1.0.0.0',
  resources: [
    {
      type: 'Microsoft.Web/sites',
      name: 'my-api',
      properties: {
        serverFarmId: "[resourceId('Microsoft.Web/serverfarms', 'my-plan')]",
        // Reference to key vault via a linked resource name — should create a calls edge.
        keyVaultRef: "[resourceId('Microsoft.KeyVault/vaults', 'my-kv')]",
      },
    },
    {
      type: 'Microsoft.Sql/servers',
      name: 'my-sql',
      properties: { administratorLogin: 'admin' },
    },
    {
      type: 'Microsoft.ServiceBus/namespaces',
      name: 'my-sb',
    },
    {
      type: 'Microsoft.KeyVault/vaults',
      name: 'my-kv',
      properties: { sku: { family: 'A', name: 'standard' } },
    },
  ],
});

const FUNC_QUEUE_TRIGGER = JSON.stringify({
  bindings: [
    {
      name: 'myQueueItem',
      type: 'queueTrigger',
      direction: 'in',
      queueName: 'orders-queue',
      connection: 'AzureWebJobsStorage',
    },
    {
      name: 'outputDoc',
      type: 'cosmosDB',
      direction: 'out',
      databaseName: 'mydb',
      collectionName: 'items',
      connection: 'CosmosDBConnection',
    },
  ],
});

const AKS_FIXTURE = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker-service
  namespace: default
spec:
  selector:
    matchLabels:
      app: worker-service
---
apiVersion: v1
kind: Service
metadata:
  name: worker-service-svc
spec:
  selector:
    app: worker-service
  ports:
    - port: 80
`;

const BICEP_FIXTURE = `
resource storageAccount 'Microsoft.Storage/storageAccounts@2021-09-01' = {
  name: 'mystorageacct'
  location: 'eastus'
  sku: {
    name: 'Standard_LRS'
  }
}

resource functionApp 'Microsoft.Web/sites@2022-03-01' = {
  name: 'my-func-app'
  location: 'eastus'
  properties: {
    storageAccountRef: storageAccount.id
  }
}
`;

// ---------------------------------------------------------------------------
// Build a representative graph

const ARM_RESOURCES = parseArmTemplate(ARM_FIXTURE);
const FUNC_JSONs = [parseFunctionJson(FUNC_QUEUE_TRIGGER, 'ProcessOrders')!];
const K8S = parseAksYaml(AKS_FIXTURE);
const BICEP_RESOURCES = parseBicep(BICEP_FIXTURE);

const FULL_INPUTS: AzureInputs = {
  armResources: ARM_RESOURCES,
  bicepResources: BICEP_RESOURCES,
  functionJsons: FUNC_JSONs,
  k8sManifests: K8S,
};

describe('buildAzureGraph — node kinds', () => {
  const graph = buildAzureGraph(FULL_INPUTS, '/repo');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const byLabel = (label: string) =>
    [...byId.values()].find((n) => n.label === label || n.label.includes(label));

  it('emits worker kind for Microsoft.Web/sites', () => {
    const node = [...byId.values()].find(
      (n) => n.metadata?.resourceType === 'Microsoft.Web/sites',
    );
    expect(node?.kind).toBe('worker');
  });

  it('emits datastore for Microsoft.Sql/servers', () => {
    const node = [...byId.values()].find(
      (n) => n.metadata?.resourceType === 'Microsoft.Sql/servers',
    );
    expect(node?.kind).toBe('datastore');
  });

  it('emits queue for Microsoft.ServiceBus/namespaces', () => {
    const node = [...byId.values()].find(
      (n) => n.metadata?.resourceType === 'Microsoft.ServiceBus/namespaces',
    );
    expect(node?.kind).toBe('queue');
  });

  it('emits secret-store for Microsoft.KeyVault/vaults', () => {
    const node = [...byId.values()].find(
      (n) => n.metadata?.resourceType === 'Microsoft.KeyVault/vaults',
    );
    expect(node?.kind).toBe('secret-store');
  });

  it('emits worker (declared) for the Azure Function', () => {
    const fn = byId.get('func:ProcessOrders');
    expect(fn?.kind).toBe('worker');
    expect(fn?.provenance).toBe('declared');
  });

  it('emits container (declared) for the k8s Deployment', () => {
    const dep = byId.get('k8s:deployment:worker-service');
    expect(dep?.kind).toBe('container');
    expect(dep?.provenance).toBe('declared');
  });

  it('emits datastore for Microsoft.Storage (from Bicep)', () => {
    const storage = [...byId.values()].find(
      (n) => n.metadata?.resourceType === 'Microsoft.Storage/storageAccounts',
    );
    expect(storage?.kind).toBe('datastore');
  });

  it('emits worker for Microsoft.Web/sites from Bicep', () => {
    const fn = [...byId.values()].find(
      (n) => n.metadata?.resourceType === 'Microsoft.Web/sites' && n.id.startsWith('bicep:'),
    );
    expect(fn?.kind).toBe('worker');
  });

  it('uses inferred provenance for ARM/Bicep resources', () => {
    const armNodes = graph.nodes.filter(
      (n) => n.id.startsWith('arm:') || n.id.startsWith('bicep:'),
    );
    expect(armNodes.every((n) => n.provenance === 'inferred')).toBe(true);
  });

  it('emits a queue node for the queueTrigger binding target', () => {
    const qNode = [...byId.values()].find(
      (n) => n.kind === 'queue' && n.label === 'orders-queue',
    );
    expect(qNode).toBeTruthy();
    void byLabel; // satisfy eslint
  });
});

describe('buildAzureGraph — edge kinds', () => {
  const graph = buildAzureGraph(FULL_INPUTS, '/repo');

  it('emits a `subscribes` edge from the Azure Function to the queue (queueTrigger)', () => {
    const edge = graph.edges.find(
      (e) => e.source === 'func:ProcessOrders' && e.kind === 'subscribes',
    );
    expect(edge).toBeTruthy();
    expect(edge?.target).toContain('queue');
  });

  it('emits a `stores-in` edge from the Azure Function to CosmosDB output', () => {
    const edge = graph.edges.find(
      (e) => e.source === 'func:ProcessOrders' && e.kind === 'stores-in',
    );
    expect(edge).toBeTruthy();
  });

  it('emits a `calls` edge between ARM resources that reference each other', () => {
    // my-api's rawText contains resourceId references to my-kv — should produce a calls edge.
    const callsEdges = graph.edges.filter((e) => e.kind === 'calls');
    expect(callsEdges.length).toBeGreaterThan(0);
  });

  it('emits a `calls` edge from the Bicep functionApp to storageAccount (symbolic reference)', () => {
    const funcBicep = graph.nodes.find(
      (n) => n.id === 'bicep:functionApp',
    );
    const storageBicep = graph.nodes.find(
      (n) => n.id === 'bicep:storageAccount',
    );
    expect(funcBicep).toBeTruthy();
    expect(storageBicep).toBeTruthy();
    const edge = graph.edges.find(
      (e) =>
        e.source === 'bicep:functionApp' &&
        e.target === 'bicep:storageAccount' &&
        e.kind === 'calls',
    );
    expect(edge).toBeTruthy();
  });

  it('emits a `calls` edge from k8s Service to matching Deployment', () => {
    const svcEdge = graph.edges.find(
      (e) =>
        e.source === 'k8s:service:worker-service-svc' &&
        e.target === 'k8s:deployment:worker-service' &&
        e.kind === 'calls',
    );
    expect(svcEdge).toBeTruthy();
  });

  it('covers all expected edge kinds in the fixture: calls + subscribes + stores-in', () => {
    const kinds = new Set(graph.edges.map((e) => e.kind));
    expect(kinds.has('calls')).toBe(true);
    expect(kinds.has('subscribes')).toBe(true);
    expect(kinds.has('stores-in')).toBe(true);
  });

  it('does NOT emit forbidden edge kinds (imports / depends-on / uses)', () => {
    const forbidden = new Set(['imports', 'depends-on', 'uses']);
    expect(graph.edges.every((e) => !forbidden.has(e.kind))).toBe(true);
  });

  it('does not emit self-edges', () => {
    expect(graph.edges.every((e) => e.source !== e.target)).toBe(true);
  });

  it('deduplicates edges', () => {
    const keys = graph.edges.map((e) => `${e.source}→${e.target}→${e.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildAzureGraph — classificationsNeeded', () => {
  const graph = buildAzureGraph(FULL_INPUTS, '/repo');

  it('queues every ARM resource for  classification with provider azure/arm', () => {
    const providers = new Set(graph.classificationsNeeded.map((c) => c.provider));
    expect(providers.has('azure/arm')).toBe(true);
  });

  it('uses provider azure/arm for Bicep resources (shares the ARM LLM cache)', () => {
    const bicepClassifications = graph.classificationsNeeded.filter((c) =>
      c.forNodeId.startsWith('bicep:'),
    );
    expect(bicepClassifications.length).toBeGreaterThan(0);
    expect(bicepClassifications.every((c) => c.provider === 'azure/arm')).toBe(true);
  });

  it('sets correct resourceType per ARM classification', () => {
    const webSites = graph.classificationsNeeded.find(
      (c) => c.resourceType === 'Microsoft.Web/sites',
    );
    expect(webSites).toBeTruthy();
    const kv = graph.classificationsNeeded.find(
      (c) => c.resourceType === 'Microsoft.KeyVault/vaults',
    );
    expect(kv).toBeTruthy();
  });

  it('does NOT emit classificationsNeeded for Azure Function nodes (declared)', () => {
    const funcClassifications = graph.classificationsNeeded.filter((c) =>
      c.forNodeId.startsWith('func:'),
    );
    expect(funcClassifications).toHaveLength(0);
  });

  it('does NOT emit classificationsNeeded for k8s nodes (declared)', () => {
    const k8sClassifications = graph.classificationsNeeded.filter((c) =>
      c.forNodeId.startsWith('k8s:'),
    );
    expect(k8sClassifications).toHaveLength(0);
  });

  it('emits one classificationNeeded per ARM resource (4 resources in fixture)', () => {
    const armClassifications = graph.classificationsNeeded.filter((c) =>
      c.forNodeId.startsWith('arm:'),
    );
    expect(armClassifications.length).toBe(ARM_RESOURCES.length);
  });
});

describe('buildAzureGraph — writes edge', () => {
  it('emits a `writes` edge for queue output binding', () => {
    const queueOutputFn = parseFunctionJson(
      JSON.stringify({
        bindings: [
          { name: 'req', type: 'httpTrigger', direction: 'in' },
          { name: 'msg', type: 'queue', direction: 'out', queueName: 'result-queue', connection: 'Storage' },
        ],
      }),
      'HttpToQueue',
    )!;
    const graph = buildAzureGraph(
      { armResources: [], bicepResources: [], functionJsons: [queueOutputFn], k8sManifests: [] },
      '/repo',
    );
    const writes = graph.edges.find(
      (e) => e.source === 'func:HttpToQueue' && e.kind === 'writes',
    );
    expect(writes).toBeTruthy();
    expect(writes?.target).toContain('result-queue');
  });
});

// ---------------------------------------------------------------------------
// review fixes: staticSites → static-site, functionapp vs web app

describe('buildAzureGraph — staticSites and functionapp kind mapping ( fix #4)', () => {
  it('emits static-site for Microsoft.Web/staticSites', () => {
    const armResources = parseArmTemplate(
      JSON.stringify({
        $schema:
          'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
        contentVersion: '1.0.0.0',
        resources: [{ type: 'Microsoft.Web/staticSites', name: 'my-static-site' }],
      }),
    );
    const graph = buildAzureGraph(
      { armResources, bicepResources: [], functionJsons: [], k8sManifests: [] },
      '/repo',
    );
    const node = graph.nodes.find((n) => n.metadata?.resourceType === 'Microsoft.Web/staticSites');
    expect(node).toBeTruthy();
    expect(node?.kind).toBe('static-site');
  });

  it('emits worker for Microsoft.Web/sites with kind=functionapp', () => {
    const armResources = parseArmTemplate(
      JSON.stringify({
        $schema:
          'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
        contentVersion: '1.0.0.0',
        resources: [{ type: 'Microsoft.Web/sites', name: 'my-func-app', kind: 'functionapp' }],
      }),
    );
    const graph = buildAzureGraph(
      { armResources, bicepResources: [], functionJsons: [], k8sManifests: [] },
      '/repo',
    );
    const node = graph.nodes.find((n) => n.metadata?.resourceType === 'Microsoft.Web/sites');
    expect(node).toBeTruthy();
    expect(node?.kind).toBe('worker');
    // armKind must be surfaced in metadata so downstream consumers can distinguish
    expect(node?.metadata?.armKind).toBe('functionapp');
  });

  it('emits worker for Microsoft.Web/sites WITHOUT kind=functionapp (plain web app)', () => {
    const armResources = parseArmTemplate(
      JSON.stringify({
        $schema:
          'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
        contentVersion: '1.0.0.0',
        resources: [{ type: 'Microsoft.Web/sites', name: 'my-web-app' }],
      }),
    );
    const graph = buildAzureGraph(
      { armResources, bicepResources: [], functionJsons: [], k8sManifests: [] },
      '/repo',
    );
    const node = graph.nodes.find((n) => n.metadata?.resourceType === 'Microsoft.Web/sites');
    expect(node).toBeTruthy();
    expect(node?.kind).toBe('worker');
    // armKind should be absent (undefined) for plain App Service sites
    expect(node?.metadata?.armKind).toBeUndefined();
  });

  it('ARM template with non-Microsoft first element is still detected and parsed', () => {
    // fix #1: isArmTemplate must not bail on resources[0] lacking Microsoft.* type.
    const armResources = parseArmTemplate(
      JSON.stringify({
        // No $schema — relies on resources-array heuristic
        resources: [
          // First element is a copy-loop object, not a real resource
          { name: '[copyIndex()]', copy: { name: 'loop', count: 3 } },
          { type: 'Microsoft.Web/sites', name: 'my-app' },
          { type: 'Microsoft.KeyVault/vaults', name: 'my-kv' },
        ],
      }),
    );
    // Both real resources should be extracted
    expect(armResources.length).toBeGreaterThanOrEqual(2);
    const types = armResources.map((r) => r.type).filter(Boolean);
    expect(types).toContain('Microsoft.Web/sites');
    expect(types).toContain('Microsoft.KeyVault/vaults');

    const graph = buildAzureGraph(
      { armResources, bicepResources: [], functionJsons: [], k8sManifests: [] },
      '/repo',
    );
    const webNode = graph.nodes.find((n) => n.metadata?.resourceType === 'Microsoft.Web/sites');
    expect(webNode?.kind).toBe('worker');
    const kvNode = graph.nodes.find((n) => n.metadata?.resourceType === 'Microsoft.KeyVault/vaults');
    expect(kvNode?.kind).toBe('secret-store');
  });
});

describe('buildAzureGraph — malformed input safety', () => {
  it('handles empty inputs without throwing', () => {
    expect(() =>
      buildAzureGraph(
        { armResources: [], bicepResources: [], functionJsons: [], k8sManifests: [] },
        '/repo',
      ),
    ).not.toThrow();
  });

  it('handles a function.json with no bindings array', () => {
    const result = parseFunctionJson('{"version": "2.0"}', 'EmptyFn');
    // Should return a result with empty bindings, not null.
    expect(result).not.toBeNull();
    expect(result?.bindings).toEqual([]);
    const graph = buildAzureGraph(
      { armResources: [], bicepResources: [], functionJsons: [result!], k8sManifests: [] },
      '/repo',
    );
    // Should emit the worker node but no edges.
    expect(graph.nodes.find((n) => n.id === 'func:EmptyFn')).toBeTruthy();
    expect(graph.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// adapter detect() + extract() integration

describe('azureAdapter.detect', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-azure-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a repo containing a .bicep file', async () => {
    writeFileSync(join(dir, 'main.bicep'), BICEP_FIXTURE);
    expect(await azureAdapter.detect(dir)).toBe(true);
  });

  it('does NOT detect a repo with no Azure signals', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-empty-'));
    try {
      expect(await azureAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('detects a repo with only function.json', async () => {
    const fnDir = mkdtempSync(join(tmpdir(), 'backthread-azfunc-'));
    try {
      mkdirSync(join(fnDir, 'MyFunction'), { recursive: true });
      writeFileSync(join(fnDir, 'host.json'), JSON.stringify({ version: '2.0' }));
      writeFileSync(
        join(fnDir, 'MyFunction', 'function.json'),
        FUNC_QUEUE_TRIGGER,
      );
      expect(await azureAdapter.detect(fnDir)).toBe(true);
    } finally {
      rmSync(fnDir, { recursive: true, force: true });
    }
  });

  it('detects a repo with an ARM template JSON', async () => {
    const armDir = mkdtempSync(join(tmpdir(), 'backthread-arm-'));
    try {
      writeFileSync(join(armDir, 'azuredeploy.json'), ARM_FIXTURE);
      expect(await azureAdapter.detect(armDir)).toBe(true);
    } finally {
      rmSync(armDir, { recursive: true, force: true });
    }
  });
});

describe('azureAdapter.extract', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-azure-extract-'));
    // ARM template
    writeFileSync(join(dir, 'azuredeploy.json'), ARM_FIXTURE);
    // Bicep
    writeFileSync(join(dir, 'main.bicep'), BICEP_FIXTURE);
    // Azure Function
    mkdirSync(join(dir, 'ProcessOrders'), { recursive: true });
    writeFileSync(join(dir, 'host.json'), JSON.stringify({ version: '2.0' }));
    writeFileSync(join(dir, 'ProcessOrders', 'function.json'), FUNC_QUEUE_TRIGGER);
    // AKS
    writeFileSync(join(dir, 'k8s.yaml'), AKS_FIXTURE);
    // Non-Azure JSON (should be ignored)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app', version: '1.0.0' }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('extract returns a graph with nodes from all surfaces', async () => {
    const graph = await azureAdapter.extract(dir);
    const kinds = new Set(graph.nodes.map((n) => n.kind));
    expect(kinds.has('worker')).toBe(true);
    expect(kinds.has('queue')).toBe(true);
    expect(kinds.has('secret-store')).toBe(true);
    expect(kinds.has('container')).toBe(true);
    expect(kinds.has('datastore')).toBe(true);
  });

  it('extract graph adapter name is azure', async () => {
    const graph = await azureAdapter.extract(dir);
    expect(graph.adapter).toBe('azure');
  });

  it('extract emits classificationsNeeded for ARM/Bicep resources', async () => {
    const graph = await azureAdapter.extract(dir);
    expect(graph.classificationsNeeded.length).toBeGreaterThan(0);
    expect(graph.classificationsNeeded.every((c) => c.provider === 'azure/arm')).toBe(true);
  });

  it('extract does not crash on a non-Azure JSON in the same dir (package.json)', async () => {
    // Already covered by the extract above not throwing — but be explicit.
    await expect(azureAdapter.extract(dir)).resolves.toBeTruthy();
  });
});

describe('azureAdapter — malformed file tolerance', () => {
  it('extract skips a malformed ARM JSON without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backthread-bad-arm-'));
    try {
      writeFileSync(join(dir, 'bad.json'), '{ resources: [Microsoft.Web/sites} ');
      // Also write a valid Bicep so detect() fires.
      writeFileSync(join(dir, 'main.bicep'), BICEP_FIXTURE);
      const graph = await azureAdapter.extract(dir);
      // Should complete with nodes from the valid Bicep.
      expect(graph).toBeTruthy();
      expect(graph.adapter).toBe('azure');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extract handles an empty repo that detect() somehow missed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backthread-empty-extract-'));
    try {
      const graph = await azureAdapter.extract(dir);
      expect(graph.nodes).toHaveLength(0);
      expect(graph.edges).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AKS workload sourceRoots via the image→source resolver.

import type { DockerfileIndex } from '../image-resolve.js';

describe('buildAzureGraph — AKS workload sourceRoots', () => {
  const AKS_WORKLOAD = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  template:
    spec:
      containers:
        - name: orders
          image: ghcr.io/acme/orders:1.4
`;
  const index: DockerfileIndex = {
    dockerfiles: [{ dockerfile: 'services/orders/Dockerfile', context: 'services/orders' }],
    pairings: [],
  };

  it('attributes an AKS Deployment to its build context via the resolver (name convention)', () => {
    const inputs: AzureInputs = { armResources: [], bicepResources: [], functionJsons: [], k8sManifests: parseAksYaml(AKS_WORKLOAD) };
    const graph = buildAzureGraph(inputs, '/repo', index);
    expect(graph.nodes.find((n) => n.id === 'k8s:deployment:orders')?.sourceRoots).toEqual(['services/orders']);
  });

  it('leaves an unresolvable AKS workload with no sourceRoots (honest "Other")', () => {
    const inputs: AzureInputs = { armResources: [], bicepResources: [], functionJsons: [], k8sManifests: parseAksYaml(AKS_WORKLOAD) };
    const graph = buildAzureGraph(inputs, '/repo', { dockerfiles: [], pairings: [] });
    expect(graph.nodes.find((n) => n.id === 'k8s:deployment:orders')?.sourceRoots).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cloud-native Azure sourceRoots (Functions dir + Container Apps image).
// (DockerfileIndex is imported once in the  block above.)

describe('buildAzureGraph — cloud-native sourceRoots', () => {
  const azIndex: DockerfileIndex = {
    dockerfiles: [{ dockerfile: 'services/api/Dockerfile', context: 'services/api' }],
    pairings: [{ image: 'ghcr.io/acme/api', context: 'services/api' }],
  };

  it('Azure Function → its folder (function.json dir) is the source root', () => {
    const fn = parseFunctionJson('{"bindings":[]}', 'hello');
    fn!.sourceDir = 'functions/hello';
    const inputs: AzureInputs = { armResources: [], bicepResources: [], functionJsons: [fn!], k8sManifests: [] };
    const graph = buildAzureGraph(inputs, '/repo', azIndex);
    expect(graph.nodes.find((n) => n.id === 'func:hello')?.sourceRoots).toEqual(['functions/hello']);
  });

  it('a Container App ARM resource image → resolved build context', () => {
    const arm = parseArmTemplate(
      JSON.stringify({
        $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
        resources: [
          {
            type: 'Microsoft.App/containerApps',
            name: 'api',
            properties: { template: { containers: [{ name: 'api', image: 'ghcr.io/acme/api:1' }] } },
          },
        ],
      }),
    );
    const inputs: AzureInputs = { armResources: arm, bicepResources: [], functionJsons: [], k8sManifests: [] };
    const graph = buildAzureGraph(inputs, '/repo', azIndex);
    const node = graph.nodes.find((n) => n.id.startsWith('arm:Microsoft.App/containerApps'));
    expect(node?.sourceRoots).toEqual(['services/api']);
  });

  it('a Container App with an unresolvable image → no sourceRoots (honest "Other")', () => {
    const arm = parseArmTemplate(
      JSON.stringify({
        $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
        resources: [
          {
            type: 'Microsoft.App/containerApps',
            name: 'cache',
            properties: { template: { containers: [{ name: 'redis', image: 'redis:7' }] } },
          },
        ],
      }),
    );
    const inputs: AzureInputs = { armResources: arm, bicepResources: [], functionJsons: [], k8sManifests: [] };
    const graph = buildAzureGraph(inputs, '/repo', azIndex);
    expect(graph.nodes.find((n) => n.id.startsWith('arm:Microsoft.App/containerApps'))?.sourceRoots).toBeUndefined();
  });
});
