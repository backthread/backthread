// esbuild.config.mjs — the self-contained distribution build.
//
// `npm run build` (tsc) is the DEV / npm-package path: it emits multi-file
// `dist/` and resolves the one runtime dep (`@modelcontextprotocol/sdk`) from
// node_modules at runtime — what `npx backthread` uses.
//
// This script is the DISTRIBUTION path: it bundles the `backthread` bin AND that one
// runtime dep into a SINGLE self-contained ESM file at `dist-bundle/backthread.js` that
// runs with NO `npm install`. That artifact is what:
//   • the Claude Code plugin references via `${CLAUDE_PLUGIN_ROOT}`, and
//   • a future standalone binary (e.g. node SEA / pkg) wraps.
//
// Tree-shaking matters here: the SDK pulls a large transitive tree (express,
// hono, jose, …) but the bin only imports `server/mcp.js` + `server/stdio.js`,
// so esbuild inlines only what those reach. Node builtins stay external.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

// ARP-732 — INLINE `@backthread/redact`'s version at build time. The CLI stamps it on
// every request (`x-backthread-redact-version`) so the server can detect redaction-
// format drift. redact ships SOURCE-ONLY with an `exports` map that exposes only `.`
// (no `./package.json` subpath), so a RUNTIME package.json read is unreliable from the
// inlined bundle — we read its version HERE and `define` it as a compile-time constant
// (version.ts has a dev/tsx fallback for the non-bundled path). Keeps the published
// `x-backthread-redact-version` value correct (not undefined/0.0.0).
const redactVersion = JSON.parse(
  readFileSync(new URL('../packages/redact/package.json', import.meta.url), 'utf8'),
).version;

await build({
  entryPoints: ['src/bin/backthread.ts'],
  outfile: 'dist-bundle/backthread.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Inline the redact version (read above) so the bundled bin reports it correctly.
  define: { __REDACT_VERSION__: JSON.stringify(redactVersion) },
  // Match the package's Node 22 LTS pin (CLAUDE.md). The SDK + `--test-force-exit`
  // assume Node 20+; 22 is the floor we ship against.
  target: 'node22',
  // No banner: src/bin/backthread.ts already starts with `#!/usr/bin/env node`, and
  // esbuild preserves a leading entry-point shebang on line 1. A banner would
  // duplicate it onto line 2 and break execution.
  legalComments: 'none',
  logLevel: 'info',
});
