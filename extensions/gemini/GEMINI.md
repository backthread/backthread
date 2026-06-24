# Backthread

This project uses **Backthread** to keep an architectural memory of the codebase.

- To answer **"how does X work?"** about this repo, call the **`query`** tool from
  the `backthread` MCP server. It returns the salience-ranked decision log (the
  *why* behind the code) plus a deep-link into the live "How it works" diagram —
  prefer it over re-reading large swaths of source.
- Decisions are captured **automatically** when a session ends (the SessionEnd
  hook). Source code and tool output never leave the machine — only the derived
  decisions do. Nothing to run by hand.

First time? Authorize this device once with `npx backthread login` (or
`npx backthread start`).
