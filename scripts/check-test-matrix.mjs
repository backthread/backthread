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
 * The job block (as text) that contains the matrix. Job keys sit at exactly two spaces of
 * indentation under `jobs:`, so the block runs from its own header to the next such header.
 * Isolating the block matters: checking the whole file would let the matrix live on one job
 * while the thing that consumes it lives on another — or nowhere.
 */
function matrixJobBlock(yaml) {
  const lines = yaml.split('\n');
  const headerAt = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(lines[i])) headerAt.push(i);
  }
  const matrixLine = lines.findIndex((line) => /^\s*workspace:\s*\[[^\]]*\]\s*$/.test(line));
  if (matrixLine === -1) return null;
  const start = [...headerAt].reverse().find((i) => i < matrixLine);
  if (start === undefined) {
    throw new Error(`the test matrix in ${WORKFLOW} is not inside a job — nothing would run it`);
  }
  const end = headerAt.find((i) => i > matrixLine) ?? lines.length;
  return { name: lines[start].trim().replace(/:$/, ''), text: lines.slice(start, end).join('\n') };
}

/**
 * The `workspace: [a, 'b']` matrix list out of ci.yml, plus the assertion that the job holding
 * it actually fans the list out to `npm test`.
 *
 * Throws rather than returning an empty list: if the shape of the workflow changes so this can
 * no longer see the matrix, the guard must go red, not quietly agree with everything. Listing
 * the right workspaces is worth nothing if the job that reads the list has been deleted, or had
 * its `npm test` step replaced, or lost `fail-fast: false` so one red leg cancels the others —
 * in all three the list stays perfectly correct and no workspace gets tested. So the mechanism
 * is checked, not just the list.
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

  const job = matrixJobBlock(yaml);
  if (!job) throw new Error(`could not locate the job holding the test matrix in ${WORKFLOW}`);
  if (!/npm test --workspace \$\{\{\s*matrix\.workspace\s*\}\}/.test(job.text)) {
    throw new Error(
      `job "${job.name}" declares a \`workspace\` matrix but never runs ` +
        '`npm test --workspace ${{ matrix.workspace }}` — the matrix would fan out to nothing.',
    );
  }
  if (!/fail-fast:\s*false/.test(job.text)) {
    throw new Error(
      `job "${job.name}" is missing \`fail-fast: false\` — one workspace going red would ` +
        "cancel the others, so they would stop reporting exactly when it matters.",
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

// The typecheck job derives its own list at runtime, so it can never drift out of sync with a
// NEW workspace — but it silently shrinks if an existing workspace loses its `typecheck` script,
// and the job's only emptiness check catches zero, not "one fewer". Nothing in this repo should
// be worth testing and not worth typechecking, so that is the invariant to close it with.
const untypechecked = expected.filter((name) => !workspacesWithScript('typecheck').includes(name));

if (missing.length > 0 || extra.length > 0 || untypechecked.length > 0) {
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
  for (const name of untypechecked) {
    console.error(
      `::error::workspace "${name}" has a \`test\` script but no \`typecheck\` script, so CI's ` +
        'typecheck job silently skips it. Give it one, or stop testing it.',
    );
  }
  process.exit(1);
}

console.log(
  "OK — ci.yml's test matrix fans out to `npm test` with fail-fast off, and covers every " +
    `workspace that has a test script (each of which is also typechecked): ${expected.join(', ')}`,
);
