#!/usr/bin/env node
// Guard: a version this repo advertises must be one npm actually serves.
//
// The `backthread` CLI stamps `x-backthread-redact-version` on every request, and the value
// is inlined at bundle time from packages/redact/package.json (cli/esbuild.config.mjs). That
// header is a claim to the reader: "the fence that redacted this transcript is
// @backthread/redact@<version> — go and read it." The package is public precisely so that
// claim can be checked. It was found stamping 0.1.6 while npm served 0.1.2: four releases
// of fence hardening had shipped inside the CLI bundle with no tarball anyone could audit,
// and nothing in the release path could notice, because the version was bumped in a file
// no release reads and the CLI release checks only its own tag.
//
// So: before the CLI publishes, every workspace named here must have its package.json
// version in the list npm serves for it. Fails CLOSED — if npm cannot be asked, that is a
// failure, not a pass.
//
// Usage:
//   node scripts/check-published-version.mjs <workspace-name> [<workspace-name> ...]
//   node scripts/check-published-version.mjs --self-test
//
// `--self-test` proves the check can fail: it re-runs itself with a stub `npm` on PATH
// that serves a list WITHOUT the local version and requires a red, then with a list that
// HAS it and requires a green. The stub is the only test double — the real code path,
// including the spawn, runs both times.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, delimiter } from 'node:path';
import { workspaceDirs } from './workspaces.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

function localVersion(name) {
  for (const dir of workspaceDirs()) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg.name === name) {
      if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
        throw new Error(`${join(dir, "package.json")} has no version`);
      }
      return pkg.version;
    }
  }
  throw new Error(`no workspace is named ${name}`);
}

/** The versions npm serves for `name`. Throws when npm cannot answer — never guesses. */
function servedVersions(name) {
  // `--workspaces=false`: run from the monorepo root, npm otherwise warns that it is
  // ignoring workspaces, and the warning is noise that has nothing to do with the answer.
  const res = spawnSync('npm', ['view', name, 'versions', '--json', '--workspaces=false'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) throw new Error(`could not run npm: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`npm view ${name} versions exited ${res.status}: ${res.stderr.trim()}`);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`npm view ${name} versions returned something that is not JSON: ${res.stdout.slice(0, 200)}`);
  }
  // npm prints a bare string when a package has exactly one version.
  const list = typeof parsed === 'string' ? [parsed] : parsed;
  if (!Array.isArray(list) || list.some((v) => typeof v !== 'string')) {
    throw new Error(`npm view ${name} versions returned an unexpected shape: ${res.stdout.slice(0, 200)}`);
  }
  return list;
}

function check(names) {
  let ok = true;
  for (const name of names) {
    let local;
    let served;
    try {
      local = localVersion(name);
      served = servedVersions(name);
    } catch (e) {
      console.error(`::error::${name}: ${e.message}`);
      ok = false;
      continue;
    }
    if (served.includes(local)) {
      console.log(`OK — ${name}@${local} is served by npm`);
    } else {
      const latest = served[served.length - 1] ?? '(nothing)';
      console.error(
        `::error::${name}@${local} is what this checkout advertises, but npm serves ${latest} at most ` +
          `(${served.length} version(s)). Publish ${name}@${local} first — see RELEASING.md — or the ` +
          `version the CLI stamps in its headers names a fence nobody can read.`,
      );
      ok = false;
    }
  }
  return ok;
}

// --- self-test --------------------------------------------------------------------------

function withStubNpm(servedJson, names) {
  const dir = mkdtempSync(join(tmpdir(), 'check-published-version-'));
  const stub = join(dir, 'npm');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' '${servedJson}'\n`);
  chmodSync(stub, 0o755);
  const res = spawnSync(process.execPath, [SELF, ...names], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
  });
  rmSync(dir, { recursive: true, force: true });
  return res;
}

function selfTest() {
  const name = '@backthread/redact';
  const local = localVersion(name);

  const missing = withStubNpm(JSON.stringify(['0.0.1']), [name]);
  if (missing.status === 0) {
    console.error(`::error::self-test: npm serving only 0.0.1 was accepted for ${name}@${local} — the guard cannot fail`);
    return false;
  }
  const present = withStubNpm(JSON.stringify(['0.0.1', local]), [name]);
  if (present.status !== 0) {
    console.error(`::error::self-test: npm serving ${local} was rejected for ${name}@${local}:\n${present.stderr}`);
    return false;
  }
  const broken = withStubNpm('not json', [name]);
  if (broken.status === 0) {
    console.error('::error::self-test: an unparseable npm answer was accepted — the guard fails open');
    return false;
  }
  console.log(`OK — self-test: a missing version is refused, a served one passes, an unreadable npm answer is refused`);
  return true;
}

// --- main -------------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1);
}
if (args.length === 0) {
  console.error('usage: node scripts/check-published-version.mjs <workspace-name> [...]  |  --self-test');
  process.exit(1);
}
process.exit(check(args) ? 0 : 1);
