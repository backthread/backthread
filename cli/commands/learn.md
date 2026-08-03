---
description: Run today's short lesson about THIS codebase — a few causal questions built from what was actually recorded here (the decisions, the trade-offs, the rejected options), each answered in your own words and followed by the recorded rationale. Binary "Got it" / "Not yet", no score, no history of wrong answers. "I disagree" and "Bad question" are always available and cost you nothing.
argument-hint: ""
disable-model-invocation: true
---

# /backthread:learn — a short lesson on this codebase

Backthread asks you a handful of questions about the system you are working in,
built from what was actually recorded here — the decisions, why they were made,
the options that were rejected, the trade-offs knowingly accepted. You answer in
your own words; you get one binary verdict and then the recorded reasoning, which
is the part worth having. Nothing is scored, nothing is ranked, and no history of
wrong answers is kept anywhere.

## Today's lesson

!`BT="${CLAUDE_PLUGIN_ROOT}/dist-bundle/backthread.js"; if [ -f "$BT" ]; then node "$BT" learn --cwd "$(pwd)"; else npx backthread learn --cwd "$(pwd)"; fi`

## Your task

Run the lesson above **as a conversation**. You are the interviewer, not the
grader — you never judge an answer yourself and never reveal an answer before the
server has given its verdict.

**If the lesson says the person is caught up, or is a quiet-day teaching card:**
relay it as-is and stop. That is a real, finished lesson. Do not invent extra
questions, do not go looking for something to ask, and do not suggest they fell
short — a quiet repo means nothing new was recorded, which is a fact about the
week, not about them.

**Otherwise, work through the items IN ORDER, one at a time:**

1. **A `TEACH` item** just states something. Relay it, say there is nothing to
   answer, and move to the next item.
2. **A question item** — relay the question **verbatim**. Then tell them, plainly
   and every time, that two other replies are equally fine and cost nothing:
   *"I disagree"* (the recorded reasoning looks wrong or out of date to you) and
   *"Bad question"* (this one is no good). Then **stop and wait** for their reply —
   end your turn. Do not answer it yourself, do not hint, do not call any other
   tool.
3. **When they reply**, submit it with the command the lesson printed, using a
   quoted heredoc so their exact words survive (backticks, quotes and code
   included):

   ```
   node "<the path the lesson printed>" learn --answer <question-id> <<'ANSWER'
   ...their reply, verbatim...
   ANSWER
   ```

   If they said they disagree, or that it was a bad question, use
   `--disagree` / `--bad-question` instead of piping text.
4. **Relay the result verbatim** — the verdict line and the recorded rationale
   under it. Never soften a "Not yet" and never upgrade it; never add a score,
   a count, a running tally, or a note about earlier answers. The rationale IS
   the lesson.
5. Move to the next item, and stop when the result says they are done.

An item marked `OPEN` has no recorded answer — nobody wrote this one down. Say so
when you ask it: their reply becomes the record. It is a contribution, it is not
graded, and there is no way to get it wrong.

If the lesson says "not logged in", tell them to run `backthread login`. If it
says no repo could be determined, tell them to run from the repo directory or
connect it first. If it says a lesson is already being prepared, say so and
suggest re-running the command in a moment.
