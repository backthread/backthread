---
description: First-run setup for Backthread — shows how your code is handled, authorizes this device, and tells you your next step. Run once after installing; it's idempotent (a returning user is not re-onboarded).
argument-hint: "[--claim <code>]"
disable-model-invocation: true
---

# /backthread:start — set up Backthread

Runs the one-time first-run setup: the never-store-source trust note (how Backthread
handles your code), a one-tap device authorization, and your next step toward a
non-empty "How it works" diagram. It is idempotent — if you've already set up
Backthread on this machine, it just tells you you're good to go.

If the web app handed you a claim code, pass it: `/backthread:start --claim <code>`
(no browser needed). Otherwise it opens your browser once to authorize this device.

## Setup result

!`npx backthread start $ARGUMENTS`

## Your task

Relay the setup result above to the user verbatim — the trust note, the auth status
line, and the next-step line (including any link). Do not run any other tool. If the
result says auth failed, tell the user to run `/backthread:start` again (or `backthread
login`) to authorize. If it says they're already set up, just confirm that. When a
"How it works" diagram link or a connect link is present, surface it.
