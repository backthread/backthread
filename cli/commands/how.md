---
description: Ask how a feature works, why it was built this way, or what you're missing about an area (a blindspot pass — unknown unknowns) — returns a cited answer from the codebase's decision log (the why/architecture the source doesn't contain), best paired with reading the code for local mechanics.
argument-hint: "<your question, e.g. how does auth work?>"
disable-model-invocation: true
---

# /backthread:how — how does it work?

Answers your "how/why does X work?" question about this repository from your
Backthread decision log. The server retrieves the question-relevant captured
decisions and synthesizes ONE short, grounded answer — every claim cited, anything
inferred flagged, and a partial-coverage note when the log is thin. Read-only:
nothing leaves the machine but the question.

## Grounded answer

!`BT="${CLAUDE_PLUGIN_ROOT}/dist-bundle/backthread.js"; if [ -f "$BT" ]; then node "$BT" how --cwd "$(pwd)" $ARGUMENTS; else npx backthread how --cwd "$(pwd)" $ARGUMENTS; fi`

## Your task

Relay the grounded answer above to the user **verbatim** — it is already written
for them, with its inline [n] citations, its Sources list, and the diagram link.
Do not re-answer from your own knowledge, re-run the command, or call any other
tool. If the result says "not logged in", tell the user to run `backthread login`.
If it says no repo could be determined, tell them to run from the repo directory or
`backthread connect` it. If it leads with a partial-coverage caveat, keep that
caveat in what you surface — do not present a partial answer as complete.
