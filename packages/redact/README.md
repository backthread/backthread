# @backthread/redact

[![npm](https://img.shields.io/npm/v/@backthread/redact?logo=npm)](https://www.npmjs.com/package/@backthread/redact)
[![license](https://img.shields.io/npm/l/@backthread/redact?label=license)](./LICENSE)

The **one redaction fence** used across [Backthread](https://backthread.dev). Pure, zero-dependency string transforms that strip source code and tool I/O out of an AI coding-agent session transcript **before anything leaves the machine** — keeping only the natural-language rationale.

## The rule (load-bearing)

> **DROP** every tool-use / tool-result record entirely. Keep **only** natural-language user prompts and assistant text/thinking. In the kept text, **REDACT** fenced code blocks (`` ``` … ``` ``) to a placeholder.

No source code and no tool I/O may leave this module — only derived rationale. This is defense-in-depth: redact at the boundary so a downstream bug can't exfiltrate code.

## Install

```bash
npm install @backthread/redact
```

> **Requires Node.js ≥ 22.18.** This package ships as source-only TypeScript (`exports` points at `./src/index.ts`) and relies on Node's default type stripping. Zero runtime dependencies.

## Usage

```ts
import { parseJsonl, redactTranscript, renderTranscript } from '@backthread/redact';

const records = parseJsonl(rawJsonlFromDisk);
const redacted = redactTranscript(records); // only prose survives; code → "[code redacted]"
const text = renderTranscript(redacted);
```

### API

- `redactTranscript(records: unknown[]): RedactedTranscript` — drop tool records, keep prose, redact code fences.
- `redactCodeFences(text: string): { text: string; count: number }` — redact ``` fences in a single string.
- `renderTranscript(t: RedactedTranscript): string` — render the surviving turns back to text.
- `parseJsonl(raw: string): unknown[]` — parse a `.jsonl` transcript.
- `sessionTimestamp(records: unknown[]): string | null` — first timestamp in a transcript.
- `CODE_REDACTION` — the placeholder string substituted for each fenced code block.

## License

[MIT](./LICENSE) © Backthread
