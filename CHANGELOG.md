# Changelog

All notable changes to the `backthread` CLI / Claude Code plugin. Releases are cut by
pushing a `v*` tag (see [`RELEASING.md`](./RELEASING.md)); the GitHub Release also
carries auto-generated notes. Earlier versions are recorded in the git tags + GitHub
Releases (`v0.5.1` and prior).

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
