// DQ.4 — env-var heuristic extractor tests. Pure (no DB / network):
// only the deterministic regex stage is exercised; classifyEnvVarPatterns is
// the LLM stage and is covered by the dogfood, not here.

import { test, expect } from './testkit.js';
import { ENV_FILES, mergeEnvServiceCandidates, parseEnvServiceCandidates } from './envVars.js';

test('extracts service prefixes from credential-shaped keys', () => {
  const content = [
    'STRIPE_SECRET_KEY=sk_test_123',
    'SENDGRID_API_KEY=SG.x',
    'ANTHROPIC_API_KEY=sk-ant',
    'SUPABASE_SECRET_KEY=service-role',
    '# a comment line',
    '',
    'DATABASE_URL=postgres://localhost/db', // URL is not a credential suffix
    'JWT_SECRET=shh', // generic prefix
    'SESSION_SECRET=shh', // generic prefix
    'PORT=3000', // not credential-shaped
    'VITE_SUPABASE_URL=https://x.supabase.co', // generic prefix + not a secret
  ].join('\n');
  const got = parseEnvServiceCandidates(content).map((c) => c.service);
  expect(got).toEqual(['anthropic', 'sendgrid', 'stripe', 'supabase']);
});

test('ignores generic prefixes and non-secret keys', () => {
  const content = [
    'API_KEY=x',
    'AUTH_TOKEN=y',
    'NODE_ENV=production',
    'LOG_LEVEL=info',
    'ADMIN_SECRET=z',
  ].join('\n');
  expect(parseEnvServiceCandidates(content)).toEqual([]);
});

test('groups multiple credential vars under one service', () => {
  const content = ['GITHUB_APP_PRIVATE_KEY=x', 'GITHUB_API_TOKEN=y'].join('\n');
  const got = parseEnvServiceCandidates(content);
  expect(got).toHaveLength(1);
  expect(got[0].service).toBe('github');
  expect(got[0].vars).toEqual(['GITHUB_API_TOKEN', 'GITHUB_APP_PRIVATE_KEY']);
});

test('handles keys with no value (bare names)', () => {
  expect(parseEnvServiceCandidates('TWILIO_AUTH_TOKEN').map((c) => c.service)).toEqual(['twilio']);
});

// ---------------------------------------------------------------------------
// The merge, shared with the CI-Action runner
// ---------------------------------------------------------------------------

test('merges several bodies into one sorted, deduped candidate list', () => {
  // The CI runner cannot call `extractEnvServiceCandidates` — that stats the working
  // directory, and on a runner the working directory is not a git clone, so an
  // untracked `.env.example` would produce services the clone path can never see.
  // It selects the tracked files itself and calls THIS, so the merge has to be the
  // same one, and order-independent, or the two paths disagree.
  const a = 'STRIPE_SECRET_KEY=\nSENDGRID_API_KEY=\n';
  const b = 'STRIPE_API_TOKEN=\nTWILIO_AUTH_TOKEN=\n';
  const forward = mergeEnvServiceCandidates([a, b]);
  const backward = mergeEnvServiceCandidates([b, a]);
  expect(forward.map((c) => c.service)).toEqual(['sendgrid', 'stripe', 'twilio']);
  expect(backward).toEqual(forward);
  // ...and the provenance of a service seen in two files is the UNION, sorted.
  expect(forward.find((c) => c.service === 'stripe')?.vars).toEqual([
    'STRIPE_API_TOKEN',
    'STRIPE_SECRET_KEY',
  ]);
});

test('merging nothing is empty, not a throw — a repo with no example env file', () => {
  expect(mergeEnvServiceCandidates([])).toEqual([]);
});

test('ENV_FILES is exported, so the runner selects the SAME four basenames', () => {
  // A second list on the runner is a basename this one can gain and that one cannot,
  // which is a service the clone path sees and the CI path does not — the exact
  // divergence this export exists to close, arriving through a transcribed constant.
  expect([...ENV_FILES].sort()).toEqual([
    '.env.dist',
    '.env.example',
    '.env.sample',
    '.env.template',
  ]);
});
