# Backthread

[![npm: backthread](https://img.shields.io/npm/v/backthread?label=backthread&logo=npm)](https://www.npmjs.com/package/backthread)
[![npm: @backthread/redact](https://img.shields.io/npm/v/@backthread/redact?label=%40backthread%2Fredact&logo=npm)](https://www.npmjs.com/package/@backthread/redact)
[![license](https://img.shields.io/npm/l/backthread?label=license)](./LICENSE)

**Architectural memory for AI-coded codebases.** When you delegate code to AI agents (Claude Code, Cursor, Codex), you lose the mental model of your own system. Backthread preserves the *why* of every change so you can stay oriented without re-reading every PR.

This repository holds the **open-source pieces** of Backthread — the client-side bits that run on your machine and touch your code, published in the open so you can audit exactly what they do. The hosted app lives at **[backthread.dev](https://backthread.dev)**.

## Packages

| Package | npm | What it is |
|---|---|---|
| [`cli`](./cli) | [`backthread`](https://www.npmjs.com/package/backthread) | The `npx backthread` CLI — captures the *why* of your changes from Claude Code sessions and queries your codebase's architectural memory from the terminal. |
| [`packages/redact`](./packages/redact) | [`@backthread/redact`](https://www.npmjs.com/package/@backthread/redact) | The redaction fence — pure, zero-dependency string transforms that strip source code and tool I/O out of a session transcript before anything leaves your machine. |

## Why these are open source

The redaction fence and the CLI are the parts of Backthread that run **on your machine and see your code**. The trust claim — *"source code and tool I/O never leave your machine unredacted"* — is only worth as much as your ability to verify it. So this code is public: read it, audit it, run it. ("Verify us," not "trust us.")

The structural extractor that derives the architecture diagram will join this repo as [`@backthread/extractor`](https://www.npmjs.com/package/@backthread/extractor) — it's polyglot by design (TypeScript today, more languages behind a pluggable adapter seam).

## Quick start

```bash
npx backthread
```

## Requirements

- **Node.js ≥ 22.18** — the redaction fence ships as source-only TypeScript and relies on Node's default type stripping.

## Endpoints

The CLI talks to the hosted Backthread service (`app.backthread.dev` and its ingest worker). These are public endpoints; no secrets are embedded in this source.

## License

[MIT](./LICENSE) © Backthread
