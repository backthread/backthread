// GCP parser tests.
//
// classifyYamlDoc and parseGcpFile are pure (doc/string → descriptor); no
// filesystem I/O. Every GCP/k8s shape is tested with representative YAML.

import { describe, it, expect } from '../../testkit.js';
import { parseAllDocuments } from 'yaml';
import { classifyYamlDoc, parseGcpFile } from './gcp-parse.js';

// ---------------------------------------------------------------------------
// Helper: parse a YAML string and return the first JS object.
function parseOne(yaml: string): unknown {
  const docs = parseAllDocuments(yaml, { strict: false });
  return docs[0]?.toJS({ reviver: undefined }) ?? null;
}

// ---------------------------------------------------------------------------
// Cloud Run service.yaml (Knative serving)

const CLOUD_RUN_YAML = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: my-api
  namespace: default
spec:
  template:
    spec:
      containers:
        - image: gcr.io/my-project/my-api:latest
          env:
            - name: DATABASE_URL
              value: postgres://...
`;

describe('classifyYamlDoc — Cloud Run', () => {
  const doc = parseOne(CLOUD_RUN_YAML);

  it('classifies as cloud-run', () => {
    const r = classifyYamlDoc(doc, '/repo/service.yaml');
    expect(r?.kind).toBe('cloud-run');
  });

  it('extracts the service name from metadata.name', () => {
    const r = classifyYamlDoc(doc, '/repo/service.yaml');
    expect(r?.name).toBe('my-api');
  });

  it('returns the raw doc object', () => {
    const r = classifyYamlDoc(doc, '/repo/service.yaml');
    expect(r?.raw).toBeTruthy();
    expect((r?.raw as Record<string, unknown>)['kind']).toBe('Service');
  });
});

// ---------------------------------------------------------------------------
// App Engine app.yaml

const APP_ENGINE_YAML = `
runtime: nodejs20
service: backend
env: standard

automatic_scaling:
  target_cpu_utilization: 0.65

handlers:
  - url: /.*
    script: auto
`;

const APP_ENGINE_STATIC_YAML = `
runtime: nodejs20

handlers:
  - url: /static
    static_dir: public
  - url: /.*
    static_files: dist/index.html
    upload: dist/index.html
`;

describe('classifyYamlDoc — App Engine', () => {
  it('classifies app.yaml with service: as app-engine', () => {
    const r = classifyYamlDoc(parseOne(APP_ENGINE_YAML), '/repo/app.yaml');
    expect(r?.kind).toBe('app-engine');
    expect(r?.name).toBe('backend');
  });

  it('defaults service name to "default" when service: is absent', () => {
    const r = classifyYamlDoc(parseOne(APP_ENGINE_STATIC_YAML), '/repo/app.yaml');
    expect(r?.kind).toBe('app-engine');
    expect(r?.name).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// Multi-document k8s manifest (Deployment + Service + Ingress)

const K8S_MULTI_YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
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
          image: gcr.io/proj/api:v1
          env:
            - name: CLOUDSQL_CONNECTION
              value: proj:us-central1:mydb
---
apiVersion: v1
kind: Service
metadata:
  name: api-service
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
  name: api-ingress
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 80
`;

describe('classifyYamlDoc — k8s Deployment', () => {
  const docs = parseAllDocuments(K8S_MULTI_YAML, { strict: false }).map((d) =>
    d.toJS({ reviver: undefined }),
  );

  it('classifies Deployment as k8s-deployment', () => {
    const r = classifyYamlDoc(docs[0], '/repo/k8s.yaml');
    expect(r?.kind).toBe('k8s-deployment');
    expect(r?.name).toBe('api-server');
  });

  it('classifies Service as k8s-service', () => {
    const r = classifyYamlDoc(docs[1], '/repo/k8s.yaml');
    expect(r?.kind).toBe('k8s-service');
    expect(r?.name).toBe('api-service');
  });

  it('classifies Ingress as k8s-ingress', () => {
    const r = classifyYamlDoc(docs[2], '/repo/k8s.yaml');
    expect(r?.kind).toBe('k8s-ingress');
    expect(r?.name).toBe('api-ingress');
  });
});

describe('parseGcpFile — multi-document', () => {
  it('returns three resources from the multi-doc YAML', () => {
    const rs = parseGcpFile(K8S_MULTI_YAML, '/repo/k8s.yaml');
    expect(rs).toHaveLength(3);
    expect(rs.map((r) => r.kind).sort()).toEqual(['k8s-deployment', 'k8s-ingress', 'k8s-service']);
  });

  it('returns cloud-run + k8s resources in a mixed file', () => {
    const mixed = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: frontend
spec: {}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec: {}
`;
    const rs = parseGcpFile(mixed, '/repo/mixed.yaml');
    expect(rs.map((r) => r.kind).sort()).toEqual(['cloud-run', 'k8s-deployment']);
  });
});

// ---------------------------------------------------------------------------
// Malformed YAML must NOT throw.

describe('parseGcpFile — malformed YAML', () => {
  it('does not throw on completely invalid YAML', () => {
    expect(() => parseGcpFile('{{{{ not yaml at all :::::', '/repo/bad.yaml')).not.toThrow();
  });

  it('does not throw on truncated YAML', () => {
    expect(() => parseGcpFile('apiVersion: apps/v1\nkind: Dep', '/repo/truncated.yaml')).not.toThrow();
  });

  it('returns no resources for an empty file', () => {
    expect(parseGcpFile('', '/repo/empty.yaml')).toEqual([]);
  });

  it('does not throw on a scalar-only YAML file', () => {
    expect(() => parseGcpFile('just a string', '/repo/scalar.yaml')).not.toThrow();
  });

  it('returns no resources for an unrelated YAML file', () => {
    // GitHub Actions workflow — should not be classified as GCP.
    const ghActions = `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
`;
    expect(parseGcpFile(ghActions, '/repo/.github/workflows/ci.yaml')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cloud Functions classification — tightened heuristic ( finding #6).

describe('classifyYamlDoc — Cloud Functions tighter signal', () => {
  it('classifies as cloud-functions when entryPoint: present', () => {
    const doc = parseOne(`
name: send-email
runtime: nodejs18
entryPoint: handler
`);
    const r = classifyYamlDoc(doc, '/repo/functions.yaml');
    expect(r?.kind).toBe('cloud-functions');
    expect(r?.name).toBe('send-email');
  });

  it('classifies as cloud-functions when trigger: present', () => {
    const doc = parseOne(`
name: process-image
runtime: python39
trigger:
  httpsTrigger: {}
`);
    const r = classifyYamlDoc(doc, '/repo/func.yaml');
    expect(r?.kind).toBe('cloud-functions');
  });

  it('falls back to app-engine when runtime: + name: present but no entryPoint/trigger', () => {
    // A YAML with runtime: + name: but no CF signal → App Engine (safe default).
    const doc = parseOne(`
runtime: nodejs20
name: my-service
`);
    const r = classifyYamlDoc(doc, '/repo/ambiguous.yaml');
    // Should NOT be cloud-functions; treated as App Engine (service name defaults to 'default').
    expect(r?.kind).toBe('app-engine');
  });
});

// ---------------------------------------------------------------------------
// Edge cases.

describe('classifyYamlDoc — edge cases', () => {
  it('returns null for null input', () => {
    expect(classifyYamlDoc(null, '/f')).toBeNull();
  });

  it('returns null for an array input', () => {
    expect(classifyYamlDoc([], '/f')).toBeNull();
  });

  it('returns null for a bare string', () => {
    expect(classifyYamlDoc('hello', '/f')).toBeNull();
  });

  it('returns null for an unknown k8s kind (ConfigMap)', () => {
    const doc = parseOne(`
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
`);
    expect(classifyYamlDoc(doc, '/f')).toBeNull();
  });

  it('classifies StatefulSet as k8s-statefulset', () => {
    const doc = parseOne(`
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  selector:
    matchLabels:
      app: postgres
`);
    const r = classifyYamlDoc(doc, '/f');
    expect(r?.kind).toBe('k8s-statefulset');
  });

  it('classifies CronJob as k8s-cronjob', () => {
    const doc = parseOne(`
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cleanup
spec: {}
`);
    const r = classifyYamlDoc(doc, '/f');
    expect(r?.kind).toBe('k8s-cronjob');
  });

  it('classifies batch/v1 Job as k8s-job', () => {
    const doc = parseOne(`
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
spec: {}
`);
    const r = classifyYamlDoc(doc, '/f');
    expect(r?.kind).toBe('k8s-job');
  });
});
