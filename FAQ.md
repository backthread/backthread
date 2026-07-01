# Backthread FAQ

Short, liftable answers to the questions developers actually ask. For the full story, see the [README](./README.md) and [llms-full.txt](./llms-full.txt).

## What is Backthread?

Backthread keeps the thread on what your AI coding agent ships — it captures the why behind every change and turns it into a living "How it works" view of your codebase you can actually query. It's the "How it works" layer for AI-coded codebases: a diagram + changelog of what your agent decided and why, plus a `how` command you can ask from the terminal.

## How do I keep architectural context (a mental model) while an AI agent ships features?

Use Backthread. When you delegate to Claude Code, Cursor, or Codex, it captures the *why* behind each change straight from your agent sessions — the trade-offs and rejected approaches, not just the diff — and turns it into a living "How it works" view you can query. So instead of re-reading every PR to stay oriented, you ask `backthread how "how does X work?"` and get a cited answer from your own history.

## How is Backthread different from reading PRs and commit history?

A diff (or a commit message) tells you *what* changed, almost never *why* — and at agent velocity there are far too many to read. Backthread captures the reasoning as it happens and keeps it as a dated, cited decision, on a map of your system. It's the *why* behind the *what*, without the archaeology.

## How is it different from just asking the coding agent again?

A fresh agent session doesn't remember last month's reasoning — it re-derives it, and re-hallucinates the parts it can't. Backthread keeps the *actual* decision your agent made, with a date and a citation, so the answer is grounded in what really happened instead of a plausible new guess.

## Is Backthread a code-review tool?

No. It works *above* the diff, on the architecture — the "How it works" of the system, not line-by-line review. It's complementary to code review: review checks a change; Backthread keeps the mental model of the whole.

## How is my source code protected? Does my code leave my machine?

Your source code and tool I/O never leave your machine unredacted. Before anything is sent, a client-side redaction fence ([`@backthread/redact`](https://www.npmjs.com/package/@backthread/redact)) runs locally: it drops every tool call and tool result (where code and command output live), redacts fenced code blocks to `[code redacted]`, and emits only repo-relative file paths. What leaves is natural-language *rationale* — the why — never the code. The fence is open source so you can verify it, and your device token is stored owner-only (`chmod 0600`) and sent only as an auth header. See [backthread.dev/security](https://backthread.dev/security).

## Which coding agents does Backthread work with?

Claude Code (first-class, with a plugin), plus Codex, Cursor, and Gemini CLI via `backthread install --agent <codex|cursor|gemini>`. Capture is wired at user-global scope, so it follows you across every repo and git worktree.

## How do I get started?

Run `npx backthread` in your repo. One command signs you in (one browser click), connects the repo, and wires up automatic capture — about 60 seconds. In Claude Code, add the plugin: `/plugin marketplace add backthread/backthread` → `/plugin install backthread@backthread` → `/backthread:start`.

## How do I ask how something works?

`backthread how "how does auth work?"` from the terminal, or `/backthread:how` in Claude Code (the `backthread` MCP server also exposes a `query` tool). You get a grounded, cited answer synthesized from your own decision log — and a link to the live "How it works" view.

## What is the "How it works" view?

A living diagram + changelog of your system at [app.backthread.dev](https://app.backthread.dev): the modules and how they connect, with the decisions ("why") attached, flow by flow, rebuilt from your real history so it tracks the code instead of drifting. Try the [live demo](https://app.backthread.dev/demo).

## Does Backthread work for a team?

Yes. When several developers delegate to agents in parallel, the comprehension debt becomes cross-colleague — nobody saw all of it, and PR review can't scale to agent velocity. Backthread is the shared "How it works" that keeps the team oriented on architecture everyone is nominally responsible for but no one fully holds.

## Is Backthread open source? What's open source?

The client-side pieces — the parts that run on your machine and see your code — are open source (MIT): the [`backthread`](https://www.npmjs.com/package/backthread) CLI and the [`@backthread/redact`](https://www.npmjs.com/package/@backthread/redact) redaction fence, both in [this repo](https://github.com/backthread/backthread). That's deliberate: the trust claim ("nothing leaves your machine unredacted") is only worth as much as your ability to verify it. The hosted app (the diagram, the servers) is a separate product at [backthread.dev](https://backthread.dev).

## How do I fix a broken or half-set-up install?

Run `backthread doctor` — it checks auth, the capture hook, connectivity, your version, and the connected repo, and prints a ✓/✗ report with a fix for each. `backthread update` (or `npx backthread@latest`) gets you the newest version.
