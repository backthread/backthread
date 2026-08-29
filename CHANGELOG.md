# Changelog

All notable changes to the `backthread` CLI / Claude Code plugin. Releases are cut by
pushing a `v*` tag (see [`RELEASING.md`](./RELEASING.md)); the GitHub Release also
carries auto-generated notes. Earlier versions are recorded in the git tags + GitHub
Releases (`v0.5.1` and prior).

## 0.25.0

**The `..` hole 0.24.0 told you about is closed.** That release said, in as many words,
that a path using `..` to step back out of a symlink could still carry another
repository's file paths into yours, and that fixing it meant resolving paths against the
disk before reducing them. This is that fix.

The problem was that `..` was cancelled out on the string — `dlink/../src/secret.ts`
becomes `src/secret.ts` on paper — and cancelling `..` is only correct against a real
directory. Against a symlink it is simply wrong, because the link does not go where its
name suggests: the reduced path looked like one of your own files while your computer
opened somebody else's. Every re-spelling of that trick went through with it: relative,
`./`-prefixed, backslash-separated, with a redundant `.` or `//` in the middle, hidden a
level down inside your own `src/`, and — the one nobody had built a fixture for — a link
that points *inside* your repo, with the `..` after it doing the leaving.

A path is now walked through the filesystem one segment at a time, in the spelling your
agent reported it in. By the time a `..` is reached everything to its left has already
been followed for real, so its parent is the true one. Measured against real repositories
and real symlinks, with each spelling first confirmed by actually reading the other
repository's bytes: 23 spellings, all refused; the same probe leaks 21 of them on 0.24.0.

**And the class was wider than `..`.** 0.24.0 climbed past any segment the filesystem
would not resolve, up to the nearest ancestor that did — which lands back inside your
repo, so the path was kept. Its note named a dangling link as the one case. It was not
one case: an escaping link behind a directory the process cannot read does it too, and so
does a symlink loop. The rule now is that only a *positive* "there is nothing here"
continues the walk. Anything else — a link that resolves nowhere, a permission refusal,
a loop, an error nobody has thought of — stops it and the path is dropped. That is what
keeps a file you **deleted**: it is genuinely absent, which is an answer, not a refusal
to answer.

**A file whose name contains a backslash was walking out too, and that one is older than
`..`.** This code used to treat `\` as a second path separator, so that a Windows
spelling could be tidied up like a POSIX one. On macOS and Linux it is not a separator —
it is an ordinary character in a filename. So a symlink genuinely *named* `x\y`, pointing
at another repository, was read here as two directories that do not exist, which looked
like empty ground inside your repo, while your computer followed it into the other
repository in a single hop. Same failure as the `..` one in a different costume: we were
checking a different path from the one being opened. There is no reading of `\` that is
right on both platforms and no way for this code to know which one produced the string,
so a path containing one is now refused outright, and `/` is the only separator anywhere
past that point. If you are on Windows, note that absolute Windows paths (`C:\…`) were
already being dropped; this now drops the relative `src\thing.ts` spelling as well.

**`file://` and friends are refused, and with them the one machine-absolute path this
code was emitting.** A `file://…` spelling is not an absolute path as far as this code is
concerned, so it fell through to the relative branch and came out as `file:/Users/you/…` —
a path from your machine, out of a module that promises never to emit one. Percent-escaped
separators (`vendor%2Fsrc/…`) go the same way: that is two different paths depending on who
unescapes it, so we would be checking one and your computer would be opening the other.

**Paths containing any control character are refused, not just NUL.** NUL was already
refused, because no filesystem can name such a file. The rest — a newline, a tab — are
technically legal in a filename, and a transcript could hand us one; a "path" with a
newline in it is a thing that renders as two lines everywhere it is later shown. They
come only from a malformed or hostile tool input.

**One thing got *less* strict, and it is a recovery, not a loosening.** 0.24.0 dropped a
path as soon as any one of your checkouts said that name leaves the repo — which also
threw away an honest file living at that name in a sibling worktree. A name is all a
*relative* path gives you, so that still holds for those. But an *absolute* path is a
place, not a name: it can be followed on its own, no other checkout gets a vote, and the
honest file survives. The escape through that same name is still refused in both
spellings — the case where a sibling worktree could vouch for an escaping link stays
closed, because the path is now resolved rather than voted on.

**A leading space in a filename was doing the same thing as the backslash.** A path
handed to a file-reading tool is trimmed of surrounding whitespace on the way in, and the
first segment of a path is a "surround" — so a symlink named ` vendor` (leading space)
pointing at another repository was measured as `vendor`, which your repo does not have,
which read as empty ground inside it. Your computer, given the spelling the agent actually
used, opened the other repository. Only the *end* of the path is trimmed now, which cannot
change where a path resolves.

**And a link in the folder you are working in was invisible.** This is the one most
likely to have affected a real repository. Paths your agent reports relatively are resolved
by your computer from the directory the session is running in — but they were being checked
from the top of your repo. So if you were working inside `packages/thing/` and that folder
contained a symlink pointing at another checkout, the check looked for that link at the top
of the repo, did not find it, concluded there was nothing there, and kept the path. Your
computer, resolving the same text the way it actually does, opened the other repository.

The same gap had a nastier second form. With `pkg/src` linked out and a session running in
`pkg/`, the path `src/keep.ts` names the *other* repo's file — but your repo has its own
`src/keep.ts`, so the "does this file exist?" check said yes and the path was recorded
under your own name. Nothing later could have told the two apart. A relative path is now
checked from the directory the session was actually in, as well as from every checkout.

### This still does not close it completely, and here is where it does not

Independent verification of this release measured a way through that it does **not** fix.
It is not a regression — the same spellings get through on 0.24.0 — and we would rather
you read it here than assume a guarantee we cannot make.

A relative path is now checked from the directory the *session* is running in, and from
every checkout. But your computer resolves a relative path from the working directory of
the **individual tool call**, and that is not always one of those. Three ways it differs,
all measured:

- a `cd` inside the very command being recorded (`cd packages/thing && cat src/x.ts`);
- a shell tool call that carries its own working directory alongside the command;
- a transcript that states a working directory of its own, different from where the hook
  ran.

In each case, if a symlink pointing at another checkout lives in *that* directory, the
check looks for it somewhere else, does not find it, and keeps the path. Concretely: with
the session at the top of your repo and a link at `sub/zlink`, the command
`cd sub && cat zlink/src/secret.ts` still records a path belonging to the other checkout.

Closing it means carrying the originating directory alongside every recorded path, which
changes the same published interface again, so it is its own release rather than a hurried
addition to this one. Until then: **if you have a symlink pointing out of a checkout, a
path reached through it from a subdirectory the session did not start in may still be
recorded.**

### What is still true rather than fixed

- **A file of yours behind a directory the process cannot read is dropped**, and so is one
  behind a symlink loop. That is the same rule that refuses an escaping link hiding in
  those places, and it cannot tell the two apart — it is deliberately the safe way round,
  but the cost is yours to know about.
- **The path that gets emitted is still reduced on the string.** Containment is now decided
  on disk, but the *name* we send is still computed by cancelling `..` arithmetically. When
  a path stays inside your repo, that can produce a name for a file that was never opened —
  `src/liblink/../top.ts` is emitted as `src/top.ts`. It cannot cross a repo boundary (the
  fence refuses those before we get here), so it is a tidiness problem in the recorded
  path, not a leak.
- **The shell-command harvest still depends on a file existing.** A path scraped out of a
  command string is only emitted if it names a real file in your working tree. That has
  always been the rule and it is unchanged.
- **If no repo root can be resolved at all, an already-relative path is kept as it is.**
  There is nothing to measure it against; this is the long-standing behaviour of running
  outside a repo.
- **A path deeper than 256 segments is dropped**, not measured. Walking it costs a
  filesystem call per segment, and no file anyone learns a system from is that deep.

## 0.24.0

**A symlink pointing out of your checkout was carrying another repository's file paths
into this one's record.** Whether a path belonged to your repo was decided by comparing
strings, and a string comparison cannot see through a link. So if your checkout contains
something like `vendor -> ../other-project` — an ordinary thing for a checkout to have —
then a file your agent opened through it read as one of yours by every rule the harvest
applies, and was sent as `vendor/src/whatever.ts` against this repo, while the file it
named belonged to the other one. Nothing about it looked wrong from the outside.

Containment is now settled by the filesystem rather than by the shape of the string. The
**directory** a path sits in is followed for real, through every link, and if any of your
checkouts says it comes out somewhere that is not one of them, the path is dropped. The
three properties the previous release bought are all still here and are tested against
real git repos and real symlinks: a file edited in a sibling worktree still counts, a file
in a genuinely different repo still does not, and a checkout you reach through a symlinked
parent still works.

### This does not close the hole completely, and you should know where it still is

Independent verification of this release measured 23 ways of spelling the escape that
leak in 0.23.0 and are refused here — and **six that still get through**, unchanged from
0.23.0. They are not a regression, and none of them is fixed by this release. We would
rather you read that here than assume a guarantee we cannot make yet.

All six need a `..` segment, or a URI scheme, in a path your agent passes to a
file-reading tool. The cause is one thing: `..` is cancelled out *arithmetically*, on the
string, before anything asks the filesystem — and cancelling `..` against a symlinked
directory gives the wrong answer, because the link does not go where its name suggests.
With `dlink` pointing at another repository's `src`, the path `dlink/../src/secret.ts`
reduces on paper to `src/secret.ts`, which looks like your own file, while your computer
opens the other repository's. A `file://` spelling gets through the same way, and emits an
absolute path from your machine, which this code otherwise never does.

The fix is to stop reducing the path on paper and resolve it against the disk first. That
is a change to a published interface, so it is its own release rather than a hurried
addition to this one. Until then: if you have a symlink pointing out of a checkout, a path
your agent reaches *through* that link is refused, and a path that uses `..` to step back
out of it may not be.

Two things this deliberately does **not** do, both worth stating rather than letting you
discover:

- **It does not require a file to still exist.** A file you deleted during the session
  keeps its path, exactly as before. Only its directory has to hold up.
- **It does not drop a symlinked file at one of your own names.** If `src/adapter.ts` is
  a link pointing anywhere at all, that name is still in your tree and git still tracks
  it, so it is still yours. What gets refused is a path that *descends through* a link
  into somebody else's repository.

**Paths containing a NUL byte are refused.** No filesystem this runs on can name such a
file — the syscall layer stops reading at the NUL — so the path named nothing, and it was
being stored and rendered anyway.

**`backthread doctor` gained a `Capture` line, because capture had no way to tell you
anything.** The session-end hook re-spawns its real work as a detached process with its
output discarded, which is what stops a slow capture being killed when your agent exits —
and it also means anything capture printed went nowhere at all. The one thing it needed
to say was that it had left some of your file paths out. It now leaves that on disk and
`doctor` reads it, so the place you already go when Backthread seems to be doing less than
you expected is the place that tells you. Nothing to dismiss: a condition that is still
happening is re-recorded every capture, and one that has stopped ages out by itself.

**That message is also a different message.** It used to say "more than 64 linked
worktrees" — a fact about a constant in our source, not about your machine — and then tell
you to run `git worktree prune`. Pruning drops stale *registrations*; it does not show you
a single skipped path and does not recover one, and if your worktrees are all live it does
nothing whatsoever. Following that advice produced no visible change and taught you
nothing. It now tells you how many worktrees you have, how many were checked, how many
were left out, and that which ones is decided by git's listing order rather than by
anything you did. There is no command that fixes it, so it no longer pretends there is.

And the reason there is no longer a command to name: **worktree registrations git has
already marked prunable are skipped before the cap applies.** A registration whose
directory you deleted was still being listed, still spending one of the checked slots,
and still counted in the number reported back to you — so stale entries could push your
*live* worktrees past the limit. That was the one case where the old advice was right,
and it is now handled for you rather than handed to you.

## 0.23.0

**If you work in more than one checkout of the same repo, capture was throwing away
almost everything you touched.** Session file paths were measured against a single
root — the directory the capture hook happened to fire in — and anything outside it
was dropped as belonging to some other project. A linked git worktree is not some
other project: same history, same file, same repo-relative path, just a different
directory. Where several worktrees of one repo are checked out at once, which is how
a lot of parallel work gets done, that rule discarded most of a session's files. One
real session recorded hundreds of decisions and not a single file path, because
everything it edited lived in a worktree next door.

Capture now measures each path against a **set** of roots and picks the deepest one
that contains it. What makes two directories the same repo is a shared git common dir
— the object store and refs both checkouts read and write — so every candidate
worktree has to prove it resolves to the same common dir as the session's own before
it is accepted. That is an allowlist, closed by construction: a neighbouring repo is
never a root, a worktree whose directory has since been replaced is refused, and a
path under a foreign repo is still dropped however many roots are in play.

**And if you reach your checkout through a symlink, this release is what makes any of
it work for you at all.** Git answers with physical paths; your agent reports the
paths you actually typed. Those do not prefix-match, and on a plain single checkout
with no worktrees involved that mismatch took a session's harvest from two files to
zero. Every root is now also offered under the spelling you use, derived from your own
working directory — and each alias then has to resolve to the same directory as the
root it came from, or it is dropped, so this widens the fence by exactly nothing.

Two smaller consequences worth stating rather than letting you discover:

- Paths are now **repo-root-relative** in every case. A session running inside a
  monorepo package used to emit paths relative to that package.
- Past the linked-worktree cap the extras used to be dropped in silence, leaving their
  files treated as another repo's. It now says so once on stderr, and suggests
  `git worktree prune` — which is the fix when the surplus is stale registrations, and
  not otherwise. If you genuinely have more live worktrees than the cap, the warning is
  telling you that some of them are not being measured.

The fence itself is unchanged and still absolute: nothing machine-absolute, nothing
outside a resolved root, nothing that traverses upward, ever leaves your machine.

## 0.22.0

**A decision now knows which files it was about, even when your agent worked in the
shell.** Capture anchors each decision to the files the session touched, and it used to
learn those files from one place only: the path a `Read`/`Edit`/`Write`/`NotebookEdit`
tool was handed. That was true of how agents worked when it was written. It isn't any
more — a modern session `rg`s, `sed`s, `git diff`s and `cat`s its way around, and shell
calls now outnumber the path-named tools by more than an order of magnitude. The file
those calls touch is named inside the command, which nothing was reading. Measured on
real sessions: about half of them ended up with an empty file list, and the share of
recorded decisions carrying any file at all fell from 85% to 38%. One session that
produced nothing at all yields 153 real files once the commands are read.

So the harvest now reads shell commands too — `Bash` in Claude Code, the `shell` argv
array in Codex.

**A path found this way has to be a real file in your repo before it counts.** That
sounds obvious and it is the whole design. A token taken out of a command carries no
evidence of what it is relative to: after `cd /etc`, `cat app/secrets.json` reads a file
that has nothing to do with your repo while looking exactly like one that does. A
scheme-less `curl internal-api.example/v3/export.json` is a hostname. A string literal
inside a heredoc is program text, not a file anyone opened. No amount of pattern matching
separates those from the real thing, so the capture hook checks each one against your
working tree and keeps only what is actually there. `.git/` and `node_modules/` are
excluded even though they exist.

The rest of the fence is unchanged and still absolute: nothing machine-absolute, nothing
outside your repo root, nothing that traverses upward, ever leaves your machine. **Only
path-shaped substrings can be kept at all — the command itself, and anything it printed,
still never leave.** One consequence worth stating plainly: a file the session *deleted*
no longer exists, so it is not recorded.

## 0.21.0

**A failure now tells you whether to try again.** When something the CLI asks for gets
rejected, you used to read `grounded-ask rejected (502): retrieval_failed` — an internal
slug, naming one of our call sites, from which nobody could conclude anything. You now read:

```
the answer didn't come back. The database was busy — try again in a moment.
```

or, when the server is not merely busy:

```
the answer didn't come back. It failed on our side, so retrying will not help. If it keeps
happening, set BACKTHREAD_VERBOSE=1 (or pass --verbose) and report what that prints at
https://github.com/backthread/backthread/issues
```

A failure that is plausibly ours names where to take it. "Retrying will not help" on its own
leaves you with nothing to do, which is the state this release exists to get you out of. A
*refusal* — not a member, no allowance left, asked too soon — names its own remedy instead,
and is never sent to the issue tracker.

And when nothing comes back at all — a timeout, a dead socket — you get
`Backthread could not be reached — check your connection and try again.` rather than
`grounded-ask request failed: fetch failed (after 2 attempts)`. No body means no `reason` to
key off; it never meant the route name was yours to read.

That distinction is not a guess on this end. The server has been sending it for a while —
every relayed failure carries a `reason` saying which of the two it is — and the CLI simply
never read it. Now it does, on **every** endpoint that sends one: `how` / the MCP `query`
tool, `learn` (start and answer), and `ask-me` (ask and answer).

**`sync` and `capture` stop relaying slugs too** (and so does the setup check, whose one
caller happens to discard the line — a fact about the caller, not about the string). Those
were quietly printing things like `read-decisions rejected (403): not_a_member` and
`ingest rejected (500): persist_failed`. The codes both the worker and that older service
send now map to the action they imply — an expired credential says to run `backthread
login`, a repo with no owning account says to connect it, a reached plan limit
says where to raise it, a lesson asked for too soon says to wait. A code that is not on that
list degrades to the plain HTTP status rather than to itself.

**A refusal is not a bug report.** "Retrying will not help" names a next step, but only when
the failure is plausibly ours: a 5xx sends you to the issue tracker, a 4xx never does.
Telling somebody to file a bug about a working permission check is worse than telling them
nothing.

**And no raw database text on any of them.** Some of these routes pair a code with the
upstream error string, and several put the string in the code's own field on a 500 — so
`duplicate key value violates unique constraint "decisions_pkey"` and
`permission denied for schema private` used to arrive as product copy. Nobody writes
reader-facing copy for a 500, so on a 5xx that field is treated as the diagnostic it is:
you get "it failed on our side" and where to report it, and `--verbose` still has the
string for whoever is fixing it.

**`--verbose` is new, and it is where the machine detail went.** The internal error code and
the database's own SQLSTATE are operator fields, not something to put in front of somebody
who just wanted an answer. Pass `--verbose` (or set `BACKTHREAD_VERBOSE=1`, which the MCP
tools read too, having no command line of their own) and the line gains
`[status=502 error=retrieval_failed reason=overloaded code=57014]` on the end.

**Sentences the server wrote for you still reach you.** `error` carries two different kinds
of thing — a machine code like `retrieval_failed`, and plain English like `repo not found or
not connected to Backthread`. The machine code is hidden. The sentence is rendered, because
somebody wrote it for a reader — on a 4xx, where the server is answering your request. On a
5xx it is a diagnostic whatever it looks like, and goes behind `--verbose` with the rest.

Under the hood: seven modules each carried their own copy of the same `message ?? String(
error)` logic — two as a named helper, five inlined at the call site — which is why fixing
the reported one would have left six. There is one renderer now, plus a registry of every
endpoint this package can reach and what a person sees when it fails. Endpoints can only be
born in one module; that module cannot make requests; every export of it must be in the
registry, its origin helpers aside; an address may be written down in only three named
files; and no URL a builder
returned may be edited — followed through its bindings, its imports and the function it was
returned from. So the ordinary ways to add an endpoint are red until somebody answers that
question. It is a source-level trace rather than a type system, so it stops forgetting, not
a determined author.

## 0.20.0

**Nothing fires before you edit any more.** The pre-edit hook that shipped in `0.17.0` —
one line, at most once per session, when you were about to change a part of the codebase
you had no coverage of — is **removed**. `Edit`, `MultiEdit` and `Write` no longer trigger
anything at all.

It was mild by construction: it never blocked, never asked for a decision, timed out in
two seconds, and stayed silent on every outcome but a clean *"you have no coverage here"*.
That is exactly why it went — *"it never blocks"* answers the letter of the rule we set
ourselves and leaves its intent alone. A line at edit time telling you what you do not
know is an interruption at the one moment nobody wants one, and four teams told us
independently that the interruption is the objection. Coverage is derived from what has
already happened; it is not something to stop you and ask about.

Nothing is lost. The question that used to arrive here now arrives only in dead time —
*after* a `Bash` / `Task` / `WebFetch` / `WebSearch` call, never before one — and
`/backthread:how` answers on demand, as it always did. The `Grep` / `Glob` context hook is
untouched.

The hosted `/coverage-preflight` endpoint stays live on purpose: every already-installed
plugin keeps calling it and fails toward silence when it cannot answer, so switching it
off would be invisible feature loss for anyone who has not updated. **This release stops
new installs and updaters only** — preflight traffic does not go to zero, and that is not
a failure to remove.

## 0.19.0

**One question about your codebase, and ignoring it costs you nothing — provably.**
`/backthread:ask-me` turns the usual direction around: instead of you asking Backthread
how something works, Backthread asks you one question built from what was actually
recorded in this repo. The plugin also offers one unprompted, at a moment your agent is
mid-errand rather than mid-edit — *after* a `Bash` / `Task` / `WebFetch` / `WebSearch`
call, never before one — at most once per session.

The reason to trust it is that there is nowhere to keep a gradebook:

- **Nothing is written down when you are asked.** The endpoint that serves the question
  performs no writes at all; the question exists only inside a signed, half-hour token,
  which nothing here keeps. Ignore it and there is no row anywhere to find later — no
  queue, no nag, no badge, no re-ask.
- **Backthread stores nothing on your machine either.** The one file it writes is a
  session id, and its bytes are *identical* whether a question came back, none did, or
  the request failed — and identical again whether you answered or ignored it. So "asked
  and ignored" and "never asked" cannot be told apart locally any more than they can on
  the server. There are tests that diff all four. (The question reaches you as hook
  context, and your coding agent keeps its own session transcript on disk like it does
  for everything else it is told — that file is the agent's, and Backthread's capture
  never uploads it, but we are not going to claim the bytes are nowhere.)
- **Nothing counts** how often you are asked or how often you answer — not for you, not
  for your team, not in aggregate.
- **It is never a pre-edit trigger.** It fires *after* a tool you were waiting on, never
  before one, and never around `Edit` / `Write` / `MultiEdit`. Nobody should be stopped
  before they want to touch anything.

`backthread ask-me --promise` prints that statement in full, straight from the server that
enforces it — the client holds no copy of the sentences, so they cannot drift away from
the behaviour they describe. The client is `cli/src/inflow.ts` and `cli/src/inflowHook.ts`,
open like the rest of it, for the same reason the redactor is. Read there and you can
check exactly what leaves your machine; the server half you are taking on trust, and the
statement is written as things you could go and check rather than as reassurance.

- A quiet repo is a finished answer, not an empty one: "nothing on record here", never a
  zero, never a percentage, never "you're caught up".
- Answering from the terminal goes through the same grader the browser uses, so what you
  get back is the same binary verdict plus the recorded reasoning — and it earns the same
  coverage. No streak, and no "done for today": there is no sitting to be done with.
- One honest caveat on "once per session": the machine remembers the last few dozen
  session ids, so a session resumed long afterwards can be offered a second question.
  Rare and bounded — written down rather than glossed.

## 0.18.1

**Nothing we publish carries an internal reference any more.** A few messages and shipped
files still ended in an internal tracking id — something you'd read in `backthread doctor`,
in `backthread sweep` output, or at the top of the Cursor wrapper script the installer
writes into your home directory. They meant nothing to anyone outside the team, so they're
gone; the sentences say the same thing without them.

- A committed check (`npm run check:no-internal-refs`) now scans the exact file set that
  goes into the published package and fails the build on an internal id, tracker URL,
  private repository name or company email domain. It runs on every pull request **and**
  again on the release tag, because a publish can't be taken back.

## 0.18.0

**When your trial ends, `backthread` says so — once, and plainly.** An elapsed trial stops two things: new decisions are no longer stored, and your "How it works" diagram stops updating. Until now that was entirely silent (capture still succeeds, nothing errors, nothing already captured is lost — it just quietly stops being added to). Now the CLI prints a single line the first time it happens in a session, telling you the diagram has stopped updating and where to keep it live.

- **One line per session, never per capture**, on stderr, best-effort — the same throttle the free-plan limit line uses. It can never interrupt or fail a capture, and a session that can't be identified stays silent rather than risk repeating itself.
- **It is a correctness notice, not a pitch.** That a map you rely on has stopped being true is worth saying on its own; the link is there because it's the fix.
- **A skip reason this version doesn't recognise prints nothing.** A wrong line about your own account is worse than no line.

**`query` / `/backthread:how` now tell you when an answer comes from a frozen diagram.** If your diagram has stopped updating, answers are led by one line naming the date it stopped and how many commits have landed on your default branch since that aren't included. The wording and the numbers come from the server, so they stay accurate without you upgrading anything — this release needs no client change for it.

## 0.17.0

**Backthread can now ask *you* — a short lesson on your own codebase, in the terminal.** `/backthread:learn` runs a handful of questions about *this* repo, built from what was actually recorded here: the decisions, the reasoning behind them, the options that were rejected. You answer in your own words, and each answer gets a plain **"Got it" / "Not yet"** followed by the recorded reasoning — which is the part worth having. Nothing is scored, nothing is ranked, and no history of wrong answers is kept anywhere.

- **"I disagree" and "Bad question" are first-class replies**, offered beside every question, and they cost you nothing. The recorded reasoning can be the thing that's out of date, and saying so should feel like contributing, not like filing a complaint. A disagreement is filed against the decision; a bad question is never asked again on that repo.
- **Open questions aren't graded.** Some questions have no recorded answer because nobody ever wrote one down. Those are marked as such, and your reply becomes the record. There's no way to get one wrong.
- **A quiet week is a finished lesson.** If little worth asking about has landed, you get a short teaching card or a plain "you're caught up" — never padding, and never an implication that you fell short because the repo was quiet.
- **Runs as a conversation, not a TUI.** The CLI prints the lesson and Claude Code asks the questions, waits for you, and relays the verdict. All the generation, quality-gating and grading happen server-side, so questions improve without you upgrading anything.

**One line before you edit an area you haven't been through.** The Claude Code plugin now registers a small pre-edit hook. At most **once per session**, when you're about to edit, rewrite or create a file in a part of the codebase you have no coverage of, it prints a single line pointing you at `/backthread:how` for what's already on record.

- **It never blocks the edit.** Short timeout, no permission prompt, no way to deny a tool call. Anything other than a clean, confident answer — you already know the area, the path doesn't resolve, you're offline or signed out, the request is slow, the repo isn't connected — is simply silent. A line shown because a lookup hiccuped would be a false accusation about your own codebase, which is worse than no line at all.
- **It sends one repo-relative path and nothing else.** The file is never opened, let alone read or uploaded. A session is also capped at a small number of lookups, so a long editing session never pays for this on every keystroke.

## 0.16.0

**Per-repo capture, enforced on your machine: an off or unconnected repo's transcript now never leaves it.** Until now, `backthread` derived a session's decisions and sent them for every project on your machine; the server decided whether to keep them (dropping the ones for repos you'd turned off or hadn't connected). Now the check happens *before* anything is sent: at the end of a session `backthread` asks the server a one-line question — "is capture on for this repo, for me?" — carrying only the repo's `owner/name` (never the transcript, never your code). If the repo is turned off, or isn't connected to Backthread, the transcript is never read or sent. You control per-repo capture on the Repos page; connected repos are on by default.

- **Nothing sent for off / unconnected repos.** A paused repo is silent. An unconnected repo occasionally prints a one-line "connect this repo?" nudge (still just the `owner/name`, never a transcript) — throttled to once per session.
- **Fail-open by design.** If the check can't reach the server (offline, an error), `backthread` proceeds and captures as before — a hiccup never silently drops a real capture. The server still applies the same per-repo decision on its side.
- **No change for a connected, capturing repo** beyond one tiny background request before the send.

## 0.15.0

**Free plan: a heads-up when you hit your decision limit.** The free plan lets you connect an agent and capture + read your first 50 decisions for free. Past that, the server quietly stops storing new ones — your existing decisions stay exactly where they are (nothing is lost, nothing errors, capture never fails). Until now that was fully silent. Now, once per session, `backthread` prints a single line letting you know new decisions aren't landing and where to upgrade to keep capturing. It's throttled to one line per session (never per capture), best-effort, and can never interrupt a capture.

## 0.11.0

**`query` learned the blindspot pre-read — "what am I missing about X?" is now a routed question type.** Before you work in an unfamiliar area, call it FIRST: a seconds-cheap, cited briefing of what's already on record — the trade-offs knowingly accepted, standing assumptions, known limitations, and rejected approaches — then do your own pass through the code. The pre-read aims your deep dive; it doesn't replace it.

- **Routed guidance.** The tool description, the session-start hint, and `/backthread:how` now name the blindspot question type ("what am I missing", a "blindspot pass", "unknown unknowns") with the pre-read sequencing. The server-side half — a retrieval leg over the recorded trade-offs/assumptions/limitations with a relevance floor, plus a sectioned briefing format — shipped worker-side and needs no CLI change; this release is the client's half (the routing copy).
- **New `/backthread:blindspots <area>` command.** A thin wrapper that asks the blindspot question for the area you name and renders the cited briefing. It reads what was captured, nothing more — sparse capture in an area means a thin, honestly-flagged briefing.
- **Gemini extension description fixed.** `GEMINI.md` still described the pre-0.6.0 "salience-ranked decision log" contract; it now matches the cited-answer contract and carries the same pre-read guidance.

## 0.10.0

**`query` now routes by question-type — it's no longer "call it first for anything."** A head-to-head against a flagship model reading your source drew a clean line: the decision log's real, unique value is the *why* (rationale, trade-offs, superseded/rejected approaches), how a design *evolved*, and whole-system *data-flow* — the history your code doesn't contain. What a single function or file does *right now* is answered better by just reading that source. So the tool description and the session-start hint now say exactly that.

- **Routed guidance.** `query` (and `/backthread:how`) are pointed at why / evolution / architecture / whole-system-flow questions; for a whole-feature "how does X work" you pair a grounded answer with reading the code for local mechanics; for "what does this one function do now," you read the source. No more reflexively routing single-module mechanics questions to the log (where they'd surface change-history instead of current behavior). Server-side changes ship alongside this — flow ("walk me through…") answers are now grounded on the diagram's own spine, and a single-module-mechanics question gets a read-the-source handoff instead of change-log soup — all with no CLI change; this release is the client's half (the routing copy).

## 0.9.0

**Grounded answers got sturdier: a 45-second ceiling with one automatic retry, and an honest note when the answer is newer than your checkout.** The `query` tool's server side also learned a lot this release (better retrieval, rename-aware answers, flow walk-throughs) — those improvements arrive with no CLI change; these two are the client's half.

- **No more one-shot timeouts.** The grounded-ask round-trip now allows up to 45s per attempt (was 30s) and automatically retries once on a timeout, network error, or server 5xx before telling you anything went wrong — the request is read-only and idempotent, so retrying is always safe. Auth and not-found errors still fail immediately (they're not transient).
- **The staleness note.** Answers come from the tracked branch's merged history; your checkout may be behind. When at least one decision cited in an answer landed in a merge your local checkout doesn't contain, the answer gains one line: *"Note: N of the decisions cited above landed after your checkout — this answer reflects the tracked branch."* It's computed entirely locally (two quick git checks per cited anchor), never phones anywhere, and stays silent on any git error, non-repo directory, or when everything cited is already in your history.

## 0.8.0

**The commands you reflexively reach for — `version`, `update`, `doctor`, `logout` — now exist, plus a friendlier CLI, a Windows login fix, and a hardened supply chain.** This release rounds out the standard command surface and gets the package ready for wider use.

- **`backthread --version` / `-v` / `version`** — print the installed version (finally). Reads the package's own version, so it never needs auth or the network.
- **`backthread doctor`** — one-shot diagnostics: ✓/✗ over auth, the capture hook (including the user-vs-project worktree-scope trap), connectivity, your version, and the connected repo — each with a fix hint. Exits non-zero when something's broken, so it's scriptable. Prints only safe output (never your token).
- **`backthread update` / `-u`** — update a global install to `backthread@latest` (old → new) and quiet the upgrade nudge. It knows the difference between a global install (updates it), an ephemeral `npx` run (already latest — explains, doesn't fake it), and the Claude Code plugin (points you at `/plugin update`), and never leaves a half-updated state.
- **`backthread logout`** — drop this device's token from `~/.backthread/config.json` while keeping your repo link. A one-liner for shared or handed-down machines.
- **Friendlier CLI** — a mistyped command now gets a "did you mean `backthread login`?" pointer instead of a wall of usage; `backthread help` is grouped and actually readable.
- **Windows login fix.** Opening the sign-in URL no longer routes through `cmd.exe` (which re-parses `&` and `%`-encoded characters in the URL, and put a shell in the open path); it now uses a direct launcher (`rundll32`).

Under the hood, for a package that's meant to spread: an internal **security review** (no critical findings — see [`SECURITY.md`](./SECURITY.md)), a **supply-chain CI floor** (a high-severity `npm audit` gate, SHA-pinned GitHub Actions, Dependabot, npm build provenance kept on), a public **`SECURITY.md`** with a private disclosure policy, and a rewritten **README** plus **`llms.txt` / `llms-full.txt` / `FAQ.md`** so both humans and LLMs get the value prop straight. Nothing about the trust model changes: your source never leaves your machine unredacted.

## 0.7.0

**`backthread login` no longer touches localhost.** The old flow spun up a `127.0.0.1`
loopback server and dumped you on a bare localhost page — which Chrome's Private Network
Access now blocks outright. Login is now a **poll-based session flow** (the same shape
GitHub / Supabase / Stripe use): the CLI generates a one-time session id + an ephemeral
keypair, opens `app.backthread.dev`, and polls for the result. The browser stays on
`app.backthread.dev` start to finish and shows a proper "✓ you're connected" screen — no
loopback, no localhost, no scary "allow access to your loopback network?" prompt.

- **End-to-end encrypted token transit.** The device token is encrypted **in your browser**
  (ECDH → HKDF → AES-256-GCM) to the CLI's ephemeral public key. Backthread's servers only
  ever store ciphertext and never see the token in the clear (auditable right here in the
  OSS CLI).
- **Works on remote / SSH / containers with zero flags.** Because the token is delivered by
  polling, the browser doesn't have to be on the same machine — `backthread login` prints a
  URL you can open on any device.
- The `--claim <code>` path (CI / fully-headless) is unchanged.

## 0.6.0

**Grounded Ask — "how does X work?" now returns a synthesized, cited answer.** This
release flips the `query` tool from browse-the-log to answer-the-question, and makes a
plain how/why question route to it automatically.

- **Thin-client `query`** (#36): the `query` MCP tool now relays the question to the
  Backthread server, which retrieves across the decision log and synthesizes one short,
  **cited** answer (the "why" the code doesn't contain), reconciled to the current state
  and flagging anything inferred. The tool description is imperative ("call this FIRST"),
  and the cli is a thin relay — so all prompt/model/retrieval tuning now happens
  server-side, with no further publishes needed.
- **`/backthread:how` slash command** (#37): a deterministic way to ask, independent of
  the agent's probabilistic tool routing — `/backthread:how <question>` prints the
  grounded, cited answer.
- **Ambient routing — SessionStart hook** (#38): the plugin now injects a one-time
  instruction at session start telling Claude to reach for `query` first on how/why
  questions, before grepping source — so a plain "how does X work?" gets a grounded
  answer with no new user habit. Injected only when you're set up; never blocks or slows
  session start.
- **Plugin manifest fix** (#35): drop a redundant hooks reference that could cause a
  duplicate-load error.

Nothing about the trust model changes: source never leaves your machine; only the
question is sent, and only the derived "why" is stored.
