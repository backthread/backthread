// Azure infra parser (v0).
//
// Handles four config surfaces:
//   1. ARM JSON templates  — `resources[]` array with `type`/`name`/nested resources
//   2. Bicep (light)       — regex match for `resource <sym> '<Type>@<ver>' = {`
//                            and `module <sym> '<path>' = {` declarations.
//                            Full Bicep DSL evaluation (expressions, params,
//                            modules-from-registry) is DEFERRED ( v1).
//   3. Azure Functions     — `function.json` (bindings[]) + `host.json` (app root)
//   4. AKS k8s manifests   — YAML multi-doc (Deployment / Service / Ingress)
//
// Each parser is tolerant: a parse error returns an empty result and the caller
// logs a warning rather than crashing the whole infra extraction.

// ---------------------------------------------------------------------------
// ARM JSON

export interface ArmResource {
  type: string;
  name: string;
  /** The ARM resource-level 'kind' field (e.g. 'functionapp', 'linux', 'app').
   *  Only present on resource types that carry it (Microsoft.Web/sites being the
   *  most common).  Undefined when the ARM JSON omits 'kind'. */
  armKind?: string;
  rawText: string; // JSON.stringify of the resource object — for reference scanning
}

/**
 * Detect an ARM template: the JSON must have '$schema' containing
 * 'deploymentTemplate' (case-insensitive), OR a top-level 'resources' array
 * where at least one element has a 'type' string matching the Microsoft.*
 * pattern. Scanning the full array (not just [0]) handles templates whose
 * first element is a copy-loop placeholder or a non-Microsoft wrapper.
 */
export function isArmTemplate(parsed: unknown): parsed is { resources: unknown[] } {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  const schema = typeof obj['$schema'] === 'string' ? obj['$schema'] : '';
  if (schema.toLowerCase().includes('deploymenttemplate')) return true;
  // Fallback: resources array where any element has a Microsoft.* type.
  if (Array.isArray(obj['resources']) && obj['resources'].length > 0) {
    return obj['resources'].some(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        /^Microsoft\./i.test(String((r as Record<string, unknown>)['type'] ?? '')),
    );
  }
  return false;
}

function flattenArmResources(
  resources: unknown[],
  collected: ArmResource[],
): void {
  for (const r of resources) {
    if (typeof r !== 'object' || r === null) continue;
    const obj = r as Record<string, unknown>;
    const type = typeof obj['type'] === 'string' ? obj['type'] : '';
    const name = typeof obj['name'] === 'string' ? obj['name'] : '';
    if (!type) continue;
    const armKind = typeof obj['kind'] === 'string' ? obj['kind'] : undefined;
    const rawText = JSON.stringify(obj);
    collected.push({ type, name, armKind, rawText });
    // Recurse into nested resources (one level — v0 scope).
    if (Array.isArray(obj['resources'])) {
      flattenArmResources(obj['resources'], collected);
    }
  }
}

/**
 * Parse an ARM JSON template. Returns [] on any parse/shape error.
 */
export function parseArmTemplate(text: string): ArmResource[] {
  try {
    const parsed = JSON.parse(text);
    if (!isArmTemplate(parsed)) return [];
    const collected: ArmResource[] = [];
    flattenArmResources(parsed.resources, collected);
    return collected;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Bicep (light — regex only; full DSL parsing is DEFERRED)

export interface BicepResource {
  symbolicName: string;
  type: string; // e.g. 'Microsoft.Web/sites'
  apiVersion: string; // e.g. '2022-03-01'
  rawText: string; // the block body (best-effort; may be truncated)
  isModule: boolean; // true for 'module' declarations
}

// Matches: resource <sym> '<Type>@<apiVersion>' = {  (and optional whitespace)
// Also matches: module <sym> '<path>' = {
const BICEP_RESOURCE_RE =
  /^[ \t]*(resource|module)\s+(\w+)\s+'([^']+)'\s*=\s*\{/gm;

/**
 * Light Bicep extraction using regex only. Finds 'resource' and 'module'
 * declarations and extracts the block body with a brace-balance walk.
 * Returns [] on any error.
 */
export function parseBicep(text: string): BicepResource[] {
  const results: BicepResource[] = [];
  BICEP_RESOURCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BICEP_RESOURCE_RE.exec(text)) !== null) {
    const keyword = m[1]; // 'resource' | 'module'
    const symbolicName = m[2];
    const typeOrPath = m[3];
    const isModule = keyword === 'module';

    // For resources: typeOrPath is 'Type@apiVersion'.
    // For modules: typeOrPath is a path/registry reference — we set type='' as
    // an explicit empty-string sentinel so consumers never mistake a filesystem
    // path for a resource type.  The original path is preserved in the caller's
    // metadata (bicepPath) for modules that need it.
    let type = '';
    let apiVersion = '';
    if (!isModule) {
      if (typeOrPath.includes('@')) {
        const at = typeOrPath.lastIndexOf('@');
        type = typeOrPath.slice(0, at);
        apiVersion = typeOrPath.slice(at + 1);
      } else {
        // No @version suffix — treat the whole string as the type.
        type = typeOrPath;
      }
    }

    // Extract the block body via brace balancing.
    const openBrace = text.indexOf('{', m.index + m[0].length - 1);
    const rawText = openBrace >= 0 ? extractBraceBlock(text, openBrace) : '';

    results.push({ symbolicName, type, apiVersion, rawText, isModule });
  }
  return results;
}

/** Extract the brace-balanced content between '{' at openIdx and its
 *  matching '}'. Returns the content INCLUDING the outer braces. */
function extractBraceBlock(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  // Unbalanced — return from openIdx to end.
  return text.slice(openIdx);
}

// ---------------------------------------------------------------------------
// Azure Functions

export type AzFuncBindingType =
  | 'httpTrigger'
  | 'queueTrigger'
  | 'serviceBusTrigger'
  | 'blobTrigger'
  | 'cosmosDBTrigger'
  | 'timerTrigger'
  | 'blob'
  | 'queue'
  | 'serviceBus'
  | 'cosmosDB'
  | 'http'
  | string; // open-ended — new trigger types shouldn't crash v0

export interface AzFuncBinding {
  type: AzFuncBindingType;
  direction: 'in' | 'out' | 'inout' | string;
  name?: string; // parameter binding name
  queueName?: string; // for queueTrigger / queue out
  topicName?: string; // for serviceBus topics
  connection?: string; // connection string setting name
}

export interface AzFuncFunctionJson {
  /** Name of the function (set from the directory name by the caller). */
  functionName: string;
  bindings: AzFuncBinding[];
  rawText: string;
  /**
   * repo-relative dir of the function (the folder holding function.json
   * = the function's source). Set by azure.ts's extract() from the file path.
   * Optional for back-compat.
   */
  sourceDir?: string;
}

/** Mark a function app root. host.json presence identifies the app level. */
export interface AzFuncHostJson {
  version?: string;
  rawText: string;
}

/**
 * Parse a function.json file. Returns null on parse error.
 */
export function parseFunctionJson(
  text: string,
  functionName: string,
): AzFuncFunctionJson | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const rawBindings = Array.isArray(obj['bindings']) ? obj['bindings'] : [];
    const bindings: AzFuncBinding[] = rawBindings.flatMap((b) => {
      if (typeof b !== 'object' || b === null) return [];
      const bObj = b as Record<string, unknown>;
      return [
        {
          type: typeof bObj['type'] === 'string' ? bObj['type'] : 'unknown',
          direction: typeof bObj['direction'] === 'string' ? bObj['direction'] : 'in',
          name: typeof bObj['name'] === 'string' ? bObj['name'] : undefined,
          queueName: typeof bObj['queueName'] === 'string' ? bObj['queueName'] : undefined,
          topicName: typeof bObj['topicName'] === 'string' ? bObj['topicName'] : undefined,
          connection: typeof bObj['connection'] === 'string' ? bObj['connection'] : undefined,
        } satisfies AzFuncBinding,
      ];
    });
    return { functionName, bindings, rawText: text };
  } catch {
    return null;
  }
}

/**
 * Parse a host.json file. Returns null on parse error.
 */
export function parseHostJson(text: string): AzFuncHostJson | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    return {
      version: typeof obj['version'] === 'string' ? obj['version'] : undefined,
      rawText: text,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// AKS / Kubernetes YAML
//
// The manifest-parsing layer is shared with the other cloud adapters (GCP/GKE,
// future EKS) — see scripts/ingest/infra/k8s/. azure.ts still imports the type
// and parser from here, so we re-export rather than make it import the shared
// module directly (keeps the adapter's surface stable). The Azure-specific
// graph assembly (node ids, ARM→AKS edges, selector name-matching) stays in
// azure.ts; only the parse primitives are delegated.
export type { K8sKind, K8sManifest } from '../k8s/index.js';
export { parseK8sManifests as parseAksYaml } from '../k8s/index.js';
