// shared k8s manifest parsing primitives tests.

import { describe, it, expect } from '../../testkit.js';
import {
  isK8sApiVersion,
  isK8sManifest,
  extractSelector,
  extractIngressBackends,
  labelsOverlap,
  parseK8sManifests,
  K8S_WORKLOAD_KINDS,
  K8S_ROUTING_KINDS,
} from './index.js';

describe('isK8sApiVersion', () => {
  it('accepts the standard k8s apiVersion groups', () => {
    for (const v of ['v1', 'apps/v1', 'batch/v1', 'networking.k8s.io/v1', 'extensions/v1beta1']) {
      expect(isK8sApiVersion(v)).toBe(true);
    }
  });
  it('rejects non-k8s / missing apiVersions', () => {
    expect(isK8sApiVersion('serving.knative.dev/v1')).toBe(false);
    expect(isK8sApiVersion('v2')).toBe(false);
    expect(isK8sApiVersion(undefined)).toBe(false);
  });
});

describe('isK8sManifest', () => {
  it('requires apiVersion + kind + metadata', () => {
    expect(isK8sManifest({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'x' } })).toBe(true);
    expect(isK8sManifest({ apiVersion: 'apps/v1', kind: 'Deployment' })).toBe(false);
    expect(isK8sManifest({ foo: 'bar' })).toBe(false);
    expect(isK8sManifest(null)).toBe(false);
  });
});

describe('extractSelector', () => {
  it('reads Deployment-style matchLabels', () => {
    expect(extractSelector({ selector: { matchLabels: { app: 'worker' } } })).toEqual({ app: 'worker' });
  });
  it('reads Service-style plain selector map', () => {
    expect(extractSelector({ selector: { app: 'worker', tier: 'be' } })).toEqual({ app: 'worker', tier: 'be' });
  });
  it('returns undefined when there is no selector', () => {
    expect(extractSelector({})).toBeUndefined();
    expect(extractSelector(null)).toBeUndefined();
  });
  it('returns the raw label map WITHOUT string-filtering (Azure-verbatim)', () => {
    // The shared primitive must not filter non-string values: Azure's original
    // extractSelector was a raw cast, and the "no behavior change" DoD requires
    // preserving that. GCP applies its own string-filter in gcp.ts:selectorLabels.
    expect(extractSelector({ selector: { app: 'worker', replicas: 3 } })).toEqual({
      app: 'worker',
      replicas: 3,
    });
  });
});

describe('extractIngressBackends', () => {
  it('reads 1.19+ backend.service.name', () => {
    const spec = { rules: [{ http: { paths: [{ backend: { service: { name: 'web-svc' } } }] } }] };
    expect(extractIngressBackends(spec)).toEqual(['web-svc']);
  });
  it('reads legacy backend.serviceName', () => {
    const spec = { rules: [{ http: { paths: [{ backend: { serviceName: 'legacy-svc' } }] } }] };
    expect(extractIngressBackends(spec)).toEqual(['legacy-svc']);
  });
  it('dedupes repeated backends', () => {
    const spec = {
      rules: [
        { http: { paths: [{ backend: { service: { name: 'web-svc' } } }, { backend: { service: { name: 'web-svc' } } }] } },
      ],
    };
    expect(extractIngressBackends(spec)).toEqual(['web-svc']);
  });
  it('returns [] for malformed spec', () => {
    expect(extractIngressBackends(null)).toEqual([]);
    expect(extractIngressBackends({})).toEqual([]);
  });
});

describe('labelsOverlap', () => {
  it('is true when any key/value pair matches', () => {
    expect(labelsOverlap({ app: 'worker' }, { app: 'worker', tier: 'be' })).toBe(true);
  });
  it('is false when no pair matches', () => {
    expect(labelsOverlap({ app: 'worker' }, { app: 'api' })).toBe(false);
    expect(labelsOverlap({}, { app: 'api' })).toBe(false);
  });
});

describe('parseK8sManifests', () => {
  const MULTI_DOC = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: prod
spec:
  selector:
    matchLabels:
      app: worker
---
apiVersion: v1
kind: Service
metadata:
  name: worker-svc
spec:
  selector:
    app: worker
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: main-ingress
spec:
  rules:
    - http:
        paths:
          - backend:
              service:
                name: worker-svc
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: cfg
data:
  foo: bar
`;

  it('parses every k8s doc and normalizes Service selectors + Ingress backends', () => {
    const manifests = parseK8sManifests(MULTI_DOC);
    const byKind = new Map(manifests.map((m) => [m.kind, m]));

    // ConfigMap is still a valid manifest (it has apiVersion+kind+metadata); the
    // shared parser surfaces it — adapters decide which kinds become topology.
    expect(manifests.map((m) => m.kind).sort()).toEqual(['ConfigMap', 'Deployment', 'Ingress', 'Service']);

    expect(byKind.get('Deployment')?.namespace).toBe('prod');
    expect(byKind.get('Service')?.selector).toEqual({ app: 'worker' });
    expect(byKind.get('Ingress')?.ingressBackends).toEqual(['worker-svc']);
    // selector/backends only populated for their owning kinds.
    expect(byKind.get('Deployment')?.selector).toBeUndefined();
    expect(byKind.get('Service')?.ingressBackends).toBeUndefined();
  });

  it('returns [] on unparseable YAML', () => {
    expect(parseK8sManifests(':\n  : : : not yaml')).toEqual([]);
  });

  it('exposes the workload + routing kind taxonomies', () => {
    expect(K8S_WORKLOAD_KINDS).toContain('Deployment');
    expect(K8S_ROUTING_KINDS).toEqual(['Service', 'Ingress']);
  });
});

// ---------------------------------------------------------------------------
// workload image extraction + image→source resolution.

import {
  extractWorkloadImages,
  workloadSourceRoots,
} from './index.js';
import type { DockerfileIndex } from '../image-resolve.js';

const deployment = (images: string[], init: string[] = []) => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'api' },
  spec: {
    template: {
      spec: {
        ...(init.length ? { initContainers: init.map((image) => ({ name: 'init', image })) } : {}),
        containers: images.map((image, i) => ({ name: `c${i}`, image })),
      },
    },
  },
});

const cronjob = (image: string) => ({
  apiVersion: 'batch/v1',
  kind: 'CronJob',
  metadata: { name: 'nightly' },
  spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: 'job', image }] } } } } },
});

describe('extractWorkloadImages', () => {
  it('reads container images from a Deployment pod template', () => {
    expect(extractWorkloadImages(deployment(['ghcr.io/acme/api:1', 'envoyproxy/envoy:v1']))).toEqual([
      'ghcr.io/acme/api:1',
      'envoyproxy/envoy:v1',
    ]);
  });

  it('includes initContainers and dedupes', () => {
    expect(extractWorkloadImages(deployment(['acme/api:1'], ['acme/api:1', 'busybox']))).toEqual([
      'acme/api:1',
      'busybox',
    ]);
  });

  it('digs into a CronJob jobTemplate', () => {
    expect(extractWorkloadImages(cronjob('acme/cron:1'))).toEqual(['acme/cron:1']);
  });

  it('returns [] for a manifest with no pod spec', () => {
    expect(extractWorkloadImages({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'x' } })).toEqual([]);
  });
});

describe('workloadSourceRoots', () => {
  const index: DockerfileIndex = {
    dockerfiles: [
      { dockerfile: 'services/api/Dockerfile', context: 'services/api' },
      { dockerfile: 'services/worker/Dockerfile', context: 'services/worker' },
    ],
    pairings: [{ image: 'ghcr.io/acme/api', context: 'services/api' }],
  };

  it('resolves a workload image to its in-repo build context (pairing)', () => {
    expect(workloadSourceRoots(deployment(['ghcr.io/acme/api:deadbeef']), index)).toEqual(['services/api']);
  });

  it('resolves by name convention and unions across containers', () => {
    // api (by pairing) + worker (by name convention); a public sidecar resolves to nothing
    const wl = deployment(['ghcr.io/acme/api:1', 'acme/worker:1', 'redis:7']);
    expect(workloadSourceRoots(wl, index)).toEqual(['services/api', 'services/worker']);
  });

  it('returns [] when no image resolves to an in-repo Dockerfile (honest "Other")', () => {
    expect(workloadSourceRoots(deployment(['postgres:15', 'bitnami/redis']), index)).toEqual([]);
  });
});
