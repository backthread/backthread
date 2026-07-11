// GCP-native InfraAdapter parser.
//
// Classifies a raw YAML document (already parsed via `yaml`) into a
// GcpResource descriptor. Called from gcp.ts after the bounded file walk
// pulls each *.yaml / *.yml through `yaml.parseAllDocuments`.
//
// Supported in v0 (declared, no LLM needed):
//   - Cloud Run service.yaml  (apiVersion: serving.knative.dev/v1, kind: Service)
//   - App Engine app.yaml     (top-level `runtime:` key, optional `service:` key)
//   - Cloud Functions         (top-level `name:` + `runtime:` without AE `service:`)
//   - GKE / k8s manifests     (standard k8s apiVersions, kind: Deployment / Service /
//                              Ingress / StatefulSet / Job / CronJob)
//
// DEFERRED: Deployment Manager .jinja, cloudbuild.yaml deploy-mechanism,
//           GKE Autopilot node-pool configs. Tracked .

import { parseAllDocuments } from 'yaml';
import { isK8sApiVersion } from '../k8s/index.js';

// ---------------------------------------------------------------------------
// Descriptor types returned by classifyYamlDoc.

export type GcpResourceKind =
  | 'cloud-run'
  | 'app-engine'
  | 'cloud-functions'
  | 'k8s-deployment'
  | 'k8s-statefulset'
  | 'k8s-job'
  | 'k8s-cronjob'
  | 'k8s-service'
  | 'k8s-ingress';

export interface GcpResource {
  kind: GcpResourceKind;
  name: string;
  /** Raw document object (the parsed YAML map). */
  raw: Record<string, unknown>;
  /** Source file (absolute path). */
  file: string;
}

// ---------------------------------------------------------------------------
// Helpers.

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// Classification.

/**
 * Classify a single parsed YAML document object into a GcpResource, or
 * return `null` if it doesn't match any recognised GCP/k8s shape.
 *
 * Deliberately defensive: every field access is guarded. A YAML doc that
 * looks like `{ foo: bar }` silently returns null.
 */
export function classifyYamlDoc(doc: unknown, file: string): GcpResource | null {
  const d = rec(doc);
  if (!d) return null;

  const kind = str(d['kind']);
  const apiVersion = str(d['apiVersion']);
  const metadata = rec(d['metadata']);
  const name = str(metadata?.['name']) ?? 'unnamed';

  // --- Cloud Run (Knative serving) -----------------------------------------
  // apiVersion: serving.knative.dev/v1 (or v1alpha1/v1beta1), kind: Service
  if (apiVersion?.startsWith('serving.knative.dev') && kind === 'Service') {
    return { kind: 'cloud-run', name, raw: d, file };
  }

  // --- Kubernetes / GKE manifests -------------------------------------------
  // Standard k8s apiVersions (apps/v1, batch/v1, networking.k8s.io/v1, v1 core,
  // extensions/v1beta1, …) — recognised by the shared k8s primitive.
  // Check this BEFORE app.yaml: k8s Service/Deployment always have apiVersion.
  if (isK8sApiVersion(apiVersion) && kind) {
    switch (kind) {
      case 'Deployment':
        return { kind: 'k8s-deployment', name, raw: d, file };
      case 'StatefulSet':
        return { kind: 'k8s-statefulset', name, raw: d, file };
      case 'Job':
        return { kind: 'k8s-job', name, raw: d, file };
      case 'CronJob':
        return { kind: 'k8s-cronjob', name, raw: d, file };
      case 'Service':
        return { kind: 'k8s-service', name, raw: d, file };
      case 'Ingress':
        return { kind: 'k8s-ingress', name, raw: d, file };
      default:
        return null; // ConfigMap, Namespace, ServiceAccount, etc. — not topology
    }
  }

  // --- App Engine app.yaml --------------------------------------------------
  // No apiVersion/kind — identified by top-level `runtime:` field (required by
  // AE). The `service:` field names the service; default is "default".
  // Must come after k8s check (k8s docs always have apiVersion).
  if (!apiVersion && !kind && str(d['runtime'])) {
    // Distinguish from Cloud Functions: App Engine uses `service:`, Cloud
    // Functions uses `name:`. Both require `runtime:` but CF lacks `service:`.
    const hasService = 'service' in d;
    const fnName = str(d['name']);
    // Cloud Functions (gen1 YAML): requires `name:` + a strong signal —
    // either `entryPoint:` or a `trigger:` block — to avoid false-positives
    // on unrelated YAML that happens to have `runtime:` + `name:`.
    // DEFERRED: package.json-based framework detection path.
    const hasFunctionSignal = 'entryPoint' in d || 'trigger' in d;
    if (!hasService && fnName && hasFunctionSignal) {
      return { kind: 'cloud-functions', name: fnName, raw: d, file };
    }
    // App Engine: has `service:`, or has `runtime:` but no strong CF signal.
    const aeName = str(d['service']) ?? 'default';
    return { kind: 'app-engine', name: aeName, raw: d, file };
  }

  return null;
}

/**
 * Parse a raw YAML string (possibly multi-document) and return all recognised
 * GCP/k8s resources found in it. Per-document parse errors are swallowed with
 * a `console.warn` — one broken doc must never crash the whole file.
 */
export function parseGcpFile(content: string, file: string): GcpResource[] {
  const results: GcpResource[] = [];
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(content, { strict: false });
  } catch {
    console.warn(`  [gcp] failed to parse YAML in ${file} — skipping file`);
    return results;
  }

  for (const doc of docs) {
    try {
      const obj = doc.toJS({ reviver: undefined });
      const resource = classifyYamlDoc(obj, file);
      if (resource) results.push(resource);
    } catch {
      // Individual doc parse/conversion error — skip, not fatal.
    }
  }

  return results;
}
