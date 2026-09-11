#!/usr/bin/env node
// Guard: the cli test suite must not write into the home directory.
//
// The cli keeps its state under ~/.backthread (config, first-run flags, nudge throttles,
// the sweep ledger). Every test that drives a real pipeline is supposed to point that at a
// temp dir via BACKTHREAD_CONFIG_DIR — but "supposed to" is a comment, and two tests that
// built their deps by hand with a bare `env: {}` were found rewriting the developer's own
// ~/.backthread/first-run.json on every `npm test`. Nothing failed: the file already said
// `onboarded: true` on the machine that noticed, so the write was a no-op there and a
// silent state change on any other.
//
// This runs the cli suite under a FRESH, EMPTY home and then checks two things:
//   1. nothing under that home named `.backthread` came into existence (the seam this
//      guard is about — the cli's own state dir, which is exactly where a test that
//      forgot BACKTHREAD_CONFIG_DIR lands), and
//   2. the REAL home's ~/.backthread is byte-for-byte as it was before the run — same
//      entries, same sizes, same mtimes. A writer that ignores $HOME (os.userInfo(),
//      a hardcoded path) is not caught by (1) and IS caught by this. On a developer machine
//      a live Backthread hook can touch that directory mid-run and trip it — CI has no
//      such directory, which is where this check is load-bearing.
// BACKTHREAD_CONFIG_DIR is cleared for the run, so an override set in the developer's
// shell cannot make a leaky test look isolated.
//
// Deliberately NOT in scope: `~/.npm`. Two tests spawn the real `npm` binary (doctor's
// version check and the never-throws contract in npm.test.ts), and npm writes its own
// logs and cache under the home it is given. That is a separate seam — a network one —
// and this guard reports it as information rather than failing on it, so a red here
// always means the cli itself wrote state.
//
// `--self-test` proves the guard can fail: it runs a probe that DOES write
// `$HOME/.backthread/probe.json` through the same harness and requires the check to
// report it. A guard that cannot fail is the bug it was added for, one step removed.
//
// Usage (from the repo root, after `npm ci` and the extractor build):
//   node scripts/check-home-isolation.mjs              # run the cli suite, isolated
//   node scripts/check-home-isolation.mjs --self-test  # prove the check catches a write

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIR = join(ROOT, 'cli');
const STATE_DIR_NAME = '.backthread';

// The real home is captured ONCE, before anything overrides $HOME for a child.
const REAL_HOME = homedir();
const REAL_STATE_DIR = join(REAL_HOME, STATE_DIR_NAME);

/** Recursive listing of a directory as `relative path → "size:mtimeMs"`; empty if absent. */
function fingerprint(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = statSync(childAbs);
      if (st.isDirectory()) {
        out.set(`${childRel}/`, 'dir');
        walk(childAbs, childRel);
      } else {
        out.set(childRel, `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir, '');
  return out;
}

function diff(before, after) {
  const changes = [];
  for (const [k, v] of after) {
    if (!before.has(k)) changes.push(`added    ${k}`);
    else if (before.get(k) !== v) changes.push(`modified ${k}`);
  }
  for (const k of before.keys()) if (!after.has(k)) changes.push(`removed  ${k}`);
  return changes;
}

function listUnder(dir) {
  return [...fingerprint(dir).keys()].filter((k) => !k.endsWith('/'));
}

/**
 * Run `command` under a fresh home with the cli's config-dir override cleared, then
 * report what it left behind. Returns { ok, problems, notes } — never throws on a
 * finding, so every finding is printed rather than the first one aborting the rest.
 */
function runIsolated(command, args, cwd) {
  const fakeHome = mkdtempSync(join(tmpdir(), 'backthread-home-isolation-'));
  const realBefore = fingerprint(REAL_STATE_DIR);

  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  delete env.BACKTHREAD_CONFIG_DIR;
  const res = spawnSync(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

  const problems = [];
  const notes = [];
  if (res.error) problems.push(`could not run ${command}: ${res.error.message}`);
  if (res.status !== 0) problems.push(`${command} ${args.join(' ')} exited ${res.status}`);

  const leaked = listUnder(join(fakeHome, STATE_DIR_NAME));
  if (leaked.length > 0) {
    problems.push(
      `the run created ${STATE_DIR_NAME}/ under an empty home — a test is writing cli state without ` +
        `BACKTHREAD_CONFIG_DIR:\n` +
        leaked.map((f) => `    ${STATE_DIR_NAME}/${f}`).join('\n'),
    );
  }

  const realChanges = diff(realBefore, fingerprint(REAL_STATE_DIR));
  if (realChanges.length > 0) {
    problems.push(
      `the REAL ${REAL_STATE_DIR} changed during the run — something writes there regardless of $HOME:\n` +
        realChanges.map((c) => `    ${c}`).join('\n'),
    );
  }

  const other = readdirSync(fakeHome).filter((n) => n !== STATE_DIR_NAME);
  if (other.length > 0) {
    notes.push(`other entries created under the fresh home (not judged by this guard): ${other.join(', ')}`);
  }

  rmSync(fakeHome, { recursive: true, force: true });
  return { ok: problems.length === 0, problems, notes, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function report(label, result) {
  for (const n of result.notes) console.log(`note: ${n}`);
  if (result.ok) {
    console.log(`OK — ${label}: nothing written to ${STATE_DIR_NAME}/ under a fresh home, real ${REAL_STATE_DIR} untouched`);
    return true;
  }
  for (const p of result.problems) console.error(`::error::${label}: ${p}`);
  return false;
}

// --- self-test: the guard must be able to fail -----------------------------------------

function selfTest() {
  // A probe that behaves like the defect: writes cli state under whatever home it is
  // given, with no BACKTHREAD_CONFIG_DIR. If the guard reports this run as clean, the
  // guard is vacuous.
  const probe = mkdtempSync(join(tmpdir(), 'backthread-home-isolation-probe-'));
  const probeScript = join(probe, 'probe.mjs');
  writeFileSync(
    probeScript,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { homedir } from 'node:os';",
      "import { join } from 'node:path';",
      `const dir = join(homedir(), ${JSON.stringify(STATE_DIR_NAME)});`,
      'mkdirSync(dir, { recursive: true });',
      "writeFileSync(join(dir, 'probe.json'), '{}');",
      '',
    ].join('\n'),
  );
  const leaky = runIsolated(process.execPath, [probeScript], probe);
  rmSync(probe, { recursive: true, force: true });

  if (leaky.ok) {
    console.error(`::error::self-test: a probe that wrote ${STATE_DIR_NAME}/probe.json under the fresh home was reported CLEAN — the guard cannot fail`);
    return false;
  }
  if (!leaky.problems.some((p) => p.includes(`${STATE_DIR_NAME}/probe.json`))) {
    console.error(`::error::self-test: the probe's write was not the reason the check failed:\n${leaky.problems.join('\n')}`);
    return false;
  }
  // And a probe that writes nothing must pass, or the check is red for every run.
  const clean = runIsolated(process.execPath, ['-e', '0'], ROOT);
  if (!clean.ok) {
    console.error(`::error::self-test: a probe that wrote nothing was reported as a leak:\n${clean.problems.join('\n')}`);
    return false;
  }
  console.log(`OK — self-test: a write to ${STATE_DIR_NAME}/ under the fresh home is reported, a run that writes nothing is not`);
  return true;
}

// --- main --------------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1);
}

// The suite is invoked directly rather than through `npm test`, which also runs the build
// and the bundle smoke and would spend a minute re-doing what the Test job already did.
const cliPkg = JSON.parse(spawnSync(process.execPath, ['-p', 'JSON.stringify(require("./package.json"))'], { cwd: CLI_DIR, encoding: 'utf8' }).stdout);
const testScript = cliPkg.scripts?.test ?? '';
const runner = testScript.split('&&')[0].trim();
if (!runner.startsWith('node ') || !runner.includes('--test')) {
  console.error(`::error::cli/package.json's test script no longer starts with a node --test invocation; update this guard: ${testScript}`);
  process.exit(1);
}
const suite = runIsolated('sh', ['-c', runner], CLI_DIR);
if (!suite.ok) {
  // The suite's own output, so a red here is diagnosable from the log alone.
  process.stderr.write(suite.stderr.slice(-4000));
}
process.exit(report('cli test suite', suite) ? 0 : 1);
