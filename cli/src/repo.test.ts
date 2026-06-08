import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoFromRemote, resolveRepo } from './repo.js';

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
