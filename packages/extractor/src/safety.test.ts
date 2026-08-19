// The source-tree safety budget, tested by MUTATION rather than by coverage.
//
// ⚠️ WHY THIS FILE EXISTS. A verifier mutation-tested the extractor and one mutant survived in
// the worst possible place: changing `lstatSync(p)` to `statSync(p)` in `enforceSourceBudget`'s
// walk — i.e. making the symlink-escape guard FOLLOW symlinks, precisely the thing its own
// comment says it must never do — left the whole suite at 2175 passing, exit 0. The
// path-traversal guard had no test that failed when it stopped working.
//
// That matters more than a normal coverage gap for three reasons. `safety.ts` runs inside the
// ephemeral container before extraction, against UNTRUSTED repositories. It is the only thing
// standing between a hostile repo's symlink and the container filesystem outside the clone —
// a container that also holds a GitHub token. And it ships in the public MIT package whose
// selling point is that source never leaves the machine, so it is exactly the file an
// evaluating engineer reads to check whether we mean it. A silently-broken traversal guard
// undercuts the claim the package was published to make auditable.
//
// ⚠️ REAL TEMP TREES, NEVER A MOCKED `fs`. The guard's entire job is what the FILESYSTEM
// actually reports — `lstat` vs `stat`, what `realpath` resolves a link to, whether a dangling
// link throws. A mocked `fs` would test our beliefs about those calls instead of the calls, and
// the surviving mutant is a one-word difference between two of them. So every fixture below is
// built on disk, including an actual symlink pointing out of the root.
//
// ⚠️ AND THE SUITE IS WRITTEN AGAINST THE FIVE PROMISES, ONE MUTANT EACH. Each block names the
// mutation it is built to kill. The point is not that these lines are executed; it is that
// removing the guarantee turns something red.
//
//   1. `lstatSync` → `statSync`            — the symlink is no longer detected
//   2. the escape rejection deleted        — a symlink to /etc is accepted
//   3/4/5. `maxFileBytes` / `maxTotalBytes` / `maxFiles` raised or inverted
//   6. a `SKIP_DIRS` entry removed         — must not throw, but must change what is counted

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, test, expect, afterEach } from './testkit.js';
import { enforceSourceBudget, DEFAULT_BUDGET, type SafetyBudget } from './safety.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A real directory on disk.
 *
 * ⚠️ `realpathSync` ON THE ROOT IS LOAD-BEARING, not tidiness. On macOS `os.tmpdir()` is
 * `/var/folders/...`, and `/var` is itself a symlink to `/private/var`. `enforceSourceBudget`
 * calls `realpathSync(root)` and compares resolved link targets against THAT, so a fixture that
 * kept the unresolved path would make every in-tree symlink look like an escape — the tests
 * would pass for the wrong reason and would keep passing with the guard removed.
 */
function tree(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bt-safety-')));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/** A directory OUTSIDE any clone — the thing a hostile symlink wants to reach. */
function outsideTree(files: Record<string, string> = { 'secret.txt': 'a token, or /etc/passwd' }): string {
  return tree(files);
}

const NO_LIMITS: SafetyBudget = {
  maxFileBytes: Number.MAX_SAFE_INTEGER,
  maxTotalBytes: Number.MAX_SAFE_INTEGER,
  maxFiles: Number.MAX_SAFE_INTEGER,
};

// ═══════════════════════════════════════════════════════════════════════════════
// PROMISE 1 + 2 — SYMLINKS ARE NOT FOLLOWED, AND ONE THAT ESCAPES IS REJECTED.

describe('the path-traversal guard', () => {
  test('rejects a symlink whose target resolves outside the clone root', () => {
    // ⚠️ THE MUTANT THIS EXISTS FOR: delete the `target !== rootReal && !target.startsWith(...)`
    // rejection, and a link to anywhere on the filesystem is accepted in silence.
    const outside = outsideTree();
    const root = tree({ 'src/app.ts': 'export const a = 1;' });
    symlinkSync(outside, join(root, 'escape'));

    expect(() => enforceSourceBudget(root, NO_LIMITS)).toThrow(/symlink escapes clone root/);
  });

  test('rejects a symlink to a FILE outside the root, not only a directory', () => {
    // A file link is the cheaper attack — it needs no traversal, just a read of one path.
    const outside = outsideTree();
    const root = tree({ 'src/app.ts': 'export const a = 1;' });
    symlinkSync(join(outside, 'secret.txt'), join(root, 'src/leak.ts'));

    expect(() => enforceSourceBudget(root, NO_LIMITS)).toThrow(/symlink escapes clone root/);
  });

  test('rejects an ABSOLUTE symlink to a real system path', () => {
    // The literal case the ticket names: a symlink pointing at /etc must not be accepted.
    // `/etc` exists on every platform this runs on and is outside any temp clone.
    const root = tree({ 'src/app.ts': 'export const a = 1;' });
    symlinkSync('/etc', join(root, 'etc-link'));

    expect(() => enforceSourceBudget(root, NO_LIMITS)).toThrow(/symlink escapes clone root/);
  });

  test('rejects a RELATIVE symlink that climbs out with ..', () => {
    // The shape a hostile repository can actually commit: git stores the link target verbatim,
    // and `../../` is portable in a way an absolute path is not. `realpathSync` resolves it, so
    // the guard sees the same escape — but only because it resolves rather than string-matches.
    const outside = outsideTree();
    const root = tree({ 'src/app.ts': 'export const a = 1;' });
    // From `<root>/src`, `..` reaches `<root>`, and one more `..` reaches the shared tmp parent
    // that also holds `outside`.
    const relative = join('..', '..', outside.split('/').pop() as string, 'secret.txt');
    symlinkSync(relative, join(root, 'src/climb.ts'));

    expect(() => enforceSourceBudget(root, NO_LIMITS)).toThrow(/symlink escapes clone root/);
  });

  test('⚠️ rejects a sibling directory whose name merely STARTS WITH the root path', () => {
    // `target.startsWith(rootReal)` alone would accept `/tmp/clone-12345-evil` as if it were
    // inside `/tmp/clone-12345`. The guard appends the separator for exactly this; without that
    // one character an attacker picks the directory name and walks straight out.
    const root = tree({ 'src/app.ts': 'export const a = 1;' });
    const evil = `${root}-evil`;
    mkdirSync(evil, { recursive: true });
    tmpDirs.push(evil);
    writeFileSync(join(evil, 'secret.txt'), 'not yours');
    symlinkSync(evil, join(root, 'sibling'));

    expect(() => enforceSourceBudget(root, NO_LIMITS)).toThrow(/symlink escapes clone root/);
  });

  test('ACCEPTS a symlink that stays inside the clone, and does not traverse it', () => {
    // ⚠️ THE POSITIVE HALF. A guard that threw on every symlink would pass all five tests above
    // and break every repo that vendors one. It must reject escapes and only escapes.
    //
    // And "does not traverse" is asserted through the FILE BUDGET rather than by inspection:
    // the link points at a directory holding two files, and `maxFiles: 2` passes. Following the
    // link would count them a second time and throw. That is the `lstat` → `stat` mutant's
    // observable consequence on an in-tree link.
    const root = tree({
      'pkg/a.ts': 'export const a = 1;',
      'pkg/b.ts': 'export const b = 2;',
    });
    symlinkSync(join(root, 'pkg'), join(root, 'alias'));

    expect(() => enforceSourceBudget(root, { ...NO_LIMITS, maxFiles: 2 })).not.toThrow();
  });

  test('ignores a DANGLING symlink rather than throwing', () => {
    // A broken link is a fact about a repo, not an attack, and `realpathSync` throws on it. The
    // guard catches that and continues; if it did not, one dead link would fail an ingest.
    const root = tree({ 'src/app.ts': 'export const a = 1;' });
    symlinkSync(join(root, 'does-not-exist'), join(root, 'dangling'));

    expect(() => enforceSourceBudget(root, NO_LIMITS)).not.toThrow();
  });

  test('⚠️ a symlink is never COUNTED as a file, however large its target', () => {
    // The `lstat` → `stat` mutant again, from the budget side: under `lstat` a symlink reports
    // the size of the link itself and is skipped before any counting; under `stat` it reports
    // the TARGET's size and is counted. An in-tree link to a big file therefore passes here and
    // trips `maxFileBytes` under the mutant — so this fails even when no escape is involved.
    const big = 'x'.repeat(4096);
    const root = tree({ 'src/big.ts': big });
    symlinkSync(join(root, 'src/big.ts'), join(root, 'src/alias.ts'));

    // A budget that admits the real file exactly once and nothing more.
    expect(() =>
      enforceSourceBudget(root, { maxFileBytes: 8192, maxTotalBytes: 5000, maxFiles: 1 }),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROMISES 3, 4, 5 — THE THREE BUDGETS.

describe('the content budgets', () => {
  test('maxFileBytes — rejects a single file over the cap, and accepts one at it', () => {
    // ⚠️ MUTANTS: raise `maxFileBytes`, or invert the `>` comparison. The pair of assertions
    // pins the BOUNDARY, so flipping `>` to `>=` also fails — a one-character change that a
    // single "too big throws" test cannot see.
    const root = tree({ 'src/big.ts': 'x'.repeat(1000) });

    expect(() => enforceSourceBudget(root, { ...NO_LIMITS, maxFileBytes: 999 })).toThrow(
      /file exceeds 999 bytes/,
    );
    expect(() => enforceSourceBudget(root, { ...NO_LIMITS, maxFileBytes: 1000 })).not.toThrow();
  });

  test('maxTotalBytes — rejects a tree over the cap even when every file is small', () => {
    // The zip-bomb shape: nothing individually suspicious, everything together fatal.
    const root = tree({
      'src/a.ts': 'x'.repeat(400),
      'src/b.ts': 'x'.repeat(400),
      'src/c.ts': 'x'.repeat(400),
    });

    expect(() =>
      enforceSourceBudget(root, { ...NO_LIMITS, maxFileBytes: 1000, maxTotalBytes: 1199 }),
    ).toThrow(/tree exceeds 1199 bytes/);
    expect(() =>
      enforceSourceBudget(root, { ...NO_LIMITS, maxFileBytes: 1000, maxTotalBytes: 1200 }),
    ).not.toThrow();
  });

  test('maxFiles — rejects a tree with more files than the cap, and accepts one at it', () => {
    const root = tree({ 'a.ts': '1', 'b.ts': '2', 'c.ts': '3' });

    expect(() => enforceSourceBudget(root, { ...NO_LIMITS, maxFiles: 2 })).toThrow(
      /more than 2 files/,
    );
    expect(() => enforceSourceBudget(root, { ...NO_LIMITS, maxFiles: 3 })).not.toThrow();
  });

  test('the shipped defaults are the ones the container runs with', () => {
    // A budget nobody pins can be "tuned" to infinity in a one-line diff. These three numbers
    // are the whole guard when no caller passes an override, and `enforceSourceBudget`'s
    // default parameter is what the container actually uses.
    expect(DEFAULT_BUDGET).toEqual({
      maxFileBytes: 8 * 1024 * 1024,
      maxTotalBytes: 512 * 1024 * 1024,
      maxFiles: 50_000,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROMISE 6 — THE SKIP LIST CHANGES WHAT IS COUNTED.

describe('the skipped directories', () => {
  // ⚠️ THIS ONE IS NOT A "DOES IT THROW" TEST, WHICH IS WHY IT IS EASY TO GET WRONG. Removing a
  // SKIP_DIRS entry does not throw — it makes the walk descend into a directory it should have
  // stepped over, and the only observable consequence is that MORE is counted. So the budget is
  // the instrument: a cap that fits the source files alone must survive the presence of a large
  // skipped directory, and must not survive that directory being walked.
  for (const skipped of ['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']) {
    test(`${skipped} is not counted against the budget`, () => {
      const root = tree({
        'src/app.ts': 'export const a = 1;',
        [`${skipped}/junk-1.bin`]: 'x'.repeat(5000),
        [`${skipped}/junk-2.bin`]: 'x'.repeat(5000),
      });

      // Room for exactly the one real source file. If `${skipped}` were walked, three files and
      // ~10KB would be counted and both caps would blow.
      expect(() =>
        enforceSourceBudget(root, { maxFileBytes: 4096, maxTotalBytes: 100, maxFiles: 1 }),
      ).not.toThrow();
    });
  }

  test('⚠️ the skip list is a NAME match, and a directory not on it IS walked', () => {
    // The negative control for the block above: without it, a mutant that skipped EVERY
    // directory would pass all six tests and count nothing at all.
    const root = tree({
      'src/app.ts': 'export const a = 1;',
      'vendor/junk-1.bin': 'x'.repeat(5000),
      'vendor/junk-2.bin': 'x'.repeat(5000),
    });

    expect(() =>
      enforceSourceBudget(root, { maxFileBytes: 4096, maxTotalBytes: 100, maxFiles: 1 }),
    ).toThrow();
  });

  test('a skipped name nested deep in the tree is skipped there too', () => {
    // `SKIP_DIRS` is checked on the basename at every level, not only at the root — a monorepo
    // has one `node_modules` per package, and only the deep ones carry the weight.
    const root = tree({
      'packages/a/src/app.ts': 'export const a = 1;',
      'packages/a/node_modules/dep/index.js': 'x'.repeat(5000),
    });

    expect(() =>
      enforceSourceBudget(root, { maxFileBytes: 4096, maxTotalBytes: 100, maxFiles: 1 }),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE HARNESS'S OWN PRECONDITIONS.

describe('the fixtures are what they claim to be', () => {
  // ⚠️ A HARNESS THAT CAN FAIL QUIETLY IS WORSE THAN NONE. Every test above rests on two facts
  // that no assertion in them checks: that `symlinkSync` really made a symlink (a filesystem or
  // a CI runner without the privilege could silently produce a copy, and every escape test
  // would then pass over a plain file), and that `outsideTree()` really is outside the root.
  test('symlinkSync produces a real symlink, and the outside tree really is outside', () => {
    const outside = outsideTree();
    const root = tree({ 'src/app.ts': 'export const a = 1;' });
    const link = join(root, 'escape');
    symlinkSync(outside, link);

    // lstat sees a link; realpath resolves it to somewhere that is not under the root.
    expect(realpathSync(link)).toBe(outside);
    expect(outside.startsWith(`${root}/`)).toBe(false);
    expect(outside).not.toBe(root);
  });

  test('an empty tree passes, so an escape test failing is never "the walk found nothing"', () => {
    const root = tree({});
    expect(() => enforceSourceBudget(root, { maxFileBytes: 1, maxTotalBytes: 1, maxFiles: 0 })).not.toThrow();
  });
});
