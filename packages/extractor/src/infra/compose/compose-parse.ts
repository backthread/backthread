// docker-compose parser + typed shape extractor.
//
// docker-compose files are YAML (the Compose Spec), so we reuse the `yaml`
// package (already a devDependency, like render-parse.ts / gcp-parse.ts). This
// module maps the raw YAML tree into a typed ComposeConfig — keeping the parse
// logic separated from the graph builder (the render-parse.ts ↔ render.ts pattern).
//
// Covered:
//   services.<name>:
//     build      — string short-form (the context dir) OR { context, dockerfile }
//     image      — a prebuilt image ref (no build → pulled, not your code)
//     depends_on — list form [a, b] OR map form { a: {condition}, b: {} }
//
// Compose Spec: https://github.com/compose-spec/compose-spec/blob/master/spec.md

import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Typed structured shape

export interface ComposeBuild {
  /**
   * The build CONTEXT — the dir Docker sends to the daemon = the source this
   * container deploys. Relative to the compose file's location. Defaults to '.'
   * (the compose file's own dir) when `build` is a mapping without `context`.
   */
  context: string;
  /** Optional Dockerfile path (metadata only; the context dir is the source root). */
  dockerfile?: string;
}

export interface ComposeService {
  name: string;
  /** Present iff the service builds from in-repo source (→ a unit that runs your code). */
  build?: ComposeBuild;
  /** Present iff the service runs a prebuilt image (→ pulled; classify by role, no source). */
  image?: string;
  /** Normalized list of service names this one depends_on (both list + map forms). */
  dependsOn: string[];
}

export interface ComposeConfig {
  services: ComposeService[];
}

// ---------------------------------------------------------------------------
// Helpers

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Normalize a `depends_on` value (list of names, or a map keyed by name). */
function parseDependsOn(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  }
  const m = obj(v);
  if (m) return Object.keys(m);
  return [];
}

/** Normalize a `build` value (string short-form, or a `{ context, dockerfile }` map). */
function parseBuild(v: unknown): ComposeBuild | undefined {
  const s = str(v);
  if (s) return { context: s };
  const m = obj(v);
  if (m) {
    // A `build:` mapping without `context` defaults to the compose file's dir ('.').
    return { context: str(m.context) ?? '.', dockerfile: str(m.dockerfile) };
  }
  return undefined;
}

function parseService(name: string, raw: Record<string, unknown>): ComposeService {
  const svc: ComposeService = { name, dependsOn: parseDependsOn(raw.depends_on) };
  const build = parseBuild(raw.build);
  if (build) svc.build = build;
  const image = str(raw.image);
  if (image) svc.image = image;
  return svc;
}

// ---------------------------------------------------------------------------
// Main parse function: raw YAML string → ComposeConfig.
// Throws on YAML syntax errors (caller wraps in try/catch + warns).

export function parseComposeConfig(yamlText: string): ComposeConfig {
  const raw = parseYaml(yamlText, { logLevel: 'silent' });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('compose file: top-level value must be a mapping');
  }
  const tree = raw as Record<string, unknown>;
  const servicesRaw = obj(tree.services);
  if (!servicesRaw) return { services: [] };

  const services: ComposeService[] = [];
  for (const [name, value] of Object.entries(servicesRaw)) {
    const svcRaw = obj(value);
    if (!name || !svcRaw) continue; // skip nameless / non-mapping entries
    services.push(parseService(name, svcRaw));
  }
  return { services };
}
