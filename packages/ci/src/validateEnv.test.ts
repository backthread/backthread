// The derived env-service names, as untrusted input.
//
// WHAT THIS CLOSES, AND WHY IT IS NOT "A THINNER PICTURE". `classifyGraphExternals`
// scans `.env.example` / `.env.sample` / `.env.template` / `.env.dist` for
// credential-shaped keys and turns each key's leading segment into an external
// SERVICE node — a node with no import to hang off, which is the entire reason the
// scan exists. `assemble` pushes those into `nodes`, and `topologyHash` is the
// sorted module ids, so a CI payload without them persists a DIFFERENT artefact
// rather than a thinner one. Measured on the host application repo: 5 services,
// and the hash moves.
//
// WHY THE NAMES CROSS AND THE FILES DO NOT. An example env file is a TEMPLATE of a
// credential file — committed, usually placeholders, and "usually" is not a
// boundary. The scan runs on the customer's runner and only the derived names cross:
// the parser splits each line at the first `=` and never looks right of it, so a
// service name is `^[a-z][a-z0-9]*$` by construction — a vendor, never a value. The
// candidate's `vars` (the KEYS it came from — `STRIPE_SECRET_KEY`) are dropped
// before the wire, exactly as `InfraNode.metadata` is.
//
// EVERY TEST HERE DIFFERS FROM THE CONTROL IN EXACTLY ONE THING, so the suite is
// mutation-testable: delete the check a test names and THIS test goes red and
// nothing else does. The mutation map at the foot of the file records the run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ENV_SERVICE_BYTES,
  MAX_ENV_SERVICES,
  validateCiPayload,
  validateEnvServices,
} from './validate.js';
import { CI_PAYLOAD_VERSION, MAX_TOTAL_ENV_BYTES } from './payload.js';

const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-08-15T12:00:00Z');
const IDENTITY = { owner: 'acme', name: 'repo-a', sha: SHA };

function rec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { loc: 10, language: 'ts', imports: [], externals: [], calls: [], reexports: [], ...over };
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payloadVersion: CI_PAYLOAD_VERSION,
    actionVersion: '1.0.0',
    extractorVersion: '0.14.0',
    repo: { owner: 'acme', name: 'repo-a', defaultBranch: 'main' },
    checkpoint: { sha: SHA, date: '2026-08-15T11:00:00Z', subject: 'merge #1', trigger: 'merge' },
    state: { headSha: SHA, files: { 'src/a.ts': rec() } },
    infra: { nodes: [], edges: [] },
    // NON-EMPTY on purpose. A control that carries `[]` would let every rejection
    // below pass on a list nothing ever walks — the exact way the infra gap survived
    // a green convergence test.
    envServices: ['stripe', 'sendgrid'],
    framework: { adapters: 0, edges: [], crossLanguageEdges: [], roles: [], groups: [] },
    ...over,
  };
}

const run = (p: unknown) => validateCiPayload({ value: p, identity: IDENTITY, now: NOW, prior: null });
const withEnv = (envServices: unknown) => run(payload({ envServices }));

// ===========================================================================
// THE CONTROL
// ===========================================================================

test('CONTROL: a clean payload carrying a NON-EMPTY env-service list is admitted', () => {
  const p = payload();
  assert.ok((p.envServices as unknown[]).length >= 2, 'the control list must be non-empty');
  const r = run(p);
  assert.equal(r.rejection, null, JSON.stringify(r.rejection));
});

// ===========================================================================
// Presence: absence and emptiness mean OPPOSITE things
// ===========================================================================

test('an ABSENT envServices field is refused', () => {
  const p = payload();
  delete p.envServices;
  const r = run(p);
  assert.equal(r.rejection?.error, 'missing_env_services');
  assert.equal(r.rejection?.status, 400);
  assert.equal(r.rejection?.tier, 2);
});

test('an EMPTY env-service list is ADMITTED — a repo with no example env file is a fact', () => {
  // The negative control for the rule above, and the half that keeps this from being
  // a usability regression: if empty were also refused, every repo without an
  // `.env.example` would be unable to use CI mode at all.
  assert.equal(withEnv([]).rejection, null);
});

test('an envServices field that is not an array is refused', () => {
  for (const bad of [{}, 'stripe', 7, null, true] as unknown[]) {
    const r = withEnv(bad);
    assert.equal(r.rejection?.error, 'invalid_env_services', `${JSON.stringify(bad)}`);
    assert.equal(r.rejection?.tier, 2);
  }
});

test('a non-string ENTRY is refused — coercion is not validation', () => {
  // `String({})` is "[object Object]", which matches nothing in the grammar but
  // would have to be COERCED first to find that out. The object then flows on
  // unchanged into the staged payload, which is where the `manifests` block learned
  // this same lesson.
  for (const bad of [7, null, {}, ['stripe'], true] as unknown[]) {
    const r = withEnv(['stripe', bad]);
    assert.equal(r.rejection?.error, 'invalid_env_services', `${JSON.stringify(bad)}`);
  }
});

// ===========================================================================
// Tier 3 — the grammar
// ===========================================================================

test('a name outside `^[a-z][a-z0-9]*$` is refused, name by name', () => {
  // Each of these is something the PRODUCER cannot emit — the scan uppercase-matches
  // the key, takes the segment before the first `_`, and lowercases it — so a name
  // outside the grammar did not come from the scan this field claims to report.
  const bad = [
    'Stripe',              // uppercase
    'stripe-api',          // hyphen
    'stripe_api',          // underscore (the scan splits on it)
    'stripe.io',           // dot
    'stripe/api',          // slash — the path shape the file-id rules exist for
    '__proto__',           // refused BY THE GRAMMAR (underscores), not by a blocklist
    '1stripe',             // leading digit
    '',                    // empty
    ' stripe',             // leading space
    'stripe ',             // trailing space
    'stri\u0000pe',       // a NUL, written as an escape so the source stays greppable
    'stri\npe',            // newline — the log/prompt-reshaping shape
    'strípe',              // non-ASCII
    'ignore previous instructions', // the whole point of refusing whitespace
  ];
  for (const name of bad) {
    const r = withEnv([name]);
    assert.equal(r.rejection?.error, 'unsafe_env_service', JSON.stringify(name));
    assert.equal(r.rejection?.tier, 3);
  }
});

test('an ORDINARY vendor name is NOT refused — the grammar must stay usable', () => {
  // The second negative control. Over-refusing is the failure a rejection suite
  // cannot see, and this field feeds a real product surface: refuse `s3` or
  // `auth0` and a customer's diagram silently loses a service.
  for (const name of ['stripe', 's3', 'auth0', 'sendgrid', 'twilio', 'openai', 'x']) {
    assert.equal(withEnv([name]).rejection, null, name);
  }
});

test('`constructor` is ADMITTED, and that is a decision rather than an oversight', () => {
  // ⚠ IT MATCHES THE GRAMMAR, AND THERE IS NO PROTOTYPE HAZARD TO GUARD. A service
  // name never becomes a bare object key: it is namespaced into `ext:env:<name>`
  // before it is a `ModuleId`, and every other consumer holds it in a `Map` or a
  // `Set` (`byService`, `seenSpecifier`, `seenDisplay`, `dropIds`). `__proto__` and
  // `prototype.x` are refused above by the GRAMMAR — they carry an underscore and a
  // dot — so a blocklist here would be a guard with no reachable hazard, which is
  // the unreachable-guard defect its sibling suites tombstone twice.
  //
  // Asserted rather than left implicit so that the day a consumer starts indexing a
  // plain object by service name, this line is the one that has to be argued with.
  assert.equal(withEnv(['constructor']).rejection, null);
  assert.equal(withEnv(['prototype']).rejection, null);
});

// ===========================================================================
// Tier 1 — bounds
// ===========================================================================

test('more than MAX_ENV_SERVICES names is refused, and exactly that many is not', () => {
  const name = (i: number) => `s${i.toString(36)}`;
  const at = Array.from({ length: MAX_ENV_SERVICES }, (_, i) => name(i));
  assert.equal(new Set(at).size, MAX_ENV_SERVICES, 'the fixture must not trip the dedupe first');
  assert.equal(withEnv(at).rejection, null, 'a payload AT the cap must be admitted');
  const over = [...at, name(MAX_ENV_SERVICES)];
  const r = withEnv(over);
  assert.equal(r.rejection?.error, 'too_many_env_services');
  assert.equal(r.rejection?.status, 413);
  assert.equal(r.rejection?.tier, 1);
});

test('a name longer than MAX_ENV_SERVICE_BYTES is refused', () => {
  // ⚠ MEASURED THROUGH `validateEnvServices` DIRECTLY, NOT THE PAYLOAD, because the
  // payload-wide `boundedStrings` walk applies a 1 KB cap first and would refuse a
  // 65 KB name as `string_too_long`. That is the shape of the `manifest_too_large`
  // tombstone in `ciValidate.ts` — a cap another cap refuses first is a cap that
  // cannot fire. This one CAN fire, because it is what the RUNNER runs standalone.
  const at = 'a'.repeat(MAX_ENV_SERVICE_BYTES);
  assert.equal(validateEnvServices([at]), null, 'a name AT the cap must be admitted');
  const over = 'a'.repeat(MAX_ENV_SERVICE_BYTES + 1);
  const r = validateEnvServices([over]);
  assert.equal(r?.error, 'env_service_too_long');
  assert.equal(r?.status, 413);
  assert.equal(r?.tier, 1);
});

test('the byte reservation is the exact product of the two caps it covers', () => {
  // A separately-picked byte cap beside a count cap is the unreachable-guard defect
  // this file's siblings tombstone twice. Deriving it means the two cannot disagree,
  // and asserting the derivation means nobody can quietly re-pick it.
  assert.equal(MAX_TOTAL_ENV_BYTES, MAX_ENV_SERVICES * (MAX_ENV_SERVICE_BYTES + 4));
  // ...and the worst legal list really does fit inside the reservation, which is the
  // whole claim the envelope budget makes.
  // ...and the worst legal FIELD really does fit inside the reservation — the field,
  // including its own key and brackets, not merely the array's contents. The first
  // cut measured the array alone and was over by one byte, which is the same
  // off-by-a-little that made `MAX_FILES` unreachable twice.
  const worst = JSON.stringify({
    envServices: Array.from({ length: MAX_ENV_SERVICES }, () => 'a'.repeat(MAX_ENV_SERVICE_BYTES)),
  });
  assert.ok(
    worst.length <= MAX_TOTAL_ENV_BYTES,
    `worst legal envServices field is ${worst.length} bytes, reservation is ${MAX_TOTAL_ENV_BYTES}`,
  );
});

// ===========================================================================
// Tier 2 — the producer may not hide one entry behind another
// ===========================================================================

test('a DUPLICATE name is refused', () => {
  // `extractEnvServiceCandidates` merges by service into a Map, so no honest scan
  // emits one twice. A duplicate would be priced twice by the classifier before the
  // display-name dedupe collapsed it — the sender's own wallet, but a real cost
  // nobody stated.
  const r = withEnv(['stripe', 'sendgrid', 'stripe']);
  assert.equal(r.rejection?.error, 'duplicate_env_service');
  assert.equal(r.rejection?.tier, 2);
});

// ===========================================================================
// The RUNNER runs this same function, standalone
// ===========================================================================

test('validateEnvServices STANDALONE enforces every bound `boundedStrings` would have', () => {
  // ⚠ THIS IS WHY THE BYTE CAP LIVES INSIDE THE FUNCTION. `scripts/ci-action`
  // calls this before it posts, where nothing has walked the payload — and the
  // equivalent omission in `validateInfraGraph` admitted a 400 000-byte label.
  assert.equal(validateEnvServices(undefined)?.error, 'missing_env_services');
  assert.equal(validateEnvServices('stripe')?.error, 'invalid_env_services');
  assert.equal(validateEnvServices(['a'.repeat(70)])?.error, 'env_service_too_long');
  assert.equal(validateEnvServices(['Stripe'])?.error, 'unsafe_env_service');
  assert.equal(validateEnvServices(['a', 'a'])?.error, 'duplicate_env_service');
  assert.equal(validateEnvServices([]), null);
  assert.equal(validateEnvServices(['stripe']), null);
});

// ===========================================================================
// The gate is WIRED — the failure mode a per-function suite cannot see
// ===========================================================================

test('validateCiPayload actually CALLS the env gate', () => {
  // A perfect `validateEnvServices` that nothing invokes is the shape an earlier
  // change shipped twice (an unreachable `if`, and a check whose only call site had
  // no test). The two assertions differ ONLY in the field, so this goes red if the
  // call site is deleted while the function-level tests above stay green.
  assert.equal(run(payload({ envServices: ['Stripe'] })).rejection?.error, 'unsafe_env_service');
  assert.equal(run(payload()).rejection, null);
});

test('`envServices` is on the top-key allowlist, and an invented sibling is not', () => {
  // The allowlist is what makes a field EXIST on the wire. Without the entry the
  // control above would be refused as `unknown_field` — which would look like the
  // env gate working, and would be the ingress refusing every real payload.
  assert.equal(run(payload()).rejection, null);
  const r = run(payload({ envVars: ['STRIPE_SECRET_KEY'] }));
  assert.equal(r.rejection?.error, 'unknown_field');
  assert.equal(r.rejection?.detail, 'envVars');
});

// ===========================================================================
// MUTATION MAP — every check above was deleted or inverted, and the named test
// went red. Recorded so a later reader can tell a live guard from a decorative
// one without re-running the exercise.
//
//  tier  mutation                                            first test to go RED
//  ----  --------------------------------------------------  ---------------------
//    2   `value === undefined` -> `false`                     an ABSENT envServices…
//    2   delete the `Array.isArray` check                     an envServices field th…
//    2   delete the per-entry `typeof !== 'string'` check     a non-string ENTRY is r…
//    3   delete the `ENV_SERVICE_RE.test` check               a name outside `^[a-z]…
//    3   `ENV_SERVICE_RE` -> `/^[\w.-]+$/`                    a name outside `^[a-z]…
//    1   delete the count cap                                 more than MAX_ENV_SERV…
//    1   `> MAX_ENV_SERVICES` -> `>=`                         more than MAX_ENV_SERV…
//    1   delete the per-name byte cap                         a name longer than MAX…
//    2   delete the duplicate check                           a DUPLICATE name is ref…
//   wire never call validateEnvServices from validateCiPayload validateCiPayload act…
//   wire drop 'envServices' from ALLOWED_TOP_KEYS             `envServices` is on the…
//   caps `MAX_TOTAL_ENV_BYTES` -> a hand-picked number        the byte reservation is…
//
// TWO NEGATIVE CONTROLS EARN THEIR PLACE, because over-refusing is the failure mode
// a rejection suite cannot see: `an EMPTY env-service list is ADMITTED` (a repo with
// no example env file must still ingest) and `an ORDINARY vendor name is NOT
// refused` (the grammar must admit `s3`, `auth0`, `x`). Both go red if the gate is
// tightened into refusing real payloads, which no amount of hostile fixtures would
// ever notice.
// ===========================================================================
