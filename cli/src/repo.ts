// repo.ts — resolve a session's working directory to an `owner/name` repo handle
// for the capture hook.
//
// VENDORED, same rationale as redact.ts: the canonical impl is the Claude
// Code adapter's `parseRepoFromRemote` + git-remote read
// (scripts/ingest/decisions/providers/claude-code.ts), but `scripts/` does not ship
// with `npx backthread`. This is a faithful copy of that PURE parser; parity is golden-
// tested in repo.test.ts.
//
// BEST-EFFORT, NOT AUTHORITATIVE: it trusts the last two path segments of any
// remote URL without checking the host is a known forge. The result is NOT a
// trust/allowlist decision — the canonical repo identity is resolved + validated
// against the DB server-side (ingest-decisions routeCapture / persist). Here it
// only decides WHICH repo slug the capture claims (connected vs repo-less is the
// server's call).
import { execFileSync } from 'node:child_process';

export interface RepoHandle {
  owner: string;
  name: string;
}

/**
 * Parse an `owner/name` out of a git remote URL. Pure + exported for testing.
 * Handles SSH (`git@host:owner/name.git`, `ssh://git@host/owner/name.git`), HTTPS
 * (`https://host/owner/name(.git)`), and token-in-URL HTTPS. Returns null when it
 * can't find owner/name.
 */
export function parseRepoFromRemote(remote: string): RepoHandle | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  let path: string;
  const scp = trimmed.match(/^[^/]+@[^/:]+:(.+)$/); // git@github.com:owner/name.git
  if (scp) {
    path = scp[1];
  } else {
    const url = trimmed.match(/^[a-z]+:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i);
    if (!url) return null;
    path = url[1];
  }

  const cleaned = path.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const name = segments[segments.length - 1];
  const owner = segments[segments.length - 2];
  if (!owner || !name) return null;
  return { owner, name };
}

/** The git-remote reader seam — shells out by default, injectable for tests. */
export type RemoteReader = (cwd: string) => string | null;

const defaultRemoteReader: RemoteReader = (cwd) => {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // not a git repo / no origin → caller falls back to skipping capture
  }
};

/**
 * Resolve a session's cwd to an `owner/name` repo handle, or null when the cwd
 * isn't a git repo / has no `origin` remote / the remote can't be parsed. The
 * git read is injectable (`readRemote`) so this is unit-testable without a repo.
 */
export function resolveRepo(cwd: string, readRemote: RemoteReader = defaultRemoteReader): RepoHandle | null {
  const remote = readRemote(cwd);
  return remote ? parseRepoFromRemote(remote) : null;
}
