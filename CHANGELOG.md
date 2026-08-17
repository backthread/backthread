# Changelog

All notable changes to the `backthread` CLI / Claude Code plugin. Releases are cut by
pushing a `v*` tag (see [`RELEASING.md`](./RELEASING.md)); the GitHub Release also
carries auto-generated notes. Earlier versions are recorded in the git tags + GitHub
Releases (`v0.5.1` and prior).

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
