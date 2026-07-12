// the framework-detection pipeline step.
//
// Mirrors scripts/ingest/infra/infra-step.ts (registerBuiltins → run): a single
// entry point both the local CLI (cli.ts) and the hosted container (container.ts)
// call IDENTICALLY, so the two twins stay mirrored. It registers the builtin
// adapters, runs the cheap detection gate, LOGS the detected-stack manifest, and
// returns it.
//
// SLICE 1: nothing downstream consumes the manifest yet — this step only logs.
// Generic-TS behavior is byte-for-byte unchanged when the manifest is empty (the
// detection is read-only: package.json reads + config-file existence checks, no
// mutation, no effect on the assembled snapshot). Adapters consume the manifest
// starting in .

import { registerBuiltinFrameworkAdapters, registerLanguageScopedFrameworkAdapters } from './register.js';
import { detectFrameworks } from './registry.js';
import type { FrameworkManifest } from './types.js';

/**
 * Register the builtin framework adapters, detect the repo's stack, log the
 * manifest, and return it. Cheap + deterministic; safe to call once per ingest
 * before extraction.
 */
export async function detectFrameworkStack(repoDir: string): Promise<FrameworkManifest> {
  // Degrade, don't abort (mirrors extractInfra's call-site discipline in cli.ts /
  // container.ts): framework detection is purely ADDITIVE + log-only this slice,
  // so a throwing adapter must never sink an otherwise-good ingest. RN's detect()
  // can't throw today (all fs reads are guarded), but the contract invites more
  // adapters — catch here, once, so BOTH call sites inherit the guarantee and stay
  // identical, and fall through to the empty-manifest generic-TS path on failure.
  try {
    registerBuiltinFrameworkAdapters();
    await registerLanguageScopedFrameworkAdapters(repoDir);
    const manifest = await detectFrameworks(repoDir);
    logManifest(manifest);
    return manifest;
  } catch (err) {
    console.warn(
      `  ⚠ framework detection failed (${(err as Error).message}) — continuing without a framework manifest`,
    );
    return { root: repoDir, matches: [] };
  }
}

// No silent caps ( constraint 7): log exactly what's detected (or the
// empty fallthrough), with each adapter's variant, root, and confidence.
function logManifest(manifest: FrameworkManifest): void {
  if (manifest.matches.length === 0) {
    console.log('→ framework detection: none — generic TS fallthrough');
    return;
  }
  const summary = manifest.matches
    .map((m) => {
      const variant = typeof m.metadata?.variant === 'string' ? ` (${m.metadata.variant})` : '';
      return `${m.adapter}${variant} @ ${m.rootPath || '.'} · conf ${m.confidence.toFixed(2)}`;
    })
    .join(', ');
  console.log(`→ framework detection: ${manifest.matches.length} stack(s) — ${summary}`);
}
