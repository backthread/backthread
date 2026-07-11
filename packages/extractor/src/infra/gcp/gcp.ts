// GCP-native InfraAdapter (v0).
//
// Covers Cloud Run, App Engine, and GKE (k8s manifests).
// Strategy:
//   - Cloud Run Service (Knative) → `worker` (serverless container)
//   - App Engine service          → `worker` (or `static-site` for static-only handlers)
//   - Cloud Functions             → `worker`
//   - k8s Deployment / StatefulSet / Job / CronJob → `container`
//   - k8s Ingress                 → routing metadata ONLY; modelled as edges
//                                   (Ingress→Service calls, Service→Deployment calls)
//                                   NOT a node — no InfraModuleKind fits routing
//   - k8s Service (clusterIP/LB)  → same: emit as routing edges, not a node
//   - Cloud SQL / Memorystore env refs → `datastore`
//
// Provenance is `declared` for every well-known shape here. The only shapes
// that go into `classificationsNeeded` would be genuinely ambiguous custom
// resources — there are none in v0 scope; the list is empty.
//
// Edges emitted:
//   calls     — Ingress → Service → Deployment (k8s routing chain)
//   stores-in — workload → Cloud SQL / Memorystore datastore (env reference)
//
// DEFERRED (documented):
//   - Deployment Manager .jinja
//   - cloudbuild.yaml deploy-mechanism parsing
//   - Per-env GKE namespace grouping / parentId zones ( ELK work)
//   - Cross-service discovery (GCP service mesh, VPC connectors)
//   Tracked under  / .

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import type { InfraModuleKind } from '../../types.js';
import { findFiles } from '../walk.js';
import { extractSelector, extractIngressBackends, labelsOverlap, workloadSourceRoots } from '../k8s/index.js';
import { buildDockerfileIndex, resolveImageToSourceRoots, type DockerfileIndex } from '../image-resolve.js';
import { parseGcpFile, type GcpResource } from './gcp-parse.js';

// ---------------------------------------------------------------------------
// File discovery.

// Well-known GCP config filenames checked first in cheap detect().
const GCP_CONFIG_NAMES = new Set(['service.yaml', 'app.yaml', 'cloudbuild.yaml', 'functions.yaml']);
const GCP_SKIP_DIRS = [
  'node_modules', '.git', 'dist', '.wrangler', '.next', 'build', 'coverage',
  '__pycache__', '.venv', 'vendor',
];

/** Find every *.yaml / *.yml in the repo (bounded recursive walk). */
function findYamlFiles(repoDir: string): string[] {
  return findFiles(repoDir, (_abs, e) => e.name.endsWith('.yaml') || e.name.endsWith('.yml'), {
    skipDirs: GCP_SKIP_DIRS,
    maxDepth: 6,
  });
}

// ---------------------------------------------------------------------------
// Id helpers (adapter-local; registry prefixes `gcp:`).

const crId = (name: string) => `cloudrun:${name}`;
const aeId = (name: string) => `appengine:${name}`;
const cfId = (name: string) => `functions:${name}`;
const k8sWorkloadId = (name: string) => `k8s:workload:${name}`;
const datastoreId = (name: string) => `datastore:${name}`;

// ---------------------------------------------------------------------------
// Source-root path helpers.

/** Normalize a repo-relative path: backslashes→/, collapse `.`/`./`, strip trailing `/`. */
function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
}
/** The repo-relative directory of a repo-relative file path ('' = repo root). */
function dirOfPath(relPath: string): string {
  const n = relPath.split('\\').join('/');
  const i = n.lastIndexOf('/');
  return i === -1 ? '' : n.slice(0, i);
}

// ---------------------------------------------------------------------------
// Cloud SQL / Memorystore env reference heuristics.
//
// Deployment manifests often pass connection strings via env vars:
//   DATABASE_URL, CLOUDSQL_CONNECTION, CLOUD_SQL_CONN, DB_HOST, REDIS_URL, etc.
// We scan envFrom / env arrays for these patterns.

// Cloud SQL env heuristic — key must have one of the anchored suffixes
// (_URL / _HOST / _CONNECTION / _CONN / _DSN) or the key itself contains
// `cloudsql` or `cloud_sql`. Bare `POSTGRES` / `POSTGRES_VERSION` etc. are
// excluded on purpose; value is also checked for a `cloudsql` proxy path or
// postgres:// scheme as a tiebreaker.
const CLOUD_SQL_KEY_RE = /(?:cloud.?sql|database|db|pg|postgres)(?:_url|_host|_connection|_conn|_dsn)$/i;
const CLOUD_SQL_NAME_RE = /cloud.?sql/i; // covers CLOUDSQL_CONNECTION, CLOUD_SQL_CONN
const CLOUD_SQL_VALUE_RE = /cloudsql|postgres:\/\//i;
const MEMORYSTORE_RE = /redis.?url|memorystore|redis.?host/i;

interface EnvRef {
  datastoreNodeId: string;
  label: string;
}

function extractEnvDatastoreRefs(raw: Record<string, unknown>): EnvRef[] {
  const refs: EnvRef[] = [];
  const seen = new Set<string>();

  // Pull env items from spec.template.spec.containers[].env
  // or from spec.containers[].env (for simpler shapes)
  const spec = raw['spec'] as Record<string, unknown> | undefined;
  const template = spec?.['template'] as Record<string, unknown> | undefined;
  const innerSpec = (template?.['spec'] ?? spec) as Record<string, unknown> | undefined;
  const containers = innerSpec?.['containers'];
  if (!Array.isArray(containers)) return refs;

  for (const c of containers) {
    if (typeof c !== 'object' || c === null) continue;
    const env = (c as Record<string, unknown>)['env'];
    if (!Array.isArray(env)) continue;
    for (const e of env) {
      if (typeof e !== 'object' || e === null) continue;
      const envObj = e as Record<string, unknown>;
      const k = typeof envObj['name'] === 'string' ? envObj['name'] : '';
      if (!k) continue;

      let id: string | undefined;
      let label: string | undefined;
      const v = typeof envObj['value'] === 'string' ? envObj['value'] : '';
      const isCloudSql =
        CLOUD_SQL_KEY_RE.test(k) || CLOUD_SQL_NAME_RE.test(k) || CLOUD_SQL_VALUE_RE.test(v);
      if (isCloudSql) {
        id = datastoreId('cloud-sql');
        label = 'Cloud SQL';
      } else if (MEMORYSTORE_RE.test(k)) {
        id = datastoreId('memorystore');
        label = 'Memorystore';
      }
      if (id && !seen.has(id)) {
        seen.add(id);
        refs.push({ datastoreNodeId: id, label: label! });
      }
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// k8s selector-based Service→Deployment matching.
//
// A k8s Service selects Deployments by `.spec.selector.matchLabels` (Deployment)
// matched against `.spec.selector` (Service). We emit a `calls` edge when
// selector labels overlap — the most reliable heuristic without full label
// evaluation. The selector/overlap primitives are shared with the other cloud
// adapters (scripts/ingest/infra/k8s/). GCP wraps the shared extractSelector to
// (a) string-filter the labels and (b) default to `{}` — both behaviors its
// original selectorLabels had and its overlap matcher relies on (the shared
// helper stays raw/undefined to preserve Azure's verbatim behavior).
function selectorLabels(raw: Record<string, unknown>): Record<string, string> {
  const sel = extractSelector(raw['spec']);
  if (!sel) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(sel)) {
    if (typeof v === 'string') result[k] = v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pure graph builder.

/**
 * Pure graph builder — takes already-parsed GcpResources and emits the
 * InfraGraph. Separated from the file walk so it can be unit-tested.
 */
export function buildGcpGraph(resources: GcpResource[], root: string, dockerfileIndex?: DockerfileIndex): InfraGraph {
  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];

  function addNode(n: InfraNode): void {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  }
  function addEdge(e: InfraEdge): void {
    edges.push(e);
  }

  const rel = (file: string) => relative(root, file) || file;

  // a k8s workload's source roots, resolved from its container
  // image(s) via the  resolver. Empty (→ no sourceRoots) when no index is
  // injected or no image resolves to an in-repo Dockerfile (honest "Other").
  const wlRoots = (raw: Record<string, unknown>): string[] =>
    dockerfileIndex ? workloadSourceRoots(raw, dockerfileIndex) : [];

  // a Cloud Run service's source roots from its container image.
  const imageRoots = (image: unknown): string[] =>
    dockerfileIndex && typeof image === 'string' && image ? resolveImageToSourceRoots(image, dockerfileIndex) : [];

  // App Engine / Cloud Functions deploy the dir holding their config
  // (app.yaml / functions config). That dir is the source root; the bare repo
  // root ('') is dropped (no catch-all).
  const configDirRoots = (file: string): string[] => {
    const d = normalizeRoot(dirOfPath(rel(file)));
    return d ? [d] : [];
  };

  // Collect k8s workloads and routing objects for cross-matching.
  const k8sWorkloads: Array<{ id: string; selectors: Record<string, string>; raw: Record<string, unknown> }> = [];
  const k8sServices: Array<{ name: string; selectors: Record<string, string>; raw: Record<string, unknown> }> = [];
  const k8sIngresses: Array<{ name: string; raw: Record<string, unknown>; file: string }> = [];

  for (const r of resources) {
    const file = r.file;

    switch (r.kind) {
      // --- Cloud Run --------------------------------------------------------
      case 'cloud-run': {
        const nodeId = crId(r.name);
        // Extract container image from spec.template.spec.containers[0].image
        const spec = r.raw['spec'] as Record<string, unknown> | undefined;
        const tmpl = spec?.['template'] as Record<string, unknown> | undefined;
        const innerSpec = tmpl?.['spec'] as Record<string, unknown> | undefined;
        const containers = innerSpec?.['containers'];
        const image =
          Array.isArray(containers) && containers.length > 0
            ? typeof (containers[0] as Record<string, unknown>)['image'] === 'string'
              ? (containers[0] as Record<string, unknown>)['image']
              : undefined
            : undefined;

        const crRoots = imageRoots(image); // resolve the container image
        addNode({
          id: nodeId,
          label: r.name,
          kind: 'worker' satisfies InfraModuleKind,
          provenance: 'declared',
          metadata: { config: rel(file), image: image ?? undefined },
          ...(crRoots.length ? { sourceRoots: crRoots } : {}),
        });

        // Datastore env refs.
        const envRefs = extractEnvDatastoreRefs(r.raw);
        for (const ref of envRefs) {
          addNode({ id: ref.datastoreNodeId, label: ref.label, kind: 'datastore', provenance: 'declared' });
          addEdge({ source: nodeId, target: ref.datastoreNodeId, kind: 'stores-in', metadata: { config: rel(file) } });
        }
        break;
      }

      // --- App Engine -------------------------------------------------------
      case 'app-engine': {
        const nodeId = aeId(r.name);
        const runtime = typeof r.raw['runtime'] === 'string' ? r.raw['runtime'] : undefined;
        // Static-only detection: handlers are all `static_files` or `static_dir`.
        const handlers = r.raw['handlers'];
        let isStatic = false;
        if (Array.isArray(handlers) && handlers.length > 0) {
          isStatic = handlers.every((h: unknown) => {
            const ho = h as Record<string, unknown>;
            return 'static_files' in ho || 'static_dir' in ho;
          });
        }
        const aeRoots = configDirRoots(file); // app.yaml dir = the source
        addNode({
          id: nodeId,
          label: `App Engine: ${r.name}`,
          kind: isStatic ? ('static-site' satisfies InfraModuleKind) : ('worker' satisfies InfraModuleKind),
          provenance: 'declared',
          metadata: { config: rel(file), runtime, service: r.name },
          ...(aeRoots.length ? { sourceRoots: aeRoots } : {}),
        });

        const envRefs = extractEnvDatastoreRefs(r.raw);
        for (const ref of envRefs) {
          addNode({ id: ref.datastoreNodeId, label: ref.label, kind: 'datastore', provenance: 'declared' });
          addEdge({ source: nodeId, target: ref.datastoreNodeId, kind: 'stores-in', metadata: { config: rel(file) } });
        }
        break;
      }

      // --- Cloud Functions --------------------------------------------------
      case 'cloud-functions': {
        const nodeId = cfId(r.name);
        const runtime = typeof r.raw['runtime'] === 'string' ? r.raw['runtime'] : undefined;
        const fnRoots = configDirRoots(file); // function config dir = the source
        addNode({
          id: nodeId,
          label: r.name,
          kind: 'worker' satisfies InfraModuleKind,
          provenance: 'declared',
          metadata: { config: rel(file), runtime },
          ...(fnRoots.length ? { sourceRoots: fnRoots } : {}),
        });
        break;
      }

      // --- k8s Deployment ---------------------------------------------------
      case 'k8s-deployment': {
        const nodeId = k8sWorkloadId(r.name);
        const roots = wlRoots(r.raw);
        addNode({
          id: nodeId,
          label: r.name,
          kind: 'container' satisfies InfraModuleKind,
          provenance: 'declared',
          metadata: { config: rel(file), k8sKind: 'Deployment' },
          ...(roots.length ? { sourceRoots: roots } : {}),
        });
        k8sWorkloads.push({ id: nodeId, selectors: selectorLabels(r.raw), raw: r.raw });

        const envRefs = extractEnvDatastoreRefs(r.raw);
        for (const ref of envRefs) {
          addNode({ id: ref.datastoreNodeId, label: ref.label, kind: 'datastore', provenance: 'declared' });
          addEdge({ source: nodeId, target: ref.datastoreNodeId, kind: 'stores-in', metadata: { config: rel(file) } });
        }
        break;
      }

      // --- k8s StatefulSet --------------------------------------------------
      case 'k8s-statefulset': {
        const nodeId = k8sWorkloadId(r.name);
        const roots = wlRoots(r.raw);
        addNode({
          id: nodeId,
          label: r.name,
          kind: 'container' satisfies InfraModuleKind,
          provenance: 'declared',
          metadata: { config: rel(file), k8sKind: 'StatefulSet' },
          ...(roots.length ? { sourceRoots: roots } : {}),
        });
        k8sWorkloads.push({ id: nodeId, selectors: selectorLabels(r.raw), raw: r.raw });

        const envRefs = extractEnvDatastoreRefs(r.raw);
        for (const ref of envRefs) {
          addNode({ id: ref.datastoreNodeId, label: ref.label, kind: 'datastore', provenance: 'declared' });
          addEdge({ source: nodeId, target: ref.datastoreNodeId, kind: 'stores-in', metadata: { config: rel(file) } });
        }
        break;
      }

      // --- k8s Job / CronJob ------------------------------------------------
      case 'k8s-job':
      case 'k8s-cronjob': {
        const nodeId = k8sWorkloadId(r.name);
        const roots = wlRoots(r.raw);
        addNode({
          id: nodeId,
          label: r.name,
          kind: 'container' satisfies InfraModuleKind,
          provenance: 'declared',
          metadata: { config: rel(file), k8sKind: r.kind === 'k8s-cronjob' ? 'CronJob' : 'Job' },
          ...(roots.length ? { sourceRoots: roots } : {}),
        });
        k8sWorkloads.push({ id: nodeId, selectors: selectorLabels(r.raw), raw: r.raw });
        break;
      }

      // --- k8s Service -------------------------------------------------------
      // k8s Services are routing — NOT emitted as nodes (no fitting InfraModuleKind).
      // Instead they participate in the routing edge chain resolved below.
      case 'k8s-service': {
        k8sServices.push({ name: r.name, selectors: selectorLabels(r.raw), raw: r.raw });
        break;
      }

      // --- k8s Ingress -------------------------------------------------------
      // Ingress is an edge-entry routing construct — similarly no InfraModuleKind fits.
      // Captured here for cross-reference below.
      case 'k8s-ingress': {
        k8sIngresses.push({ name: r.name, raw: r.raw, file });
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Post-pass: resolve k8s routing edges.
  //
  // For each k8s Service, find the Deployment(s) it routes to via selector
  // matching. Emit a `calls` edge Service→Deployment — but since k8s Service
  // has no node, we use the *Ingress* → Deployment chain if an Ingress exists,
  // otherwise we emit workload→workload `calls` via the matched service name as
  // a synthetic annotation edge.
  //
  // Concretely:
  //   Ingress → workload (direct, when a matching Service name appears in Ingress backends)
  //   Service → Deployment (via selector match → calls edge between matched workloads)
  //
  // This avoids phantom nodes while still conveying the routing topology.

  // Map service name → matched workload ids (from selector matching).
  const serviceToWorkloads = new Map<string, string[]>();
  for (const svc of k8sServices) {
    const matched: string[] = [];
    for (const wl of k8sWorkloads) {
      if (labelsOverlap(svc.selectors, wl.selectors)) {
        matched.push(wl.id);
      }
    }
    // If no selector match, record empty (service still exists, just unmatched).
    serviceToWorkloads.set(svc.name, matched);
  }

  // Emit service→workload edges (calls).
  // We emit from a virtual "service" perspective — but since k8s Service is not
  // a node, we look for an Ingress to anchor from. If no Ingress, we emit a
  // synthetic "external-entry" node as the call source.
  const hasIngress = k8sIngresses.length > 0;

  if (hasIngress) {
    // Emit one `cdn` node per Ingress, keyed by its metadata.name.
    // `cdn` is the closest InfraModuleKind — it's an edge termination / routing layer.
    for (const ing of k8sIngresses) {
      const ingressId = `k8s:ingress:${ing.name}`;
      addNode({
        id: ingressId,
        label: `Ingress: ${ing.name}`,
        kind: 'cdn' satisfies InfraModuleKind,
        provenance: 'declared',
        metadata: { k8sKind: 'Ingress', name: ing.name },
      });

      // Ingress → workloads via service backend names. Backend extraction
      // (1.19+ `service.name` + legacy `serviceName`) is the shared k8s
      // primitive; we then map each backend Service to its selector-matched
      // workloads and emit the routing edges.
      let routedFromRules = false;
      for (const svcName of extractIngressBackends(ing.raw['spec'])) {
        const targets = serviceToWorkloads.get(svcName) ?? [];
        for (const wlId of targets) {
          // Ingress → workload (calls).
          addEdge({ source: ingressId, target: wlId, kind: 'calls', metadata: { via: 'k8s-ingress-backend' } });
          routedFromRules = true;
        }
      }

      // Fallback: when rules didn't resolve any targets but we have exactly
      // one workload + one service (common simple case), wire them directly.
      if (!routedFromRules && k8sWorkloads.length === 1 && k8sServices.length === 1) {
        const wlId = k8sWorkloads[0].id;
        addEdge({ source: ingressId, target: wlId, kind: 'calls', metadata: { via: 'k8s-routing-simple' } });
      }
    }
  }

  // Service → Deployment edges (routing chain within the cluster).
  // When no Ingress exists, a LoadBalancer/NodePort Service is the external
  // entrypoint — emit it as a `cdn` node regardless of whether its selector
  // matched a workload (don't silently drop entrypoints).
  if (!hasIngress) {
    for (const svc of k8sServices) {
      const svcNodeId = `k8s:service:${svc.name}`;
      addNode({
        id: svcNodeId,
        label: `Service: ${svc.name}`,
        kind: 'cdn' satisfies InfraModuleKind,
        provenance: 'declared',
        metadata: { k8sKind: 'Service' },
      });
      const wlIds = serviceToWorkloads.get(svc.name) ?? [];
      for (const wlId of wlIds) {
        addEdge({ source: svcNodeId, target: wlId, kind: 'calls', metadata: { via: 'k8s-service-selector' } });
      }
    }
  }

  return {
    root,
    adapter: 'gcp',
    nodes: [...nodes.values()],
    edges,
    // No classificationsNeeded — all GCP/k8s shapes in v0 scope are statically
    // mappable to InfraModuleKind. The open-ended GCP Terraform resources go
    // through the terraform adapter's classify path instead.
    classificationsNeeded: [],
  };
}

// ---------------------------------------------------------------------------
// Cheap detect() helpers.
//
// detect() must be a fast existence check — no full YAML parse.
// Strategy:
//   1. Known GCP filename (service.yaml, app.yaml, etc.) → likely GCP.
//   2. Substring scan for strong GCP/k8s signals in the raw text:
//      - "serving.knative.dev"  → Cloud Run
//      - "kind: Deployment"     → k8s / GKE
//      - top-level "runtime:"   → App Engine / Cloud Functions
//      - "apiVersion: apps/"    → k8s
//      - "apiVersion: networking.k8s.io/" → k8s Ingress
// No YAML parse happens in detect().

// Signals that are reliably GCP/k8s-specific (fast substring checks on raw text).
const DETECT_SUBSTRINGS: ReadonlyArray<string> = [
  'serving.knative.dev',
  'apiVersion: apps/',
  'apiVersion: batch/',
  'apiVersion: networking.k8s.io/',
  'apiVersion: extensions/',
  'apiVersion: v1\n',
  '\nruntime:',
];

function fileContainsGcpSignal(content: string): boolean {
  for (const s of DETECT_SUBSTRINGS) {
    if (content.includes(s)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Adapter.

export const gcpAdapter: InfraAdapter = {
  name: 'gcp',

  async detect(repoDir: string): Promise<boolean> {
    // Cheap existence check — no full YAML parse.
    // 1. If a well-known GCP config filename exists anywhere in the tree, assume GCP.
    // 2. Otherwise, scan YAML file text for strong GCP/k8s substrings.
    const files = findYamlFiles(repoDir);
    for (const file of files) {
      const base = file.slice(file.lastIndexOf('/') + 1);
      if (GCP_CONFIG_NAMES.has(base)) return true;
    }
    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf8');
        if (fileContainsGcpSignal(content)) return true;
      } catch {
        // Unreadable file — skip.
      }
    }
    return false;
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    // Single authoritative parse — no double-parse with detect().
    const files = findYamlFiles(repoDir);
    const resources: GcpResource[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf8');
        resources.push(...parseGcpFile(content, file));
      } catch (err) {
        console.warn(`  [gcp] skipping unparseable ${relative(repoDir, file)}: ${(err as Error).message}`);
      }
    }
    // build the in-repo Dockerfile index once so k8s (GKE) workloads
    // can attribute their container images back to a build context.
    return buildGcpGraph(resources, repoDir, buildDockerfileIndex(repoDir));
  },
};
