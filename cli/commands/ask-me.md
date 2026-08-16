---
description: Have Backthread ask YOU one question about this codebase, built from what was actually recorded here — a decision, a trade-off, an option someone rejected. Answer it in your own words and you get the recorded reasoning back. Ignore it and nothing happens: nothing is written down unless you answer, nothing counts how often you are asked, and your lead sees what the team understands, never who replied.
disable-model-invocation: true
---

# /backthread:ask-me — one question about this codebase

The other way round from `/backthread:how`. Instead of you asking Backthread how
something works, Backthread asks you — one question, built from what was actually
recorded in this repo. You answer in your own words, and you get back the reasoning
that was written down at the time, which is the part worth having.

**Nothing is written down when you are asked.** If you do not answer, there is no row
anywhere to find later: no queue, no nag, no badge, no re-ask. The full statement lives
behind `backthread ask-me --promise`, and that is the authoritative wording — it comes
from the server that enforces it, so it cannot drift from what the code actually does.

## The question

!`BT="${CLAUDE_PLUGIN_ROOT}/dist-bundle/backthread.js"; if [ -f "$BT" ]; then node "$BT" ask-me --cwd "$(pwd)"; else npx backthread ask-me --cwd "$(pwd)"; fi`

## Your task

You are the interviewer, not the grader. You never judge the answer yourself and
never reveal it before the server has.

**If it says there is nothing on record to ask about:** relay that and stop. It is a
complete answer, not a failure and not an empty result — this repo has not recorded
anything worth a question yet. Do not go looking for something to ask instead, do not
invent a question, and do not suggest anyone fell short.

**If there is a question:**

1. Relay it **verbatim**. Tell them, plainly, that two other replies are equally fine
   and cost nothing: *"I disagree"* (the recorded reasoning looks wrong or out of
   date to you) and *"Bad question"* (this one is no good). Then **stop and wait** —
   end your turn. Do not answer it, do not hint, do not call another tool.
2. **When they reply**, submit it with the command the question printed, using a
   quoted heredoc so their exact words survive:

   ```
   node "<the path it printed>" ask-me --answer '<the token it printed>' <<'ANSWER'
   ...their reply, verbatim...
   ANSWER
   ```

   If they disagreed, or called it a bad question, use `--disagree` /
   `--bad-question` in place of the heredoc.
3. **Relay the result verbatim** — the verdict line and the recorded reasoning under
   it. Never soften a "Not yet" and never upgrade it. Never add a score, a count, a
   running tally, or a note about anything they were asked before; no such number
   exists anywhere and inventing one would be a lie about how this works.

**If they ignore it, or say no:** that is a completely normal outcome. Drop it, do not
ask again, and do not bring it up later in the session. The ask expires on its own and
nothing about it is recorded either way.

A question marked `OPEN` has no recorded answer — nobody wrote this one down. Say so
when you ask it: their reply becomes the record. It is a contribution, it is not
graded, and there is no way to get it wrong.

If it says "not logged in", tell them to run `backthread login`. If it says no repo
could be determined, tell them to run from the repo directory or connect it first.
