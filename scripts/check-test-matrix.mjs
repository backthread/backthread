#!/usr/bin/env node
// Guard: CI must actually run every workspace's tests and typecheck.
//
// CI used to run `npm test --workspaces --if-present`, which discovered workspaces by itself
// but stopped at the first one that failed — so one red workspace hid every other workspace's
// result. The matrix in ci.yml fixes that by giving each workspace its own job, and buys a worse
// failure mode in exchange: a workspace nobody remembered to add is never tested at all, and CI
// stays green about it. Silently untested is worse than noisily unreported, so the list is a
// CLOSED ALLOWLIST and this is what closes it.
//
// WHAT THIS GUARD IS AND IS NOT. It defends against ACCIDENTS — a step commented out while
// debugging and never restored, a `needs:` added while tidying, a `paths:` filter added to make
// CI cheaper, a script stubbed to `echo`, a workspace added and forgotten. It is NOT
// tamper-proof and cannot be: a guard that lives in the repo can always be removed from the
// repo. Deleting the `guards` job, deleting the line that invokes this file, and rewriting the
// npm script that points at it all defeat it, by construction. It anchors its own invocation and
// its own npm script so that each of those takes a deliberate, visible edit rather than one
// forgetful line — that is the achievable property, and the honest one to claim.
//
// It reads ci.yml as text (with comments stripped first, because a `#` must not be able to
// disable a check the guard thinks it verified) rather than with a YAML library, because it runs
// in the CI job that does NO install — so no advisory and no drifted lockfile can stop it. It
// treats "I cannot find what I am supposed to check" as a FAILURE, never as a pass.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { workspaceDirs, workspacesWithScript, hasTestFiles } from './workspaces.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = '.github/workflows/ci.yml';
const WORKFLOW = join(ROOT, WORKFLOW_PATH);
const SELF_SCRIPT = 'node scripts/check-test-matrix.mjs';

/**
 * The file with YAML comments removed, line by line, so that commenting a step out cannot leave
 * the guard matching the commented text and reporting the check as present. Quotes are tracked
 * so a `#` inside a string survives. The result is only ever SEARCHED, never re-parsed, so a
 * mangled edge case can cause a false alarm but never a false pass.
 */
function stripComments(yaml) {
  return yaml
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === "'" || ch === '"') {
          quote = ch;
        } else if (ch === '#') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

function fail(message) {
  // `::error::` so a structural failure ANNOTATES the pull request. Throwing a bare Error prints
  // a Node stack trace that GitHub renders as ordinary log noise, which is how a red gate ends up
  // looking like an infrastructure hiccup instead of a defect.
  console.error(`::error::${WORKFLOW_PATH}: ${message}`);
  process.exit(1);
}

/**
 * The job block holding the `workspace:` matrix. Job keys sit at exactly two spaces under
 * `jobs:` — and only after `jobs:`, because `on:` has two-space children too (`pull_request:`,
 * `push:`) that would otherwise be mistaken for job headers.
 */
function matrixJob(yaml) {
  const lines = yaml.split('\n');
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) fail('has no top-level `jobs:` key');
  const headers = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(lines[i])) headers.push(i);
  }
  const matrixLine = lines.findIndex((line) => /^\s*workspace:\s*\[[^\]]*\]\s*$/.test(line));
  if (matrixLine === -1) return null;
  const start = [...headers].reverse().find((i) => i < matrixLine);
  if (start === undefined) fail('the test matrix is not inside a job — nothing would run it');
  const end = headers.find((i) => i > matrixLine) ?? lines.length;
  return { name: lines[start].trim().replace(/:$/, ''), text: lines.slice(start, end).join('\n') };
}

/** The workflow can still be triggered by a code change at all. */
function assertTriggersOnEveryPullRequest(yaml) {
  const onBlock = yaml.match(/^on:\s*\n((?: {2}.*\n|\s*\n)*)/m);
  if (!onBlock) fail('has no `on:` block, so it can never run');
  if (!/^ {2}pull_request:/m.test(onBlock[1])) {
    fail('does not trigger on `pull_request`, so no pull request would be checked at all');
  }
  if (/^\s*paths(-ignore)?:/m.test(onBlock[1])) {
    fail(
      'narrows its triggers with `paths:`/`paths-ignore:` — a change outside those paths would ' +
        'skip every gate and report nothing. Remove the filter, or teach this guard why it is safe.',
    );
  }
}

/** Nothing may make the matrix job optional, conditional, or dependent on another gate. */
function assertMatrixJobActuallyGates(job) {
  if (!/npm test --workspace \$\{\{\s*matrix\.workspace\s*\}\}/.test(job.text)) {
    fail(
      `job "${job.name}" declares a \`workspace\` matrix but never runs ` +
        '`npm test --workspace ${{ matrix.workspace }}` — the matrix would fan out to nothing',
    );
  }
  if (/npm test --workspace \$\{\{[^\n]*\}\}[^\n]*\|\|/.test(job.text)) {
    fail(`job "${job.name}" swallows the test command's failure with \`||\``);
  }
  if (!/fail-fast:\s*false/.test(job.text)) {
    fail(
      `job "${job.name}" is missing \`fail-fast: false\` — one workspace going red would cancel ` +
        'the others, so they would stop reporting exactly when it matters',
    );
  }
  if (/fail-fast:\s*true/.test(job.text)) fail(`job "${job.name}" sets \`fail-fast: true\``);
  if (/continue-on-error:/.test(job.text)) {
    fail(`job "${job.name}" uses \`continue-on-error\`, so a failing test would report green`);
  }
  if (/^\s*if:/m.test(job.text)) {
    fail(`job "${job.name}" is conditional on an \`if:\` — a skipped job does not fail a run`);
  }
  if (/^\s*needs:/m.test(job.text)) {
    fail(
      `job "${job.name}" declares \`needs:\` — another gate's failure would skip the tests, ` +
        'which is the blackout this workflow was split up to end',
    );
  }
  if (/^\s*exclude:/m.test(job.text)) {
    fail(`job "${job.name}" uses \`matrix.exclude\`, which removes legs the matrix list claims`);
  }
}

/**
 * This guard is still wired up. ci.yml invokes it as `node scripts/check-test-matrix.mjs`
 * DIRECTLY rather than through `npm run`, and this asserts that exact string, so rewriting the
 * convenience npm script to `echo ok` or appending `|| true` to it cannot disarm the CI copy.
 * Deleting the invocation line still works, by construction — nothing can stop that.
 */
function assertGuardIsStillInvoked(yaml) {
  if (!yaml.includes(SELF_SCRIPT)) {
    fail(
      `no job runs \`${SELF_SCRIPT}\`, so this guard would never execute. Invoke it directly ` +
        'rather than through an npm script, which can be rewritten without touching CI.',
    );
  }
  // CI does not use this script, so rewriting it cannot disarm CI — but a contributor running
  // `npm run check:test-matrix` by hand would be fooled by an `echo ok`, so keep it honest too.
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const alias = root.scripts?.['check:test-matrix'];
  if (alias !== undefined && alias !== SELF_SCRIPT) {
    console.error(
      `::error::root package.json's "check:test-matrix" is \`${alias}\`, which is not exactly ` +
        `\`${SELF_SCRIPT}\` — a contributor running it by hand would not be running this guard`,
    );
    process.exit(1);
  }
}

/** The typecheck gate still exists and still runs `tsc` per workspace. */
function assertTypecheckJobRuns(yaml) {
  if (!/npm run typecheck --workspace/.test(yaml)) {
    fail('no job runs `npm run typecheck --workspace`, so nothing is typechecked');
  }
}

/** A script that exists but runs nothing is the same as no script, and looks like coverage. */
function assertScriptsDoSomething() {
  for (const dir of workspaceDirs()) {
    const rel = dir.slice(ROOT.length + 1);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const test = pkg.scripts?.test;
    const typecheck = pkg.scripts?.typecheck;
    if (hasTestFiles(dir) && !test) {
      console.error(
        `::error::${rel} contains *.test.ts files but has no \`test\` script, so CI never runs them`,
      );
      process.exit(1);
    }
    if (test && !/(--test\b|vitest)/.test(test)) {
      console.error(
        `::error::${rel}'s \`test\` script does not invoke a test runner (\`${test}\`) — it would ` +
          'pass without running anything',
      );
      process.exit(1);
    }
    if (typecheck && !/\btsc\b/.test(typecheck)) {
      console.error(
        `::error::${rel}'s \`typecheck\` script does not invoke \`tsc\` (\`${typecheck}\`) — it ` +
          'would pass without checking anything',
      );
      process.exit(1);
    }
  }
}

const raw = readFileSync(WORKFLOW, 'utf8');
const yaml = stripComments(raw);

assertTriggersOnEveryPullRequest(yaml);
assertGuardIsStillInvoked(yaml);
assertTypecheckJobRuns(yaml);
assertScriptsDoSomething();

const matrices = [...yaml.matchAll(/^\s*workspace:\s*\[([^\]]*)\]\s*$/gm)];
if (matrices.length === 0) {
  fail(
    'could not find a `workspace: [...]` matrix. If the test job was restructured — a YAML ' +
      'block list, an anchor — update scripts/check-test-matrix.mjs to match. Do not delete it.',
  );
}
if (matrices.length > 1) {
  fail(
    `found ${matrices.length} \`workspace: [...]\` matrices; this guard only knows how to check ` +
      'one. Update it before adding another.',
  );
}

const job = matrixJob(yaml);
if (!job) fail('could not locate the job holding the test matrix');
assertMatrixJobActuallyGates(job);

const declared = matrices[0][1]
  .split(',')
  .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
  .filter(Boolean);
if (declared.length === 0) fail('the test matrix is empty');

const expected = workspacesWithScript('test');
const typechecked = workspacesWithScript('typecheck');

const missing = expected.filter((name) => !declared.includes(name));
const extra = declared.filter((name) => !expected.includes(name));
// The typecheck job derives its list at runtime, so it can never miss a NEW workspace — but it
// shrinks silently when an existing one loses its `typecheck` script, and the job's own check
// catches zero rather than "one fewer". Nothing here should be worth testing and not typechecking.
const untypechecked = expected.filter((name) => !typechecked.includes(name));

if (missing.length > 0 || extra.length > 0 || untypechecked.length > 0) {
  for (const name of missing) {
    console.error(
      `::error::workspace "${name}" has a \`test\` script but is NOT in ci.yml's test matrix — ` +
        'its tests would never run. Add it to `matrix.workspace`.',
    );
  }
  for (const name of extra) {
    console.error(
      `::error::ci.yml's test matrix lists "${name}", which has no \`test\` script — that job ` +
        'cannot do anything. Remove it, or give the workspace a `test` script.',
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
  `OK — ci.yml triggers on every pull request, still invokes this guard, fans \`${job.name}\` out ` +
    'to `npm test` with fail-fast on and nothing making it optional, typechecks per workspace, ' +
    `and covers every workspace with a real test script: ${expected.join(', ')}`,
);
