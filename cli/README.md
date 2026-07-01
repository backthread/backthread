# backthread

[![npm](https://img.shields.io/npm/v/backthread?logo=npm)](https://www.npmjs.com/package/backthread)
[![license](https://img.shields.io/npm/l/backthread?label=license)](./LICENSE)

**Backthread keeps the thread on what your AI coding agent ships — it captures the why behind every change and turns it into a living 'How it works' view of your codebase you can actually query.**

```bash
npx backthread
```

One command, the whole setup: signs you in (one browser click), connects this
repo, wires up automatic capture, and hands you the link to your live **"How it
works"** diagram. Re-run it any time — it's idempotent, so a returning user just
gets told they're good to go.

> **In Claude Code?** `/plugin marketplace add backthread/backthread` →
> `/plugin install backthread@backthread` → `/backthread:start`. The plugin
> bundles the CLI, so there's no separate npm step.

When you hand code to AI agents (Claude Code, Codex, Cursor), you stop reading
every change — and a few weeks later you own a codebase you never internalized.
Debugging slows down, refactors get scary. Backthread captures the **why** behind
each change straight from your agent sessions, so you can ask *"how does X work?"*
and stay oriented without spelunking through PRs. The decisions become a live
**"How it works"** diagram and changelog at
[app.backthread.dev](https://app.backthread.dev) — see the
[live demo](https://app.backthread.dev/demo).

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

## What `npx backthread` does

The bare command is the unified front door. Under the hood it:

1. **Signs you in** — opens your browser for one click (you'll need a free
   [Backthread](https://backthread.dev) account; the CLI never sees a password,
   and your device token is never printed or copied to the clipboard).
2. **Wires up capture** — registers a hook so each Claude Code session is
   captured automatically when it ends.
3. **Backfills history** — replays your recent Claude Code sessions in this repo
   so your "How it works" log isn't empty on day one.

Then keep coding. At the end of every Claude Code session, Backthread captures
the decisions automatically — nothing to remember. Ask *"how does X work?"* right
from the terminal (`backthread how "how does auth work?"`) or inside Claude Code
(the `backthread` MCP server exposes a `query` tool + a `/backthread:how` slash
command), or open the live diagram at [app.backthread.dev](https://app.backthread.dev).

### Claude Code plugin (alternative)

Prefer the marketplace? In Claude Code:

```
/plugin marketplace add backthread/backthread
/plugin install backthread@backthread
/backthread:start
```

Installing the plugin bundles the CLI — no separate npm step — and registers, at
**user/global scope** (so it works across every repo and git worktree), the
SessionEnd **capture hook**, the `/backthread:capture` & `/backthread:start`
commands, and the **backthread MCP server** (capture + `query`). `/backthread:start`
just signs you in.

### Codex / Cursor / Gemini CLI

Use another coding agent? One command wires up its **MCP server** (the `query`
tool) **and** an automatic capture hook — written to that agent's **user-global**
config so capture follows you across every repo and git worktree:

```bash
npx backthread install --agent codex     # ~/.codex/config.toml + ~/.codex/hooks.json
npx backthread install --agent cursor     # ~/.cursor/mcp.json   + ~/.cursor/hooks.json
npx backthread install --agent gemini     # ~/.gemini/settings.json (MCP + SessionEnd hook)
```

It's idempotent (re-running never duplicates anything) and a strict merge (it never
clobbers your other config). Then `npx backthread login` once to authorize. Gemini
users can also install the [one-command extension](https://github.com/backthread/backthread/tree/main/extensions/gemini)
instead, and Codex users the [plugin](https://github.com/backthread/backthread/tree/main/extensions/codex).

## Commands

```
backthread                     Set up Backthread — the front door (sign in + connect + capture).
                               Idempotent: a returning user is told they're good to go.
backthread how "<question>"    Ask how/why something works — a grounded, cited answer from your log
backthread install             Set up capture for this repo (sign in + hook + backfill)
backthread login / logout      Authorize this device / sign it out (drops the local token)
backthread doctor              Diagnose your setup (auth, hook, connectivity, version, repo)
backthread update              Update a global install to the latest (also -u)
backthread version             Print the installed version (also --version, -v)
backthread whoami              Show this device's config (your token is never printed)
backthread capture             Capture a session's decisions (run automatically by the hook)
backthread mcp                 Start the MCP server — the capture + "how does X work?" query tools
backthread help                Show the full usage (also --help, -h)
```

## Requirements

- **Node.js ≥ 22.18**

## Learn more

- **Live app & demo** — [app.backthread.dev](https://app.backthread.dev) · [app.backthread.dev/demo](https://app.backthread.dev/demo)
- **Marketing site** — [backthread.dev](https://backthread.dev)
- **How your data is handled** — [backthread.dev/security](https://backthread.dev/security)
- **Source & internals** — [github.com/backthread/backthread](https://github.com/backthread/backthread)

## License

[MIT](./LICENSE) © Backthread
