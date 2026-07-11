// (Slice 1) — detection-step resilience.
//
// The step is ADDITIVE + log-only this slice, so a throwing adapter must never
// abort an ingest (mirrors extractInfra's call-site degrade discipline). This
// locks that guarantee in.

import { describe, it, expect, beforeEach } from '../testkit.js';
import { detectFrameworkStack } from './detect-step.js';
import { clearFrameworkAdapters, registerFrameworkAdapter } from './registry.js';
import type { FrameworkAdapter } from './types.js';

describe('detectFrameworkStack', () => {
  beforeEach(() => clearFrameworkAdapters());

  it('degrades to an empty manifest when an adapter throws (additive, never abort)', async () => {
    const thrower: FrameworkAdapter = {
      name: 'boom',
      async detect() {
        throw new Error('kaboom');
      },
    };
    registerFrameworkAdapter(thrower);
    // detectFrameworkStack registers the builtins on top (idempotent-additive),
    // so `boom` stays registered and detection rejects → caught → empty manifest.
    const manifest = await detectFrameworkStack('/no/such/repo');
    expect(manifest.matches).toEqual([]);
    expect(manifest.root).toBe('/no/such/repo');
  });

  it('returns an empty manifest for a non-framework path (no throw)', async () => {
    const manifest = await detectFrameworkStack('/no/such/repo');
    expect(manifest.matches).toEqual([]);
  });
});
