// The ignore-it-and-nothing-happens statement, kept identical in the three places it is
// written down.
//
// WHY THIS TEST EXISTS. The statement is authoritative on the SERVER — the README says so
// itself ("it comes from the server that enforces it, so it cannot drift from the behaviour
// it describes the way a README can") — and then the README's own one-line outline drifted
// anyway, along with the slash-command description an engineer reads at the moment of being
// asked to supply data about themselves.
//
// The wording that drifted was "your lead sees what the team understands, never who replied".
// Both halves were false: a lead sees each NAMED person's coverage, not just the aggregate,
// and "who replied" is inferable, because credit for a demonstrated answer exists only where
// that person's graded row does. What genuinely is not measured anywhere is how much anyone
// TAKES PART, and that is what the sentence promises now.
//
// A false privacy promise is worst exactly here, at a consent moment, and it is the easiest
// kind to discover — so the three copies are pinned against each other rather than trusted.
//
// WHAT A GREEN RUN HERE DOES NOT PROVE. This pins the three copies TO EACH OTHER. It cannot
// see the server, so all three can be consistently stale, and a reword on the server side
// lands here as a manual update. Fetching the live `--promise` output in CI would close that
// gap and cost a network call plus a signed-in session on every run, which is worse. When you
// change the server statement, change these three too — the string in the fixture is a
// verbatim quote, not a paraphrase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROMISE } from './inflowFixtures.test.js';

const ROOT = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** The claim itself, as a shape rather than a sentence, so punctuation may differ. */
const SAYS = /sees what each person understands,? (?:never|rather than) how much anyone\s+took part/i;

/** The two wordings that were shipped and are false. Neither may return. */
const RETIRED = [/never who replied/i, /sees what the team understands/i];

const DOCS = ['README.md', 'commands/ask-me.md'];

test('the fixture quotes the server statement, including the part that makes it checkable', () => {
  const third = PROMISE.points[2];
  assert.match(third, SAYS);
  // …and the sentence that makes the claim falsifiable rather than reassuring.
  assert.ok(third.includes('"Did not answer" and "was not asked" are the same thing here'));
});

for (const doc of DOCS) {
  test(`${doc} makes the same claim as the fixture`, () => {
    assert.match(read(doc), SAYS);
  });

  test(`${doc} does not carry a retired wording`, () => {
    const text = read(doc);
    for (const bad of RETIRED) assert.doesNotMatch(text, bad);
  });
}

test('the guard can fail: the retired wording does not satisfy the claim, and the claim is not vacuous', () => {
  // Without this, a regex that matched nothing would pass every assertion above.
  const retired = 'your lead sees what the team understands, never who replied.';
  assert.doesNotMatch(retired, SAYS);
  assert.ok(RETIRED.some((r) => r.test(retired)));
  assert.match('your lead sees what each person understands, never how much anyone took part.', SAYS);
  // And the files really were read — an empty string must not pass.
  assert.ok(read('README.md').length > 1000);
  assert.ok(read('commands/ask-me.md').length > 200);
});
