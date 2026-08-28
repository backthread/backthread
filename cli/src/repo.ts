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
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

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

/**
 * How many linked worktrees we are willing to verify. Each one costs a `git rev-parse`,
 * and the list is attacker-free but not bounded by anything: a long-lived machine can
 * accumulate registrations. Well past any real workflow, and a hard stop on the number
 * of subprocesses one capture can spawn.
 */
const MAX_LINKED_WORKTREES = 64;

/**
 * Add each root back under the spelling the CALLER would use, when they reached the repo
 * through a symlink and git answered with the physical path.
 *
 * Git always replies to `--show-toplevel` and `worktree list` with real paths, so every
 * root is physical. But an agent started under `/var/project` — a symlink to
 * `/private/var/project`, which is how macOS spells the same directory — reports its file
 * paths that way too, and a physical root does not prefix-match a symlinked path. Putting
 * the identity on physical paths is what makes the worktree matching work at all, so
 * without this it would buy that by taking away the paths of anyone whose checkout is
 * reached through a link. Both spellings name the same directories, so both are roots.
 *
 * The symlink is somewhere ABOVE the working directory, so we find it by comparing the
 * caller's `cwd` with its own real path and taking the longest run of trailing path
 * segments they agree on. What is left in front is the substitution: every root under the
 * physical head is re-spelled with the logical one. That covers sibling worktrees too, not
 * just the session's own checkout — they are named by the same listing and reached through
 * the same link.
 *
 * This never widens a root. Each alias names exactly the directory its source named, by
 * another path. If the two spellings do not line up we add nothing rather than guess: an
 * over-wide root would let a foreign path in, and losing a path is the safer failure.
 */
function withLogicalAlias(cwd: string, roots: string[]): string[] {
  const logicalCwd = resolve(cwd);
  let physicalCwd: string;
  try {
    physicalCwd = realpathSync(logicalCwd);
  } catch {
    return roots; // cwd is gone from under us — nothing to alias
  }
  if (logicalCwd === physicalCwd) return roots; // no symlink in play

  // Longest common trailing segment run, e.g. `/var/x/app` vs `/private/var/x/app`
  // agree on `var/x/app`, leaving the heads `` and `/private`.
  const logSegs = logicalCwd.split('/');
  const physSegs = physicalCwd.split('/');
  let shared = 0;
  while (
    shared < logSegs.length &&
    shared < physSegs.length &&
    logSegs[logSegs.length - 1 - shared] === physSegs[physSegs.length - 1 - shared]
  ) {
    shared += 1;
  }
  // `shared === 0` is the link that RENAMES: `~/proj -> /Users/me/www/thing`. The two
  // spellings then share no trailing segment at all and the whole of one maps to the
  // whole of the other, which the loop below handles as the `root === physicalHead` case.
  const logicalHead = logSegs.slice(0, logSegs.length - shared).join('/');
  const physicalHead = physSegs.slice(0, physSegs.length - shared).join('/');
  if (logicalHead === physicalHead) return roots;

  const out = [...roots];
  for (const root of roots) {
    if (physicalHead.length > 0 && root !== physicalHead && !root.startsWith(physicalHead + '/')) continue;
    const alias = logicalHead + root.slice(physicalHead.length);
    if (alias.length > 0 && alias !== root && !out.includes(alias)) out.push(alias);
  }
  return out;
}

/** The `<path>` of each `worktree <path>` line in `git worktree list --porcelain`. */
function parseWorktreePorcelain(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    // Porcelain is `<label> <value>`; the record separator is a blank line. Only the
    // `worktree` label carries a path — HEAD/branch/detached/locked/prunable do not.
    if (!line.startsWith('worktree ')) continue;
    const p = line.slice('worktree '.length).trim();
    if (p.length > 0) paths.push(p);
  }
  return paths;
}

/**
 * Every directory on this machine that IS this repo: the checkout the session ran in,
 * plus every linked worktree of the same repo.
 *
 * WHY: a session's file paths were previously measured against one root — the hook's
 * cwd — and anything outside it was dropped as belonging to another repo. A linked
 * worktree is not another repo. It is the same project, same history, same file at the
 * same repo-relative path, sitting at a sibling directory. Where parallel worktrees are
 * the normal way to work, that rule threw away most of what a session touched and left
 * its decisions anchored to nothing.
 *
 * WHAT MAKES TWO DIRECTORIES THE SAME REPO: a shared `--git-common-dir`. That is the
 * object store and ref store both checkouts read and write; `--show-toplevel` alone
 * only names a directory, and two unrelated repos sitting next to each other have two
 * perfectly good toplevels. So every candidate has to prove it resolves to the SAME
 * common dir as the session's own — an allowlist, closed by construction. This also
 * settles the stale case: a registration whose directory has since been replaced by a
 * different repo answers with a different common dir and is refused.
 *
 * The FIRST root is always the session's own toplevel, which is what a caller should
 * use when it needs one canonical root. Returns `[resolve(cwd)]` when `cwd` is not a
 * git repo at all — same fail-soft as the rest of this module: capture still works,
 * it is just anchored where it always was.
 */
export function resolveRepoRoots(
  cwd: string,
  run: GitRunner = defaultGitRunner,
  warn: (message: string) => void = (m) => console.warn(m),
): string[] {
  const top = (run(cwd, ['rev-parse', '--show-toplevel']) ?? '').trim();
  if (top.length === 0) return [resolve(cwd)]; // not a git repo → the cwd is all we have
  const primary = resolve(top);

  // `--git-common-dir` answers relative to the cwd it was asked from (plain `.git` in a
  // main checkout, an absolute path from a linked worktree), so resolve before comparing.
  // Everything below is measured from `primary`, NEVER from the caller's `cwd`.
  // `--show-toplevel` answers with the PHYSICAL path, while `--git-common-dir` can
  // answer with a bare `.git` relative to wherever it was asked from. Ask from `cwd`
  // and a caller who reached the repo through a symlink gets a LOGICAL identity that
  // matches no candidate — every sibling worktree is then refused and the whole
  // widening silently does nothing. Asking from `primary` puts both sides on physical
  // paths. (`cwd` here comes off a hook payload, so it is not guaranteed physical.)
  const commonDir = (run(primary, ['rev-parse', '--git-common-dir']) ?? '').trim();
  if (commonDir.length === 0) return withLogicalAlias(cwd, [primary]);
  const identity = resolve(primary, commonDir);

  const listed = run(primary, ['worktree', 'list', '--porcelain']);
  if (listed === null) return withLogicalAlias(cwd, [primary]);

  const roots = [primary];
  let checked = 0;
  for (const raw of parseWorktreePorcelain(listed)) {
    const candidate = resolve(raw);
    if (roots.includes(candidate)) continue;
    // Asked from inside a submodule, `worktree list` names the submodule's GITDIR
    // (`<host>/.git/modules/<name>`). It shares the common dir, so it would pass the
    // check below — but it is git's own storage, never a checkout, and no file a
    // session edits lives under it.
    if (candidate === identity || candidate.startsWith(identity + '/')) continue;
    if (checked >= MAX_LINKED_WORKTREES) {
      // Say so. Past the cap, paths in the remaining worktrees go back to being
      // dropped as foreign — this function's own bug, reappearing at scale — and
      // WHICH worktrees survive is decided by git's listing order, not by which ones
      // the session touched. Silent truncation leaves that undiagnosable from the
      // outside; one line on stderr makes it a one-line diagnosis. It can only fire
      // on a machine that has outgrown the bound, so it is not noise.
      warn(
        `backthread: more than ${MAX_LINKED_WORKTREES} linked worktrees; file paths in the ` +
          'remainder will not be recognised as belonging to this repo. Run `git worktree prune` ' +
          'to drop stale registrations and restore full coverage.',
      );
      break;
    }
    checked += 1;
    const candidateCommon = (run(candidate, ['rev-parse', '--git-common-dir']) ?? '').trim();
    if (candidateCommon.length === 0) continue; // gone, or no longer a repo → not us
    if (resolve(candidate, candidateCommon) !== identity) continue; // a DIFFERENT repo
    roots.push(candidate);
  }
  return withLogicalAlias(cwd, roots);
}
