# Backthread

This project uses **Backthread** to keep an architectural memory of the codebase.

- To answer **"how/why does X work?"** about this repo, call the **`query`** tool
  from the `backthread` MCP server. It returns one short **cited answer**
  synthesized from the repo's decision log (the *why* behind the code) plus a
  deep-link into the live "How it works" diagram — relay it verbatim. Before
  working in an unfamiliar area ("what am I missing", a **blindspot pass**,
  unknown unknowns), call it FIRST — a seconds-cheap cited pre-read of what's on
  record (trade-offs knowingly accepted, standing assumptions, known limitations,
  rejected approaches) — then do your own pass through the code: the pre-read
  aims your deep dive, it doesn't replace it. For what a single function or file
  does right now, read the source instead.
- Decisions are captured **automatically** when a session ends (the SessionEnd
  hook). Source code and tool output never leave the machine — only the derived
  decisions do. Nothing to run by hand.

First time? Authorize this device once with `npx backthread login` (or
`npx backthread start`).
