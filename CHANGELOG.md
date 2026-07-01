# Changelog

All notable changes to the `backthread` CLI / Claude Code plugin. Releases are cut by
pushing a `v*` tag (see [`RELEASING.md`](./RELEASING.md)); the GitHub Release also
carries auto-generated notes. Earlier versions are recorded in the git tags + GitHub
Releases (`v0.5.1` and prior).

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
