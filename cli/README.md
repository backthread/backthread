# backthread

[![npm](https://img.shields.io/npm/v/backthread?logo=npm)](https://www.npmjs.com/package/backthread)
[![license](https://img.shields.io/npm/l/backthread?label=license)](./LICENSE)

**Keep the thread on what your AI agent actually shipped.**

When you hand code to AI agents (Claude Code, Codex, Cursor), you stop reading
every change — and a few weeks later you own a codebase you never internalized.
Debugging slows down, refactors get scary.

Backthread captures the **why** behind each change straight from your agent
sessions, so you can ask *"how does X work?"* and stay oriented without
spelunking through PRs. The decisions become a live **"How it works"** diagram
and changelog at [backthread.dev](https://backthread.dev).

## Your source code never leaves your machine

Backthread reads your agent **transcripts**, not your repo. Before anything is
sent, the CLI redacts every transcript **locally**:

- **Drops** every tool call and tool result — where source code and command output live.
- **Keeps** only natural-language prompts and the agent's reasoning.
- **Redacts** any fenced code block to `[code redacted]`.

So no source code and no tool I/O ever leave your machine. Because the default
path runs inference on our servers, what *does* leave is the **redacted
transcript** — natural-language prose only. The Worker re-runs the fenced-code
scrub server-side as a fail-closed backstop, derives the **decisions**, and
discards the transcript right after — processed in memory, never stored. Only
the decisions are persisted.

That's a weaker claim than the bring-your-own-key path — where nothing but the
derived decisions ever leaves your machine — which is designed and coming. We'd
rather say so than paper over it. The redaction fence is open source
([`@backthread/redact`](https://www.npmjs.com/package/@backthread/redact)) so you
can verify it — read more at [backthread.dev/security](https://backthread.dev/security).

## Quick start

### Claude Code → install the plugin (one click, recommended)

In Claude Code:

```
/plugin marketplace add backthread/backthread
/plugin install backthread@backthread
/backthread:start
```

Installing the plugin bundles the CLI — no separate npm step — and registers, at
**user/global scope** (so it works across every repo and git worktree), the
SessionEnd **capture hook**, the `/backthread:capture` & `/backthread:start`
commands, and the **backthread MCP server** (capture + `query`). `/backthread:start`
just signs you in. That's the whole setup.

### Any agent (or bare terminal) → `npx backthread install`

In your project:

```bash
npx backthread install
```

That's the whole setup. `install`:

1. **Signs you in** — opens your browser for one click (you'll need a free
   [Backthread](https://backthread.dev) account; the CLI never sees a password,
   and your device token is never printed or copied to the clipboard).
2. **Wires up capture** — registers a hook so each Claude Code session is
   captured automatically when it ends.
3. **Backfills history** — replays your recent Claude Code sessions in this repo
   so your "How it works" log isn't empty on day one.

Already added Backthread as a Claude Code plugin? The hook is wired for you —
run `/backthread:start` (or `npx backthread start`) just to sign in.

## Onboard yourself in 3 steps

1. **Install** — `npx backthread install` in your repo. One browser click to authorize.
2. **Keep coding** — at the end of every Claude Code session, Backthread captures
   the decisions automatically. Nothing to remember.
3. **Ask "how does X work?"** — query your decision log right inside Claude Code
   (the `backthread` MCP server exposes a `query` tool), or open the live diagram
   at [app.backthread.dev](https://app.backthread.dev).

## Commands

```
backthread install   Set up capture for this repo (sign in + hook + backfill)
backthread start     First-run for the Claude Code plugin (sign in + your next step)
backthread login     Authorize this device (opens your browser)
backthread whoami    Show this device's config (your token is never printed)
backthread capture   Capture a session's decisions (run automatically by the hook)
backthread mcp       Start the MCP server — the capture + "how does X work?" query tools
backthread help      Show usage
```

## Requirements

- **Node.js ≥ 22.18**

## Learn more

- **Live app** — [backthread.dev](https://backthread.dev)
- **How your data is handled** — [backthread.dev/security](https://backthread.dev/security)
- **Source & internals** — [github.com/backthread/backthread](https://github.com/backthread/backthread)

## License

[MIT](./LICENSE) © Backthread
