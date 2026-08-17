#!/usr/bin/env node
// Guard: a workspace's suite must report at least as many PASSING tests as its checked-in floor.
//
// Why a count and not just `# fail 0`: the test scripts run with
// `--experimental-test-isolation=none`, and that mode SWALLOWS a module-level throw once any test
// in the file has registered — the run exits 0 with `# fail 0` and quietly reports fewer tests
// (measured: 2174 of 2175). `npm test` is happy, the gate is green, and tests have stopped running.
// A floor is the only thing that distinguishes "everything passed" from "less of it ran".
//
// FAIL-CLOSED: a missing or unparsable `# pass` line is a failure, never a pass. "I could not tell"
// and "it passed" must not share an exit code.
//
// Usage:  node scripts/check-test-floor.mjs <workspace-name> <path-to-test-output>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [workspace, outputPath] = process.argv.slice(2);

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (!workspace || !outputPath) fail('usage: check-test-floor.mjs <workspace> <output-file>');

const { floors } = JSON.parse(readFileSync(join(ROOT, 'scripts/test-floors.json'), 'utf8'));
const floor = floors[workspace];
if (typeof floor !== 'number') {
  fail(
    `workspace "${workspace}" has no floor in scripts/test-floors.json, so its suite could shrink ` +
      'to nothing unnoticed. Add one (its current passing count).',
  );
}

let output;
try {
  output = readFileSync(outputPath, 'utf8');
} catch {
  fail(`could not read the test output at ${outputPath} — refusing to assume the suite passed`);
}

// `# pass N` is emitted once per `node --test` invocation. A workspace script may run more than
// one, so take the total rather than the first.
const passes = [...output.matchAll(/^# pass (\d+)$/gm)].map((m) => Number(m[1]));
if (passes.length === 0) {
  fail(
    `found no \`# pass N\` line in ${outputPath} for "${workspace}" — the suite did not report, so ` +
      'this gate cannot say anything about it',
  );
}
const total = passes.reduce((a, b) => a + b, 0);

if (total < floor) {
  fail(
    `"${workspace}" reported ${total} passing test(s), below its floor of ${floor}. Either tests ` +
      'stopped running (a module-level throw is swallowed silently in this mode) or they were ' +
      'removed on purpose — in which case lower the floor in scripts/test-floors.json and say why.',
  );
}

console.log(`OK — "${workspace}" reported ${total} passing test(s), floor ${floor}`);
