// Kamal config parser + typed shape extractor.
//
// Kamal (Basecamp/DHH) deploys a Docker image to one or more VPS hosts. Its
// config is `config/deploy.yml` (YAML) — so this reuses the `yaml` package and
// mirrors the render-parse.ts ↔ render.ts parse/builder split.
//
// Covered top-level keys:
//   service     — the app's name (the app container's label/id)
//   image       — the app image ref (`myorg/app`) — resolved to a build context
//   builder     — { context, dockerfile } — a DIRECT source signal when present
//   accessories — name → { image } — the side services (db/redis/…), classified
//                 from their image by role (the compose image-role token map)
//
// Kamal reference: https://kamal-deploy.org/docs/configuration/

import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Typed structured shape

export interface KamalBuilder {
  /** `builder.context` — the build context dir (the app's source). */
  context?: string;
  /** `builder.dockerfile` — path to the Dockerfile (its dir is the source). */
  dockerfile?: string;
}

export interface KamalAccessory {
  name: string;
  /** The accessory's image ref (`postgres:16`, `redis:7`) — classified by role. */
  image?: string;
}

export interface KamalConfig {
  /** `service:` — the app name. */
  service?: string;
  /** `image:` — the app image ref Kamal builds + deploys. */
  image?: string;
  /** `builder:` — direct build-source signals, when present. */
  builder?: KamalBuilder;
  /** `accessories:` — the side services, in declaration order. */
  accessories: KamalAccessory[];
}

// ---------------------------------------------------------------------------
// Helpers

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// ---------------------------------------------------------------------------
// Main parse function: raw YAML string → KamalConfig.
// Throws on YAML syntax errors (caller wraps in try/catch + warns).

export function parseKamalConfig(yamlText: string): KamalConfig {
  const raw = parseYaml(yamlText, { logLevel: 'silent' });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('kamal deploy.yml: top-level value must be a mapping');
  }
  const tree = raw as Record<string, unknown>;
  const config: KamalConfig = { accessories: [] };

  const service = str(tree.service);
  if (service) config.service = service;
  const image = str(tree.image);
  if (image) config.image = image;

  const builderRaw = obj(tree.builder);
  if (builderRaw) {
    const builder: KamalBuilder = {};
    const context = str(builderRaw.context);
    if (context) builder.context = context;
    const dockerfile = str(builderRaw.dockerfile);
    if (dockerfile) builder.dockerfile = dockerfile;
    config.builder = builder;
  }

  const accessoriesRaw = obj(tree.accessories);
  if (accessoriesRaw) {
    for (const [name, value] of Object.entries(accessoriesRaw)) {
      const accRaw = obj(value);
      if (!name || !accRaw) continue; // skip nameless / non-mapping entries
      const accessory: KamalAccessory = { name };
      const accImage = str(accRaw.image);
      if (accImage) accessory.image = accImage;
      config.accessories.push(accessory);
    }
  }

  return config;
}
