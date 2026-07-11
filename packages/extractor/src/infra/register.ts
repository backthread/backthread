// builtin infra-adapter registration.
//
// Registration ORDER is the conflict-resolution priority for the merge step
// (registry.ts): the first-registered adapter wins a `declared`-vs-`declared`
// tie. The locked order is CF → Supabase → Terraform: a provider-specific
// config (wrangler.toml, supabase/config.toml) is more authoritative about its
// own resources than a generic Terraform `cloudflare_*` / `supabase_*` block,
// and Terraform is the universal fallback. / slot their adapters
// into this list in priority order.
//
// `registerInfraAdapter` is idempotent on name (replaces), so calling this more
// than once across a process is safe.

import { registerInfraAdapter } from './registry.js';
import { cloudflareAdapter } from './cloudflare/cloudflare.js';
import { supabaseAdapter } from './supabase/supabase.js';
import { dockerComposeAdapter } from './compose/compose.js';
import { netlifyAdapter } from './netlify/netlify.js';
import { firebaseAdapter } from './firebase/firebase.js';
import { convexAdapter } from './convex/convex.js';
import { vercelAdapter } from './vercel/vercel.js';
import { flyAdapter } from './fly/fly.js';
import { renderAdapter } from './render/render.js';
import { railwayAdapter } from './railway/railway.js';
import { herokuAdapter } from './heroku/heroku.js';
import { digitaloceanAdapter } from './digitalocean/digitalocean.js';
import { kamalAdapter } from './kamal/kamal.js';
import { sstAdapter } from './sst/sst.js';
import { pulumiAdapter } from './pulumi/pulumi.js';
import { opentofuAdapter } from './opentofu/opentofu.js';
import { awsAdapter } from './aws/aws.js';
import { gcpAdapter } from './gcp/gcp.js';
import { azureAdapter } from './azure/azure.js';
import { terraformAdapter } from './terraform/terraform.js';

export function registerBuiltinInfraAdapters(): void {
  registerInfraAdapter(cloudflareAdapter);
  registerInfraAdapter(supabaseAdapter);
  // docker-compose — a self-hosted container declaration; its id space
  // (`compose:service:*`) is disjoint from the cloud adapters, so order is
  // cosmetic, but it sits with the specific provider configs ahead of the
  // generic IaC fallbacks.
  registerInfraAdapter(dockerComposeAdapter);
  // Netlify before Vercel: netlify.toml is the explicit, stronger frontend-host
  // signal, so it's listed ahead of Vercel's bare `next.config.*` detection. (Their
  // id spaces are disjoint, so this is intent-documenting; the attribution win comes
  // from Netlify emitting sourceRoots where the Vercel next.config path doesn't.)
  registerInfraAdapter(netlifyAdapter);
  // Firebase — a BaaS like Supabase; disjoint id space (`firebase:*`), grouped
  // with the other provider-specific configs ahead of the generic IaC fallbacks.
  registerInfraAdapter(firebaseAdapter);
  // Convex — a reactive-TS BaaS like Supabase/Firebase; disjoint id
  // space (`convex:*`), grouped with the provider-specific configs ahead of the
  // generic IaC fallbacks. Source-based (functions ARE code), no image resolver.
  registerInfraAdapter(convexAdapter);
  registerInfraAdapter(vercelAdapter);
  registerInfraAdapter(flyAdapter);
  registerInfraAdapter(renderAdapter);
  registerInfraAdapter(railwayAdapter);
  registerInfraAdapter(herokuAdapter);
  // DigitalOcean App Platform — keyed off the `.do/` app spec (NOT bare app.yaml,
  // which GCP App Engine owns). Disjoint id space (`digitalocean:*`).
  registerInfraAdapter(digitaloceanAdapter);
  // Kamal — Docker-to-VPS deploy; self-hosted-container-shaped like
  // docker-compose. Keyed off config/deploy.yml (path-scoped); disjoint id space
  // (`kamal:*`), so order is cosmetic — no detect() overlap with other adapters.
  registerInfraAdapter(kamalAdapter);
  // SST v3 "Ion" — config-as-code IaC like Pulumi (ts-morph over
  // sst.config.ts); disjoint id space (`sst:*`). Triggers only on sst.config.*,
  // so no detect() double-fire with Pulumi (Pulumi.yaml) or Terraform (*.tf);
  // grouped with the code-IaC adapters ahead of the generic fallbacks.
  registerInfraAdapter(sstAdapter);
  registerInfraAdapter(pulumiAdapter);
  registerInfraAdapter(opentofuAdapter);
  registerInfraAdapter(awsAdapter);
  registerInfraAdapter(gcpAdapter);
  registerInfraAdapter(azureAdapter);
  // Terraform last — the universal fallback. A provider-specific config
  // (wrangler.toml, supabase/config.toml) is more authoritative about its own
  // resources than a generic `cloudflare_*` / `supabase_*` Terraform block.
  registerInfraAdapter(terraformAdapter);
}
