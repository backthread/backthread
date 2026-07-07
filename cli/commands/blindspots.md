---
description: Blindspot pre-read before you work in an unfamiliar area — "what am I missing about X?", unknown unknowns. A seconds-cheap cited briefing of what's already on record (trade-offs knowingly accepted, standing assumptions, known limitations, rejected approaches) that aims your own pass through the code — it doesn't replace it.
argument-hint: "<the area, e.g. billing>"
disable-model-invocation: true
---

# /backthread:blindspots — what am I missing?

Run this FIRST, before you dive into an area you don't know well. It is a
blindspot pre-read: a short cited briefing of what's already on record in your
Backthread decision log — the trade-offs knowingly accepted, standing
assumptions, known limitations, and rejected approaches the code itself doesn't
contain. Then do your own pass through the code — the pre-read aims your deep
dive, it doesn't replace it. It reads what was captured, nothing more: sparse
capture in the area means a thin (and honestly flagged) briefing. Every claim
cited; a partial-coverage note when little matched. Read-only: nothing leaves
the machine but the question.

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
