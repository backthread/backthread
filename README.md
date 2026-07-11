# Backthread

[![npm: backthread](https://img.shields.io/npm/v/backthread?label=backthread&logo=npm)](https://www.npmjs.com/package/backthread)
[![npm: @backthread/redact](https://img.shields.io/npm/v/@backthread/redact?label=%40backthread%2Fredact&logo=npm)](https://www.npmjs.com/package/@backthread/redact)
[![license](https://img.shields.io/npm/l/backthread?label=license)](./LICENSE)

**Backthread keeps the thread on what your AI coding agent ships — it captures the why behind every change and turns it into a living 'How it works' view of your codebase you can actually query.**

```bash
npx backthread
```

One command, the whole setup: signs you in (one browser click), connects this repo, wires up automatic capture, and hands you the link to your live **"How it works"** view. Re-run it anytime — it's idempotent.

> **In Claude Code?** `/plugin marketplace add backthread/backthread` → `/plugin install backthread@backthread` → `/backthread:start`. The plugin bundles the CLI, so there's no separate npm step.

## What it is

You delegate code to an agent (Claude Code, Cursor, Codex). It ships. You skim the diff, approve, move on. Three or four weeks later you own a codebase full of decisions you nominally made but never actually internalized — and now debugging is slow and every refactor is a coin flip.

Backthread captures the **why** behind each change straight from your agent sessions — the trade-offs, the rejected approaches, the "we did it this way because…" — and turns it into a living **"How it works"** view of your system: a diagram + changelog at [app.backthread.dev](https://app.backthread.dev), plus a `how` command you can ask right from the terminal. Try the [live demo](https://app.backthread.dev/demo).

Your source code never leaves your machine unredacted — [that's the whole point](#security), and it's auditable right here.

## When to use Backthread

- You're a **founder or CTO who's been vibecoding with an agent for weeks** and can no longer fully explain your own system.
- Your **team ships agent PRs faster than anyone can actually review them**, and nobody holds the whole architecture in their head anymore.
- You're about to **refactor or debug a part of the codebase you didn't write by hand** and need the *why* before you touch it.
- You want to **onboard a teammate (or your future self)** to how a system works without a week of PR archaeology.
- You want to **ask "how does auth work?" or "why is billing structured this way?"** and get a cited answer from your own history — not a fresh guess.

## Backthread vs. the alternatives

You already have ways to reconstruct the *why*. They just don't keep up with agent velocity:

- **vs. re-reading PRs & commit archaeology** — the diff shows *what* changed, never *why* — and at agent speed there are far too many to read. Backthread captures the why as it happens.
- **vs. re-interrogating the agent** — a fresh session doesn't remember last month's reasoning; it re-derives (and re-hallucinates) it. Backthread keeps the *actual* decision, dated and cited.
- **vs. docs that rot the day they're written** — hand-maintained docs drift the moment the next PR lands. Backthread's view is rebuilt from your real history, so it tracks the code instead of lying about it.

Backthread isn't a code-review tool — it lives *above* the diff, on the architecture.

## Quickstart

```bash
npx backthread            # sign in + connect this repo + wire up capture (~60 seconds)
```

That's the whole setup. From then on Backthread captures the why behind each session automatically. Then, whenever you're lost:

```bash
backthread how "how does auth work?"    # a grounded, cited answer from your own decision log
```

…and open your live **"How it works"** view at [app.backthread.dev](https://app.backthread.dev).

Not sure what's wired up? `npx backthread doctor` tells you exactly what's set up and what isn't.

## Commands

| Command | What it does |
|---|---|
| `backthread` | The front door: sign in, connect this repo, wire up capture. Idempotent — re-run anytime. |
| `backthread how "<question>"` | Ask how/why something works — a grounded, cited answer from your decision log. |
| `backthread login` / `backthread logout` | Authorize this device (one browser click) / sign it out (drops the local token, keeps the repo link). |
| `backthread install` | Set up capture for this repo (`--agent codex\|cursor\|gemini` wires up other agents). |
| `backthread doctor` | Diagnose your setup — auth, capture hook, connectivity, version, repo — with ✓/✗ + fixes. |
| `backthread update` | Update a global install to the latest (also `-u`). |
| `backthread version` | Print the installed version (also `--version`, `-v`). |
| `backthread whoami` | Show this device's config (never prints the token). |
| `backthread mcp` | Start the MCP server (the `capture` + `how`/`query` tools) over stdio. |
| `backthread graph` | Refresh the repo-local **structure** cache (offline, incremental) — the local tier of the grep-time context hook. |
| `backthread sync` | Sync this repo's merged decision **"why"** into the local cache (device-token auth, hours-TTL). |
| `backthread help` | The full list (also `--help`, `-h`). |

## Two tiers: grep-time context vs. hosted synthesis

Backthread answers "what's going on here?" at two depths, so you pay for depth only when you need it:

- **Local, per-grep (free, offline, automatic).** When your agent runs Grep/Glob, a PreToolUse hook injects a ~300-token pointer for the search term — the relevant local modules **and** the recorded *why* (trade-offs, assumptions, rejected approaches) — before the search runs. No network, no LLM, no billing. It's keyed off the **search term, not node identity**, so it stays right even when your working tree has diverged from what's merged: a brand-new local module still gets the on-record why by keyword match, with nothing mis-attributed.
- **Hosted synthesis (on demand).** For a hard whole-system question — *"how does the whole X work?"*, how a design evolved, a deliberate blindspot pass — `backthread how "…"` (or the `query` MCP tool / `/backthread:how`) reconciles the full merged decision log into a short, cited answer the raw local cache can't produce.

**The cache** lives at `.backthread/cache.json` in your repo root (self-ignored — it never touches your tracked `.gitignore`), with two sections:

- `structure` — computed **locally** from your working tree by `backthread graph` (exact, offline, zero-LLM), refreshed **incrementally** (the expensive symbol work stays proportional to what changed).
- `decisions` — the **merged** decision log synced down by `backthread sync`. Decisions are merge-gated, so they rarely change mid-session.

**Freshness.** SessionStart refreshes both in the background (a decision sync + a structure re-extract), and the decision sync also carries an hours-TTL fallback. You can refresh either on demand with `backthread graph` / `backthread sync`. No action needed beyond installing the plugin and staying on the latest version.

## Packages

| Package | npm | What it is |
|---|---|---|
| [`cli`](./cli) | [`backthread`](https://www.npmjs.com/package/backthread) | The `npx backthread` CLI — captures the *why* of your changes from your agent sessions and answers "how does X work?" from the terminal. |
| [`packages/redact`](./packages/redact) | [`@backthread/redact`](https://www.npmjs.com/package/@backthread/redact) | The redaction fence — pure, zero-dependency string transforms that strip source code and tool I/O out of a session transcript before anything leaves your machine. |
| [`packages/extractor`](./packages/extractor) | `@backthread/extractor` *(not yet published)* | Deterministic, install-free structural extraction (AST → communities → god-nodes → framework & infra adapters) for TypeScript + Python — zero LLM/DB/network. Powers the local structure cache. |

## Why these are open source

The redaction fence and the CLI are the parts of Backthread that run **on your machine and see your code**. The trust claim — *"source code and tool I/O never leave your machine unredacted"* — is only worth as much as your ability to verify it. So this code is public: read it, audit it, run it. **Verify us, don't trust us.**

The structural extractor that derives the architecture view lives in this repo as [`@backthread/extractor`](./packages/extractor) — polyglot by design (TypeScript + Python today, more languages behind a pluggable adapter seam), and it's the same engine that powers the local structure cache above. (Not yet published to npm; the CLI resolves it from this workspace for now.)

## Security

Found a hole in that promise? Report it privately — see [`SECURITY.md`](./SECURITY.md) (or GitHub's "Report a vulnerability" button). How your data is handled end to end: [backthread.dev/security](https://backthread.dev/security).

The short version: your source and tool I/O never leave your machine unredacted — the [`@backthread/redact`](./packages/redact) fence strips them **locally, before anything is sent**, and the device token is stored owner-only (`chmod 0600`) and sent only as an auth header, never in a URL or log.

## Requirements

- **Node.js ≥ 22.18** — the redaction fence ships as source-only TypeScript and relies on Node's default type stripping. The CLI talks only to public endpoints (`app.backthread.dev` + its ingest worker); no secrets are embedded in this source.

## Links

- **Live app & demo** — [app.backthread.dev](https://app.backthread.dev) · [app.backthread.dev/demo](https://app.backthread.dev/demo)
- **Marketing site** — [backthread.dev](https://backthread.dev)
- **How your data is handled** — [backthread.dev/security](https://backthread.dev/security)
- **CLI on npm** — [npmjs.com/package/backthread](https://www.npmjs.com/package/backthread)

## License

[MIT](./LICENSE) © Backthread
