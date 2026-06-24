# Backthread — Gemini CLI extension

Keep the thread on what your AI agent shipped. This [Gemini CLI](https://geminicli.com)
extension bundles, in one install:

- the **`backthread` MCP server** (the `query` "how does X work?" tool + `capture`), and
- an automatic **SessionEnd capture hook** — every session's decisions (the *why*)
  are captured when it ends, with **no manual step**.

Your **source code and tool I/O never leave your machine** — Backthread redacts every
transcript locally before anything is sent. See
[backthread.dev/security](https://backthread.dev/security).

## Install

Both the MCP server and the hook run the published `backthread` CLI via `npx`, so the
extension itself is just config — nothing to build.

**From a local clone of this repo:**

```bash
gemini extensions install --path ./extensions/gemini
```

**One-time sign-in** (authorizes this device; the token is never printed):

```bash
npx backthread login
```

That's it. Ask *"how does X work?"* and Gemini will use the `query` tool; keep coding
and each session is captured automatically when it ends.

## What it registers

- `gemini-extension.json` → the `backthread` MCP server (`npx -y backthread mcp`).
- `hooks/hooks.json` → a `SessionEnd` hook that runs
  `npx -y backthread capture --from-hook --agent gemini-cli --detach`. Gemini's
  SessionEnd is best-effort (the CLI does not wait for the hook), so the capture
  **detaches** a worker that finishes the redact → derive → persist round-trip after
  the CLI exits. It always exits 0 and never delays your session.

## Requirements

- **Node.js ≥ 22.18** (for `npx backthread`)
- **Gemini CLI ≥ 0.26.0** (hooks; enabled by default)

## Learn more

- [backthread.dev](https://backthread.dev) · [How your data is handled](https://backthread.dev/security)
- The `backthread` CLI: [npm](https://www.npmjs.com/package/backthread) ·
  [source](https://github.com/backthread/backthread/tree/main/cli)
