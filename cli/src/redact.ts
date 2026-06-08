// redact.ts — the LOCAL parse + redaction fence for the capture hook.
//
// This is now a THIN RE-EXPORT SHIM over the shared `@backthread/redact` package.
// The fence used to be VENDORED here — a behaviour-identical
// copy of `scripts/ingest/decisions/transcript.ts`, kept in parity only by golden
// tests that would eventually drift. The de-vendor collapsed both copies
// into ONE implementation in `packages/redact/`, so the security-critical fence
// has exactly one source of truth.
//
// WHY A SHIM (and not importing @backthread/redact at every call site directly):
// the cli's import paths (`./redact.js` from capture.ts, and redact.test.ts) stay
// unchanged — minimal churn — while the actual code lives in the shared package.
//
// HOW IT STILL SHIPS LIGHT: @backthread/redact is a zero-dependency, source-only
// package wired in via a `file:` dep (see cli/package.json). The esbuild bundle
// (`npm run bundle`) INLINES it into `dist-bundle/backthread.js`, so the published
// `npx backthread` artifact carries no runtime dependency on a private package.
//
// THE RULE (load-bearing, non-negotiable — enforced in @backthread/redact):
//   DROP every tool-use / tool-result record entirely. Keep ONLY natural-language
//   user prompts and assistant text/thinking. In kept text, REDACT fenced code
//   blocks (``` … ```) to a placeholder. No source code and no tool I/O may leave
//   this module — only derived rationale reaches the inference router.

export {
  CODE_REDACTION,
  parseJsonl,
  redactCodeFences,
  redactTranscript,
  sessionTimestamp,
  type RedactedTranscript,
  type TranscriptTurn,
} from '@backthread/redact';
