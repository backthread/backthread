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
