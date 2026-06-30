# Changelog

All notable changes to the `backthread` CLI / Claude Code plugin. Releases are cut by
pushing a `v*` tag (see [`RELEASING.md`](./RELEASING.md)); the GitHub Release also
carries auto-generated notes. Earlier versions are recorded in the git tags + GitHub
Releases (`v0.5.1` and prior).

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
