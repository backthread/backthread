// `narrow.ts` — what a locally-extracted graph is REDUCED TO before it may cross.
//
// ⚠ THESE TESTS EXIST BECAUSE THEIR ABSENCE WAS MEASURED, NOT BECAUSE THE FUNCTIONS
// LOOKED UNTESTED. Both narrowings had behavioural coverage where they used to live,
// and when they moved into this package the coverage stayed behind: an independent
// verifier mutated `narrowInfraForWire` to `return graph` — stop narrowing entirely,
// ship `root` and every `metadata` bag whole — and the suite stayed GREEN at 313 of
// 313. `narrowEnvForWire` returning its input unchanged survived too. The only thing
// naming either function was a source-text grep proving the client CALLS it, which
// proves a call site exists and never that the callee is right.
//
// ⚠ AND WHAT SURVIVES A MISSING NARROWING IS NOT ABSTRACT. Measured on a real repo
// before this reduction existed: `metadata.image` carried a Cloudflare ACCOUNT ID,
// elsewhere the same key holds a GCP project id and an ECR host containing an AWS
// account id, one adapter puts a literal credential REFERENCE in `metadata.ref`, and
// another held 50 table names read out of migration SQL. `root` is an absolute path
// inside the customer's runner. `EnvServiceCandidate.vars` holds the env var KEYS a
// service was inferred from — the names a customer's credentials are filed under.
//
// So every assertion below is paired with a NEGATIVE CONTROL: the fixture is first
// checked to actually CONTAIN the thing that must not cross. An absence assertion
// over a fixture that never had the field is a test that cannot fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MergedInfraGraph } from '@backthread/extractor';
import { narrowEnvForWire, narrowInfraForWire } from './narrow.js';

/** A graph carrying exactly the things measurement showed must not cross. */
function hostileGraph(): MergedInfraGraph {
  return {
    root: '/home/runner/work/customer-repo/customer-repo',
    nodes: [
      {
        id: 'cf:worker:api',
        label: 'api',
        kind: 'worker',
        provenance: 'declared',
        metadata: {
          type: 'cloudflare-worker',
          image: 'registry.cloudflare.com/a1b2c3d4e5f60718293a4b5c6d7e8f90/api:sha-abc',
          ref: '${{Postgres.DATABASE_URL}}',
          tables: ['users', 'accounts', 'sessions'],
        },
        sourceRoots: ['worker/src'],
      },
      {
        id: 'tf:db:primary',
        label: 'primary',
        kind: 'datastore',
        provenance: 'inferred',
        // No `type` key at all, and an empty sourceRoots — both must come out ABSENT
        // rather than as an empty bag, because an absent key and an empty one mean the
        // same thing and only one of them costs bytes on every node.
        metadata: { project: 'acme-prod-42', account: '0123456789012' },
        sourceRoots: [],
      },
    ],
    edges: [
      {
        source: 'cf:worker:api',
        target: 'tf:db:primary',
        kind: 'writes',
        metadata: { connectionString: 'postgres://user:pw@host/db' },
      },
    ],
    classificationsNeeded: [
      { provider: 'terraform/aws', resourceType: 'aws_lambda_function', forNodeId: 'tf:db:primary' },
    ],
  };
}

test('narrowInfraForWire drops `root` — an absolute path inside the customer runner', () => {
  const graph = hostileGraph();
  assert.equal(typeof graph.root, 'string', 'NEGATIVE CONTROL: the fixture must HAVE a root');
  assert.ok(graph.root.length > 0);

  const wire = narrowInfraForWire(graph);
  assert.equal((wire as unknown as Record<string, unknown>).root, undefined);
  // Asserted over the SERIALISED form as well, because the wire is JSON and a key
  // present-but-undefined and a key absent are the same thing to `typeof` and
  // different things to `JSON.stringify`.
  assert.doesNotMatch(JSON.stringify(wire), /home\/runner/);
});

test('narrowInfraForWire reduces node metadata to `type`, and to NOTHING when there is no type', () => {
  const graph = hostileGraph();
  // NEGATIVE CONTROLS — every one of these must be present to drop, or the
  // assertions below are satisfied by a fixture that never carried them.
  const raw = JSON.stringify(graph);
  assert.match(raw, /a1b2c3d4e5f60718293a4b5c6d7e8f90/, 'fixture must carry an account id');
  assert.match(raw, /acme-prod-42/, 'fixture must carry a project id');
  assert.match(raw, /\$\{\{Postgres\.DATABASE_URL\}\}/, 'fixture must carry a credential reference');
  assert.match(raw, /sessions/, 'fixture must carry table names');

  const wire = narrowInfraForWire(graph);
  const out = JSON.stringify(wire);
  assert.doesNotMatch(out, /a1b2c3d4e5f60718293a4b5c6d7e8f90/);
  assert.doesNotMatch(out, /acme-prod-42/);
  assert.doesNotMatch(out, /0123456789012/);
  assert.doesNotMatch(out, /Postgres\.DATABASE_URL/);
  assert.doesNotMatch(out, /sessions/);

  // The one key any consumer reads survives...
  assert.deepEqual(wire.nodes[0].metadata, { type: 'cloudflare-worker' });
  // ...and a node with no `type` gets NO metadata key at all, rather than `{}`.
  assert.equal('metadata' in wire.nodes[1], false);
});

test('narrowInfraForWire keeps the fields the renderer needs, and omits an EMPTY sourceRoots', () => {
  const wire = narrowInfraForWire(hostileGraph());
  assert.deepEqual(Object.keys(wire.nodes[0]).sort(), [
    'id',
    'kind',
    'label',
    'metadata',
    'provenance',
    'sourceRoots',
  ]);
  assert.deepEqual(wire.nodes[0].sourceRoots, ['worker/src']);
  // An empty array and an absent key mean the same thing; only one costs bytes.
  assert.equal('sourceRoots' in wire.nodes[1], false);
  assert.deepEqual(Object.keys(wire.nodes[1]).sort(), ['id', 'kind', 'label', 'provenance']);
});

test('narrowInfraForWire reduces an edge to its three endpoints and drops edge metadata', () => {
  const graph = hostileGraph();
  assert.ok(graph.edges[0].metadata, 'NEGATIVE CONTROL: the fixture edge must HAVE metadata');

  const wire = narrowInfraForWire(graph);
  assert.deepEqual(wire.edges, [
    { source: 'cf:worker:api', target: 'tf:db:primary', kind: 'writes' },
  ]);
  assert.doesNotMatch(JSON.stringify(wire.edges), /connectionString|postgres:\/\//);
});

test('narrowInfraForWire CARRIES classificationsNeeded — the server resolves them, so dropping them is a loss', () => {
  // The counterweight to every assertion above: narrowing that removed this would
  // leave the server unable to classify an open-ended IaC resource type at all, and
  // the node would render with a guessed kind instead of a resolved one. The
  // customer's CI has no model and no key; the reference is how the work moves to
  // the side that does.
  const wire = narrowInfraForWire(hostileGraph());
  assert.deepEqual(wire.classificationsNeeded, [
    { provider: 'terraform/aws', resourceType: 'aws_lambda_function', forNodeId: 'tf:db:primary' },
  ]);
});

test('narrowEnvForWire carries the service NAME and never the env var keys it was inferred from', () => {
  const candidates = [
    { service: 'stripe', vars: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
    { service: 'sendgrid', vars: ['SENDGRID_API_KEY'] },
  ];
  // NEGATIVE CONTROL: there must BE something to drop.
  assert.ok(candidates.some((c) => c.vars.length > 0));

  const wire = narrowEnvForWire(candidates);
  assert.deepEqual(wire, ['stripe', 'sendgrid']);
  const out = JSON.stringify(wire);
  assert.doesNotMatch(out, /SECRET/);
  assert.doesNotMatch(out, /_KEY/);
  assert.doesNotMatch(out, /vars/);
  // Every element is a bare string, so there is no object left to hide a field in.
  assert.ok(wire.every((s) => typeof s === 'string'));
});

test('narrowEnvForWire preserves order and multiplicity — it is a projection, not a filter', () => {
  // If it deduped or sorted, the wire list would stop matching what the clone path
  // produces, and the two paths would render different external-service sets for a
  // reason no hash diff could explain.
  const wire = narrowEnvForWire([
    { service: 'redis', vars: ['REDIS_URL'] },
    { service: 'aws', vars: ['AWS_ACCESS_KEY_ID'] },
    { service: 'redis', vars: ['REDIS_TLS_URL'] },
  ]);
  assert.deepEqual(wire, ['redis', 'aws', 'redis']);
});

test('narrowEnvForWire returns an empty list for an empty input, rather than throwing', () => {
  // `[]` is a legal MEASUREMENT — "I scanned for an example env file and there is
  // nothing to report" — and it is the common case. It must not be an error path.
  assert.deepEqual(narrowEnvForWire([]), []);
});
