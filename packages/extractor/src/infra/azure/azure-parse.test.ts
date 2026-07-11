// azure-parse unit tests.
//
// Covers: ARM JSON, light Bicep regex, function.json (queueTrigger),
// AKS multi-doc YAML, and malformed-input safety.

import { describe, it, expect } from '../../testkit.js';
import {
  parseArmTemplate,
  isArmTemplate,
  parseBicep,
  parseFunctionJson,
  parseHostJson,
  parseAksYaml,
} from './azure-parse.js';

// ---------------------------------------------------------------------------
// ARM JSON

const ARM_TEMPLATE = JSON.stringify({
  $schema:
    'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  contentVersion: '1.0.0.0',
  resources: [
    {
      type: 'Microsoft.Web/sites',
      name: 'my-app',
      properties: {
        serverFarmId: "[resourceId('Microsoft.Web/serverfarms', 'my-plan')]",
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
      resources: [
        {
          type: 'Microsoft.ServiceBus/namespaces/queues',
          name: 'my-sb/orders',
        },
      ],
    },
    {
      type: 'Microsoft.KeyVault/vaults',
      name: 'my-kv',
    },
  ],
});

describe('parseArmTemplate', () => {
  it('parses a valid ARM template and returns all top-level resources', () => {
    const resources = parseArmTemplate(ARM_TEMPLATE);
    expect(resources.length).toBeGreaterThanOrEqual(4);
    const types = resources.map((r) => r.type);
    expect(types).toContain('Microsoft.Web/sites');
    expect(types).toContain('Microsoft.Sql/servers');
    expect(types).toContain('Microsoft.ServiceBus/namespaces');
    expect(types).toContain('Microsoft.KeyVault/vaults');
  });

  it('flattens nested resources (one level)', () => {
    const resources = parseArmTemplate(ARM_TEMPLATE);
    const types = resources.map((r) => r.type);
    expect(types).toContain('Microsoft.ServiceBus/namespaces/queues');
  });

  it('exposes rawText for each resource (for reference scanning)', () => {
    const resources = parseArmTemplate(ARM_TEMPLATE);
    const app = resources.find((r) => r.type === 'Microsoft.Web/sites');
    expect(app?.rawText).toBeTruthy();
    expect(app?.rawText).toContain('serverFarmId');
  });

  it('returns [] for non-ARM JSON', () => {
    expect(parseArmTemplate('{"foo": "bar"}')).toEqual([]);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseArmTemplate('{ not valid json ;;')).toEqual([]);
    expect(parseArmTemplate('')).toEqual([]);
  });

  it('detects ARM via the $schema field', () => {
    expect(
      isArmTemplate({
        $schema:
          'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
        resources: [],
      }),
    ).toBe(true);
  });

  it('detects ARM via the resources array heuristic (no $schema)', () => {
    expect(
      isArmTemplate({
        resources: [{ type: 'Microsoft.Web/sites', name: 'x' }],
      }),
    ).toBe(true);
  });

  it('does NOT flag arbitrary JSON with a resources array as ARM', () => {
    expect(
      isArmTemplate({
        resources: [{ id: '123', kind: 'generic' }],
      }),
    ).toBe(false);
  });

  // fix #1: isArmTemplate must scan the full array, not just resources[0].
  it('detects ARM when the FIRST element is a non-Microsoft copy-loop placeholder and a later element is Microsoft.*', () => {
    expect(
      isArmTemplate({
        resources: [
          // copy-loop placeholder — no 'type' at all
          { name: '[copyIndex()]', copy: { name: 'storageCopy', count: 3 } },
          { type: 'Microsoft.Storage/storageAccounts', name: 'store' },
        ],
      }),
    ).toBe(true);
  });

  it('detects ARM when the first element is a nested-deployment wrapper and a later element is Microsoft.*', () => {
    expect(
      isArmTemplate({
        resources: [
          { type: 'Microsoft.Resources/deployments', name: 'wrapper' },
          { type: 'Microsoft.Web/sites', name: 'app' },
        ],
      }),
    ).toBe(true);
  });

  it('still detects ARM when the ONLY element has a non-$schema Microsoft.* type', () => {
    // Regression: the single-element case must still work after switching to .some().
    expect(
      isArmTemplate({
        resources: [{ type: 'Microsoft.KeyVault/vaults', name: 'kv' }],
      }),
    ).toBe(true);
  });

  it('extracts armKind from ARM resource objects', () => {
    const template = JSON.stringify({
      $schema:
        'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
      contentVersion: '1.0.0.0',
      resources: [
        { type: 'Microsoft.Web/sites', name: 'my-func', kind: 'functionapp' },
        { type: 'Microsoft.Web/sites', name: 'my-app' /* no kind */ },
        { type: 'Microsoft.Web/staticSites', name: 'my-static' },
      ],
    });
    const resources = parseArmTemplate(template);
    const funcApp = resources.find((r) => r.name === 'my-func');
    expect(funcApp?.armKind).toBe('functionapp');
    const plainApp = resources.find((r) => r.name === 'my-app');
    expect(plainApp?.armKind).toBeUndefined();
    const staticSite = resources.find((r) => r.name === 'my-static');
    expect(staticSite?.type).toBe('Microsoft.Web/staticSites');
    expect(staticSite?.armKind).toBeUndefined(); // staticSites does not use 'kind'
  });
});

// ---------------------------------------------------------------------------
// Bicep (light regex)

const BICEP_SNIPPET = `
param location string = 'eastus'

resource appService 'Microsoft.Web/sites@2022-03-01' = {
  name: 'my-app'
  location: location
  properties: {
    serverFarmId: appServicePlan.id
  }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2022-03-01' = {
  name: 'my-plan'
  location: location
  sku: {
    name: 'S1'
  }
}

resource sqlServer 'Microsoft.Sql/servers@2021-11-01' = {
  name: 'my-sql'
  location: location
  properties: {
    administratorLogin: 'admin'
  }
}

module myModule './modules/shared.bicep' = {
  name: 'sharedModule'
}
`;

describe('parseBicep', () => {
  it('extracts resource declarations with correct type + apiVersion', () => {
    const resources = parseBicep(BICEP_SNIPPET);
    const appSvc = resources.find((r) => r.symbolicName === 'appService');
    expect(appSvc).toBeTruthy();
    expect(appSvc?.type).toBe('Microsoft.Web/sites');
    expect(appSvc?.apiVersion).toBe('2022-03-01');
    expect(appSvc?.isModule).toBe(false);
  });

  it('extracts multiple resources', () => {
    const resources = parseBicep(BICEP_SNIPPET);
    const types = resources.filter((r) => !r.isModule).map((r) => r.type);
    expect(types).toContain('Microsoft.Web/sites');
    expect(types).toContain('Microsoft.Web/serverfarms');
    expect(types).toContain('Microsoft.Sql/servers');
  });

  it('captures rawText (block body) for each resource', () => {
    const resources = parseBicep(BICEP_SNIPPET);
    const plan = resources.find((r) => r.symbolicName === 'appServicePlan');
    expect(plan?.rawText).toContain('my-plan');
  });

  it('flags module declarations with isModule=true', () => {
    const resources = parseBicep(BICEP_SNIPPET);
    const mod = resources.find((r) => r.symbolicName === 'myModule');
    expect(mod?.isModule).toBe(true);
  });

  it('returns [] for text with no Bicep resource declarations', () => {
    expect(parseBicep('// just a comment\nparam x string = "y"')).toEqual([]);
  });

  it('does not throw on empty or malformed input', () => {
    expect(() => parseBicep('')).not.toThrow();
    expect(() => parseBicep("resource 'broken")).not.toThrow();
  });

  // fix #2: module declarations must have type='' (empty-string sentinel),
  // not the raw filesystem path, so downstream never mistakes a path for a resource type.
  it('assigns empty-string type sentinel to module declarations (not the raw path)', () => {
    const resources = parseBicep(BICEP_SNIPPET);
    const mod = resources.find((r) => r.symbolicName === 'myModule');
    expect(mod?.isModule).toBe(true);
    // type must be '' — never a path like './modules/shared.bicep'
    expect(mod?.type).toBe('');
    expect(mod?.type).not.toMatch(/\//); // no slash means it is NOT a filesystem path
  });

  it('resource declarations (non-module) still have their full type from the declaration', () => {
    const resources = parseBicep(BICEP_SNIPPET);
    const appSvc = resources.find((r) => r.symbolicName === 'appService');
    expect(appSvc?.isModule).toBe(false);
    expect(appSvc?.type).toBe('Microsoft.Web/sites');
  });
});

// ---------------------------------------------------------------------------
// Azure Functions — function.json

const QUEUE_TRIGGER_FUNCTION_JSON = JSON.stringify({
  bindings: [
    {
      name: 'myQueueItem',
      type: 'queueTrigger',
      direction: 'in',
      queueName: 'orders-queue',
      connection: 'AzureWebJobsStorage',
    },
    {
      name: '$return',
      type: 'http',
      direction: 'out',
    },
  ],
});

const HTTP_TRIGGER_FUNCTION_JSON = JSON.stringify({
  bindings: [
    {
      name: 'req',
      type: 'httpTrigger',
      direction: 'in',
      authLevel: 'anonymous',
      methods: ['get', 'post'],
    },
    {
      name: '$return',
      type: 'http',
      direction: 'out',
    },
  ],
});

const COSMOS_OUTPUT_FUNCTION_JSON = JSON.stringify({
  bindings: [
    {
      name: 'myTimer',
      type: 'timerTrigger',
      direction: 'in',
      schedule: '0 */5 * * * *',
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

describe('parseFunctionJson', () => {
  it('parses a queueTrigger function.json correctly', () => {
    const result = parseFunctionJson(QUEUE_TRIGGER_FUNCTION_JSON, 'ProcessOrders');
    expect(result).not.toBeNull();
    expect(result!.functionName).toBe('ProcessOrders');
    const trigger = result!.bindings.find((b) => b.type === 'queueTrigger');
    expect(trigger).toBeTruthy();
    expect(trigger?.direction).toBe('in');
    expect(trigger?.queueName).toBe('orders-queue');
  });

  it('parses an httpTrigger function.json', () => {
    const result = parseFunctionJson(HTTP_TRIGGER_FUNCTION_JSON, 'HttpApi');
    expect(result).not.toBeNull();
    expect(result!.bindings.map((b) => b.type)).toContain('httpTrigger');
  });

  it('parses a cosmosDB output binding', () => {
    const result = parseFunctionJson(COSMOS_OUTPUT_FUNCTION_JSON, 'TimerToCosmosWriter');
    expect(result).not.toBeNull();
    const cosmos = result!.bindings.find((b) => b.type === 'cosmosDB');
    expect(cosmos?.direction).toBe('out');
    expect(cosmos?.connection).toBe('CosmosDBConnection');
  });

  it('returns null on malformed JSON', () => {
    expect(parseFunctionJson('{ not valid }', 'Fn')).toBeNull();
    expect(parseFunctionJson('', 'Fn')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseFunctionJson('"just a string"', 'Fn')).toBeNull();
    expect(parseFunctionJson('42', 'Fn')).toBeNull();
  });
});

describe('parseHostJson', () => {
  it('parses a valid host.json', () => {
    const result = parseHostJson(JSON.stringify({ version: '2.0', extensions: {} }));
    expect(result).not.toBeNull();
    expect(result?.version).toBe('2.0');
  });

  it('returns null on malformed input', () => {
    expect(parseHostJson('not json')).toBeNull();
    expect(parseHostJson('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AKS YAML (multi-doc)

const AKS_MULTI_DOC = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: default
spec:
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
        - name: api
          image: myregistry.azurecr.io/api:latest
---
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: default
spec:
  selector:
    app: api-server
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: main-ingress
spec:
  rules:
    - http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 80
`;

describe('parseAksYaml', () => {
  it('parses all three manifest kinds from a multi-doc YAML', () => {
    const manifests = parseAksYaml(AKS_MULTI_DOC);
    const kinds = manifests.map((m) => m.kind);
    expect(kinds).toContain('Deployment');
    expect(kinds).toContain('Service');
    expect(kinds).toContain('Ingress');
  });

  it('extracts name and namespace from Deployment', () => {
    const manifests = parseAksYaml(AKS_MULTI_DOC);
    const dep = manifests.find((m) => m.kind === 'Deployment');
    expect(dep?.name).toBe('api-server');
    expect(dep?.namespace).toBe('default');
  });

  it('extracts Service selector', () => {
    const manifests = parseAksYaml(AKS_MULTI_DOC);
    const svc = manifests.find((m) => m.kind === 'Service');
    expect(svc?.selector).toMatchObject({ app: 'api-server' });
  });

  it('preserves non-string Service selector values (no string-filtering)', () => {
    // review #1: the shared extractSelector must NOT filter non-string
    // selector values — Azure's original parser returned a raw cast, and the
    // "no behavior change" DoD requires keeping that. A YAML int selector value
    // must survive into manifest.selector exactly as parsed.
    const yaml = `
apiVersion: v1
kind: Service
metadata:
  name: weird-svc
spec:
  selector:
    app: api-server
    shard: 3
`;
    const svc = parseAksYaml(yaml).find((m) => m.kind === 'Service');
    expect(svc?.selector).toEqual({ app: 'api-server', shard: 3 });
  });

  it('extracts Ingress backend service names', () => {
    const manifests = parseAksYaml(AKS_MULTI_DOC);
    const ingress = manifests.find((m) => m.kind === 'Ingress');
    expect(ingress?.ingressBackends).toContain('api-service');
  });

  it('returns [] on malformed YAML', () => {
    expect(parseAksYaml(': : invalid: yaml: {')).toEqual([]);
    expect(parseAksYaml('')).toEqual([]);
  });

  it('skips non-k8s YAML documents (no apiVersion/kind/metadata)', () => {
    const nonK8s = `
foo: bar
list:
  - a
  - b
---
baz: qux
`;
    expect(parseAksYaml(nonK8s)).toEqual([]);
  });

  it('does not throw on mixed valid + invalid documents', () => {
    const mixed = `${AKS_MULTI_DOC}
---
not: a k8s manifest
`;
    expect(() => parseAksYaml(mixed)).not.toThrow();
    const manifests = parseAksYaml(mixed);
    // The valid k8s manifests should still be present.
    expect(manifests.length).toBeGreaterThanOrEqual(3);
  });
});
