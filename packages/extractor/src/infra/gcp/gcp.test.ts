// GCP adapter tests.
//
// buildGcpGraph is pure (GcpResource[] → InfraGraph); the adapter's
// detect/extract are exercised against real tmp dirs.

import { describe, it, expect, beforeAll, afterAll } from '../../testkit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGcpGraph, gcpAdapter } from './gcp.js';
import { parseGcpFile } from './gcp-parse.js';

// ---------------------------------------------------------------------------
// Fixtures — inline YAML for a representative GCP app:
//   - 1 Cloud Run service (with DATABASE_URL env → Cloud SQL edge)
//   - 1 GKE Deployment + Service + Ingress (k8s routing)
//   - Cloud SQL datastore referenced via env

const CLOUD_RUN_YAML = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: payments-api
spec:
  template:
    spec:
      containers:
        - image: gcr.io/myproj/payments-api:v2
          env:
            - name: DATABASE_URL
              value: postgres://user:pass@/db?host=/cloudsql/proj:us:mydb
`;

const K8S_DEPLOYMENT_YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker-service
spec:
  selector:
    matchLabels:
      app: worker-service
  template:
    metadata:
      labels:
        app: worker-service
    spec:
      containers:
        - name: worker
          image: gcr.io/myproj/worker:v1
          env:
            - name: REDIS_URL
              value: redis://10.0.0.5:6379
`;

const K8S_SERVICE_YAML = `
apiVersion: v1
kind: Service
metadata:
  name: worker-svc
spec:
  selector:
    app: worker-service
  ports:
    - port: 80
      targetPort: 8080
`;

const K8S_INGRESS_YAML = `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: main-ingress
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: worker-svc
                port:
                  number: 80
`;

const APP_ENGINE_YAML = `
runtime: nodejs20
service: admin-portal
`;

// ---------------------------------------------------------------------------
// Build the full fixture graph.

function parseFixture(yaml: string, file: string) {
  return parseGcpFile(yaml, file);
}

function buildFixtureGraph() {
  const resources = [
    ...parseFixture(CLOUD_RUN_YAML, '/repo/services/payments/service.yaml'),
    ...parseFixture(K8S_DEPLOYMENT_YAML, '/repo/k8s/worker-deployment.yaml'),
    ...parseFixture(K8S_SERVICE_YAML, '/repo/k8s/worker-service.yaml'),
    ...parseFixture(K8S_INGRESS_YAML, '/repo/k8s/ingress.yaml'),
    ...parseFixture(APP_ENGINE_YAML, '/repo/admin/app.yaml'),
  ];
  return buildGcpGraph(resources, '/repo');
}

describe('buildGcpGraph — fixture: Cloud Run + GKE + App Engine', () => {
  const graph = buildFixtureGraph();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // ------- Node kinds -------------------------------------------------------

  it('emits Cloud Run service as a worker node', () => {
    const n = byId.get('cloudrun:payments-api');
    expect(n?.kind).toBe('worker');
    expect(n?.provenance).toBe('declared');
    expect(n?.label).toBe('payments-api');
  });

  it('embeds the container image in Cloud Run metadata', () => {
    const n = byId.get('cloudrun:payments-api');
    expect(n?.metadata?.['image']).toBe('gcr.io/myproj/payments-api:v2');
  });

  it('emits GKE Deployment as a container node', () => {
    const n = byId.get('k8s:workload:worker-service');
    expect(n?.kind).toBe('container');
    expect(n?.provenance).toBe('declared');
  });

  it('emits App Engine service as a worker node', () => {
    const n = byId.get('appengine:admin-portal');
    expect(n?.kind).toBe('worker');
  });

  it('emits Cloud SQL datastore from DATABASE_URL env ref', () => {
    const n = byId.get('datastore:cloud-sql');
    expect(n?.kind).toBe('datastore');
    expect(n?.provenance).toBe('declared');
  });

  it('emits Memorystore datastore from REDIS_URL env ref', () => {
    const n = byId.get('datastore:memorystore');
    expect(n?.kind).toBe('datastore');
  });

  it('emits k8s Ingress as a cdn node (edge entry)', () => {
    const n = byId.get('k8s:ingress:main-ingress');
    expect(n?.kind).toBe('cdn');
    expect(n?.provenance).toBe('declared');
  });

  it('does NOT emit a separate k8s Service node (routing-as-edge)', () => {
    // k8s Service is modelled as an edge, not a node — no InfraModuleKind fits routing
    expect([...byId.keys()].some((k) => k.startsWith('k8s:service:'))).toBe(false);
  });

  // ------- Edge kinds -------------------------------------------------------

  it('emits stores-in from Cloud Run to Cloud SQL', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'cloudrun:payments-api',
        target: 'datastore:cloud-sql',
        kind: 'stores-in',
      }),
    );
  });

  it('emits stores-in from GKE Deployment to Memorystore', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'k8s:workload:worker-service',
        target: 'datastore:memorystore',
        kind: 'stores-in',
      }),
    );
  });

  it('emits calls from Ingress to GKE Deployment (k8s routing chain)', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: 'k8s:ingress:main-ingress',
        target: 'k8s:workload:worker-service',
        kind: 'calls',
      }),
    );
  });

  // ------- Graph invariants -------------------------------------------------

  it('all nodes have declared provenance (no LLM needed)', () => {
    expect(graph.nodes.every((n) => n.provenance === 'declared')).toBe(true);
  });

  it('emits empty classificationsNeeded (all shapes are statically known)', () => {
    expect(graph.classificationsNeeded).toEqual([]);
  });

  it('adapter name is gcp', () => {
    expect(graph.adapter).toBe('gcp');
  });
});

// ---------------------------------------------------------------------------
// Static-only App Engine detection.

describe('buildGcpGraph — App Engine static-site', () => {
  it('classifies all-static handlers as static-site', () => {
    const yaml = `
runtime: nodejs20
handlers:
  - url: /static
    static_dir: public
  - url: /.*
    static_files: dist/index.html
    upload: dist/index.html
`;
    const resources = parseGcpFile(yaml, '/repo/app.yaml');
    const graph = buildGcpGraph(resources, '/repo');
    const n = graph.nodes.find((n) => n.kind === 'static-site');
    expect(n).toBeTruthy();
    expect(n?.kind).toBe('static-site');
  });

  it('classifies mixed handlers as worker (not all-static)', () => {
    const yaml = `
runtime: nodejs20
handlers:
  - url: /static
    static_dir: public
  - url: /.*
    script: auto
`;
    const resources = parseGcpFile(yaml, '/repo/app.yaml');
    const graph = buildGcpGraph(resources, '/repo');
    const n = graph.nodes.find((n) => n.id === 'appengine:default');
    expect(n?.kind).toBe('worker');
  });
});

// ---------------------------------------------------------------------------
// Malformed YAML must NOT crash.

describe('buildGcpGraph — malformed input', () => {
  it('does not throw on empty resource list', () => {
    expect(() => buildGcpGraph([], '/repo')).not.toThrow();
  });

  it('emits an empty graph for no recognisable resources', () => {
    const graph = buildGcpGraph([], '/repo');
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detect() — hit and miss.

describe('gcpAdapter detect + extract', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'backthread-gcp-'));
    mkdirSync(join(dir, 'k8s'), { recursive: true });
    mkdirSync(join(dir, 'services', 'payments'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });

    writeFileSync(join(dir, 'services', 'payments', 'service.yaml'), CLOUD_RUN_YAML);
    writeFileSync(join(dir, 'k8s', 'deployment.yaml'), K8S_DEPLOYMENT_YAML);
    writeFileSync(join(dir, 'k8s', 'service.yaml'), K8S_SERVICE_YAML);
    writeFileSync(join(dir, 'k8s', 'ingress.yaml'), K8S_INGRESS_YAML);

    // Unrelated YAML in node_modules — must NOT be picked up.
    writeFileSync(
      join(dir, 'node_modules', 'pkg', 'config.yaml'),
      'description: should be ignored\nversion: 1.0.0\n',
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects a repo with Cloud Run service.yaml', async () => {
    expect(await gcpAdapter.detect(dir)).toBe(true);
  });

  it('extracts Cloud Run + k8s topology', async () => {
    const graph = await gcpAdapter.extract(dir);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('cloudrun:payments-api');
    expect(ids).toContain('k8s:workload:worker-service');
  });

  it('skips node_modules YAML', async () => {
    const graph = await gcpAdapter.extract(dir);
    // Unrelated node_modules YAML would produce no GCP resources anyway,
    // but verify no bogus nodes crept in.
    expect(graph.nodes.every((n) => !n.id.includes('ignored'))).toBe(true);
  });

  it('does NOT detect a repo with no GCP YAML', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-gcp-empty-'));
    try {
      // Only put non-GCP YAML here.
      writeFileSync(join(empty, 'docker-compose.yaml'), 'version: "3"\nservices:\n  web:\n    image: nginx\n');
      expect(await gcpAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('does NOT detect an empty repo', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'backthread-gcp-nofiles-'));
    try {
      expect(await gcpAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// No k8s Service node emitted — routing-as-edge enforcement.

describe('buildGcpGraph — k8s routing modelled as edges not nodes', () => {
  it('when no Ingress: emits a cdn Service node + calls edge (LB case)', () => {
    const resources = [
      ...parseGcpFile(K8S_DEPLOYMENT_YAML, '/repo/deployment.yaml'),
      ...parseGcpFile(K8S_SERVICE_YAML, '/repo/service.yaml'),
    ];
    const graph = buildGcpGraph(resources, '/repo');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // Without Ingress, Service is represented as a cdn node.
    const svcNode = byId.get('k8s:service:worker-svc');
    expect(svcNode?.kind).toBe('cdn');
    // Edge from Service → Deployment.
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'k8s:service:worker-svc', target: 'k8s:workload:worker-service', kind: 'calls' }),
    );
  });

  it('with Ingress: emits Ingress cdn node NOT a separate Service node', () => {
    const resources = [
      ...parseGcpFile(K8S_DEPLOYMENT_YAML, '/repo/deployment.yaml'),
      ...parseGcpFile(K8S_SERVICE_YAML, '/repo/service.yaml'),
      ...parseGcpFile(K8S_INGRESS_YAML, '/repo/ingress.yaml'),
    ];
    const graph = buildGcpGraph(resources, '/repo');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // With Ingress present, k8s Service node should NOT appear.
    expect([...byId.keys()].some((k) => k.startsWith('k8s:service:'))).toBe(false);
    // Ingress node present (keyed by metadata.name).
    expect(byId.get('k8s:ingress:main-ingress')?.kind).toBe('cdn');
  });
});

// ---------------------------------------------------------------------------
// Cloud Functions (basic).

describe('buildGcpGraph — Cloud Functions', () => {
  it('classifies a Cloud Function yaml as worker', () => {
    const yaml = `
name: process-orders
runtime: python39
entryPoint: main
trigger:
  httpsTrigger: {}
`;
    const resources = parseGcpFile(yaml, '/repo/functions.yaml');
    const graph = buildGcpGraph(resources, '/repo');
    expect(graph.nodes.find((n) => n.kind === 'worker')?.label).toBe('process-orders');
  });
});

// ---------------------------------------------------------------------------
// detect() — cheap check correctness ( finding #2).

describe('gcpAdapter detect — cheap check does not full-parse', () => {
  it('detects a repo via well-known filename (app.yaml) without needing full parse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backthread-gcp-detect-'));
    try {
      // Write an app.yaml with just enough to be a known GCP filename.
      writeFileSync(join(dir, 'app.yaml'), 'runtime: nodejs20\nservice: frontend\n');
      expect(await gcpAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a repo via apiVersion: apps/ substring without a known filename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backthread-gcp-detect2-'));
    try {
      writeFileSync(join(dir, 'manifests.yaml'), K8S_DEPLOYMENT_YAML);
      expect(await gcpAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT false-fire on a GitHub Actions CI workflow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backthread-gcp-ci-'));
    try {
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(
        join(dir, '.github', 'workflows', 'ci.yml'),
        'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v3\n',
      );
      expect(await gcpAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT false-fire on a Docker Compose file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backthread-gcp-compose-'));
    try {
      writeFileSync(
        join(dir, 'docker-compose.yml'),
        'version: "3"\nservices:\n  web:\n    image: nginx\n  db:\n    image: postgres\n',
      );
      expect(await gcpAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Multiple Ingresses → distinct nodes ( finding #3).

describe('buildGcpGraph — multiple ingresses emit distinct nodes', () => {
  const INGRESS_A = `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: public-ingress
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: worker-svc
                port:
                  number: 80
`;

  const INGRESS_B = `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: internal-ingress
spec:
  rules:
    - http:
        paths:
          - path: /internal
            pathType: Prefix
            backend:
              service:
                name: worker-svc
                port:
                  number: 80
`;

  it('emits two distinct Ingress cdn nodes keyed by metadata.name', () => {
    const resources = [
      ...parseGcpFile(K8S_DEPLOYMENT_YAML, '/repo/deployment.yaml'),
      ...parseGcpFile(K8S_SERVICE_YAML, '/repo/service.yaml'),
      ...parseGcpFile(INGRESS_A, '/repo/ingress-a.yaml'),
      ...parseGcpFile(INGRESS_B, '/repo/ingress-b.yaml'),
    ];
    const graph = buildGcpGraph(resources, '/repo');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('k8s:ingress:public-ingress')?.kind).toBe('cdn');
    expect(byId.get('k8s:ingress:internal-ingress')?.kind).toBe('cdn');
    // No collapsed fallback id.
    expect(byId.has('k8s:ingress:entry')).toBe(false);
  });

  it('each Ingress emits its own calls edge to the target workload', () => {
    const resources = [
      ...parseGcpFile(K8S_DEPLOYMENT_YAML, '/repo/deployment.yaml'),
      ...parseGcpFile(K8S_SERVICE_YAML, '/repo/service.yaml'),
      ...parseGcpFile(INGRESS_A, '/repo/ingress-a.yaml'),
      ...parseGcpFile(INGRESS_B, '/repo/ingress-b.yaml'),
    ];
    const graph = buildGcpGraph(resources, '/repo');
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'k8s:ingress:public-ingress', target: 'k8s:workload:worker-service', kind: 'calls' }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ source: 'k8s:ingress:internal-ingress', target: 'k8s:workload:worker-service', kind: 'calls' }),
    );
  });
});

// ---------------------------------------------------------------------------
// LB Service with no selector match still emits node ( finding #5).

describe('buildGcpGraph — LB Service with unmatched selector still emitted', () => {
  it('emits the Service cdn node even when its selector matches no workload', () => {
    // Service selects `app: ghost-service` but no Deployment has that label.
    const unmatchedSvcYaml = `
apiVersion: v1
kind: Service
metadata:
  name: ghost-lb
spec:
  selector:
    app: ghost-service
  type: LoadBalancer
  ports:
    - port: 80
`;
    const resources = [
      ...parseGcpFile(unmatchedSvcYaml, '/repo/ghost-lb.yaml'),
    ];
    const graph = buildGcpGraph(resources, '/repo');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // Node emitted despite no matching workload.
    expect(byId.get('k8s:service:ghost-lb')?.kind).toBe('cdn');
    // No calls edges emitted (nothing to call).
    expect(graph.edges.filter((e) => e.source === 'k8s:service:ghost-lb')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cloud SQL env heuristic tightening ( finding #6).

describe('buildGcpGraph — Cloud SQL env heuristic', () => {
  it('fires on DATABASE_URL with cloudsql value', () => {
    const yaml = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - image: gcr.io/proj/api:v1
          env:
            - name: DATABASE_URL
              value: postgres://user:pass@/db?host=/cloudsql/proj:us:mydb
`;
    const resources = parseGcpFile(yaml, '/repo/service.yaml');
    const graph = buildGcpGraph(resources, '/repo');
    expect(graph.nodes.find((n) => n.id === 'datastore:cloud-sql')).toBeTruthy();
  });

  it('fires on CLOUDSQL_CONNECTION key regardless of value', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec:
  selector:
    matchLabels:
      app: worker
  template:
    spec:
      containers:
        - name: w
          image: img
          env:
            - name: CLOUDSQL_CONNECTION
              value: proj:us-central1:mydb
`;
    const resources = parseGcpFile(yaml, '/repo/deploy.yaml');
    const graph = buildGcpGraph(resources, '/repo');
    expect(graph.nodes.find((n) => n.id === 'datastore:cloud-sql')).toBeTruthy();
  });

  it('does NOT fire on POSTGRES_VERSION (false-positive guard)', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec:
  selector:
    matchLabels:
      app: worker
  template:
    spec:
      containers:
        - name: w
          image: img
          env:
            - name: POSTGRES_VERSION
              value: "14"
`;
    const resources = parseGcpFile(yaml, '/repo/deploy.yaml');
    const graph = buildGcpGraph(resources, '/repo');
    expect(graph.nodes.find((n) => n.id === 'datastore:cloud-sql')).toBeUndefined();
  });

  it('does NOT fire on DB_NAME alone (not a host/url/connection key)', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec:
  selector:
    matchLabels:
      app: worker
  template:
    spec:
      containers:
        - name: w
          image: img
          env:
            - name: DB_NAME
              value: mydb
`;
    const resources = parseGcpFile(yaml, '/repo/deploy.yaml');
    const graph = buildGcpGraph(resources, '/repo');
    expect(graph.nodes.find((n) => n.id === 'datastore:cloud-sql')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// k8s (GKE) workload sourceRoots via the image→source resolver.

import type { DockerfileIndex } from '../image-resolve.js';

describe('buildGcpGraph — k8s workload sourceRoots', () => {
  const DEPLOY_YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:deadbeef
`;
  const index: DockerfileIndex = {
    dockerfiles: [{ dockerfile: 'services/api/Dockerfile', context: 'services/api' }],
    pairings: [{ image: 'ghcr.io/acme/api', context: 'services/api' }],
  };

  it('attributes a GKE Deployment to its build context via the resolver', () => {
    const resources = parseGcpFile(DEPLOY_YAML, '/repo/k8s/api.yaml');
    const graph = buildGcpGraph(resources, '/repo', index);
    expect(graph.nodes.find((n) => n.id === 'k8s:workload:api')?.sourceRoots).toEqual(['services/api']);
  });

  it('leaves a workload with an unresolvable image with no sourceRoots (honest "Other")', () => {
    const resources = parseGcpFile(DEPLOY_YAML, '/repo/k8s/api.yaml');
    const graph = buildGcpGraph(resources, '/repo', { dockerfiles: [], pairings: [] });
    expect(graph.nodes.find((n) => n.id === 'k8s:workload:api')?.sourceRoots).toBeUndefined();
  });

  it('emits no sourceRoots when no index is injected (back-compat)', () => {
    const resources = parseGcpFile(DEPLOY_YAML, '/repo/k8s/api.yaml');
    const graph = buildGcpGraph(resources, '/repo');
    expect(graph.nodes.find((n) => n.id === 'k8s:workload:api')?.sourceRoots).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cloud-native GCP sourceRoots (Cloud Run image + App Engine/Functions dir).

describe('buildGcpGraph — cloud-native sourceRoots', () => {
  const CLOUD_RUN = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - image: ghcr.io/acme/api:1
`;
  const APP_ENGINE = `
runtime: nodejs18
service: web
handlers:
  - url: /.*
    script: auto
`;
  const crIndex: DockerfileIndex = {
    dockerfiles: [{ dockerfile: 'services/api/Dockerfile', context: 'services/api' }],
    pairings: [{ image: 'ghcr.io/acme/api', context: 'services/api' }],
  };

  it('Cloud Run service image → resolved build context', () => {
    const resources = parseGcpFile(CLOUD_RUN, '/repo/service.yaml');
    const graph = buildGcpGraph(resources, '/repo', crIndex);
    const cr = graph.nodes.find((n) => n.id.startsWith('cloudrun:'));
    expect(cr?.sourceRoots).toEqual(['services/api']);
  });

  it('Cloud Run with an unresolvable image → no sourceRoots (honest "Other")', () => {
    const resources = parseGcpFile(CLOUD_RUN, '/repo/service.yaml');
    const graph = buildGcpGraph(resources, '/repo', { dockerfiles: [], pairings: [] });
    expect(graph.nodes.find((n) => n.id.startsWith('cloudrun:'))?.sourceRoots).toBeUndefined();
  });

  it('App Engine app.yaml → its config dir is the source root', () => {
    const resources = parseGcpFile(APP_ENGINE, '/repo/services/web/app.yaml');
    const graph = buildGcpGraph(resources, '/repo', crIndex);
    const ae = graph.nodes.find((n) => n.id.startsWith('appengine:'));
    expect(ae?.sourceRoots).toEqual(['services/web']);
  });

  it('App Engine at the repo root → no sourceRoots (no catch-all)', () => {
    const resources = parseGcpFile(APP_ENGINE, '/repo/app.yaml');
    const graph = buildGcpGraph(resources, '/repo', crIndex);
    expect(graph.nodes.find((n) => n.id.startsWith('appengine:'))?.sourceRoots).toBeUndefined();
  });
});
