#!/usr/bin/env node
// Guard: CI's test matrix must list EVERY workspace that has a `test` script.
//
// CI used to run `npm test --workspaces --if-present`, which discovered workspaces by
// itself but stopped at the first one that failed — so one red workspace hid every other
// workspace's result. The matrix in ci.yml fixes that by giving each workspace its own job,
// and buys a worse failure mode in exchange: a workspace nobody remembered to add to the
// list is never tested at all, and CI stays green about it. Silently untested is worse than
// noisily unreported, so the list is a CLOSED ALLOWLIST and this guard is what closes it.
//
// It is checked in BOTH directions:
//   • a workspace with a `test` script that the matrix omits  → nothing would run it
//   • a matrix entry with no `test` script                    → the job would fail on
//                                                               `npm test` with no script
//
// Dependency-free, and it runs in the CI job that does no install — so no advisory and no
// drifted lockfile can stop it. It parses ci.yml with a regex rather than a YAML library for
// that reason, and treats "I could not find the matrix" as a FAILURE, never as a pass.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { workspacesWithScript } from './workspaces.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github/workflows/ci.yml');

/**
 * The `workspace: [a, 'b']` matrix list out of ci.yml.
 * Throws rather than returning an empty list: if the shape of the workflow changes so this
 * can no longer see the matrix, the guard must go red, not quietly agree with everything.
 */
function matrixWorkspaces() {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const matches = [...yaml.matchAll(/^\s*workspace:\s*\[([^\]]*)\]\s*$/gm)];
  if (matches.length === 0) {
    throw new Error(
      `could not find a \`workspace: [...]\` matrix in ${WORKFLOW}. If the test job was ` +
        'restructured, update scripts/check-test-matrix.mjs to match — do not delete it.',
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `found ${matches.length} \`workspace: [...]\` matrices in ${WORKFLOW}; this guard ` +
        'only knows how to check one. Update it before adding another.',
    );
  }
  const entries = matches[0][1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  if (entries.length === 0) throw new Error(`the test matrix in ${WORKFLOW} is empty`);
  return entries;
}

const declared = matrixWorkspaces();
const expected = workspacesWithScript('test');

const missing = expected.filter((name) => !declared.includes(name));
const extra = declared.filter((name) => !expected.includes(name));

if (missing.length > 0 || extra.length > 0) {
  for (const name of missing) {
    console.error(
      `::error::workspace "${name}" has a \`test\` script but is NOT in ci.yml's test ` +
        'matrix — its tests would never run. Add it to `matrix.workspace`.',
    );
  }
  for (const name of extra) {
    console.error(
      `::error::ci.yml's test matrix lists "${name}", which has no \`test\` script — that ` +
        'job cannot do anything. Remove it, or give the workspace a `test` script.',
    );
  }
  process.exit(1);
}

console.log(`OK — ci.yml's test matrix covers every workspace with a test script: ${expected.join(', ')}`);
