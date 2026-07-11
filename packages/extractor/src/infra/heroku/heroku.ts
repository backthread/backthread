// the Heroku InfraAdapter (v0).
//
// Surfaces the PaaS deployment topology from Procfile + app.json. Emits:
//   - One `worker` node per Procfile process type (web/worker/release/clock/custom)
//   - One node per app.json addon, kind decided by a static slug map
//   - `stores-in` edges (dyno → datastore addon)
//   - `calls` edges (dyno → external-api addon)
//
// Everything is `declared` provenance: the files literally name the dyno type
// and the addon slug. No LLM, no inference → classificationsNeeded: [].
//
// heroku.yml (Docker-based deploys) is DEFERRED — it is YAML, and there is no
// YAML parser available in this dependency-free adapter. Presence of
// heroku.yml is used in detect() only. Parsing is tracked for .
//
// PaaS tight static model: an addon slug literally names the managed service,
// so the kind decision is made by a static slug→kind map here rather than
// delegating to the LLM classifier. Unknown slugs fall back to `external-api`
// (a named managed service you don't own) — declared, not classified.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InfraAdapter, InfraEdge, InfraGraph, InfraNode } from '../types.js';
import type { InfraModuleKind } from '../../types.js';
import { parseProcfile, parseAppJson } from './heroku-parse.js';

// ---------------------------------------------------------------------------
// Static addon-slug → kind map.
// Rule: match slug prefixes (e.g. 'heroku-postgresql:mini' uses the root slug
// 'heroku-postgresql'). Plans are stripped before lookup.

interface AddonMeta {
  kind: InfraModuleKind;
  label: string;
}

/**
 * Extract the root slug from an addon slug that may carry a plan suffix
 * (e.g. 'heroku-postgresql:mini' → 'heroku-postgresql').
 */
function rootSlug(slug: string): string {
  return slug.split(':')[0].toLowerCase().trim();
}

const SLUG_MAP: Record<string, AddonMeta> = {
  // Relational / Postgres
  'heroku-postgresql': { kind: 'datastore', label: 'Heroku Postgres' },
  'jawsdb': { kind: 'datastore', label: 'JawsDB MySQL' },
  'jawsdb-maria': { kind: 'datastore', label: 'JawsDB MariaDB' },
  'cleardb': { kind: 'datastore', label: 'ClearDB MySQL' },
  'xeround': { kind: 'datastore', label: 'Xeround' },
  // Redis / Memcache
  'heroku-redis': { kind: 'datastore', label: 'Heroku Redis' },
  'rediscloud': { kind: 'datastore', label: 'Redis Cloud' },
  'redistogo': { kind: 'datastore', label: 'RedisToGo' },
  'memcachier': { kind: 'datastore', label: 'MemCachier' },
  'memcachedcloud': { kind: 'datastore', label: 'Memcached Cloud' },
  // Search / Time-series
  'searchbox': { kind: 'datastore', label: 'SearchBox (Elasticsearch)' },
  'bonsai': { kind: 'datastore', label: 'Bonsai (Elasticsearch)' },
  'algoliasearch': { kind: 'external-api', label: 'Algolia' },
  // Messaging / Email
  'sendgrid': { kind: 'external-api', label: 'SendGrid' },
  'mailgun': { kind: 'external-api', label: 'Mailgun' },
  'mandrill': { kind: 'external-api', label: 'Mandrill' },
  'postmark': { kind: 'external-api', label: 'Postmark' },
  'sparkpost': { kind: 'external-api', label: 'SparkPost' },
  // SMS / telephony
  'twilio': { kind: 'external-api', label: 'Twilio' },
  // Payments
  'stripe': { kind: 'external-api', label: 'Stripe' },
  // Monitoring / logging
  'papertrail': { kind: 'external-api', label: 'Papertrail' },
  'logentries': { kind: 'external-api', label: 'Logentries' },
  'librato': { kind: 'external-api', label: 'Librato' },
  'new-relic': { kind: 'external-api', label: 'New Relic' },
  'rollbar': { kind: 'external-api', label: 'Rollbar' },
  'sentry': { kind: 'external-api', label: 'Sentry' },
  'scout': { kind: 'external-api', label: 'Scout APM' },
  'airbrake': { kind: 'external-api', label: 'Airbrake' },
  'honeybadger': { kind: 'external-api', label: 'Honeybadger' },
  // Queuing / jobs
  'cloudamqp': { kind: 'queue', label: 'CloudAMQP' },
  'rabbitmq-bigwig': { kind: 'queue', label: 'RabbitMQ Bigwig' },
  'iron-mq': { kind: 'queue', label: 'IronMQ' },
  // Storage / CDN
  'cloudinary': { kind: 'external-api', label: 'Cloudinary' },
  'bucketeer': { kind: 'datastore', label: 'Bucketeer (S3)' },
  // Auth
  'auth0': { kind: 'external-api', label: 'Auth0' },
  'stormpath': { kind: 'external-api', label: 'Stormpath' },
  // Scheduled jobs helpers
  'scheduler': { kind: 'external-api', label: 'Heroku Scheduler' },
  'heroku-scheduler': { kind: 'external-api', label: 'Heroku Scheduler' },
};

function lookupAddon(slug: string): AddonMeta {
  const root = rootSlug(slug);
  return (
    SLUG_MAP[root] ?? {
      kind: 'external-api' as InfraModuleKind,
      label: slug, // use the raw slug as label for unknown addons
    }
  );
}

// ---------------------------------------------------------------------------
// Source-root resolution.
//
// A Heroku app builds the whole repo (or a monorepo sub-dir) into one slug; the
// dynos all run process types from that single slug, so every dyno shares ONE
// source root. The only honest sub-root signal is the monorepo-buildpack base
// dir, declared in app.json `env` as `APP_BASE` (heroku-buildpack-monorepo) or
// `PROJECT_PATH`. With that → the dynos' code lives under that sub-dir. Without
// it the app sits at the repo root, which is a catch-all: we emit NO source root
// (the deployment consumer drops an empty root anyway, and a bare repo root must
// never swallow sibling units) → the code honestly stays "Other".

/** Normalize a repo-relative path: backslashes→/, collapse `.`/`./`, strip trailing `/`. */
function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.(?:\/|$)/, '').replace(/\/+$/, '');
}

/** Read an app.json env value, which may be a bare string or `{ value: string }`. */
function envValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v || undefined;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const val = (v as Record<string, unknown>).value;
    return typeof val === 'string' && val ? val : undefined;
  }
  return undefined;
}

/**
 * The repo-relative source root shared by every dyno: the monorepo-buildpack
 * base dir from app.json env (`APP_BASE` / `PROJECT_PATH`), or '' (→ no source
 * root) for a root-level app.
 */
function appSourceRoot(appJson: HerokuInputs['appJson']): string {
  if (!appJson) return '';
  for (const key of ['APP_BASE', 'PROJECT_PATH']) {
    const raw = envValue(appJson.env[key]);
    if (raw) return normalizeRoot(raw);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Node-id helpers — adapter-local natural keys.

const dynoId = (processType: string) => `dyno:${processType}`;
const addonId = (slug: string) => `addon:${rootSlug(slug)}`;

// ---------------------------------------------------------------------------
// Detection helpers.

const HEROKU_FILES = ['Procfile', 'app.json', 'heroku.yml'];

function detectHeroku(repoDir: string): boolean {
  return HEROKU_FILES.some((f) => existsSync(join(repoDir, f)));
}

// ---------------------------------------------------------------------------
// Pure graph builder.

export interface HerokuInputs {
  procfileEntries: Array<{ processType: string; command: string }>;
  appJson: { name?: string; addons: Array<{ slug: string; plan?: string }>; env: Record<string, unknown>; formation: Record<string, unknown> } | null;
  hasHerokuYml: boolean;
}

/**
 * Pure graph builder — takes pre-parsed Heroku config objects and emits an
 * InfraGraph. Separated from fs IO for unit-testing without a real repo dir.
 */
export function buildHerokuGraph(inputs: HerokuInputs, root: string): InfraGraph {
  const { procfileEntries, appJson } = inputs;

  const nodes = new Map<string, InfraNode>();
  const edges: InfraEdge[] = [];

  const addNode = (n: InfraNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  // ---- Dynos (one `worker` node per Procfile process type) ----------------
  // every dyno shares the app's single source root (the monorepo base
  // dir, or none for a root-level app).
  const srcRoot = appSourceRoot(appJson);
  for (const { processType, command } of procfileEntries) {
    addNode({
      id: dynoId(processType),
      label: `${processType} dyno`,
      kind: 'worker',
      provenance: 'declared',
      metadata: { processType, command },
      ...(srcRoot ? { sourceRoots: [srcRoot] } : {}),
    });
  }

  // ---- Addons (from app.json) -----------------------------------------------
  const addonMetas: Array<{ id: string; meta: AddonMeta; slug: string }> = [];
  if (appJson) {
    for (const { slug, plan } of appJson.addons) {
      if (!slug) continue;
      const meta = lookupAddon(slug);
      const id = addonId(slug);
      const node: InfraNode = {
        id,
        label: meta.label,
        kind: meta.kind,
        provenance: 'declared',
        metadata: { provider: 'heroku', slug: rootSlug(slug), ...(plan ? { plan } : {}) },
      };
      addNode(node);
      addonMetas.push({ id, meta, slug });
    }
  }

  // ---- Edges: each dyno → each addon, verb by addon kind -------------------
  // Only emit edges when we have dynos (Procfile present).
  // Edge verb follows the 8-verb taxonomy:
  //   datastore  → stores-in
  //   queue      → publishes  (can't distinguish producer/consumer from Procfile alone)
  //   external-api / other → calls
  if (procfileEntries.length > 0) {
    for (const { processType } of procfileEntries) {
      const srcId = dynoId(processType);
      for (const { id: targetId, meta } of addonMetas) {
        let kind: InfraEdge['kind'];
        if (meta.kind === 'datastore') {
          kind = 'stores-in';
        } else if (meta.kind === 'queue') {
          kind = 'publishes';
        } else {
          kind = 'calls';
        }
        edges.push({ source: srcId, target: targetId, kind });
      }
    }
  }

  return {
    root,
    adapter: 'heroku',
    nodes: [...nodes.values()],
    edges,
    classificationsNeeded: [], // all declared via static slug map
  };
}

// ---------------------------------------------------------------------------
// Adapter.

export const herokuAdapter: InfraAdapter = {
  name: 'heroku',

  async detect(repoDir: string): Promise<boolean> {
    return detectHeroku(repoDir);
  },

  async extract(repoDir: string): Promise<InfraGraph> {
    // -- Procfile --
    let procfileEntries: HerokuInputs['procfileEntries'] = [];
    const procfilePath = join(repoDir, 'Procfile');
    if (existsSync(procfilePath)) {
      try {
        procfileEntries = parseProcfile(readFileSync(procfilePath, 'utf8'));
      } catch (err) {
        console.warn(`  [heroku] skipping unparseable ${procfilePath}: ${(err as Error).message}`);
      }
    }

    // -- app.json --
    let appJson: HerokuInputs['appJson'] = null;
    const appJsonPath = join(repoDir, 'app.json');
    if (existsSync(appJsonPath)) {
      try {
        appJson = parseAppJson(readFileSync(appJsonPath, 'utf8'));
      } catch (err) {
        console.warn(`  [heroku] skipping unparseable ${appJsonPath}: ${(err as Error).message}`);
      }
    }

    // -- heroku.yml (presence check only — YAML parsing deferred) --
    const hasHerokuYml = existsSync(join(repoDir, 'heroku.yml'));
    if (hasHerokuYml) {
      console.warn('  [heroku] heroku.yml detected but YAML parsing is deferred in v0 — skipping content extraction');
    }

    return buildHerokuGraph({ procfileEntries, appJson, hasHerokuYml }, repoDir);
  },
};
