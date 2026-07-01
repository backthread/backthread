# Security Policy

Backthread's whole pitch rests on one promise: **your source code and tool I/O never
leave your machine unredacted.** This repository is public so you can check that we mean
it — *verify us, don't trust us.* This document is how to report a hole in that promise,
and what the promise actually is.

## Reporting a vulnerability

**Please report privately first — don't open a public issue for a security bug.**

Two ways, either is fine:

- **Email [security@backthread.dev](mailto:security@backthread.dev)** — the fastest path.
- **GitHub → the [Security tab](https://github.com/backthread/backthread/security) → "Report a
  vulnerability"** — GitHub's private advisory flow, so the report and our back-and-forth
  stay private until there's a fix.

Please include: what you found, how to reproduce it (a proof of concept is gold), the
version (`backthread --version`), and the impact as you see it.

- **We respond within one business day.**
- We'll confirm the report, agree a disclosure timeline with you, keep you posted while we
  fix it, and credit you when it ships (unless you'd rather stay anonymous).
- We don't run a paid bug bounty yet. When we do, this document will say so.

Operator: **BACKTHREAD OÜ**, Estonia. Full data-handling posture, sub-processors, and the
long-form policy live at **[backthread.dev/security](https://backthread.dev/security)**.

## Supported versions

Backthread is a rolling release — the CLI self-updates (the `npx backthread@latest` hooks
re-resolve the newest version on every run), so we support **the latest published release**
and fix security issues by shipping forward, fast.

| Version                    | Supported                                             |
| -------------------------- | ----------------------------------------------------- |
| Latest published release   | ✅ Yes                                                |
| Anything older             | ⚠️ Please update — `backthread update` (or `npx backthread@latest`) |

Check yours with `backthread --version`; diagnose an install with `backthread doctor`.

## Safe harbor

We consider security research conducted in **good faith** — probing your own install,
respecting privacy, avoiding data destruction and service degradation, and giving us a
reasonable chance to fix an issue before you disclose it — to be authorized. We won't
pursue or support legal action against good-faith researchers, and if a third party brings
action against you for such research, we'll make it known that it was authorized. Don't
access, modify, or exfiltrate other people's data; don't run automated scans that degrade
the hosted service; when in doubt, ask at [security@backthread.dev](mailto:security@backthread.dev).

## Scope

This repository is the **client-side** OSS: the [`backthread`](https://www.npmjs.com/package/backthread)
CLI (in [`cli/`](./cli)) and the [`@backthread/redact`](https://www.npmjs.com/package/@backthread/redact)
redaction fence (in [`packages/redact`](./packages/redact)) — the code that runs on your
machine and touches your code. Vulnerabilities in the **hosted service**
(`app.backthread.dev` + its ingest worker) are also in scope for reports — same contact
above; that surface just isn't in this repo.

## Threat model & trust boundaries

The security-critical claim is **"nothing leaves your machine except redacted rationale."**
Here's the boundary it rests on, all auditable in this repo:

- **The redaction fence runs locally, first.** [`@backthread/redact`](./packages/redact) is
  a pure, zero-dependency transform that, before anything is sent anywhere:
  - **drops every `tool_use` / `tool_result`** record wholesale — that's where source code,
    diffs, and command output live;
  - **replaces fenced code blocks** (` ``` … ``` `) in kept prose with `[code redacted]`, with
    a **fail-closed** backstop for an unterminated fence (redact-to-end rather than leak);
  - emits **only repo-relative file paths** — absolute, `~`, `../`-escaping, Windows-drive,
    and UNC paths are dropped, so no machine layout or out-of-repo path is harvested.
  What reaches our servers is natural-language *rationale* — the "why" — never the code.
- **The device token is a local secret.** It's stored in `~/.backthread/config.json` at
  **`chmod 0600`** (dir `0700`), is **never printed or logged** (`whoami` shows presence
  only; `logout` removes it), and rides requests **only as an `Authorization: Bearer`
  header** — never in a URL or query string.
- **Login is end-to-end encrypted.** The browser sign-in flow encrypts the minted token to
  a single-use CLI key pair (ECDH P-256 → HKDF-SHA256 → AES-256-GCM); the server only ever
  stores/forwards **ciphertext** and never sees the token in the clear.
- **No secrets are embedded in this source or the published bundle.** The CLI talks to
  public endpoints (`app.backthread.dev` + the ingest worker); there are no baked-in keys.
- **No source execution.** The CLI reads your agent transcript as data; it never `eval`s or
  shells out to run it, and every subprocess it does spawn is invoked with an argument
  array (no shell string interpolation).

Because these run on your machine and see your code, they're open on purpose: read them,
run them, and tell us at [security@backthread.dev](mailto:security@backthread.dev) if the
boundary leaks. That's the deal.
