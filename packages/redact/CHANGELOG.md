# Changelog — `@backthread/redact`

The fence the `backthread` CLI inlines into its bundle and names on every request
(`x-backthread-redact-version`). Each version here is meant to be readable on npm at exactly
that number, so the header can be checked against the code. Releases are cut by pushing a
`redact-v<version>` tag (see the repo's `RELEASING.md`).

## 0.1.6

`sessionPaths` measures a relative path from the directory its own tool call ran in, not from
the repo root — and where that base cannot be worked out, the path is dropped rather than
guessed at. A symlink living in the session's subdirectory was invisible from the root and read
as empty ground inside the repo while the kernel opened another repository.

## 0.1.5

The session-path fence resolves a harvested path against the filesystem BEFORE normalizing it:
a `..` cancelled on the string against a symlinked segment, or a segment whose realpath fails,
could reduce to a name this repo genuinely has while pointing elsewhere. Backslashes are refused
outright as a separator; every C0 control character is refused; a root that no longer resolves
cannot vouch for a path; a dropped path is reported to the caller instead of vanishing.

## 0.1.4

Paths named inside shell commands (`cat`, `sed`, `grep` targets and the like) are harvested as
well as those in file-tool inputs, since the agent had moved from opening files to running
commands and the harvest never noticed. A sibling worktree is treated as the same repo, not as
someone else's.

## 0.1.3

Cursor transcripts parse: the turn role is read from `type`, `role`, or `message.role`, where
before only Claude Code's field was consulted and every Cursor turn was dropped as roleless.

## 0.1.2

`sessionPaths` drops mid-path `../` traversal; capture-side file paths.

## 0.1.1

`sessionPaths()` helper: the file paths a session touched, harvested from tool inputs.

## 0.1.0

First public release of the one redaction fence.
