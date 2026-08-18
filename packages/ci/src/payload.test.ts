// The bounded body reader.
//
// WHY THIS FILE EXISTS. The first round of this PR had none, and every request
// in `ciSnapshot.test.ts` sent plain uncompressed JSON — so `inflateBounded` ran
// ZERO times, and deleting the whole `maxInflated` block, or setting the caps to
// Infinity, was green. The module header calls this function "part of the trust
// boundary"; nothing proved it. Applying this repo's own rule — mutate the line
// that RUNS — the tests below each fail if their guard is removed. The mutation
// map is at the bottom of the file.
//
// Every gzip fixture is built with `CompressionStream('gzip')`, the same
// primitive the runner would use, rather than a checked-in binary blob — so the
// test proves the reader handles real gzip, not one recorded example of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BODY_BYTES,
  MAX_DECOMPRESSION_RATIO,
  MAX_INFLATED_BYTES,
  RATIO_GUARD_FLOOR_BYTES,
  ciPayloadKey,
  readBoundedBody,
} from './payload.js';

async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  void w.write(new TextEncoder().encode(text));
  void w.close();
  const out: Uint8Array[] = [];
  const reader = (cs.readable as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out.push(value);
  }
  const total = out.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let at = 0;
  for (const c of out) {
    merged.set(c, at);
    at += c.byteLength;
  }
  return merged;
}

/**
 * The body shapes `Request` accepts, named locally. `BodyInit` is a DOM global; this
 * package compiles against Node's types alone (adding `lib: ["DOM"]` re-types
 * `DecompressionStream` and breaks the source under test), so the alias is declared
 * where it is used rather than pulling a whole lib in for one name.
 */
type BodyInit = string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

function req(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request('https://worker.test/ci/snapshot', { method: 'POST', body, headers });
}

/**
 * A request whose body arrives in chunks with NO content-length — the shape that
 * made the old `arrayBuffer()` read unbounded. `cancelled` records whether the
 * reader stopped the source early, which is the property the bound is FOR.
 */
function chunkedReq(chunkBytes: number, chunks: number): { request: Request; pulled: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
  });
  return {
    request: new Request('https://worker.test/ci/snapshot', {
      method: 'POST',
      body: stream,
      // Workers/undici need this for a streaming request body.
      duplex: 'half',
    }),
    pulled: () => pulled,
  };
}

// --- the happy paths --------------------------------------------------------

test('plain JSON round-trips and is reported as not gzipped', async () => {
  const r = await readBoundedBody(req(JSON.stringify({ a: 1 })));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value, { a: 1 });
  assert.equal(r.gzipped, false);
});

test('a GZIPPED payload round-trips, is detected by magic bytes, and reports both sizes', async () => {
  const text = JSON.stringify({ files: Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`) });
  const body = await gzip(text);
  // Deliberately NO `Content-Encoding` header: detection must not depend on a
  // header the platform may strip or an attacker may lie about.
  const r = await readBoundedBody(req(body as unknown as BodyInit));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.gzipped, true);
  assert.equal(r.inflatedBytes, new TextEncoder().encode(text).length);
  assert.ok(r.rawBytes < r.inflatedBytes, 'the compressed body must be the smaller one');
});

// --- the bomb guards --------------------------------------------------------

test('BOMB: a small, highly compressible body that inflates past the ratio is rejected as decompression_ratio', async () => {
  // ~4 MB of zeros gzips to a couple of KB — a ratio in the thousands. It passes
  // the 1 MiB floor, so the ratio guard is the thing that fires, not the size cap.
  const bomb = await gzip('0'.repeat(4 * 1024 * 1024));
  assert.ok(
    (4 * 1024 * 1024) / bomb.byteLength > MAX_DECOMPRESSION_RATIO,
    'the fixture must actually exceed the ratio, or this test proves nothing',
  );
  const r = await readBoundedBody(req(bomb as unknown as BodyInit));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'decompression_ratio');
});

test('the ratio guard does NOT fire below its floor — a tiny honest payload compresses well too', async () => {
  // 64 KB of repetition: a ratio far above 500:1, but under RATIO_GUARD_FLOOR_BYTES,
  // so it must be admitted. Without the floor this is a false rejection of real repos.
  const small = JSON.stringify({ pad: 'a'.repeat(64 * 1024) });
  assert.ok(new TextEncoder().encode(small).length < RATIO_GUARD_FLOOR_BYTES);
  const r = await readBoundedBody(req((await gzip(small)) as unknown as BodyInit));
  assert.equal(r.ok, true, 'the floor is what keeps small honest payloads admissible');
});

test('INFLATED CAP: a body inflating past the cap is rejected as inflated_too_large', async () => {
  const text = 'x'.repeat(2 * 1024 * 1024);
  const body = await gzip(text);
  // The `limits` argument exists precisely so this need not allocate 16 MiB.
  const r = await readBoundedBody(req(body as unknown as BodyInit), {
    maxInflatedBytes: 512 * 1024,
    maxRatio: Number.POSITIVE_INFINITY, // isolate the SIZE cap from the ratio guard
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'inflated_too_large');
  assert.match(r.detail ?? '', /524288/);
});

test('the inflated cap fires MID-STREAM, not after the whole body has expanded', async () => {
  // 8 MB of unique-ish text so gzip cannot collapse it to nothing; the cap is
  // 64 KiB. If the guard only ran after full inflation the reason would be the
  // same, so the observable proof is that a cap far below the payload still
  // returns rather than exhausting memory — and that the reported overshoot is a
  // single chunk past the cap, not the payload's full size.
  const text = Array.from({ length: 300_000 }, (_, i) => `line-${i}-${(i * 7919) % 99991}`).join('\n');
  const r = await readBoundedBody(req((await gzip(text)) as unknown as BodyInit), {
    maxInflatedBytes: 64 * 1024,
    maxRatio: Number.POSITIVE_INFINITY,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'inflated_too_large');
  const seen = Number(/^(\d+)/.exec(r.detail ?? '')?.[1] ?? 0);
  assert.ok(
    seen < new TextEncoder().encode(text).length / 4,
    `aborted after ${seen} bytes; the full payload is ${text.length} — the guard must not drain the stream`,
  );
});

// --- the raw read -----------------------------------------------------------

test('RAW BOUND: a chunked body with NO content-length is cut off at maxBodyBytes', async () => {
  // The exact shape the first round of this PR could not stop: `arrayBuffer()`
  // would have materialised all 40 chunks before any check ran.
  const { request, pulled } = chunkedReq(64 * 1024, 40);
  const r = await readBoundedBody(request, { maxBodyBytes: 256 * 1024 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'body_too_large');
  assert.ok(pulled() <= 6, `read ${pulled()} chunks; the reader must cancel, not drain`);
});

test('a lying content-length is refused up front, and it is only an optimisation', async () => {
  const r = await readBoundedBody(
    req(JSON.stringify({ a: 1 }), { 'content-length': String(MAX_BODY_BYTES + 1) }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'body_too_large');
  assert.match(r.detail ?? '', /content-length/);
});

// --- malformed input --------------------------------------------------------

test('truncated gzip is malformed_gzip, not an unhandled throw', async () => {
  const body = (await gzip(JSON.stringify({ a: 1 }))).slice(0, 6);
  const r = await readBoundedBody(req(body as unknown as BodyInit));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'malformed_gzip');
});

test('gzip magic bytes followed by garbage is malformed_gzip', async () => {
  const body = new Uint8Array([0x1f, 0x8b, ...new Array(64).fill(0x41)]);
  const r = await readBoundedBody(req(body as unknown as BodyInit));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'malformed_gzip');
});

test('non-JSON text is malformed_json, distinguishable from every size failure', async () => {
  const r = await readBoundedBody(req('not json at all'));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'malformed_json');
});

test('an empty body is empty_body — and returns BEFORE any division by rawBytes', async () => {
  const r = await readBoundedBody(req(''));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'empty_body');
});

test('every failure reason is distinct, so a test cannot pass by accident', async () => {
  const reasons = new Set<string>();
  for (const r of [
    await readBoundedBody(req('')),
    await readBoundedBody(req('nope')),
    await readBoundedBody(req((await gzip('0'.repeat(4 * 1024 * 1024))) as unknown as BodyInit)),
    await readBoundedBody(req(JSON.stringify({}), { 'content-length': String(MAX_BODY_BYTES + 1) })),
    await readBoundedBody(req(new Uint8Array([0x1f, 0x8b, 1, 2, 3]) as unknown as BodyInit)),
  ]) {
    if (!r.ok) reasons.add(r.reason);
  }
  assert.equal(reasons.size, 5, [...reasons].join(','));
});

// --- constants --------------------------------------------------------------

test('the caps are ordered so each one owns a regime the others cannot reach', () => {
  assert.ok(MAX_BODY_BYTES < MAX_INFLATED_BYTES, 'a body must be able to inflate');
  // Above ~MAX_INFLATED/MAX_RATIO of raw input the size cap always fires first, so
  // the ratio guard owns only the small-input regime. Pinned so a future edit that
  // makes one guard subsume the other is visible rather than quietly vacuous.
  const ratioOwnsBelow = MAX_INFLATED_BYTES / MAX_DECOMPRESSION_RATIO;
  assert.ok(ratioOwnsBelow < MAX_BODY_BYTES, 'the ratio guard must have a regime of its own');
  assert.equal(Math.round(ratioOwnsBelow / 1024), 33);
});

test('the R2 key is scoped by repo and commit, and carries no user-controlled text', () => {
  const key = ciPayloadKey('repo-uuid', 'a'.repeat(40), 'job-uuid');
  assert.equal(key, `ci/repo-uuid/${'a'.repeat(40)}/job-uuid.json`);
  assert.ok(!key.includes('..') && !key.startsWith('/'));
});

// ===========================================================================
// MUTATION MAP — run, not asserted. Each row was applied to `ciPayload.ts`, the
// suite executed, and the named tests observed to fail.
//
//   delete `if (total > maxBody)` in readRawBounded  → RAW BOUND: a chunked body…
//   delete `if (bytes > maxInflated)`                → INFLATED CAP…, fires MID-STREAM…
//   delete the ratio guard block                     → BOMB: a small, highly compressible…
//   MAX_DECOMPRESSION_RATIO = Infinity               → BOMB…
//   MAX_INFLATED_BYTES = Number.MAX_SAFE_INTEGER     → the caps are ordered…
//   drop `await reader.cancel()` in inflateBounded    → (memory only; not observable —
//       recorded as a KNOWN un-guarded line rather than claimed as covered)
//   remove the RATIO_GUARD_FLOOR_BYTES condition     → the ratio guard does NOT fire below…
//   trust `Content-Encoding` instead of magic bytes  → a GZIPPED payload round-trips…
// ===========================================================================
