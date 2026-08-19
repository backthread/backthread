// The client half of connecting a repository without the GitHub App.
//
// Acceptance, verbatim: "Present → carried; absent → payload byte-identical to today;
// stale → ignored, build stays green. Tested behaviourally in `preflight`-style code a
// test can call, not by a grep over `action.ts` — that file runs `main()` on import and
// three separate defects hid behind exactly that."
//
// So every assertion below CALLS the function. The one thing a unit test cannot reach
// is the assembly inside `main()`; that is covered by `action.test.ts`'s source guard
// PLUS the payload-equality test here, which measures the property the assembly exists
// to have rather than the shape of the line that has it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimFromEnv, connectFailureHint, defaultBranchFrom } from './connect.js';
import { assertPayloadIsAcceptable } from './preflight.js';
import { CI_PAYLOAD_VERSION, type CiSnapshotPayload } from './payload.js';
import type { RawFrameworkContributions } from '@backthread/extractor';

const SHA = 'a'.repeat(40);
const IDENTITY = { owner: 'acme', name: 'app', sha: SHA };

/** The same minimal-but-real payload `preflight.test.ts` uses. */
function okPayload(over: Record<string, unknown> = {}): CiSnapshotPayload {
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

// ===========================================================================
// claimFromEnv
// ===========================================================================

test('absent, empty and whitespace-only are all "no claim" — and carry no warning', () => {
  // A user who never heard of this feature must see nothing, including no noise.
  assert.deepEqual(claimFromEnv({}), {});
  assert.deepEqual(claimFromEnv({ BACKTHREAD_CLAIM: '' }), {});
  assert.deepEqual(claimFromEnv({ BACKTHREAD_CLAIM: '   \n' }), {});
});

test('PRESENT → carried verbatim', () => {
  assert.deepEqual(claimFromEnv({ BACKTHREAD_CLAIM: 'bt_4e6c971191c6393e96d98a53' }), {
    claim: 'bt_4e6c971191c6393e96d98a53',
  });
});

test('a trailing newline from a YAML env: block is trimmed, not refused', () => {
  // `env: BACKTHREAD_CLAIM: |` and a copy-paste both do this routinely. Refusing a
  // correct code for a reason no user can see is the worst kind of refusal.
  assert.deepEqual(claimFromEnv({ BACKTHREAD_CLAIM: '  bt_4e6c971191c6393e96d98a53\n' }), {
    claim: 'bt_4e6c971191c6393e96d98a53',
  });
});

test('A MALFORMED VALUE IS DROPPED WITH A WARNING, NEVER SENT — the build must not die on a typo', () => {
  // The payload gate runs on the RUNNER too, so sending this would throw
  // `invalid_claim` after a full extract and fail an otherwise-fine build over a
  // variable that only matters on the very first run.
  for (const bad of ['short', 'has space', "quote'", 'x'.repeat(65), 'semi;colon']) {
    const out = claimFromEnv({ BACKTHREAD_CLAIM: bad });
    assert.equal(out.claim, undefined, `should not carry ${JSON.stringify(bad)}`);
    assert.match(String(out.warning), /BACKTHREAD_CLAIM/);
  }
});

test('NEGATIVE CONTROL for the drop: the malformed value really WOULD have killed the build', () => {
  // Without this, the test above proves only that the function is fussy — not that its
  // fussiness prevents anything. `assertPayloadIsAcceptable` is the gate the RUNNER
  // itself calls, after a full extract, and it THROWS.
  assert.throws(
    () => assertPayloadIsAcceptable(okPayload({ claim: 'has space' }), IDENTITY, Date.now()),
    /invalid_claim/,
  );
  // …and the same payload without the bad field passes, so the throw is the claim.
  assert.doesNotThrow(() => assertPayloadIsAcceptable(okPayload(), IDENTITY, Date.now()));
});

test('ABSENT → the payload is byte-identical to one built without the field', () => {
  // The acceptance says "byte-identical", so this measures bytes rather than shape.
  const { claim } = claimFromEnv({});
  const withSpread = JSON.stringify({ repo: 'r', ...(claim ? { claim } : {}) });
  const without = JSON.stringify({ repo: 'r' });
  assert.equal(withSpread, without);
});

test('A STALE CODE IS STILL CARRIED — only the ingress can know it is spent', () => {
  // The claim is consumed on first use and the variable then sits in the workflow
  // forever. The client cannot tell live from spent, and must not guess: the ingress
  // ignores an unmatched code for a connected repo, and the build stays green.
  const spent = 'bt_0000000000000000deadbeef';
  assert.deepEqual(claimFromEnv({ BACKTHREAD_CLAIM: spent }), { claim: spent });
});

// ===========================================================================
// defaultBranchFrom
// ===========================================================================

const EVENT = (branch: unknown) => JSON.stringify({ repository: { default_branch: branch } });

test('the REPOSITORY default branch wins over the branch this run is on', () => {
  // The bug this prevents: connecting from a workflow_dispatch on a feature branch
  // would seed `repos.default_branch` to that branch forever.
  assert.equal(defaultBranchFrom({ eventJson: EVENT('main'), refName: 'feature/x' }), 'main');
});

test('NEGATIVE CONTROL: with no event file it falls back to the ref name, exactly as before', () => {
  assert.equal(defaultBranchFrom({ eventJson: null, refName: 'feature/x' }), 'feature/x');
});

test('every unusable event shape falls back rather than throwing', () => {
  for (const json of ['not json', '[]', 'null', '{}', '{"repository":null}', '{"repository":[]}', EVENT(7), EVENT('  ')]) {
    assert.equal(defaultBranchFrom({ eventJson: json, refName: 'trunk' }), 'trunk', `for ${json}`);
  }
});

test('with neither an event file nor a ref name it is "main", not undefined', () => {
  assert.equal(defaultBranchFrom({ eventJson: null, refName: undefined }), 'main');
  assert.equal(defaultBranchFrom({ eventJson: null, refName: '  ' }), 'main');
});

// ===========================================================================
// connectFailureHint — the review finding: the last line named the wrong cause
// ===========================================================================

test('a discarded claim is re-surfaced on the refusal that it caused', () => {
  const { warning } = claimFromEnv({ BACKTHREAD_CLAIM: 'has space' });
  const hint = connectFailureHint({ claimWarning: warning, status: 404 });
  assert.match(hint, /BACKTHREAD_CLAIM/);
  assert.match(hint, /not connected/);
});

test('NEGATIVE CONTROL: nothing is added when the claim was fine, or when it is unrelated', () => {
  // Without this the hint would ride along on every failure and stop meaning anything.
  assert.equal(connectFailureHint({ claimWarning: undefined, status: 404 }), '');
  assert.equal(connectFailureHint({ claimWarning: 'w', status: 413 }), '', 'a size refusal is not this');
  assert.equal(connectFailureHint({ claimWarning: 'w', status: 402 }), '', 'nor is an expired trial');
});
