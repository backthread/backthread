#!/usr/bin/env node
// backthread — the Backthread CLI/plugin entrypoint.
//
// The shared spine the later surfaces hang off of:
//   backthread start            the CC-plugin first-run: never-store-source trust
//                         copy → one-tap auth (claim handoff / browser loopback) → the
//                         unified state's next step. Idempotent (returning user not
//                         re-onboarded). Backs the /backthread:start slash command.
//   backthread login            browser OAuth-loopback → device token in ~/.backthread/config.json
//   backthread login --device   headless device-code fallback (stubbed)
//   backthread whoami           show what's in ~/.backthread/config.json (NEVER prints the token)
//   backthread capture          SessionEnd/Stop hook: read transcript_path off the
//                         hook's STDIN → redact LOCALLY → derive → persist. Best-
//                         effort + NON-BLOCKING — it ALWAYS exits 0 so a capture
//                         hiccup can never disrupt or delay the user's CC session.
//   backthread mcp              start the MCP server over stdio — exposes the
//                         `capture` + `query` ("how does X work?") tools to Claude
//                         Code. Long-running: serves until stdin closes.
//   backthread install          onboarding: auth handshake + register the SessionEnd
//                         hook (settings.json fallback; the plugin manifest does it
//                         when installed as a plugin) + chain a one-shot backfill so
//                         the decision log is non-empty at the aha moment.
//
// Distribution: `npx backthread` (this bin). A Claude Code plugin manifest can wrap the
// same bin later. See cli/README.md.
import { login } from '../login.js';
import { readConfig } from '../config.js';
import { readHookInput, readRawHookInput, runCapture } from '../capture.js';
import { parseManualArgs, runManualCapture } from '../captureCommand.js';
import { parseAgent, runFromHook } from '../fromHook.js';
import { startMcpServer } from '../mcp.js';
import { runInstall } from '../install.js';
import { runStart } from '../firstRun.js';

const USAGE = `backthread — capture the "why" of your AI-coded changes

Usage:
  backthread start              First-run setup (backs the /backthread:start slash command):
                          trust copy + one-tap auth + your next step. Idempotent.
                          [--claim <code>]
  backthread login              Authorize this device (opens your browser)
  backthread login --claim <code>
                          Authorize with a single-use claim code from the web app
                          (no browser needed — codes expire in ~10 minutes)
  backthread login --device     Headless / SSH login (device-code flow — coming soon)
  backthread whoami             Show the current device's config (token is never printed)
  backthread capture            Capture this session's decisions (run by the SessionEnd/Stop hook)
  backthread capture --from-hook
                          Shared multi-agent hook entrypoint: read the hook payload off
                          STDIN and capture the named transcript (always exits 0)
                          [--agent <codex|cursor|gemini-cli>] [--detach]
  backthread capture --manual   Manually capture a session now (the /backthread capture slash command)
                          [--session <id>] [--transcript <path>] [--cwd <dir>]
  backthread mcp                Start the MCP server (capture + query tools) over stdio
  backthread install            Set up capture for this repo (login + hook + backfill history)
                          [--claim <code>] [--skip-auth] [--skip-hook] [--skip-backfill]
  backthread help               Show this message

Docs: https://app.backthread.dev`;

// Returns an exit code, or null for a long-running command (e.g. `backthread mcp`) that
// must keep the event loop alive instead of exiting.
// Parse `--claim <code>` out of an arg list. Returns the code, or
// undefined when the flag is absent. A dangling `--claim` (no value, or another
// flag where the value should be) FAILS FAST (review #2): the user explicitly
// asked for claim-code auth, and silently falling back to the browser loopback
// would HANG on the headless/SSH boxes the claim path exists for. The throw is
// caught by main()'s catch-all, which prints the message and exits 1.
function parseClaimFlag(rest: string[]): string | undefined {
  const i = rest.indexOf('--claim');
  if (i === -1) return undefined;
  const value = rest[i + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(
      '`--claim` needs a code. Usage: backthread login --claim backthread_claim_… (copy it from the web app)',
    );
  }
  return value;
}

// Read the value that follows `--flag` in an arg list, or undefined when the flag is
// absent or has no value (a dangling flag / another flag where the value should be).
// Used by `capture --from-hook --agent <x>`; unlike `--claim`, a missing `--agent`
// value DEGRADES (→ undefined → 'unknown' agent / canonical field names) rather than
// throwing, because `--from-hook` must never fail the host agent's session.
function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  if (i === -1) return undefined;
  const value = rest[i + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

async function main(argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'login': {
      const device = rest.includes('--device');
      const claim = parseClaimFlag(rest);
      const result = await login({ device, claim });
      return result.ok ? 0 : 1;
    }
    case 'whoami': {
      const cfg = await readConfig();
      // Print identity WITHOUT the token. We only ever say whether a token is
      // present, never its value — the token must not enter terminal scrollback.
      const lines = [
        `account:      ${cfg.account ?? '(not set)'}`,
        `repo:         ${cfg.repo ?? '(not set)'}`,
        `device token: ${cfg.device_token ? 'present (hidden)' : '(not logged in — run `backthread login`)'}`,
      ];
      console.log(lines.join('\n'));
      return cfg.device_token ? 0 : 1;
    }
    case 'capture': {
      // THREE modes share `backthread capture`:
      //
      //  • FROM-HOOK — the SHARED multi-agent hook entrypoint. Triggered
      //    by `--from-hook`. Reads the stdin payload (per-agent field shapes via `--agent`),
      //    normalizes it to a HookInput, de-dupes per session id, optionally re-spawns
      //    DETACHED (`--detach`, for Gemini's fire-and-forget SessionEnd), and feeds the
      //    named transcript through the SAME runCapture fence. Emits a JSON ack on STDOUT
      //    only for Codex. ALWAYS exits 0 — it must never disrupt the host agent.
      //
      //  • MANUAL — the `/backthread capture` slash command. Triggered by
      //    `--manual` (or any of --transcript/--session/--cwd). Resolves a transcript
      //    (the slash host doesn't feed one on STDIN — see captureCommand.ts), runs
      //    the SAME runCapture pipeline, prints a per-run SUMMARY to STDOUT, and exits
      //    non-zero on a genuine failure / not-logged-in so the user sees it.
      //
      //  • HOOK — the CC SessionEnd/Stop hook, the DEFAULT. Reads the
      //    payload off STDIN, logs one terse line to stderr, and ALWAYS exits 0:
      //    best-effort + non-blocking, a capture hiccup must never disrupt the user's
      //    Claude Code session.
      //
      // `--from-hook` is checked FIRST: it's the explicit shared-entrypoint signal and
      // must not be mistaken for the bare CC hook (also stdin-fed) or for manual mode.
      if (rest.includes('--from-hook')) {
        // Read the RAW stdin payload ONCE here (the bin owns stdio); pass it down so the
        // detached worker can re-hand the EXACT bytes via env. `--detach` requests the
        // fire-and-forget re-spawn; `--no-detach` (the detached child's own re-invocation)
        // forces a real run so it can't recurse. Default = run inline (Codex/Cursor/CC).
        const raw = await readRawHookInput();
        const detach = rest.includes('--detach') && !rest.includes('--no-detach');
        const result = await runFromHook({
          rawPayload: raw,
          agent: parseAgent(flagValue(rest, '--agent')),
          detach,
        });
        // STDOUT is the hook channel ONLY for Codex (result.stdout is null otherwise),
        // so nothing leaks onto stdout for the CC/Gemini/Cursor wirings.
        if (result.stdout) console.log(JSON.stringify(result.stdout));
        // A terse stderr line for local debugging (mirrors the CC hook); never the token.
        console.error(
          `backthread capture --from-hook: ${result.status}` +
            (result.outcome ? ` — ${result.outcome.status}: ${result.outcome.detail}` : ''),
        );
        return result.exitCode; // ALWAYS 0
      }

      const { manual, input } = parseManualArgs(rest);
      const manualRequested =
        manual || input.transcriptPath !== undefined || input.sessionId !== undefined;
      if (manualRequested) {
        const result = await runManualCapture(input);
        // Summary → STDOUT (this is a user-facing command, not the silent hook).
        console.log(result.text);
        return result.exitCode;
      }
      try {
        const hookInput = await readHookInput();
        const outcome = await runCapture(hookInput);
        console.error(`backthread capture: ${outcome.status} — ${outcome.detail}`);
      } catch (e) {
        // Belt-and-braces: a capture problem can never fail the session.
        console.error(`backthread capture: error (swallowed) — ${(e as Error).message ?? e}`);
      }
      return 0;
    }
    case 'mcp': {
      // Start the MCP server over stdio. This is long-running: startMcpServer
      // connects the transport and resolves; the process then stays alive serving
      // JSON-RPC over stdin/stdout until the host closes stdin. We DON'T return a
      // numeric code that would trigger process.exit — returning null signals main's
      // caller to leave the event loop running. stdout is the MCP channel, so all
      // diagnostics go to stderr only.
      await startMcpServer();
      return null;
    }
    case 'start': {
      // The CC-plugin FIRST-RUN experience, behind the
      // `/backthread:start` slash command. Idempotent: a returning user is short-
      // circuited (never re-onboarded). Otherwise: never-store-source trust copy →
      // one-tap auth (claim handoff or browser loopback; `--device` is OUT OF SCOPE →
      // loud stub) → the unified state's canonical next step (the connect
      // nudge when no repo). runStart reports each step to stderr and returns a non-zero
      // exit ONLY on a genuine auth failure (capture won't run until the user acts).
      const result = await runStart({
        claim: parseClaimFlag(rest),
        device: rest.includes('--device'),
      });
      return result.exitCode;
    }
    case 'install': {
      // onboarding glue: auth handshake → register the SessionEnd hook
      // (settings.json fallback) → chain the one-shot backfill. runInstall reports
      // each step to stderr and returns an exit code (non-zero only on a genuine
      // auth failure — the backfill leg is best-effort and never fails install).
      const result = await runInstall({
        claim: parseClaimFlag(rest),
        skipAuth: rest.includes('--skip-auth'),
        skipHook: rest.includes('--skip-hook'),
        skipBackfill: rest.includes('--skip-backfill'),
      });
      return result.exitCode;
    }
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    // null ⇒ a long-running command (`backthread mcp`) is now serving; don't exit, let
    // the event loop keep the stdio transport alive until the host closes stdin.
    if (code === null) return;
    process.exit(code);
  })
  .catch((err) => {
    // Never let an unexpected throw leak a token (it never reaches here anyway —
    // the token isn't carried in any error). Print the message, exit non-zero.
    console.error(`backthread: ${(err as Error).message ?? err}`);
    process.exit(1);
  });
