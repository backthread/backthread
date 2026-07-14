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

// --- ARP-696: local git context for merge-gated capture ----------------------
//
// The capture hook reports the session's git state (current branch + HEAD sha) so
// the server can HOLD the decision as `pending_merge` until that work merges (epic
// ARP-694). This is the cli's only job here: REPORT git state — the server decides
// the held state (locked decision #3, no client-side merge assertion). It is plain
// VCS METADATA (a ref name + a commit sha), never source, so the never-store-source
// claim is unaffected (same posture as the file-path metadata in redact.ts).

export interface GitContext {
  /** Current branch (`git rev-parse --abbrev-ref HEAD`); null when detached/none. */
  branch: string | null;
  /** Current HEAD sha (`git rev-parse HEAD`); null when none. */
  headSha: string | null;
  /** The configured git user ("Name <email>"), so the server can scope which held
   * decisions a merge could plausibly release (the user who committed to the merged
   * branch). Null when git has no user.name/user.email. Public commit metadata — the
   * same identity every commit already carries — never source. */
  gitUser: string | null;
}

/** The git-command runner seam — shells out by default, injectable for tests. */
export type GitRunner = (cwd: string, args: string[]) => string | null;

const defaultGitRunner: GitRunner = (cwd, args) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // not a git repo / git missing → caller treats as "no context"
  }
};

/**
 * Resolve a session's cwd to its git context. Pure-ish (the git read is injectable).
 * A detached HEAD reports the literal branch `HEAD` from `--abbrev-ref` — we map that
 * to null (it's not a real ref to match a merged PR against) and rely on the sha for
 * ancestry matching. Either field is null when unavailable (non-git cwd, no commits);
 * the server then simply won't HOLD the decision (held ⟺ releasable), which is correct.
 */
export function resolveGitContext(cwd: string, run: GitRunner = defaultGitRunner): GitContext {
  const rawBranch = run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = rawBranch ? rawBranch.trim() : '';
  const rawSha = run(cwd, ['rev-parse', 'HEAD']);
  const sha = rawSha ? rawSha.trim() : '';
  // The committer identity, formatted "Name <email>" (email-only / name-only when the
  // other is unset). Best-effort: a repo with no configured user → null.
  const name = (run(cwd, ['config', 'user.name']) ?? '').trim();
  const email = (run(cwd, ['config', 'user.email']) ?? '').trim();
  const gitUser = email ? (name ? `${name} <${email}>` : email) : name || null;
  return {
    branch: branch && branch !== 'HEAD' ? branch : null,
    headSha: sha || null,
    gitUser,
  };
}
