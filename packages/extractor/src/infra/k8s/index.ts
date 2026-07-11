// shared Kubernetes manifest parsing for the cloud adapters.
//
// GCP (GKE), Azure (AKS) — and any future EKS-style adapter — all read the same
// Kubernetes manifest YAML: Deployment / StatefulSet / Job / CronJob workloads,
// plus Service / Ingress routing objects. Before this module each adapter shipped
// its own copy of the manifest-parsing primitives (multi-doc YAML parse, the
// apiVersion/kind recognisers, selector-label extraction with matchLabels
// fallback, and ingress-backend resolution across the 1.19+/legacy backend
// shapes). This is that one copy.
//
// SCOPE — parsing primitives ONLY. The two adapters deliberately model the
// *graph* differently and their tests lock those differences in:
//   * GCP keys workloads `k8s:workload:<name>` and emits Service/Ingress as
//     `cdn` nodes (earn-a-box routing layer), matching via label OVERLAP.
//   * Azure keys workloads `k8s:deployment:<name>`, never emits a routing node,
//     matches via a name heuristic, and treats DaemonSet as a workload.
// Those divergences are graph-assembly policy, not parsing, so they stay in the
// adapters. What's centralised here is the genuinely-identical parse layer plus
// the one convention that must never drift: a k8s Service/Ingress is ROUTING —
// it becomes edges (and, where an entrypoint must earn a box, a `cdn` node),
// never a bogus InfraModuleKind. See K8S_ROUTING_KINDS below.

import { parseAllDocuments } from 'yaml';
import { resolveImageToSourceRoots, type DockerfileIndex } from '../image-resolve.js';

// ---------------------------------------------------------------------------
// Kind taxonomy.

/**
 * Workload kinds — every adapter models these as `container` InfraModuleKind
 * nodes. Note GCP's v0 scope omits DaemonSet while Azure includes it; each
 * adapter decides its own workload set, so this is the documented SUPERSET and
 * adapters intersect it with what they support rather than relying on it.
 */
export const K8S_WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'] as const;

/**
 * Routing kinds — NEVER a node-with-a-module-kind. A Service/Ingress is modelled
 * as edges (and, for an external entrypoint, a `cdn` node). Centralised here so
 * the "no bogus module kind for routing" rule has one home.
 */
export const K8S_ROUTING_KINDS = ['Service', 'Ingress'] as const;

export type K8sWorkloadKind = (typeof K8S_WORKLOAD_KINDS)[number];
export type K8sRoutingKind = (typeof K8S_ROUTING_KINDS)[number];
export type K8sKind = K8sWorkloadKind | K8sRoutingKind | string;

/**
 * Recognise a standard Kubernetes `apiVersion`. Mirrors the prefix set the GCP
 * adapter has always used: core `v1`, plus the `apps/`, `batch/`,
 * `networking.k8s.io/`, and `extensions/` groups.
 */
export function isK8sApiVersion(apiVersion: string | undefined): boolean {
  if (!apiVersion) return false;
  return (
    apiVersion === 'v1' ||
    apiVersion.startsWith('apps/') ||
    apiVersion.startsWith('batch/') ||
    apiVersion.startsWith('networking.k8s.io/') ||
    apiVersion.startsWith('extensions/')
  );
}

// ---------------------------------------------------------------------------
// Manifest descriptor.

export interface K8sManifest {
  kind: K8sKind;
  apiVersion?: string;
  name: string; // metadata.name
  namespace?: string;
  /** For Service: spec.selector labels (for matching Deployments). */
  selector?: Record<string, string>;
  /** For Ingress: list of backend service names extracted from rules. */
  ingressBackends?: string[];
  rawObj: Record<string, unknown>;
}

/**
 * Detect a Kubernetes manifest: must have 'apiVersion' and 'kind' and
 * 'metadata' at the top level. Guards against firing on arbitrary YAML.
 */
export function isK8sManifest(doc: unknown): doc is Record<string, unknown> {
  if (typeof doc !== 'object' || doc === null) return false;
  const obj = doc as Record<string, unknown>;
  return (
    typeof obj['apiVersion'] === 'string' &&
    typeof obj['kind'] === 'string' &&
    typeof obj['metadata'] === 'object' &&
    obj['metadata'] !== null
  );
}

// ---------------------------------------------------------------------------
// Selector & routing primitives.

/**
 * Extract selector labels from a manifest `spec`. Handles both shapes:
 *   * `spec.selector.matchLabels` (Deployment / StatefulSet style)
 *   * `spec.selector` as a plain label map (Service style)
 * Returns the raw label map (cast, NOT filtered — preserving Azure's original
 * behavior verbatim), or `undefined` when there is no selector. (Azure keeps
 * the `undefined` to gate selector-less Services out of routing; GCP wraps this
 * with its own string-filter + `?? {}` for its overlap matcher — see
 * gcp.ts selectorLabels.) Deliberately NOT string-filtered here so the shared
 * primitive is a no-behavior-change drop-in for the old per-adapter code.
 */
export function extractSelector(spec: unknown): Record<string, string> | undefined {
  if (typeof spec !== 'object' || spec === null) return undefined;
  const sel = (spec as Record<string, unknown>)['selector'];
  if (typeof sel !== 'object' || sel === null) return undefined;
  const ml = (sel as Record<string, unknown>)['matchLabels'];
  if (typeof ml === 'object' && ml !== null) {
    return ml as Record<string, string>;
  }
  return sel as Record<string, string>;
}

/**
 * Extract the backend Service names an Ingress routes to, across both backend
 * encodings: k8s 1.19+ (`backend.service.name`) and legacy
 * extensions/v1beta1 (`backend.serviceName`). Deduplicated, source order.
 */
export function extractIngressBackends(spec: unknown): string[] {
  if (typeof spec !== 'object' || spec === null) return [];
  const rules = Array.isArray((spec as Record<string, unknown>)['rules'])
    ? ((spec as Record<string, unknown>)['rules'] as unknown[])
    : [];
  const names: string[] = [];
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null) continue;
    const http = (rule as Record<string, unknown>)['http'];
    if (typeof http !== 'object' || http === null) continue;
    const paths = Array.isArray((http as Record<string, unknown>)['paths'])
      ? ((http as Record<string, unknown>)['paths'] as unknown[])
      : [];
    for (const p of paths) {
      if (typeof p !== 'object' || p === null) continue;
      const backend = (p as Record<string, unknown>)['backend'];
      if (typeof backend !== 'object' || backend === null) continue;
      // k8s 1.19+ networking.k8s.io style:
      const svc = (backend as Record<string, unknown>)['service'];
      if (typeof svc === 'object' && svc !== null) {
        const svcName = (svc as Record<string, unknown>)['name'];
        if (typeof svcName === 'string') names.push(svcName);
      }
      // Legacy extensions/v1beta1 style:
      const legacySvcName = (backend as Record<string, unknown>)['serviceName'];
      if (typeof legacySvcName === 'string') names.push(legacySvcName);
    }
  }
  return [...new Set(names)];
}

/** True when two selector label maps share at least one identical key/value pair. */
export function labelsOverlap(a: Record<string, string>, b: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(a)) {
    if (b[k] === v) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Workload image → source-root resolution.
//
// k8s references PRE-BUILT images (`image: ghcr.io/acme/api:1.2`), never source
// dirs — so a workload's code can only attribute to a deployment unit by mapping
// its container image(s) back to the in-repo Dockerfile that builds them. That's
// the  resolver. These helpers find a workload's images and union the
// resolved roots; the GCP (GKE) + Azure (AKS) adapters call them on their
// `container` workload nodes.

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * The Pod spec inside a workload manifest, across the nesting variants:
 *   * Deployment / StatefulSet / DaemonSet / Job → `spec.template.spec`
 *   * CronJob                                    → `spec.jobTemplate.spec.template.spec`
 *   * bare Pod                                   → `spec`
 */
function podSpecOf(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const spec = asRecord(raw['spec']);
  if (!spec) return undefined;
  const jobTemplate = asRecord(spec['jobTemplate']); // CronJob
  if (jobTemplate) {
    const jspec = asRecord(jobTemplate['spec']);
    const tmpl = asRecord(jspec?.['template']);
    return asRecord(tmpl?.['spec']);
  }
  const tmpl = asRecord(spec['template']); // Deployment/StatefulSet/DaemonSet/Job
  if (tmpl) return asRecord(tmpl['spec']);
  return spec; // bare Pod
}

/**
 * Every container image ref a workload manifest declares (containers +
 * initContainers, across the workload nesting variants). Deduped, source order.
 */
export function extractWorkloadImages(raw: Record<string, unknown>): string[] {
  const podSpec = podSpecOf(raw);
  if (!podSpec) return [];
  const images: string[] = [];
  for (const key of ['initContainers', 'containers']) {
    const list = podSpec[key];
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      const image = asRecord(c)?.['image'];
      if (typeof image === 'string' && image) images.push(image);
    }
  }
  return [...new Set(images)];
}

/**
 * The repo-relative source roots a k8s workload deploys: each container image
 * resolved via the  image→source resolver, unioned. Returns [] when no
 * image resolves to an in-repo Dockerfile (honest "Other"). Deterministic.
 */
export function workloadSourceRoots(raw: Record<string, unknown>, index: DockerfileIndex): string[] {
  const roots = new Set<string>();
  for (const image of extractWorkloadImages(raw)) {
    for (const r of resolveImageToSourceRoots(image, index)) roots.add(r);
  }
  return [...roots].sort();
}

// ---------------------------------------------------------------------------
// Multi-document parse.

/**
 * Parse a YAML file potentially containing multiple Kubernetes manifest
 * documents into normalized {@link K8sManifest} descriptors. Returns `[]` on any
 * parse error; non-k8s documents within a multi-doc file are silently skipped.
 * Selector labels are populated for Services and backend names for Ingresses.
 */
export function parseK8sManifests(text: string): K8sManifest[] {
  try {
    const docs = parseAllDocuments(text);
    const results: K8sManifest[] = [];
    for (const doc of docs) {
      if (doc.errors && doc.errors.length > 0) continue; // skip bad doc
      const obj = doc.toJS() as unknown;
      if (!isK8sManifest(obj)) continue;
      const meta = obj['metadata'] as Record<string, unknown>;
      const name = typeof meta['name'] === 'string' ? meta['name'] : '';
      const namespace = typeof meta['namespace'] === 'string' ? meta['namespace'] : undefined;
      const kind = obj['kind'] as string;
      const manifest: K8sManifest = {
        kind,
        apiVersion: typeof obj['apiVersion'] === 'string' ? obj['apiVersion'] : undefined,
        name,
        namespace,
        rawObj: obj as Record<string, unknown>,
      };
      if (kind === 'Service') {
        manifest.selector = extractSelector(obj['spec']);
      }
      if (kind === 'Ingress') {
        manifest.ingressBackends = extractIngressBackends(obj['spec']);
      }
      results.push(manifest);
    }
    return results;
  } catch {
    return [];
  }
}
