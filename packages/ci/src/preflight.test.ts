// The preflight REFUSES — asserted by calling it, not by reading the source it lives in.
//
// ⚠ EVERY TEST HERE REPLACES A SOURCE-TEXT GUARD THAT COULD NOT FAIL. These four checks
// used to sit inline in `action.ts`, which runs `main()` on import, so nothing could
// execute them and what stood in for coverage was a search of that file for the shape
// the code was expected to have. An independent verifier measured the gap: rewriting the
// payload gate's condition to `if (rejection && rejection.error === '__never_matches__')`
// — compute the refusal, then upload anyway — passed `tsc` and all 325 tests, as did
// `if (false && rejection)`. The guard proved the call was present and ordered. It could
// not prove the answer was acted on.
//
// So the deciding moved into a module that can simply be called, and these are the tests
// that could not previously exist. The source guard in `action.test.ts` stays, narrowed
// to the one thing text is right for: that `action.ts` still calls this at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MergedInfraGraph, RawFrameworkContributions } from '@backthread/extractor';
import type { CiSnapshotPayload } from './payload.js';
import { CI_PAYLOAD_VERSION, MAX_ENV_SERVICES } from './payload.js';
import {
  assertPayloadIsAcceptable,
  payloadCounts,
  preparedEnvServices,
  preparedFramework,
  preparedInfra,
} from './preflight.js';

const SHA = 'a'.repeat(40);
const IDENTITY = { owner: 'acme', name: 'app', sha: SHA };

function okInfra(): MergedInfraGraph {
  return {
    root: '/home/runner/work/app/app',
    nodes: [{ id: 'cf:worker:api', label: 'api', kind: 'worker', provenance: 'declared' }],
    edges: [],
    classificationsNeeded: [],
  };
}

function okPayload(over: Partial<CiSnapshotPayload> = {}): CiSnapshotPayload {
  return {
    payloadVersion: CI_PAYLOAD_VERSION,
    actionVersion: '0.1.0',
    extractorVersion: '0.15.0',
    repo: { owner: 'acme', name: 'app', defaultBranch: 'main' },
    checkpoint: { sha: SHA, date: new Date().toISOString(), subject: 'a commit', trigger: 'push' },
    state: {
      headSha: SHA,
      files: {
        'src/a.ts': { language: 'ts', loc: 10, imports: [], calls: [], externals: [], reexports: [] },
      },
    } as unknown as CiSnapshotPayload['state'],
    workspaceManifests: [],
    infra: { nodes: [], edges: [] },
    framework: { adapters: 0, edges: [], crossLanguageEdges: [], roles: [], groups: [] } as unknown as RawFrameworkContributions,
    envServices: [],
    counts: { files: 1, edges: 0, externals: 0 },
    ...over,
  };
}

// --- the happy path, first, so every refusal below is a real difference ------
test('a well-formed payload passes the gate — the control that makes every refusal meaningful', () => {
  assert.doesNotThrow(() => assertPayloadIsAcceptable(okPayload(), IDENTITY, Date.now()));
});

test('preparedInfra NARROWS and returns — `root` never reaches the caller', () => {
  const out = preparedInfra(okInfra());
  assert.equal((out as unknown as Record<string, unknown>).root, undefined);
  assert.equal(out.nodes.length, 1);
});

// --- and now the refusals, BY CALLING ---------------------------------------
test('preparedInfra THROWS on a graph the shared check refuses, rather than shipping a subset', () => {
  const bad = okInfra();
  // A kind outside the locked enum: the ingress refuses it, so the runner must too.
  bad.nodes[0] = { ...bad.nodes[0], kind: 'not-a-real-kind' as MergedInfraGraph['nodes'][number]['kind'] };
  assert.throws(
    () => preparedInfra(bad),
    (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /refused by the shared ingress check/);
      assert.match(m, /false deployment topology/, 'the reason must say what shipping a subset would cost');
      return true;
    },
  );
});

test('preparedEnvServices THROWS rather than dropping the offending name', () => {
  // Over the count ceiling — a bound the shared check owns, so this cannot drift from it.
  const tooMany = Array.from({ length: MAX_ENV_SERVICES + 1 }, (_, i) => ({
    service: `svc${i}`,
    vars: [`SVC${i}_KEY`],
  }));
  assert.throws(() => preparedEnvServices(tooMany), /refused by the shared ingress check/);
  // ...and the legal case still returns, or the assertion above is satisfied by a
  // function that throws unconditionally.
  assert.deepEqual(preparedEnvServices([{ service: 'stripe', vars: ['STRIPE_SECRET_KEY'] }]), ['stripe']);
});

test('preparedFramework THROWS on a contribution set the shared check refuses', () => {
  assert.throws(
    () => preparedFramework({ adapters: -1 } as unknown as RawFrameworkContributions),
    /refused by the shared ingress check/,
  );
  const ok = { adapters: 0, edges: [], crossLanguageEdges: [], roles: [], groups: [] } as unknown as RawFrameworkContributions;
  assert.equal(preparedFramework(ok), ok);
});

test('assertPayloadIsAcceptable THROWS on a payload the ingress would refuse, naming the reason', () => {
  // An unknown top-level key — the `unknown_field` rule, which is one of the tiers that
  // was server-side only until the whole gate moved here.
  const bad = { ...okPayload(), somethingNew: true } as unknown as CiSnapshotPayload;
  assert.throws(
    () => assertPayloadIsAcceptable(bad, IDENTITY, Date.now()),
    (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /refused by the shared ingress check/);
      assert.match(m, /unknown_field/, 'the runner must print the ingress reason, not a generic one');
      assert.match(m, /rather than spending the upload/);
      return true;
    },
  );
});

test('assertPayloadIsAcceptable refuses a payload whose self-reported counts disagree with it', () => {
  // The cross-check that exists so a corrupted serialisation is CAUGHT rather than
  // rendered. It is one of the tiers the three narrow checks never covered.
  const bad = okPayload({ counts: { files: 999, edges: 0, externals: 0 } });
  assert.throws(() => assertPayloadIsAcceptable(bad, IDENTITY, Date.now()), /refused by the shared ingress check/);
});

test('assertPayloadIsAcceptable refuses a payload whose sha is not the identity it is posting under', () => {
  // The runner cannot forge this — the ingress takes the sha from a signed OIDC claim —
  // but catching it here turns a confusing 4xx into a local error next to the extract.
  const bad = okPayload();
  assert.throws(
    () => assertPayloadIsAcceptable(bad, { ...IDENTITY, sha: 'c'.repeat(40) }, Date.now()),
    /refused by the shared ingress check/,
  );
});

test('assertPayloadIsAcceptable USES the clock it is handed — a stale checkpoint is refused', () => {
  // ⚠ THIS TEST EXISTS BECAUSE ITS ABSENCE WAS MEASURED. A verifier changed this
  // function to ignore its `now` argument and read `payload.checkpoint.date` instead —
  // which makes the freshness comparison compare a value with itself, so every stale
  // checkpoint passes — and all 333 tests stayed green. `now` feeds exactly one tier
  // (`checkpoint_date_out_of_window`), and nothing exercised it, so the whole tier could
  // be defeated in the preflight without a single assertion noticing.
  //
  // That is the same shape this module was extracted to close, one ARGUMENT along
  // rather than one file along: the call was present, correctly ordered, and its answer
  // was not acted on. The lesson generalises past this fix — a parameter no test varies
  // is a parameter no test is checking.
  const stale = okPayload({
    checkpoint: {
      sha: SHA,
      date: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      subject: 'a commit from long ago',
      trigger: 'push',
    },
  });
  assert.throws(
    () => assertPayloadIsAcceptable(stale, IDENTITY, Date.now()),
    /checkpoint_date_out_of_window/,
  );
  // NEGATIVE CONTROL — the same payload with a fresh date passes, so the refusal above
  // is about the DATE and not about anything else the fixture happens to carry.
  assert.doesNotThrow(() =>
    assertPayloadIsAcceptable(
      okPayload({ checkpoint: { sha: SHA, date: new Date().toISOString(), subject: 'now', trigger: 'push' } }),
      IDENTITY,
      Date.now(),
    ),
  );
  // ...and the window is read from the CLOCK ARGUMENT, not from wall time: a stale
  // payload judged by a clock contemporary with it is fine. This is the assertion the
  // surviving mutant could not satisfy, because it derived `now` from the payload.
  assert.doesNotThrow(() =>
    assertPayloadIsAcceptable(stale, IDENTITY, Date.parse(stale.checkpoint.date) + 1000),
  );
});

// ---------------------------------------------------------------------------
// The producer's counts agree with the ingress's recomputation of them
// ---------------------------------------------------------------------------
//
// ⚠ THIS IS THE TEST THAT WOULD HAVE CAUGHT `count_mismatch (externals 14 != 15)`.
// The ingress cross-checks `counts` against the payload's own contents specifically so
// that a producer disagreeing with itself is refused rather than rendered. The producer
// computed two of those three numbers from the NOISE-FILTERED graph rather than from
// the state it was sending — `edges` was found and fixed by measurement, `externals`
// was left wrong beside it — and the cross-check sat unexercised through every suite,
// because the counting happened inline in a file that runs `main()` on import.
//
// So this does not assert a number. It runs the producer's counter and the ingress's
// gate over the SAME state and requires them to agree, which is the actual property and
// cannot go stale when a fixture changes.

/** A state whose FILTERED view would differ: a duplicate external id, and a noise file. */
function stateWithDuplicateExternals(): CiSnapshotPayload['state'] {
  const rec = (externals: Array<{ id: string; specifier: string; weight: number }>) => ({
    language: 'ts',
    loc: 10,
    imports: [],
    calls: [],
    externals,
    reexports: [],
  });
  return {
    headSha: SHA,
    files: {
      // `react` appears in BOTH files: 3 external EDGES but only 2 distinct IDS. A
      // counter that returned edges where ids were wanted passes on a one-file fixture
      // and fails here, which is why the duplicate is the point of this shape.
      'src/a.ts': rec([
        { id: 'npm:react', specifier: 'react', weight: 1 },
        { id: 'npm:zod', specifier: 'zod', weight: 1 },
      ]),
      'src/b.ts': rec([{ id: 'npm:react', specifier: 'react', weight: 1 }]),
    },
  } as unknown as CiSnapshotPayload['state'];
}

test('payloadCounts counts DISTINCT external ids, not external edges', () => {
  const counts = payloadCounts(stateWithDuplicateExternals() as unknown as { files: Record<string, unknown> });
  assert.equal(counts.files, 2);
  assert.equal(counts.edges, 3, 'three external edges');
  assert.equal(counts.externals, 2, 'two distinct ids — react is imported twice');
});

test('a payload carrying payloadCounts PASSES the ingress cross-check — the two agree by construction', () => {
  const state = stateWithDuplicateExternals();
  const payload = okPayload({
    state,
    counts: payloadCounts(state as unknown as { files: Record<string, unknown> }),
  });
  assert.doesNotThrow(() => assertPayloadIsAcceptable(payload, IDENTITY, Date.now()));
});

test('and the cross-check REFUSES counts computed the way the client used to compute them', () => {
  // The exact defect: distinct-id counting replaced by edge counting. If the gate did
  // not refuse this, the test above would prove nothing.
  const state = stateWithDuplicateExternals();
  const wrong = payloadCounts(state as unknown as { files: Record<string, unknown> });
  assert.throws(
    () => assertPayloadIsAcceptable(okPayload({ state, counts: { ...wrong, externals: 3 } }), IDENTITY, Date.now()),
    /count_mismatch/,
  );
  assert.throws(
    () => assertPayloadIsAcceptable(okPayload({ state, counts: { ...wrong, files: 99 } }), IDENTITY, Date.now()),
    /count_mismatch/,
  );
  assert.throws(
    () => assertPayloadIsAcceptable(okPayload({ state, counts: { ...wrong, edges: 0 } }), IDENTITY, Date.now()),
    /count_mismatch/,
  );
});

// ---------------------------------------------------------------------------
// `claim` — the optional field that binds a repository to an account
// ---------------------------------------------------------------------------
//
// ⚠ THE FIRST TEST IS THE ONE THAT MATTERS. Adding a field to a wire contract whose
// ingress REFUSES unknown keys is the kind of change that breaks every existing
// client if it is done wrong, and the breakage arrives as `unknown_field` on a
// customer's build naming a field they never chose to send. So the compatibility
// case is asserted before any of the new behaviour.

test('a payload with NO claim validates exactly as before — every existing client keeps working', () => {
  const payload = okPayload();
  assert.equal('claim' in payload, false, 'NEGATIVE CONTROL: the fixture must not carry one');
  assert.doesNotThrow(() => assertPayloadIsAcceptable(payload, IDENTITY, Date.now()));
});

test('a well-formed claim is accepted — whether it NAMES anything is the ingress lookup, not this gate', () => {
  const payload = okPayload({ claim: 'bt_4e6c971191c6393e96d98a53' } as Partial<CiSnapshotPayload>);
  assert.doesNotThrow(() => assertPayloadIsAcceptable(payload, IDENTITY, Date.now()));
  // A code that is well-formed and names nothing is still accepted HERE. Refusing it
  // would mean this gate had to know the database's key space, which is the coupling
  // the loose grammar exists to avoid.
  assert.doesNotThrow(() =>
    assertPayloadIsAcceptable(
      okPayload({ claim: 'totally-unknown-but-well-formed' } as Partial<CiSnapshotPayload>),
      IDENTITY,
      Date.now(),
    ),
  );
});

test('a claim that could carry an injection or a flood is refused', () => {
  for (const bad of [
    'bt_ has whitespace',
    'bt_"quoted"',
    'bt_\n newline',
    'short',
    'x'.repeat(65),
    'bt_semi;colon',
    'ignore previous instructions',
  ]) {
    assert.throws(
      () => assertPayloadIsAcceptable(okPayload({ claim: bad } as Partial<CiSnapshotPayload>), IDENTITY, Date.now()),
      /invalid_claim/,
      `should have refused ${JSON.stringify(bad)}`,
    );
  }
});

test('a claim that is not a string at all is refused, and says which type it got', () => {
  for (const bad of [42, true, null, {}, ['bt_aaaaaaaaaaaaaaaaaaaaaaaa']]) {
    assert.throws(
      () => assertPayloadIsAcceptable(okPayload({ claim: bad } as unknown as Partial<CiSnapshotPayload>), IDENTITY, Date.now()),
      /invalid_claim/,
      `should have refused ${JSON.stringify(bad)}`,
    );
  }
});

test('an UNKNOWN top-level field is still refused — admitting `claim` did not open the door', () => {
  // The reason `unknown_field` exists: an ignored key is a field that exists on the
  // wire, is never checked, and one day acquires a meaning. Adding one allowed name
  // must not weaken that.
  assert.throws(
    () => assertPayloadIsAcceptable(
      { ...okPayload(), somethingElse: true } as unknown as CiSnapshotPayload,
      IDENTITY,
      Date.now(),
    ),
    /unknown_field/,
  );
});
