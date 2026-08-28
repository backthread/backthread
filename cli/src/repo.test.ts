import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

test('resolveRepoRoots degrades to the toplevel alone when git cannot list worktrees', () => {
  const run: GitRunner = (_cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/work/app\n';
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return '.git\n';
    return null; // `worktree list` unavailable (ancient git, or a bare repo)
  };
  assert.deepEqual(resolveRepoRoots('/work/app', run), ['/work/app']);
});
