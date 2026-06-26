# Backthread — Codex plugin

Keep the thread on what your AI agent shipped. This [Codex](https://developers.openai.com/codex)
plugin bundles, in one install:

- the **`backthread` MCP server** (the `query` "how does X work?" tool + `capture`), and
- an automatic **Stop capture hook** — every session's decisions (the *why*) are
  captured when a turn ends, with **no manual step**.

Your **source code and tool I/O never leave your machine** — Backthread redacts every
transcript locally before anything is sent. See
[backthread.dev/security](https://backthread.dev/security).

## Install

Both the MCP server and the hook run the published `backthread` CLI via `npx`, so the
plugin itself is just config — nothing to build.

```bash
# Register this directory as a Codex plugin marketplace, then install via /plugins:
codex plugin marketplace add ./extensions/codex
# then, inside Codex:  /plugins  → install "backthread"
```

**One-time sign-in** (authorizes this device; the token is never printed):

```bash
npx backthread login
```

That's it. Ask *"how does X work?"* and Codex will use the `query` tool; keep coding
and each session is captured automatically.

## What it registers

- `plugins/backthread/.mcp.json` → the `backthread` MCP server (`npx -y backthread mcp`).
- `plugins/backthread/hooks/hooks.json` → a `Stop` hook running
  `npx -y backthread@latest capture --from-hook --agent codex --detach`. Codex's `Stop`
  fires at **turn scope** and is **awaited** (it expects a JSON ack on stdout), so the
  capture **detaches** a worker — it prints the `{ "continue": true }` ack and returns
  instantly so it never adds latency to a turn, while the redact → derive → persist
  round-trip finishes in the background. The shared `--from-hook` entrypoint dedupes
  per session, so the per-turn `Stop` captures each session only once.

## Verify-live status (spike-flavored — ARP-505 / ARP-507)

Built against the official Codex plugin + hooks docs, but confirm on a real Codex
install before relying on it:

- **`.mcp.json` direct server map** (vs a wrapped `{ "mcpServers": … }` object) — the
  docs call the direct map standard; verify the server loads.
- **`marketplace.json` `source: { source: "local", path }`** shape + whether
  `codex plugin marketplace add <dir>` discovers `marketplace.json` at the dir root.
- **`Stop` ack** — Codex expects JSON on stdout when the hook exits 0; the
  `--agent codex` path emits `{ "continue": true, … }`. Confirm the turn isn't blocked.

The verified two-file fallback (write `~/.codex/config.toml` MCP + `[[hooks.Stop]]`) is
`backthread install --agent codex` (ARP-503).

## Requirements

- **Node.js ≥ 22.18** (for `npx backthread`)
- **Codex CLI ≥ 0.124.0** (hooks stable) / ≥ 0.117.0 (plugins)

## Learn more

- [backthread.dev](https://backthread.dev) · [How your data is handled](https://backthread.dev/security)
- The `backthread` CLI: [npm](https://www.npmjs.com/package/backthread) ·
  [source](https://github.com/backthread/backthread/tree/main/cli)
