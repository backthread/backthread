// The README tells a reader to run something that WORKS.
//
// ⚠ THIS EXISTS BECAUSE THE FIRST VERSION DID NOT, AND ONLY A REAL RUN FOUND IT. The
// README said `npx --yes @backthread/ci`, which is the obvious line and is what the
// package's own dogfood workflow ran. Measured on npm 10.9.8 — the npm that
// `actions/setup-node` installs alongside Node 22:
//
//     working directory has a package.json   -> works
//     working directory has none             -> sh: backthread-ci: command not found
//
// npx derives the command name from the package spec and, with no local manifest to
// anchor its temporary install against, resolves that name without ever fetching the
// package; `~/.npm/_npx` is left empty. `--package=` and `-p … -c …` fail identically.
//
// The failure is exactly inverted from where it hurts least: this client's whole point
// is that a repository need not be a Node project, so the repositories most likely to
// adopt it are precisely the ones with no `package.json` for npx to anchor to. Three
// separate places told people to run the broken form before anything executed it.
//
// A test cannot run a customer's workflow. What it CAN do is stop the instruction
// silently reverting to the form that was measured broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('the README documents the invocation that works in a repo with no package.json', () => {
  assert.match(readme, /npm install -g @backthread\/ci/);
  assert.match(readme, /^\s*- run: backthread-ci\s*$/m);
});

test('the README does not tell anyone to npx this package', () => {
  // Scoped to the quickstart block, because the explanation below it necessarily
  // QUOTES the broken form — a blanket ban would make the README unable to say why.
  const quickstart = readme.slice(0, readme.indexOf('<details>'));
  assert.ok(quickstart.length > 200, 'NEGATIVE CONTROL: the quickstart block must be found');
  assert.doesNotMatch(
    quickstart,
    /npx[^\n]*@backthread\/ci/,
    'npx does not resolve this package in a repository without a package.json',
  );
});

test('the README still explains WHY, so the next person does not "simplify" it back', () => {
  // A rule with no reason attached is a rule someone deletes. The measurement is the
  // reason, so the measurement has to stay next to the instruction.
  assert.match(readme, /command not found/);
  assert.match(readme, /npm 10\.9\.8/);
});

// ⚠ THE README ONCE SAID "the only environment variable this reads beyond
// GitHub's own is BACKTHREAD_ENDPOINT". That sentence was TRUE when written and became
// false the moment the client learned to carry a claim code — and nothing would have
// noticed, because prose has no compiler. These pin the two facts a reader most needs
// and most easily gets wrong.
test('every environment variable the client reads is documented', () => {
  const src = readFileSync(new URL('./connect.ts', import.meta.url), 'utf8');
  const read = [...src.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]);
  // NEGATIVE CONTROL: if the parse stops matching, this must not go quietly green.
  assert.ok(read.length >= 1, `expected connect.ts to read an env var, parsed ${read.length}`);
  const undocumented = [...new Set(read)].filter((name) => !readme.includes(name));
  assert.deepEqual(undocumented, [], 'env vars the client reads and the README never names');
});

test('the README says the claim code is NOT a secret, and does not tell anyone to store it as one', () => {
  // Users who read it as a credential put it in repository secrets. Harmless, and it
  // teaches the wrong thing about a product whose whole pitch is what it does not hold.
  assert.match(readme, /not a credential/i);
  assert.doesNotMatch(readme, /BACKTHREAD_CLAIM: \$\{\{\s*secrets\./);
});
