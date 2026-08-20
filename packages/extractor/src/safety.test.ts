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
// a container that also holds a git token. And it ships in the public MIT package whose
// selling point is that source never leaves the machine, so it is exactly the file an
// evaluating engineer reads to check whether we mean it. A silently-broken traversal guard
// undercuts the claim the package was published to make auditable.
//
// ⚠️ REAL TEMP TREES, NEVER A MOCKED `fs`. The guard's entire job is what the FILESYSTEM
// actually reports — `lstat` vs `stat`, what `realpath` resolves a link to, whether a dangling
// link throws. A mocked `fs` would test our beliefs about those calls instead of the calls, and
// the surviving mutant is a one-word difference between two of them. So every fixture below is
// built on disk, including actual symlinks pointing out of the root.
//
// ⚠️ WRITTEN AGAINST THE PROMISES, ONE MUTANT EACH. Each block names the mutation it exists to
// kill. The point is never that a line is executed; it is that removing a guarantee turns
// something red.
//
//   1. `lstatSync` → `statSync`             — the symlink is no longer detected
//   2. the escape rejection deleted         — a symlink to /etc is accepted
//   3. the separator dropped from the match — `/clone-evil` passes as `/clone`
//   4. the skip check hoisted above `lstat` — `ln -s /etc node_modules` walks straight out
//   5/6/7. `maxFileBytes` / `maxTotalBytes` / `maxFiles` raised, or the comparison inverted
//   8. the DEFAULT_BUDGET default parameter widened — production passes no budget at all
//   9. a `SKIP_DIRS` entry removed          — must not throw, but must change what is counted

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { describe, test, expect } from './testkit.js';
import { enforceSourceBudget, DEFAULT_BUDGET, type SafetyBudget } from './safety.js';

interface Fixtures {
  /** A real directory on disk, with real files in it. Path fully resolved. */
  tree(files?: Record<string, string>): string;
  /** The same, but with the path left UNRESOLVED — see the unresolved-root test. */
  unresolvedTree(files?: Record<string, string>): string;
  /** A directory OUTSIDE any clone — what a hostile symlink wants to reach. */
  outside(): string;
  /** A directory whose NAME merely starts with another's — the prefix-match bypass. */
  sibling(of: string): string;
}

/**
 * Temp trees made during ONE test, removed when it ends — whatever happens.
 *
 * ⚠️ DELIBERATELY NOT AN `afterEach`, AND REVIEW IS WHY. This package runs under
 * `--experimental-test-isolation=none`, where a top-level `afterEach` registers on the shared
 * ROOT context and fires around every test in the whole run rather than around this file's.
 * Cleanup that depends on the runner's context model is a thing to re-reason about at every
 * edit; a `finally` is not. Each test owns its fixtures and disposes of them itself.
 */
function withTrees<T>(body: (make: Fixtures) => T): T {
  const made: string[] = [];
  const write = (dir: string, files: Record<string, string>): string => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, ...rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    return dir;
  };
  const make: Fixtures = {
    unresolvedTree(files = {}) {
      const dir = mkdtempSync(join(tmpdir(), 'bt-safety-'));
      made.push(dir);
      return write(dir, files);
    },
    tree(files = {}) {
      return write(realpathSync(make.unresolvedTree()), files);
    },
    outside() {
      return make.tree({ 'secret.txt': 'a token, or /etc/passwd' });
    },
    sibling(of: string) {
      const dir = `${of}-evil`;
      mkdirSync(dir, { recursive: true });
      made.push(dir);
      return write(dir, { 'secret.txt': 'not yours' });
    },
  };
  try {
    return body(make);
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  }
}

const NO_LIMITS: SafetyBudget = {
  maxFileBytes: Number.MAX_SAFE_INTEGER,
  maxTotalBytes: Number.MAX_SAFE_INTEGER,
  maxFiles: Number.MAX_SAFE_INTEGER,
};

// ═══════════════════════════════════════════════════════════════════════════════
// PROMISES 1–4 — SYMLINKS ARE NOT FOLLOWED, AND ONE THAT ESCAPES IS REJECTED.

describe('the path-traversal guard', () => {
  test('rejects a symlink whose target resolves outside the clone root', () =>
    withTrees((make) => {
      // ⚠️ THE MUTANT THIS EXISTS FOR: delete the `target !== rootReal && !target.startsWith(…)`
      // rejection and a link to anywhere on the filesystem is accepted in silence.
      const root = make.tree({ 'src/app.ts': 'export const a = 1;' });
      symlinkSync(make.outside(), join(root, 'escape'));

      expect(() => enforceSourceBudget(root, NO_LIMITS)).toThrow(/symlink escapes clone root/);
    }));

  test('rejects a symlink to a FILE outside the root, not only a directory', () =>
    withTrees((make) => {
      // A file link is the cheaper attack — no traversal needed, just a read of one path.
      const root = make.tree({ 'src/app.ts': 'export const a = 1;' });
      symlinkSync(join(make.outside(), 'secret.txt'), join(root, 'src/leak.ts'));

      expect(() => enforceSourceBudget(root, NO_LIMITS)).toThrow(/symlink escapes clone root/);
    }));

  test('rejects an ABSOLUTE symlink to a real system path', () =>
    withTrees((make) => {
      // The literal case: a symlink pointing at /etc must not be accepted. `/etc` exists on
      // every platform this runs on and is outside any temp clone.
      const root = make.tree({ 'src/app.ts': 'export const a = 1;' });
      symlinkSync('/etc', join(root, 'etc-link'));

      expect(() => enforceSourceBudget(root, NO_LIMITS)).toThrow(/symlink escapes clone root/);
    }));

  test('rejects a RELATIVE symlink that climbs out with ..', () =>
    withTrees((make) => {
      // The shape a hostile repository can actually commit: git stores the link target verbatim
      // and `../../` is portable in a way an absolute path is not. The guard resolves rather
      // than string-matches, which is the only reason it sees this as the same escape.
      const root = make.tree({ 'src/app.ts': 'export const a = 1;' });
      const outside = make.outside();
      // From `<root>/src`, `..` reaches `<root>` and one more reaches the shared tmp parent
      // that also holds `outside`.
      symlinkSync(join('..', '..', basename(outside), 'secret.txt'), join(root, 'src/climb.ts'));

      expect(() => enforceSourceBudget(root, NO_LIMITS)).toThrow(/symlink escapes clone root/);
    }));

  test('⚠️ rejects a sibling directory whose name merely STARTS WITH the root path', () =>
    withTrees((make) => {
      // `target.startsWith(rootReal)` alone would accept `/tmp/clone-12345-evil` as if it were
      // inside `/tmp/clone-12345`. The guard appends the separator for exactly this; without
      // that one character an attacker picks the directory name and walks out.
      const root = make.tree({ 'src/app.ts': 'export const a = 1;' });
      symlinkSync(make.sibling(root), join(root, 'sibling'));

      expect(() => enforceSourceBudget(root, NO_LIMITS)).toThrow(/symlink escapes clone root/);
    }));

  test('⚠️ rejects an escaping symlink NAMED like a skipped directory', () =>
    withTrees((make) => {
      // ⚠️ REVIEW FINDING, AND THE SHARPEST ONE IN THIS FILE. The ORDER of the two checks is
      // load-bearing: `lstat` and the symlink branch run BEFORE `SKIP_DIRS`. Hoisting the skip
      // check above them survives every other test here — and hands an attacker six names they
      // choose (`.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`) that walk
      // straight past the traversal guard. `ln -s /etc node_modules` is a one-line repository.
      //
      // Nothing else pins "symlinks are judged first", so it is pinned here, for every name on
      // the list rather than for one of them.
      for (const skipped of ['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']) {
        const root = make.tree({ 'src/app.ts': 'export const a = 1;' });
        symlinkSync(make.outside(), join(root, skipped));

        expect(() => enforceSourceBudget(root, NO_LIMITS), skipped).toThrow(
          /symlink escapes clone root/,
        );
      }
    }));

  test('ACCEPTS a symlink that stays inside the clone, and does not traverse it', () =>
    withTrees((make) => {
      // ⚠️ THE POSITIVE HALF. A guard that threw on every symlink would pass all six tests
      // above and break every repo that vendors one. It must reject escapes and only escapes.
      //
      // "Does not traverse" is asserted through the FILE BUDGET rather than by inspection: the
      // link points at a directory holding two files and `maxFiles: 2` passes. Following it
      // would count them twice and throw — the `lstat` → `stat` mutant's observable
      // consequence on an in-tree link.
      const root = make.tree({
        'pkg/a.ts': 'export const a = 1;',
        'pkg/b.ts': 'export const b = 2;',
      });
      symlinkSync(join(root, 'pkg'), join(root, 'alias'));

      expect(() => enforceSourceBudget(root, { ...NO_LIMITS, maxFiles: 2 })).not.toThrow();
    }));

  test('ACCEPTS a symlink to the clone root itself', () =>
    withTrees((make) => {
      // ⚠️ REVIEW FINDING. `target !== rootReal` is a real branch and nothing covered it:
      // deleting it makes `ln -s . self` — which repositories really do commit — fail the
      // ingest of an otherwise innocent repo, with every test green.
      const root = make.tree({ 'src/app.ts': 'export const a = 1;' });
      symlinkSync(root, join(root, 'self'));

      expect(() => enforceSourceBudget(root, NO_LIMITS)).not.toThrow();
    }));

  test('ignores a DANGLING symlink rather than throwing', () =>
    withTrees((make) => {
      // A broken link is a fact about a repo, not an attack, and `realpathSync` throws on it.
      // The guard catches that and continues; otherwise one dead link fails an ingest.
      const root = make.tree({ 'src/app.ts': 'export const a = 1;' });
      symlinkSync(join(root, 'does-not-exist'), join(root, 'dangling'));

      expect(() => enforceSourceBudget(root, NO_LIMITS)).not.toThrow();
    }));

  test('⚠️ a symlink is never COUNTED as a file, however large its target', () =>
    withTrees((make) => {
      // The `lstat` → `stat` mutant from the budget side: under `lstat` a symlink reports the
      // size of the link itself and is skipped before any counting; under `stat` it reports the
      // TARGET's size and is counted. So this fails even where no escape is involved.
      const root = make.tree({ 'src/big.ts': 'x'.repeat(4096) });
      symlinkSync(join(root, 'src/big.ts'), join(root, 'src/alias.ts'));

      expect(() =>
        enforceSourceBudget(root, { maxFileBytes: 8192, maxTotalBytes: 5000, maxFiles: 1 }),
      ).not.toThrow();
    }));

  test('⚠️ works on an UNRESOLVED root, so it is the guard resolving and not the caller', () =>
    withTrees((make) => {
      // ⚠️ REVIEW FINDING, AND IT CORRECTED THIS FILE'S OWN REASONING. An earlier note here
      // claimed fixtures MUST pre-resolve their root or in-tree symlinks would look like
      // escapes. That is false: `enforceSourceBudget` calls `realpathSync(root)` itself, so the
      // comparison is resolved-to-resolved whatever the caller passes — and because every
      // fixture WAS pre-resolved, replacing that call with `resolve(root)` survived the whole
      // suite. A test resting on a false premise is a test nobody can maintain.
      //
      // On macOS `os.tmpdir()` is `/var/folders/…` and `/var` is a symlink to `/private/var`,
      // so an unresolved root is exactly where that mutant bites. Both halves are asserted: an
      // in-tree link is still accepted, and an escape is still caught.
      const root = make.unresolvedTree({ 'pkg/a.ts': 'export const a = 1;' });
      symlinkSync(join(root, 'pkg'), join(root, 'alias'));
      expect(() => enforceSourceBudget(root, NO_LIMITS)).not.toThrow();

      symlinkSync(make.outside(), join(root, 'escape'));
      expect(() => enforceSourceBudget(root, NO_LIMITS)).toThrow(/symlink escapes clone root/);
    }));
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROMISES 5, 6, 7, 8 — THE THREE BUDGETS, AND THE DEFAULTS NOBODY PASSES.

describe('the content budgets', () => {
  test('maxFileBytes — rejects a single file over the cap, and accepts one at it', () =>
    withTrees((make) => {
      // ⚠️ MUTANTS: raise `maxFileBytes`, or invert `>`. The PAIR pins the boundary, so `>` →
      // `>=` also fails — a one-character change a lone "too big throws" test cannot see.
      const root = make.tree({ 'src/big.ts': 'x'.repeat(1000) });

      expect(() => enforceSourceBudget(root, { ...NO_LIMITS, maxFileBytes: 999 })).toThrow(
        /file exceeds 999 bytes/,
      );
      expect(() => enforceSourceBudget(root, { ...NO_LIMITS, maxFileBytes: 1000 })).not.toThrow();
    }));

  test('maxTotalBytes — rejects a tree over the cap even when every file is small', () =>
    withTrees((make) => {
      // The zip-bomb shape: nothing individually suspicious, everything together fatal.
      const root = make.tree({
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
    }));

  test('maxFiles — rejects a tree with more files than the cap, and accepts one at it', () =>
    withTrees((make) => {
      const root = make.tree({ 'a.ts': '1', 'b.ts': '2', 'c.ts': '3' });

      expect(() => enforceSourceBudget(root, { ...NO_LIMITS, maxFiles: 2 })).toThrow(
        /more than 2 files/,
      );
      expect(() => enforceSourceBudget(root, { ...NO_LIMITS, maxFiles: 3 })).not.toThrow();
    }));

  test('⚠️ the DEFAULT budget is enforced when the caller passes none', () =>
    withTrees((make) => {
      // ⚠️ REVIEW FINDING. Every test above passes an explicit budget, so swapping the default
      // parameter for `{ Infinity, Infinity, Infinity }` survived all of them — and the default
      // parameter is the form production uses: nothing calls `enforceSourceBudget` with a
      // budget at all.
      //
      // So: one file just over `DEFAULT_BUDGET.maxFileBytes`, and the call made the way the
      // container makes it. 8 MB of writes is the cost of covering the only code path that
      // actually ships. The pair is kept, so this is the CAP biting rather than "a big file
      // throws".
      const root = make.tree({});
      writeFileSync(join(root, 'bomb.ts'), 'x'.repeat(DEFAULT_BUDGET.maxFileBytes + 1));
      expect(() => enforceSourceBudget(root)).toThrow(/file exceeds/);

      writeFileSync(join(root, 'bomb.ts'), 'x'.repeat(DEFAULT_BUDGET.maxFileBytes));
      expect(() => enforceSourceBudget(root)).not.toThrow();
    }));

  test('the shipped defaults are the ones the container runs with', () =>
    withTrees(() => {
      // A budget nobody pins can be "tuned" to infinity in a one-line diff.
      expect(DEFAULT_BUDGET).toEqual({
        maxFileBytes: 8 * 1024 * 1024,
        maxTotalBytes: 512 * 1024 * 1024,
        maxFiles: 50_000,
      });
    }));
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROMISE 9 — THE SKIP LIST CHANGES WHAT IS COUNTED.

describe('the skipped directories', () => {
  // ⚠️ NOT A "DOES IT THROW" TEST, WHICH IS WHY IT IS EASY TO GET WRONG. Removing a SKIP_DIRS
  // entry does not throw — it makes the walk descend into a directory it should have stepped
  // over, and the only observable consequence is that MORE is counted. So the budget is the
  // instrument: a cap that fits the source files alone must survive a large skipped directory,
  // and must not survive that directory being walked.
  for (const skipped of ['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']) {
    test(`${skipped} is not counted against the budget`, () =>
      withTrees((make) => {
        const root = make.tree({
          'src/app.ts': 'export const a = 1;',
          [`${skipped}/junk-1.bin`]: 'x'.repeat(5000),
          [`${skipped}/junk-2.bin`]: 'x'.repeat(5000),
        });

        // Room for exactly the one real source file. Were `${skipped}` walked, three files and
        // ~10 KB would be counted and both caps would blow.
        expect(() =>
          enforceSourceBudget(root, { maxFileBytes: 4096, maxTotalBytes: 100, maxFiles: 1 }),
        ).not.toThrow();
      }));
  }

  test('⚠️ the skip list is a NAME match, and a directory not on it IS walked', () =>
    withTrees((make) => {
      // The negative control for the block above: without it, a mutant that skipped EVERY
      // directory would pass all six by counting nothing at all. It asserts the SPECIFIC error
      // — a bare `toThrow()` goes green on any error, including a broken fixture.
      const root = make.tree({
        'src/app.ts': 'export const a = 1;',
        'vendor/junk-1.bin': 'x'.repeat(5000),
        'vendor/junk-2.bin': 'x'.repeat(5000),
      });

      expect(() =>
        enforceSourceBudget(root, { maxFileBytes: 4096, maxTotalBytes: 100, maxFiles: 1 }),
      ).toThrow(/file exceeds 4096 bytes/);
    }));

  test('a skipped name nested deep in the tree is skipped there too', () =>
    withTrees((make) => {
      // `SKIP_DIRS` is checked on the basename at every level, not only at the root — a
      // monorepo has one `node_modules` per package and only the deep ones carry the weight.
      const root = make.tree({
        'packages/a/src/app.ts': 'export const a = 1;',
        'packages/a/node_modules/dep/index.js': 'x'.repeat(5000),
      });

      expect(() =>
        enforceSourceBudget(root, { maxFileBytes: 4096, maxTotalBytes: 100, maxFiles: 1 }),
      ).not.toThrow();
    }));
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE HARNESS'S OWN PRECONDITIONS.

describe('the fixtures are what they claim to be', () => {
  // ⚠️ A HARNESS THAT CAN FAIL QUIETLY IS WORSE THAN NONE. Every test above rests on two facts
  // no assertion in them checks: that `symlinkSync` really made a symlink (a filesystem or CI
  // runner without the privilege could silently produce a copy, and every escape test would
  // then pass over a plain file), and that the "outside" tree really is outside the root.
  test('symlinkSync produces a real symlink, and the outside tree really is outside', () =>
    withTrees((make) => {
      const root = make.tree({ 'src/app.ts': 'export const a = 1;' });
      const outside = make.outside();
      const link = join(root, 'escape');
      symlinkSync(outside, link);

      // ⚠️ `lstat`, NOT a comment claiming lstat. An earlier version described this check in
      // prose and never made it, which is the same defect as the one under test.
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(outside);
      expect(outside.startsWith(`${root}/`)).toBe(false);
      expect(outside).not.toBe(root);
    }));

  test('an empty tree passes, so an escape test failing is never "the walk found nothing"', () =>
    withTrees((make) => {
      const root = make.tree();
      expect(() =>
        enforceSourceBudget(root, { maxFileBytes: 1, maxTotalBytes: 1, maxFiles: 0 }),
      ).not.toThrow();
    }));
});
