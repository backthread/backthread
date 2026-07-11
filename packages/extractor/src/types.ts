// Structural type vocabulary for the deterministic extractor.
//
// This is the shared type substrate the AST → cluster → framework → infra
// pipeline enforces: the 8-verb edge taxonomy, the 4 app-role + 8 infra Module
// kinds, and the branded primitives. The type system is law — a producer that
// emits an out-of-enum value is a bug in the classifier, never a reason to
// widen the enum (fail loud at the boundary instead of landing low-quality data).
//
// These definitions mirror the host application's domain types exactly (same
// literals, same brand strings) so a graph produced here is structurally
// interchangeable with one produced server-side. A drift-guard test keeps the
// two in lockstep.

// --- Branded primitives -----------------------------------------------------

export type ShortSha = string & { readonly __brand: 'ShortSha' };
export type ModuleId = string & { readonly __brand: 'ModuleId' };

export const ShortSha = (s: string): ShortSha => s as ShortSha;
export const ModuleId = (s: string): ModuleId => s as ModuleId;

// --- Module kind ------------------------------------------------------------
// What kind of thing a module is. Two families:
//
// Internal-app altitude (your own code, container/component level) on a single
// request/trigger axis:
// frontend  — user-facing client UI (SPA / mobile / SSR)
// gateway   — edge entry/router: routes requests + webhooks inward, no logic
// service   — your own backend business-logic compute, triggered by a REQUEST
// job       — your own backend compute triggered by a SCHEDULE or QUEUE
//
// Infra / runtime-platform altitude (inferred from config by the InfraAdapters):
// worker · static-site · queue · container · datastore · external-api ·
// secret-store · cdn
//
// Legacy kind retained for reader back-compat only: `external` (DEPRECATED alias
// for external-api). Don't emit it from new producers.
export type ModuleKind =
  | 'frontend'
  | 'service'
  | 'gateway'
  | 'job'
  | 'worker'
  | 'static-site'
  | 'queue'
  | 'container'
  | 'datastore'
  | 'external-api'
  | 'secret-store'
  | 'cdn'
  | 'external';

// The 8 infra-altitude kinds, enumerated for runtime guards.
export const INFRA_MODULE_KINDS = [
  'worker',
  'static-site',
  'queue',
  'container',
  'datastore',
  'external-api',
  'secret-store',
  'cdn',
] as const;
export type InfraModuleKind = (typeof INFRA_MODULE_KINDS)[number];

// Every NON-deprecated kind a producer may emit — ModuleKind minus the legacy
// `external` alias. Producer-side guard (parseModuleKind) validates against this;
// readers stay tolerant of `external` in already-seeded blobs.
export const MODULE_KINDS = [
  'frontend',
  'service',
  'gateway',
  'job',
  'worker',
  'static-site',
  'queue',
  'container',
  'datastore',
  'external-api',
  'secret-store',
  'cdn',
] as const;

/**
 * Producer-side: returns a strict, non-deprecated ModuleKind or throws.
 * The deprecated `external` alias is REJECTED — producers must emit
 * `external-api`. Readers tolerate legacy `external`; producers must not
 * regenerate it, so we fail loud at the producer boundary.
 */
export function parseModuleKind(candidate: string): ModuleKind {
  if (candidate === 'external') {
    throw new Error(
      `deprecated module kind 'external' — emit 'external-api' instead. ` +
        `Readers tolerate legacy 'external'; producers must not regenerate it.`,
    );
  }
  if (!(MODULE_KINDS as readonly string[]).includes(candidate)) {
    throw new Error(
      `unknown module kind '${candidate}'. Use one of: ${MODULE_KINDS.join(', ')}.`,
    );
  }
  return candidate as ModuleKind;
}

// Where a per-node attribute came from. `llm-classified` covers a tier/kind
// label from a batched classifier; `declared` covers extractor-direct evidence
// (a `wrangler.toml` line is declared); `inferred` covers a code-import inference.
export type NodeProvenance = 'declared' | 'inferred' | 'llm-classified';

// The architectural ROLE of a workspace package (monorepo), attached to the
// package's subsystem so the canvas can label the top-level box app vs lib vs
// tooling. Purely descriptive metadata — NOT a Module kind.
// app     — a runnable application
// lib     — a shared library consumed by other packages
// tooling — build/lint/config tooling
export type PackageRole = 'app' | 'lib' | 'tooling';

// --- Edge kind: the 8-verb taxonomy -----------------------------------------
// Every edge is a verb with a direction. Substrate-only labels
// (`imports / depends-on / uses`) are refused at the user-facing boundary.
//
// Producer-side discipline: `parseEdgeKind` returns an EdgeKind or throws — a
// classifier that emits `imports` fails loudly at the persist boundary.
// Reader-side discipline: `coerceEdgeKind` is tolerant; it maps legacy/unknown
// values onto an 8-verb fallback so old data still renders. Producers must
// NEVER call coerce — it exists for the renderer only.

export const EDGE_KINDS = [
  'calls',
  'reads',
  'writes',
  'publishes',
  'subscribes',
  'webhook-from',
  'deploys-to',
  'stores-in',
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

// Substrate-only edge labels — refused at the user-facing boundary.
export const FORBIDDEN_EDGE_KINDS = ['imports', 'depends-on', 'uses'] as const;
export type ForbiddenEdgeKind = (typeof FORBIDDEN_EDGE_KINDS)[number];

/**
 * Producer-side: returns a strict EdgeKind or throws. Use this at the extractor
 * / enrichment / persist boundary. A throw means the classifier produced a
 * substrate-only label that should never have left its layer — fix the
 * classifier, not the type.
 */
export function parseEdgeKind(candidate: string): EdgeKind {
  if ((FORBIDDEN_EDGE_KINDS as readonly string[]).includes(candidate)) {
    throw new Error(
      `forbidden edge kind '${candidate}' — substrate-only, never user-facing. ` +
        `Use one of: ${EDGE_KINDS.join(', ')}.`,
    );
  }
  if (!(EDGE_KINDS as readonly string[]).includes(candidate)) {
    throw new Error(
      `unknown edge kind '${candidate}'. Use one of: ${EDGE_KINDS.join(', ')}.`,
    );
  }
  return candidate as EdgeKind;
}

/**
 * Reader-side: tolerant coercion of legacy / unknown values onto the closest
 * 8-verb equivalent so old snapshots still render. New producers must NEVER
 * call this — they call parseEdgeKind.
 * - 'webhook'                          → 'webhook-from'
 * - 'imports' | 'uses' | 'depends-on'  → 'calls' (most-general structural verb)
 * - anything else not in the 8 verbs   → 'calls'
 */
export function coerceEdgeKind(candidate: string): EdgeKind {
  if ((EDGE_KINDS as readonly string[]).includes(candidate)) return candidate as EdgeKind;
  if (candidate === 'webhook') return 'webhook-from';
  return 'calls';
}

export interface Edge {
  source: ModuleId;
  target: ModuleId;
  kind: EdgeKind;
}
