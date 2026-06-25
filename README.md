# Backthread

[![npm: backthread](https://img.shields.io/npm/v/backthread?label=backthread&logo=npm)](https://www.npmjs.com/package/backthread)
[![npm: @backthread/redact](https://img.shields.io/npm/v/@backthread/redact?label=%40backthread%2Fredact&logo=npm)](https://www.npmjs.com/package/@backthread/redact)
[![license](https://img.shields.io/npm/l/backthread?label=license)](./LICENSE)

**Keep the thread on what your AI agent actually shipped.**

```bash
npx backthread
```

One command, the whole setup: signs you in (one browser click), connects this
repo, wires up automatic capture, and hands you the link to your live **"How it
works"** diagram. Re-run it any time — it's idempotent.

> **In Claude Code?** `/plugin marketplace add backthread/backthread` →
> `/plugin install backthread@backthread` → `/backthread:start`. The plugin
> bundles the CLI, so there's no separate npm step.

When you delegate code to AI agents (Claude Code, Cursor, Codex), you stop
reading every change — and a few weeks later you own a codebase you never
internalized. Debugging slows down, refactors get scary. Backthread captures the
*why* behind each change straight from your agent sessions, so you can ask
*"how does X work?"* and stay oriented without re-reading every PR. The decisions
become a live **"How it works"** diagram and changelog at
[app.backthread.dev](https://app.backthread.dev) — try the
[live demo](https://app.backthread.dev/demo), or sign up at
[app.backthread.dev](https://app.backthread.dev).

This repository holds the **open-source pieces** of Backthread — the client-side
bits that run on your machine and touch your code, published in the open so you
can audit exactly what they do. The hosted app lives at
**[backthread.dev](https://backthread.dev)**.

## Packages

| Package | npm | What it is |
|---|---|---|
| [`cli`](./cli) | [`backthread`](https://www.npmjs.com/package/backthread) | The `npx backthread` CLI — captures the *why* of your changes from Claude Code sessions and queries your codebase's "How it works" log from the terminal. |
| [`packages/redact`](./packages/redact) | [`@backthread/redact`](https://www.npmjs.com/package/@backthread/redact) | The redaction fence — pure, zero-dependency string transforms that strip source code and tool I/O out of a session transcript before anything leaves your machine. |

## Why these are open source

The redaction fence and the CLI are the parts of Backthread that run **on your machine and see your code**. The trust claim — *"source code and tool I/O never leave your machine unredacted"* — is only worth as much as your ability to verify it. So this code is public: read it, audit it, run it. ("Verify us," not "trust us.")

The structural extractor that derives the architecture diagram will join this repo as [`@backthread/extractor`](https://www.npmjs.com/package/@backthread/extractor) — it's polyglot by design (TypeScript today, more languages behind a pluggable adapter seam).

## Requirements

- **Node.js ≥ 22.18** — the redaction fence ships as source-only TypeScript and relies on Node's default type stripping.

## Endpoints

The CLI talks to the hosted Backthread service (`app.backthread.dev` and its ingest worker). These are public endpoints; no secrets are embedded in this source.

## Links

- **Live app & demo** — [app.backthread.dev](https://app.backthread.dev) · [app.backthread.dev/demo](https://app.backthread.dev/demo)
- **Marketing site** — [backthread.dev](https://backthread.dev)
- **How your data is handled** — [backthread.dev/security](https://backthread.dev/security)
- **CLI on npm** — [npmjs.com/package/backthread](https://www.npmjs.com/package/backthread)

## License

[MIT](./LICENSE) © Backthread
