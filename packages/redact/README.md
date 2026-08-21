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
- `sessionPaths(records: unknown[], repoRoot?: string, options?: SessionPathsOptions): string[]` — the file-path harvest; see below.
- `HARVESTED_PATH_EXTENSIONS` — the extensions a shell-scraped token must end in.
- `CODE_REDACTION` — the placeholder string substituted for each fenced code block.

## `sessionPaths` — what it reads, and what leaves the machine

This function is the one part of the package that does **not** simply drop tool records. It exists so a captured decision can say *which files it was about*, so it runs over the **raw** records **before** `redactTranscript` drops them. Read this section carefully if you are auditing the never-store-source claim — the rest of the package only ever removes things, and this part selects things.

**What it reads.** Four path-named tool-input fields (`file_path`, `path`, `notebook_path`, `cwd`), and — this is the part worth knowing — **the raw text of shell commands** (`input.command`: a string for Claude Code's `Bash`, an argv array for Codex's `shell`). A modern agent session touches most of its files through shell calls, so the path-named fields alone miss about half of them.

**What leaves the machine.** Only **repo-relative file paths**: `worker/src/queue.ts`. Never file contents, never command output, and **never the command string itself** — a shell command is scanned for path-shaped substrings and those substrings are all that can be emitted. A heredoc that writes a whole source file can therefore contribute the *name* of the file it wrote, and nothing else from its body.

**What can never be emitted**, enforced in this order:

1. Anything machine-absolute. An absolute path is either rewritten relative to the repo root or dropped; if no root can be resolved, it is dropped.
2. Anything outside the repo root, including a sibling directory with a shared prefix (`/repo-other` is not inside `/repo`).
3. Any traversal. A `../` escape, a `~` home path, a Windows or UNC path, and a mid-path `..` that resolves above the root are all dropped. **No emitted path ever contains a `..` segment.**
4. From a shell command specifically: anything that is not confirmed to be a real file in the repo (see next), anything under `.git/` or `node_modules/`, any token over 200 characters, and anything past the first 200 distinct paths in a session.

**The `exists` predicate is required for shell scanning, and this is the important part.** A token scraped out of a command carries no evidence of what it is relative to. After `cd /etc`, the command `cat app/secrets.json` produces `app/secrets.json` — a well-formed, in-repo-looking path naming a file that has nothing to do with your repo. So do a scheme-less URL (`curl internal-api.example/v3/export.json`), a REST route, and a string literal inside a heredoc. No string rule can tell those apart from a real path; only the filesystem can. So `sessionPaths` takes the check as an injected predicate:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const paths = sessionPaths(records, repoRoot, {
  exists: (rel) => existsSync(join(repoRoot, rel)), // memoise this
});
```

**Omit `exists` and no shell-derived path is emitted at all** — it fails closed, so a caller that has not opted in cannot leak. The predicate is injected rather than performed here because this package is pure and dependency-free by design.

**A known trade-off:** a file the session *deleted* no longer exists, so its path is lost. That is deliberate — a decision anchored to a path that resolves to nothing teaches nobody anything, and the alternative is trusting every unverifiable token.

## License

[MIT](./LICENSE) © Backthread
