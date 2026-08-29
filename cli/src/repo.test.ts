import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRepoFromRemote,
  resolveRepo,
  resolveGitContext,
  resolveRepoRoots,
  type GitRunner,
} from './repo.js';

test('parseRepoFromRemote handles scp-style SSH', () => {
  assert.deepEqual(parseRepoFromRemote('git@github.com:backthread/marola-platform.git'), {
    owner: 'backthread',
    name: 'marola-platform',
  });
});

test('parseRepoFromRemote handles ssh:// URLs', () => {
  assert.deepEqual(parseRepoFromRemote('ssh://git@github.com/acme/app.git'), {
    owner: 'acme',
    name: 'app',
  });
});

test('parseRepoFromRemote handles HTTPS (with and without .git)', () => {
  assert.deepEqual(parseRepoFromRemote('https://github.com/acme/app'), { owner: 'acme', name: 'app' });
  assert.deepEqual(parseRepoFromRemote('https://github.com/acme/app.git'), { owner: 'acme', name: 'app' });
});

test('parseRepoFromRemote handles token-in-URL HTTPS', () => {
  assert.deepEqual(parseRepoFromRemote('https://x-access-token:TOKEN@github.com/acme/app.git'), {
    owner: 'acme',
    name: 'app',
  });
});

test('parseRepoFromRemote takes the tail two segments for nested groups', () => {
  assert.deepEqual(parseRepoFromRemote('https://ghe.corp/team/sub/repo.git'), {
    owner: 'sub',
    name: 'repo',
  });
});

test('parseRepoFromRemote returns null on garbage', () => {
  assert.equal(parseRepoFromRemote(''), null);
  assert.equal(parseRepoFromRemote('not-a-url'), null);
  assert.equal(parseRepoFromRemote('https://github.com/only-one-segment'), null);
});

test('resolveRepo returns null when the remote reader yields null (no git / no origin)', () => {
  assert.equal(resolveRepo('/tmp/x', () => null), null);
});

test('resolveRepo maps a read remote through the parser', () => {
  assert.deepEqual(
    resolveRepo('/tmp/x', () => 'git@github.com:acme/app.git\n'),
    { owner: 'acme', name: 'app' },
  );
});

// --- ARP-696: resolveGitContext ----------------------------------------------

// A runner that answers the rev-parse + git-config calls from a fixture map.
function gitRunner(map: { branch?: string | null; sha?: string | null; name?: string | null; email?: string | null }): GitRunner {
  return (_cwd, args) => {
    if (args.includes('--abbrev-ref')) return map.branch ?? null;
    if (args[0] === 'rev-parse') return map.sha ?? null;
    if (args[0] === 'config' && args[1] === 'user.name') return map.name ?? null;
    if (args[0] === 'config' && args[1] === 'user.email') return map.email ?? null;
    return null;
  };
}

test('resolveGitContext returns the trimmed branch + sha + "Name <email>" git user', () => {
  assert.deepEqual(
    resolveGitContext('/tmp/x', gitRunner({ branch: 'feat/x\n', sha: 'abc123\n', name: 'Jane Doe\n', email: 'jane@x.com\n' })),
    { branch: 'feat/x', headSha: 'abc123', gitUser: 'Jane Doe <jane@x.com>' },
  );
});

test('resolveGitContext maps a detached HEAD (branch "HEAD") to null branch, keeps the sha', () => {
  assert.deepEqual(resolveGitContext('/tmp/x', gitRunner({ branch: 'HEAD\n', sha: 'abc123\n' })), {
    branch: null,
    headSha: 'abc123',
    gitUser: null, // no user.name/user.email configured
  });
});

test('resolveGitContext returns nulls for a non-git cwd (runner returns null)', () => {
  assert.deepEqual(resolveGitContext('/tmp/x', gitRunner({ branch: null, sha: null })), {
    branch: null,
    headSha: null,
    gitUser: null,
  });
});

test('resolveGitContext falls back to email-only / name-only git user', () => {
  assert.equal(resolveGitContext('/tmp/x', gitRunner({ email: 'e@x.com' })).gitUser, 'e@x.com');
  assert.equal(resolveGitContext('/tmp/x', gitRunner({ name: 'Just Name' })).gitUser, 'Just Name');
});

// --- resolveRepoRoots: which directories ARE this repo -----------------------
//
// The question under test is a git question, so most of these run against REAL git
// repos in a temp dir rather than a mocked runner. A mock would only prove the parser
// agrees with the fixture its own author wrote; what has to be true is that a linked
// worktree is recognised as the same repo and a neighbouring repo is not.

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A repo with one commit, so `worktree add` has something to check out. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
}

test('resolveRepoRoots returns the checkout AND its linked worktrees, but not a neighbouring repo', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bt-roots-')));
  try {
    const main = join(tmp, 'app');
    const lane1 = join(tmp, 'app-lane1');
    const lane2 = join(tmp, 'app-lane2');
    const foreign = join(tmp, 'other-repo'); // a DIFFERENT repo, sitting right next door
    initRepo(main);
    initRepo(foreign);
    git(main, 'worktree', 'add', '-q', '-b', 'lane1', lane1);
    git(main, 'worktree', 'add', '-q', '-b', 'lane2', lane2);

    // Asked from the main checkout.
    const fromMain = resolveRepoRoots(main);
    assert.equal(fromMain[0], main, "the session's own toplevel must come first");
    assert.deepEqual([...fromMain].sort(), [main, lane1, lane2].sort());

    // Asked from a linked worktree — the SAME repo identity, its own toplevel first.
    const fromLane = resolveRepoRoots(lane1);
    assert.equal(fromLane[0], lane1);
    assert.deepEqual([...fromLane].sort(), [main, lane1, lane2].sort());

    // NEGATIVE CONTROL: the neighbouring repo is never a root of this one, in either
    // direction. If this ever fails, the widening has become a leak.
    assert.ok(!fromMain.includes(foreign), 'a foreign repo must never be a root');
    assert.ok(!fromLane.includes(foreign), 'a foreign repo must never be a root');
    assert.deepEqual(resolveRepoRoots(foreign), [foreign]);

    // And the probe itself can fail: the foreign repo WITH a worktree of its own
    // reports two roots, so the one-element answer above is a real result rather
    // than a call that quietly returned nothing.
    const foreignLane = join(tmp, 'other-repo-lane');
    git(foreign, 'worktree', 'add', '-q', '-b', 'flane', foreignLane);
    assert.deepEqual([...resolveRepoRoots(foreign)].sort(), [foreign, foreignLane].sort());
    assert.ok(!resolveRepoRoots(foreign).includes(main));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveRepoRoots resolves a SUBDIRECTORY to the repo toplevel, so sibling files still count', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bt-roots-sub-')));
  try {
    const main = join(tmp, 'app');
    initRepo(main);
    mkdirSync(join(main, 'packages', 'core'), { recursive: true });
    assert.equal(resolveRepoRoots(join(main, 'packages', 'core'))[0], main);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveRepoRoots falls back to the cwd when it is not a git repo at all', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bt-roots-nogit-')));
  try {
    assert.deepEqual(resolveRepoRoots(tmp), [tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The common-dir comparison IS the allowlist, so it gets a case that can only pass if
// the comparison actually runs: a listed worktree whose git common dir belongs to
// another repo is refused, even though `git worktree list` named it.
test('resolveRepoRoots refuses a listed worktree whose git common dir is a different repo', () => {
  const run: GitRunner = (cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/work/app\n';
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      // The impostor answers with ANOTHER repo's object store.
      return cwd === '/work/impostor' ? '/work/other/.git\n' : '/work/app/.git\n';
    }
    if (args[0] === 'worktree') {
      return ['worktree /work/app', '', 'worktree /work/lane1', '', 'worktree /work/impostor', ''].join('\n');
    }
    return null;
  };
  assert.deepEqual(resolveRepoRoots('/work/app', run), ['/work/app', '/work/lane1']);
});

test('resolveRepoRoots reads only the `worktree` lines of the porcelain record', () => {
  const run: GitRunner = (_cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/work/app\n';
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return '/work/app/.git\n';
    if (args[0] === 'worktree') {
      return [
        'worktree /work/app',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree /work/lane1',
        'HEAD 2222222222222222222222222222222222222222',
        'detached',
        'locked',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n');
    }
    return null;
  };
  // `HEAD …`, `branch …`, `detached`, `locked` and `prunable …` are not paths.
  assert.deepEqual(resolveRepoRoots('/work/app', run), ['/work/app', '/work/lane1']);
});

// A hook payload's `cwd` is whatever the host agent reported, which is not guaranteed
// to be the physical path — `/tmp` is a symlink on macOS, and people symlink project
// dirs. Measured against a LOGICAL cwd, git's common dir answer resolves somewhere no
// candidate can match and every worktree is refused: the widening degrades to exactly
// the behaviour it exists to replace, silently. This is why the identity is taken from
// the toplevel and not from the cwd.
test('resolveRepoRoots still finds the worktrees when reached through a SYMLINKED path', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bt-roots-link-')));
  try {
    const real = join(tmp, 'real');
    mkdirSync(real, { recursive: true });
    const main = join(real, 'app');
    const lane1 = join(real, 'app-lane1');
    initRepo(main);
    git(main, 'worktree', 'add', '-q', '-b', 'lane1', lane1);
    symlinkSync(real, join(tmp, 'link'), 'dir');

    const linked = join(tmp, 'link', 'app');
    const linkedLane = join(tmp, 'link', 'app-lane1');
    const viaLink = resolveRepoRoots(linked);
    // Both the real directories AND the spelling the caller used, for EVERY root. An
    // agent started under the symlink reports its file paths under the symlink too, and
    // a physical root does not prefix-match those — so measuring only physically would
    // buy worktree matching by taking away the session's own paths. The sibling worktree
    // needs the same treatment: it is reached through the same link.
    assert.deepEqual([...viaLink].sort(), [main, lane1, linked, linkedLane].sort());
    assert.equal(viaLink[0], main, 'the physical toplevel still leads');
    // The probe is live: reached physically, there is no alias to add.
    assert.deepEqual([...resolveRepoRoots(main)].sort(), [main, lane1].sort());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The real shape of this on macOS: `/var` is a symlink to `/private/var`, so the
// substituted prefix sits MANY segments above the repos. A root's alias has to keep the
// whole path below the link, not just the repo's own directory name — otherwise every
// repo collapses to the same place and the aliases name directories that do not exist.
// A symlink that RENAMES the checkout — `~/proj -> ~/www/thing`, which is how a lot of
// people shorten a path they type often. The two spellings share no trailing segment, so
// the whole of one maps to the whole of the other.
test('resolveRepoRoots handles a symlink that renames the checkout, not just its parent', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bt-roots-rename-')));
  try {
    const main = join(tmp, 'www', 'thing');
    initRepo(main);
    const lane = join(tmp, 'www', 'thing-lane');
    git(main, 'worktree', 'add', '-q', '-b', 'lane', lane);
    const alias = join(tmp, 'proj');
    symlinkSync(main, alias, 'dir');

    const roots = resolveRepoRoots(alias);
    // The renamed spelling has to be a root, or the session's own paths — which the
    // agent reports as `<tmp>/proj/src/a.ts` — match nothing and are all dropped.
    assert.ok(roots.includes(alias), 'the spelling the caller used must be a root');
    assert.ok(roots.includes(main));
    assert.ok(roots.includes(lane), 'the sibling worktree is still found');
    // And it must not have widened to the directory holding both repos.
    assert.ok(!roots.includes(tmp));
    assert.ok(!roots.includes(join(tmp, 'www')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// THE case string reasoning cannot settle: an alias that EXISTS and names something
// else. With a second link in the tree, substituting the prefix can land on a real
// directory that has nothing to do with the repo — and as a root it would make every
// file under it count as in-repo. Only asking the filesystem separates the two.
test('resolveRepoRoots rejects an alias that exists but resolves to a DIFFERENT directory', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bt-roots-decoy-')));
  try {
    const real = join(tmp, 'real');
    const app = join(real, 'app');
    const worktree = join(real, 'decoy');
    mkdirSync(app, { recursive: true });
    mkdirSync(worktree, { recursive: true });

    // `link/` is a REAL directory. `link/app` is a symlink to the checkout, which is how
    // the session reaches it — but `link/decoy` is an unrelated directory that merely
    // happens to sit where the substitution points.
    const link = join(tmp, 'link');
    mkdirSync(link, { recursive: true });
    symlinkSync(app, join(link, 'app'), 'dir');
    mkdirSync(join(link, 'decoy'), { recursive: true });
    writeFileSync(join(link, 'decoy', 'not-ours.ts'), 'export const x = 1;\n');

    const run: GitRunner = (_cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${app}\n`;
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return `${app}/.git\n`;
      if (args[0] === 'worktree') return [`worktree ${app}`, '', `worktree ${worktree}`, ''].join('\n');
      return null;
    };

    const roots = resolveRepoRoots(join(link, 'app'), run);
    // The alias that genuinely names the checkout is kept.
    assert.ok(roots.includes(join(link, 'app')), 'the real alias must survive');
    assert.ok(roots.includes(app) && roots.includes(worktree));
    // The one that only looks right is not.
    assert.ok(!roots.includes(join(link, 'decoy')), 'an alias naming another directory must be refused');
    assert.equal(roots.length, 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// NEGATIVE CONTROL for the aliasing. A root that is not under the substituted prefix
// must be left alone. Rewriting it anyway can shorten it to the directory ABOVE the
// repos, and a root that wide swallows every unrelated repo sitting beside them — the
// exact leak the whole change is built to avoid, arriving through the fix for symlinks.
test('resolveRepoRoots never aliases a root outside the substituted prefix into a wider one', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bt-roots-alias-')));
  try {
    const real = join(tmp, 'real');
    const app = join(real, 'app');
    mkdirSync(app, { recursive: true });
    symlinkSync(real, join(tmp, 'link'), 'dir');
    // A foreign repo living beside the checkout under the symlinked spelling. If the
    // alias ever widens to `<tmp>/link`, this becomes in-repo.
    mkdirSync(join(real, 'unrelated'), { recursive: true });

    const run: GitRunner = (_cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${app}\n`;
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return `${app}/.git\n`;
      // A worktree registered far outside the symlinked tree, and SHORTER than the
      // prefix being substituted — the shape that collapses to the parent directory.
      if (args[0] === 'worktree') return [`worktree ${app}`, '', 'worktree /x', ''].join('\n');
      return null;
    };

    const roots = resolveRepoRoots(join(tmp, 'link', 'app'), run);
    assert.ok(!roots.includes(join(tmp, 'link')), 'must never adopt the directory above the repo');
    assert.ok(!roots.includes(real), 'must never adopt the physical directory above the repo');
    assert.ok(!roots.includes(''), 'must never adopt an empty root');
    // What it should be: the checkout, the far-away worktree, and the linked spelling
    // of the checkout — nothing wider.
    assert.deepEqual([...roots].sort(), [app, '/x', join(tmp, 'link', 'app')].sort());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveRepoRoots rebuilds the full path below a symlink several levels above the repos', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bt-roots-deep-')));
  try {
    const outer = join(tmp, 'outer');
    const nest = join(outer, 'a', 'b');
    mkdirSync(nest, { recursive: true });
    const main = join(nest, 'app');
    const lane = join(nest, 'app-lane');
    initRepo(main);
    git(main, 'worktree', 'add', '-q', '-b', 'lane', lane);
    symlinkSync(outer, join(tmp, 'link'), 'dir');

    const roots = resolveRepoRoots(join(tmp, 'link', 'a', 'b', 'app'));
    assert.deepEqual(
      [...roots].sort(),
      [main, lane, join(tmp, 'link', 'a', 'b', 'app'), join(tmp, 'link', 'a', 'b', 'app-lane')].sort(),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveRepoRoots aliases the TOPLEVEL, not the subdirectory, when reached via a symlink', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bt-roots-linksub-')));
  try {
    const real = join(tmp, 'real');
    mkdirSync(real, { recursive: true });
    const main = join(real, 'app');
    initRepo(main);
    mkdirSync(join(main, 'packages', 'core'), { recursive: true });
    symlinkSync(real, join(tmp, 'link'), 'dir');

    const roots = resolveRepoRoots(join(tmp, 'link', 'app', 'packages', 'core'));
    // The alias must climb back to the repo root, or a path under the symlink would
    // relativize to `a.ts` instead of `packages/core/a.ts` and anchor to the wrong file.
    assert.deepEqual([...roots].sort(), [main, join(tmp, 'link', 'app')].sort());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveRepoRoots adds no alias for a repo with no worktrees reached physically', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bt-roots-noalias-')));
  try {
    const main = join(tmp, 'app');
    initRepo(main);
    // Guards against the alias becoming an always-on second root: a wider root set than
    // the repo is exactly how a foreign path would get in.
    assert.deepEqual(resolveRepoRoots(main), [main]);
    mkdirSync(join(main, "sub"), { recursive: true });
    assert.deepEqual(resolveRepoRoots(join(main, "sub")), [main]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveRepoRoots refuses a worktree whose directory has been deleted', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bt-roots-gone-')));
  try {
    const main = join(tmp, 'app');
    const gone = join(tmp, 'app-gone');
    initRepo(main);
    git(main, 'worktree', 'add', '-q', '-b', 'gone', gone);
    assert.ok(resolveRepoRoots(main).includes(gone), 'precondition: it was a root while it existed');
    rmSync(gone, { recursive: true, force: true });
    // `git worktree list` still names it (nothing has pruned the registration), so the
    // only thing keeping it out is the check that it answers as a repo at all.
    assert.deepEqual(resolveRepoRoots(main), [main]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveRepoRoots never admits git internals (a submodule gitdir) as a checkout', () => {
  const run: GitRunner = (_cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/work/host/sub\n';
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return '/work/host/.git/modules/sub\n';
    if (args[0] === 'worktree') {
      // What `worktree list` reports from inside a submodule: the checkout AND the
      // gitdir. The gitdir shares the common dir, so only an explicit exclusion keeps
      // git's own storage out of a list of directories a session edits files in.
      return ['worktree /work/host/sub', '', 'worktree /work/host/.git/modules/sub', ''].join('\n');
    }
    return null;
  };
  assert.deepEqual(resolveRepoRoots('/work/host/sub', run), ['/work/host/sub']);
});

test('resolveRepoRoots ignores a path-less porcelain line rather than adopting the process cwd', () => {
  const run: GitRunner = (_cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/work/app\n';
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return '/work/app/.git\n';
    if (args[0] === 'worktree') return ['worktree /work/app', '', 'worktree ', '', 'worktree   ', ''].join('\n');
    return null;
  };
  const roots = resolveRepoRoots('/work/app', run);
  // An empty path would `resolve('')` to the PROCESS cwd — this repo — and quietly make
  // the machine's own checkout a root of somebody else's repo.
  assert.deepEqual(roots, ['/work/app']);
  assert.ok(!roots.includes(process.cwd()));
});

test('resolveRepoRoots caps how many linked worktrees one call will probe', () => {
  let probes = 0;
  const run: GitRunner = (_cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/work/app\n';
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      probes += 1;
      return '/work/app/.git\n';
    }
    if (args[0] === 'worktree') {
      const lines = ['worktree /work/app', ''];
      for (let i = 0; i < 500; i += 1) lines.push(`worktree /work/lane${i}`, '');
      return lines.join('\n');
    }
    return null;
  };
  const warnings: string[] = [];
  const roots = resolveRepoRoots('/work/app', run, (m) => warnings.push(m));
  // The cap bounds how many subprocesses one capture can spawn: the session's own probe
  // plus at most 64 candidates, never the 500 git happened to list.
  assert.equal(roots.length, 65);
  assert.equal(probes, 65);
  // And it SAYS SO. Past the cap the remaining worktrees' paths are dropped as foreign
  // again — this function's own bug at scale — so the truncation must not be silent.
  assert.equal(warnings.length, 1);
  // It has to report THIS MACHINE's numbers. "More than 64" is a fact about a constant
  // in our source; 500 listed, 64 checked, 436 left out is a fact about the reader's
  // repo, and it is the only version of the sentence they can do anything with.
  assert.match(warnings[0], /500 linked worktrees/);
  assert.match(warnings[0], /first 64 were checked/);
  assert.match(warnings[0], /other 436/);
  // AND IT PRESCRIBES NO COMMAND. It used to end by telling the reader to run
  // `git worktree prune`, which drops stale registrations: it does not show a single
  // skipped path, does not recover one, and on a machine whose worktrees are all live
  // does nothing whatsoever. Following it produced no visible change and taught
  // nothing, which is worse than being told only what happened.
  assert.doesNotMatch(warnings[0], /prune/);
  assert.doesNotMatch(warnings[0], /\bRun\b/);
});

test('resolveRepoRoots stays quiet when it is under the cap', () => {
  const run: GitRunner = (_cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/work/app\n';
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return '/work/app/.git\n';
    if (args[0] === 'worktree') return ['worktree /work/app', '', 'worktree /work/lane1', ''].join('\n');
    return null;
  };
  const warnings: string[] = [];
  resolveRepoRoots('/work/app', run, (m) => warnings.push(m));
  // Otherwise the warning above is worthless: it has to mean something happened.
  assert.deepEqual(warnings, []);
});

// THE BOUNDARY ITSELF. The two tests above sit at 1 and 500, which leaves the only
// interesting numbers unguarded: `skipped > 0` could be `skipped > -1` and both would
// still pass while the message fired at exactly the cap claiming "the other 0". Off by
// one here is a line that appears on a machine that lost nothing, which is precisely
// the kind of noise that teaches people to ignore it.
test('resolveRepoRoots speaks at exactly one over the cap and not one under', () => {
  const runWith = (linked: number): GitRunner => (_cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/work/app\n';
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return '/work/app/.git\n';
    if (args[0] === 'worktree') {
      const lines = ['worktree /work/app', ''];
      for (let i = 0; i < linked; i += 1) lines.push(`worktree /work/lane${i}`, '');
      return lines.join('\n');
    }
    return null;
  };
  const warningsAt = (linked: number): string[] => {
    const out: string[] = [];
    resolveRepoRoots('/work/app', runWith(linked), (m) => out.push(m));
    return out;
  };
  assert.deepEqual(warningsAt(63), []);
  assert.deepEqual(warningsAt(64), []); // every one of them was checked — nothing to say
  const at65 = warningsAt(65);
  assert.equal(at65.length, 1);
  assert.match(at65[0], /has 65 linked worktrees/);
  assert.match(at65[0], /other 1 /); // never "the other 0"
});

test('resolveRepoRoots degrades to the toplevel alone when git cannot list worktrees', () => {
  const run: GitRunner = (_cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/work/app\n';
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return '.git\n';
    return null; // `worktree list` unavailable (ancient git, or a bare repo)
  };
  assert.deepEqual(resolveRepoRoots('/work/app', run), ['/work/app']);
});
