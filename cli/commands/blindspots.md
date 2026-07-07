---
description: Blindspot pass before touching an area — "what am I missing about X?" Surfaces the captured trade-offs, standing assumptions, known limitations, and rejected alternatives (your unknown unknowns) from the decision log, cited.
argument-hint: "<the area, e.g. billing>"
disable-model-invocation: true
---

# /backthread:blindspots — what am I missing?

Runs a blindspot pass on the area you name: a short ranked briefing of the
accepted trade-offs, standing assumptions, known limitations, and rejected
alternatives recorded in your Backthread decision log — the unknown unknowns a
code read won't surface. Every claim cited; a partial-coverage note when little
risk capture matched the area. Read-only: nothing leaves the machine but the
question.

## Grounded briefing

!`BT="${CLAUDE_PLUGIN_ROOT}/dist-bundle/backthread.js"; Q="What am I missing about $ARGUMENTS? Do a blindspot pass: surface the accepted trade-offs, standing assumptions, known limitations, and rejected alternatives."; if [ -f "$BT" ]; then node "$BT" how --cwd "$(pwd)" "$Q"; else npx backthread how --cwd "$(pwd)" "$Q"; fi`

## Your task

Relay the grounded briefing above to the user **verbatim** — it is already
written for them, with its inline [n] citations, its Sources list, and the
diagram link. Do not re-answer from your own knowledge, re-run the command, or
call any other tool. If the result says "not logged in", tell the user to run
`backthread login`. If it says no repo could be determined, tell them to run
from the repo directory or `backthread connect` it. If it leads with a
partial-coverage caveat, keep that caveat in what you surface — do not present a
partial briefing as complete.
