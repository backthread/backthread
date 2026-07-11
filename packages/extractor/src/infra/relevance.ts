// Stage A — infra-relevance gate for diff-driven ingestion.
//
// Decides whether a checkpoint's diff could change the INFRA topology: only
// then is an infra re-extraction warranted; otherwise the previous
// checkpoint's infra graph is reused.
//
// TWO classes of trigger ( fix):
//   1. CONFIG/IaC paths — `diffTouchesInfra` below. Every adapter reads these;
//      a config-DECLARED adapter (Cloudflare, Terraform, Fly, …) reads ONLY
//      these, so a checkpoint that touches none can safely carry that adapter's
//      graph.
//   2. SOURCE paths a source-grep adapter reads — `diffTouchesInfraWithSources`.
//      This is the carry-invariant fix: it is FALSE that "infra adapters read
//      only config/IaC." The Supabase adapter greps app `.ts/.tsx/.js/…` for
//      `.from(`/`.auth`/`.storage`/`.realtime` (→ app→Postgres edges + the
//      Auth/Storage/Realtime nodes), and the Vercel adapter reads
//      `app/**/route.ts`, `pages/api/**`, `middleware.ts`. A `supabase.from(...)`
//      added in plain `src/**` changes the infra graph, so it MUST force a
//      re-extract — otherwise the carried graph silently drops the new
//      node/edge until the next full re-seed. This is acute on example-app,
//      which has NO supabase/config.toml: its WHOLE Supabase topology is
//      source-grep-derived, exactly the signal `diffTouchesInfra` alone misses.
//      The source globs are NOT hard-coded here — they come from the active
//      adapters' own `scansSourcePath` predicates (registry.activeSourceScanners)
//      so the gate can't drift from what the adapters actually read.
//
// The CONFIG pattern list is DERIVED from the registered adapters' detect()/file
// matchers (scripts/ingest/infra/*):
//   cloudflare → wrangler.toml/jsonc/json            supabase → supabase/**
//   terraform  → *.tf, *.tfvars                      opentofu → *.tofu(.json), tofu.tfvars
//   vercel     → vercel.json, next.config.*          fly      → fly.toml
//   netlify    → netlify.toml         firebase → firebase.json, .firebaserc
//   convex     → convex.json (; convex/** source via scansSourcePath)
//   render     → render.yaml/yml                     railway  → railway.json/toml, nixpacks.toml, Procfile
//   heroku     → Procfile, app.json, heroku.yml      pulumi   → Pulumi.yaml
//   sst        → sst.config.ts/.mjs/.js
//   aws        → *.template.json, serverless.yml/yaml, samconfig.toml, template.yaml/yml, cdk.json
//   gcp        → app.yaml, cloudbuild.yaml           azure    → *.bicep, function.json, host.json
//   digitalocean → .do/*.y(a)ml app spec (path-scoped, NOT bare app.yaml)
//   kamal      → config/deploy(.<env>)?.y(a)ml (path-scoped, NOT bare deploy.yml)
//   + generic container signals: Dockerfile*, docker-compose*/compose* (.ya?ml), .dockerignore
//     (the docker-compose adapter — reads these compose files)
//   + root Vite SPA signal: vite.config.* — Cloudflare now reads it (+
//     index.html) to emit the Pages frontend unit + its `src/**` source root. Only
//     vite.config is gated (index.html is a noisy basename; a SPA appearing always
//     lands a vite.config, so this still catches it).
//
// DELIBERATELY NARROWER than the broadest adapters (gcp/azure scan every
// *.yaml): a "rerun infra" false-negative only delays an infra-topology update
// to the next full extract, while matching every yaml would fire the gate on
// CI workflows and i18n files constantly, making it useless. Conservative
// where it's cheap (well-known names), not where it's noisy.
//
// NOTE: the HOSTED container pipeline now DOES run infra extraction
// (container.ts → extractCheckpointInfra). This gate is the per-checkpoint
// carry/re-extract decision + observability counter for that walk.

const INFRA_BASENAME_RE = new RegExp(
  '^(' +
    [
      'wrangler\\.(toml|jsonc|json)',
      'netlify\\.toml', // 
      'firebase\\.json', // 
      '\\.firebaserc', // 
      'convex\\.json', // Convex config (functions-dir override); the
                       // convex/** source signal is covered by scansSourcePath
      'vercel\\.json',
      'next\\.config\\.[^/]+',
      'fly\\.toml',
      'render\\.ya?ml',
      'railway\\.(json|toml)',
      'nixpacks\\.toml',
      'Procfile',
      'app\\.json',
      'heroku\\.yml',
      'Pulumi\\.ya?ml',
      'sst\\.config\\.[^/]+', // SST v3 Ion config (sst.config.ts/.mjs/.js)
      'serverless\\.ya?ml',
      'samconfig\\.toml',
      'template\\.ya?ml',
      'cdk\\.json',
      'app\\.yaml',
      'cloudbuild\\.ya?ml',
      'function\\.json',
      'host\\.json',
      'tofu\\.tfvars',
      'Dockerfile[^/]*',
      'docker-compose[^/]*\\.ya?ml',
      'compose(\\.[^/]+)?\\.ya?ml', // Compose Spec default filename (compose.yaml / compose.prod.yml)
      '\\.dockerignore',
      'vite\\.config\\.[^/]+',
    ].join('|') +
    ')$',
);

const INFRA_EXTENSION_RE = /\.(tf|tf\.json|tfvars|tofu|tofu\.json|bicep)$/;

/** A DO App Platform spec under `.do/` — path-scoped, NOT bare app.yaml. */
const DO_SPEC_RE = /(^|\/)\.do\/[^/]+\.ya?ml$/;

/** A Kamal config — path-scoped `config/deploy(.<env>)?.y(a)ml`, NOT a
 * bare `deploy.yml` basename (CI workflows use that). */
const KAMAL_SPEC_RE = /(^|\/)config\/deploy(\.[A-Za-z0-9_-]+)?\.ya?ml$/;

/** Is this repo-relative path one an infra adapter would read? */
export function isInfraRelevantPath(path: string): boolean {
  if (path === 'supabase' || path.startsWith('supabase/')) return true;
  if (DO_SPEC_RE.test(path)) return true;
  if (KAMAL_SPEC_RE.test(path)) return true;
  if (INFRA_EXTENSION_RE.test(path)) return true;
  const base = path.split('/').pop() ?? path;
  return INFRA_BASENAME_RE.test(base);
}

/** Do any of a diff's paths touch infra-relevant CONFIG/IaC files? */
export function diffTouchesInfra(paths: readonly string[]): boolean {
  return paths.some(isInfraRelevantPath);
}

/**
 * the source-aware carry/re-extract decision for the hosted walk.
 *
 * True iff the diff touches a CONFIG/IaC infra path (diffTouchesInfra) OR a
 * SOURCE path that one of the ACTIVE source-grep adapters reads. `sourceScanners`
 * is the list of `scansSourcePath` predicates for the adapters whose detect()
 * is positive on this repo (registry.activeSourceScanners) — pass an empty list
 * (or omit) for a repo with no source-grep adapter, and this collapses to
 * `diffTouchesInfra`, preserving the carry optimization for config-only stacks.
 */
export function diffTouchesInfraWithSources(
  paths: readonly string[],
  sourceScanners: ReadonlyArray<(path: string) => boolean> = [],
): boolean {
  if (diffTouchesInfra(paths)) return true;
  if (sourceScanners.length === 0) return false;
  return paths.some((p) => sourceScanners.some((scans) => scans(p)));
}
