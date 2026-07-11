// Stage A — infra-relevance gate tests (derived from the adapters'
// detect()/file matchers; see relevance.ts for the derivation table).

import { describe, it, expect } from '../testkit.js';
import {
  isInfraRelevantPath,
  diffTouchesInfra,
  diffTouchesInfraWithSources,
} from './relevance.js';
import { supabaseAdapter } from './supabase/supabase.js';
import { vercelAdapter, vercelScansSourcePath } from './vercel/vercel.js';
import { cloudflareAdapter } from './cloudflare/cloudflare.js';
import { terraformAdapter } from './terraform/terraform.js';

describe('isInfraRelevantPath', () => {
  it('matches each adapter family', () => {
    for (const p of [
      'wrangler.toml',
      'worker/wrangler.jsonc',
      'wrangler.json',
      'supabase/config.toml',
      'supabase/migrations/20260601_init.sql',
      'infra/main.tf',
      'envs/prod/vars.tfvars',
      'stack.tofu',
      'stack.tofu.json',
      'vercel.json',
      'netlify.toml', // 
      'firebase.json', // 
      '.firebaserc',
      'convex.json', // Convex config trigger

      'next.config.mjs',
      'fly.toml',
      'render.yaml',
      'render.yml',
      'railway.json',
      'railway.toml',
      'nixpacks.toml',
      'Procfile',
      'app.json',
      'heroku.yml',
      'Pulumi.yaml',
      'sst.config.ts', // SST v3 Ion config
      'sst.config.mjs',
      'serverless.yml',
      'samconfig.toml',
      'template.yaml',
      'cdk.json',
      'app.yaml',
      '.do/app.yaml', // DO App Platform spec (path-scoped)
      '.do/deploy.template.yaml',
      'config/deploy.yml', // Kamal config (path-scoped)
      'config/deploy.production.yml',
      'cloudbuild.yaml',
      'api/function.json',
      'host.json',
      'infra/main.bicep',
      'Dockerfile',
      'Dockerfile.worker',
      'docker-compose.yml',
      'docker-compose.prod.yaml',
      'compose.yaml', // Compose Spec default filename
      'compose.yml',
      'compose.override.yaml',
      '.dockerignore',
      'vite.config.ts', // root Vite SPA → CF Pages unit
      'vite.config.mjs',
    ]) {
      expect(isInfraRelevantPath(p), p).toBe(true);
    }
  });

  it('does NOT fire on application source / generic yaml (deliberately narrower than gcp/azure scans)', () => {
    for (const p of [
      'src/app.ts',
      'src/worker.ts',
      '.github/workflows/ci.yml',
      '.github/workflows/deploy.yml', // a CI deploy.yml is NOT a Kamal config (path-scoped to config/)
      'locales/en.yaml',
      'README.md',
      'package.json', // an invalidator, not an infra signal
      'src/terraform-docs.md',
      'supabase.ts', // a source file, not the supabase/ dir
      'composer.yaml', // must NOT match the compose pattern (PHP composer, not Compose)
    ]) {
      expect(isInfraRelevantPath(p), p).toBe(false);
    }
  });
});

describe('diffTouchesInfra', () => {
  it('true iff any path is infra-relevant', () => {
    expect(diffTouchesInfra(['src/a.ts', 'wrangler.toml'])).toBe(true);
    expect(diffTouchesInfra(['src/a.ts', 'docs/x.md'])).toBe(false);
    expect(diffTouchesInfra([])).toBe(false);
  });
});

// the source-aware carry/re-extract gate. The carry invariant
// ("infra adapters read ONLY config/IaC") is FALSE for source-grep adapters
// (Supabase/Vercel), so a diff touching their scanned SOURCE must re-extract.
describe('diffTouchesInfraWithSources', () => {
  const supabaseScans = (p: string) => supabaseAdapter.scansSourcePath!(p);

  it('with NO source scanners, collapses to diffTouchesInfra (config-only carry preserved)', () => {
    // A src-only change on a config-only stack does NOT force a re-extract.
    expect(diffTouchesInfraWithSources(['src/auth/login.ts'], [])).toBe(false);
    expect(diffTouchesInfraWithSources(['src/auth/login.ts'])).toBe(false);
    // …but a config path still does.
    expect(diffTouchesInfraWithSources(['wrangler.toml'], [])).toBe(true);
  });

  it('with the Supabase scanner active, a src-only `.from(...)`-bearing file forces re-extract', () => {
    // The dogfood case: example-app has no supabase/config.toml, so a new
    // `supabase.from(...)` lands in plain src/** and the config-only gate would
    // miss it. With the source scanner, it is correctly infra-relevant.
    expect(
      diffTouchesInfraWithSources(['src/lib/db.ts'], [supabaseScans]),
    ).toBe(true);
    expect(
      diffTouchesInfraWithSources(['components/Page.tsx'], [supabaseScans]),
    ).toBe(true);
    // A non-source file the scanner doesn't read still doesn't fire (unless it
    // is config — covered by diffTouchesInfra).
    expect(diffTouchesInfraWithSources(['README.md'], [supabaseScans])).toBe(false);
    expect(diffTouchesInfraWithSources(['docs/x.md'], [supabaseScans])).toBe(false);
  });

  it('with the Vercel scanner active, route/api/middleware source forces re-extract', () => {
    for (const p of [
      'app/api/users/route.ts',
      'src/app/checkout/route.tsx',
      'pages/api/hello.ts',
      'src/pages/api/nested/x.js',
      'middleware.ts',
      'src/middleware.js',
    ]) {
      expect(diffTouchesInfraWithSources([p], [vercelScansSourcePath]), p).toBe(true);
    }
    // A plain src file Vercel does NOT read (not a route/api/middleware) does
    // not fire the Vercel scanner.
    expect(
      diffTouchesInfraWithSources(['src/lib/util.ts'], [vercelScansSourcePath]),
    ).toBe(false);
  });

  it('config path always fires regardless of scanners', () => {
    expect(diffTouchesInfraWithSources(['supabase/migrations/1.sql'], [])).toBe(true);
    expect(diffTouchesInfraWithSources(['vercel.json'], [vercelScansSourcePath])).toBe(true);
  });
});

describe('which adapters declare scansSourcePath', () => {
  it('source-grep adapters (Supabase, Vercel) declare it', () => {
    expect(typeof supabaseAdapter.scansSourcePath).toBe('function');
    expect(typeof vercelAdapter.scansSourcePath).toBe('function');
  });

  it('config-only adapters (Cloudflare, Terraform) do NOT — their carry stays free', () => {
    expect(cloudflareAdapter.scansSourcePath).toBeUndefined();
    expect(terraformAdapter.scansSourcePath).toBeUndefined();
  });
});
