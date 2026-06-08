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

await build({
  entryPoints: ['src/bin/backthread.ts'],
  outfile: 'dist-bundle/backthread.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Match the package's Node 22 LTS pin (CLAUDE.md). The SDK + `--test-force-exit`
  // assume Node 20+; 22 is the floor we ship against.
  target: 'node22',
  // No banner: src/bin/backthread.ts already starts with `#!/usr/bin/env node`, and
  // esbuild preserves a leading entry-point shebang on line 1. A banner would
  // duplicate it onto line 2 and break execution.
  legalComments: 'none',
  logLevel: 'info',
});
