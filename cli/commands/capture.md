---
description: Manually capture this Claude Code session's decisions (the "why") into your Backthread "How it works" log. Use mid-session to capture what you just decided, or to re-run a session's capture.
argument-hint: "[transcript-path]"
disable-model-invocation: true
---

# /backthread:capture — capture this session now

Captures this session's DECISIONS (the "why" behind the changes) into your Backthread
decision log, using the same local-redact → derive → persist pipeline as the
automatic SessionEnd hook. No source code or tool I/O ever leaves the machine.

The capture has already run for this session (its summary is below). It resolves
the transcript from this session id + working directory; if that failed, the
summary tells you to re-run with an explicit path:
`backthread capture --manual --transcript <path>`.

## Capture result

!`npx backthread capture --manual --session "${CLAUDE_SESSION_ID}" --cwd "$(pwd)" $ARGUMENTS`

## Your task

Relay the capture result above to the user verbatim — the status line and the
decision count. Do not re-run the capture or invoke any other tool. If the result
says "not logged in", tell the user to run `backthread login`. If it says nothing was
captured, that's a normal outcome (the session may have been all code / tool work)
— just report it. If it reports a number of decisions captured, confirm that and,
when a "How it works" diagram link is present, surface it.
