# Backthread

This project uses **Backthread** to keep an architectural memory of the codebase.

- To answer **"how/why does X work?"** about this repo, call the **`query`** tool
  from the `backthread` MCP server. It returns one short **cited answer**
  synthesized from the repo's decision log (the *why* behind the code) plus a
  deep-link into the live "How it works" diagram — relay it verbatim. Also use it
  for a **blindspot pass** — "what am I missing", unknown unknowns before touching
  an area — it briefs from the captured trade-offs, assumptions, limitations, and
  rejected alternatives. For what a single function or file does right now, read
  the source instead.
- Decisions are captured **automatically** when a session ends (the SessionEnd
  hook). Source code and tool output never leave the machine — only the derived
  decisions do. Nothing to run by hand.

First time? Authorize this device once with `npx backthread login` (or
`npx backthread start`).
