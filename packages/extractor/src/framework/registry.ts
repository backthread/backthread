// FrameworkAdapter registry + detection gate.
//
// Mirrors scripts/ingest/infra/registry.ts: adapters register in REGISTRATION
// ORDER (= the conflict/priority order for the merge step the later slices add),
// registration is idempotent on `name` (re-registering replaces — the mock-swap
// pattern tests use), and `clear()` wipes the registry between specs.
//
// `detectFrameworks` is the detection GATE: it runs every registered adapter's
// cheap `detect()` against the repo and returns the ordered detected-stack
// MANIFEST. Multiple adapters co-apply (a Turborepo with a Next app + a Nest
// API + an Expo app), so the manifest is a list, not a single winner. No
// adapter matching ⇒ an EMPTY manifest ⇒ today's generic-TS behavior runs
// unchanged (the headline acceptance invariant).

import type {
  DetectMatch,
  FrameworkAdapter,
  FrameworkDetectContext,
  FrameworkManifest,
} from './types.js';

// ---------------------------------------------------------------------------
// Registration.

const REGISTERED: FrameworkAdapter[] = [];

/**
 * Register an adapter. Idempotent on `name` — re-registering replaces the
 * existing entry (useful for tests swapping a mock). Insertion order is the
 * priority order the later contribution-merge slices consume.
 */
export function registerFrameworkAdapter(adapter: FrameworkAdapter): void {
  const existing = REGISTERED.findIndex((a) => a.name === adapter.name);
  if (existing >= 0) REGISTERED[existing] = adapter;
  else REGISTERED.push(adapter);
}

/** Read-only view of registered adapters in registration order. */
export function listFrameworkAdapters(): readonly FrameworkAdapter[] {
  return REGISTERED;
}

/** Test helper — wipe the registry between specs. Never call from production. */
export function clearFrameworkAdapters(): void {
  REGISTERED.length = 0;
}

// ---------------------------------------------------------------------------
// The detection gate.

/**
 * Run every registered adapter's `detect()` against `repoDir` and return the
 * ordered detected-stack manifest.
 *
 * Detection runs in PARALLEL (cheap file-exists + one package.json read each),
 * exactly like the infra registry's detect pass. Results stay in REGISTRATION
 * ORDER (Promise.all preserves array order), so the manifest's priority is the
 * registration priority. Each match's `adapter` is stamped from the producing
 * adapter's `name` defensively, so consumers can always trust it.
 *
 * `opts.packageDir` scopes detection to one workspace package (the per-package
 * fan-out). Absent ⇒ the thin single-root pass over the repo root.
 *
 * No match ⇒ `matches: []` ⇒ the caller falls straight through to generic-TS
 * behavior, byte-for-byte unchanged.
 */
export async function detectFrameworks(
  repoDir: string,
  opts: { packageDir?: string } = {},
): Promise<FrameworkManifest> {
  const ctx: FrameworkDetectContext = { repoDir, packageDir: opts.packageDir };
  const results = await Promise.all(
    REGISTERED.map(async (adapter) => {
      const match = await adapter.detect(ctx);
      if (!match) return null;
      // Stamp the registry name so the manifest is authoritative about which
      // adapter produced each match, regardless of what the adapter set.
      return { ...match, adapter: adapter.name } satisfies DetectMatch;
    }),
  );
  return {
    root: repoDir,
    matches: results.filter((m): m is DetectMatch => m !== null),
  };
}
