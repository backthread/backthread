import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoFromRemote, resolveRepo, resolveGitContext, type GitRunner } from './repo.js';

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
