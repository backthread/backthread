#!/usr/bin/env node
// backthread — the Backthread CLI/plugin entrypoint.
//
// A BARE `npx backthread` (no subcommand) IS the canonical unified front door
// (ARP-703): it runs the SAME onboarding as `backthread start` — never-store-source
// trust copy → one-tap auth → entry-aware capture step + connect nudge — and is
// idempotent for a returning user. (`backthread help` still shows usage; an unknown
// subcommand still errors with usage.) The order is entry-point-aware: the terminal
// door (bare npx / plugin) leads with CAPTURE then nudges connect-repo; the web door
// (`--claim` handoff) skips the connect re-nudge. See entry.ts.
//
// The shared spine the later surfaces hang off of:
//   backthread (no args)        the unified front door — alias of `backthread start`
//                         (entry = terminal). Bare `npx backthread` runs onboarding.
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
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { login } from '../login.js';
import { readConfig } from '../config.js';
import { readHookInput, readRawHookInput, runCapture } from '../capture.js';
import { parseManualArgs, runManualCapture } from '../captureCommand.js';
import { parseAgent, runFromHook } from '../fromHook.js';
import { setRequestAgent } from '../version.js';
import { startMcpServer, formatQueryOutcome } from '../mcp.js';
import { queryDecisions } from '../query.js';
import { runInstall } from '../install.js';
import { parseInstallAgent } from '../installAgent.js';
import { runStart } from '../firstRun.js';
import { detectEntry } from '../entry.js';

const USAGE = `backthread — capture the "why" of your AI-coded changes

Usage:
  backthread                    Set up Backthread (the unified front door — same as
                          \`backthread start\`): trust copy + one-tap auth + your next
                          step. Idempotent. [--claim <code>]
  backthread start              First-run setup (backs the /backthread:start slash command):
                          trust copy + one-tap auth + your next step. Idempotent.
                          [--claim <code>]
  backthread login              Authorize this device (opens your browser)
  backthread login --claim <code>
                          Authorize with a single-use claim code from the web app
                          (no browser needed — codes expire in ~10 minutes)
  backthread login --device     Headless / SSH login (device-code flow — coming soon)
  backthread whoami             Show the current device's config (token is never printed)
  backthread how <question>     Ask how/why something in this repo works — prints a
                          grounded, cited answer from your Backthread decision log
                          (backs the /backthread:how slash command). [--cwd <path>]
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
  backthread install --agent <codex|cursor|gemini>
                          Set up capture for another agent: write its USER-GLOBAL
                          MCP server config + session-end capture hook (idempotent)
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

/** Return args with `flag` and its value removed — so the remaining free-text (e.g.
 * a `backthread how` question) can be joined without the `--cwd …` pair leaking in. */
export function stripFlag(rest: string[], flag: string): string[] {
  const i = rest.indexOf(flag);
  if (i === -1) return rest;
  // drop the flag and (when present + not itself a flag) its value
  const dropValue = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--');
  return [...rest.slice(0, i), ...rest.slice(i + (dropValue ? 2 : 1))];
}

/**
 * The unified onboarding front door, shared by a bare `npx backthread` and the
 * explicit `backthread start` (and its `/backthread:start` slash command). Idempotent:
 * a returning, onboarded user is short-circuited inside runStart (never re-wizarded).
 * The entry point is derived (a `--claim` code ⇒ web-initiated, else terminal-first)
 * so the step order is right for how the user arrived. Returns the process exit code.
 */
export async function runOnboarding(rest: string[]): Promise<number> {
  const claim = parseClaimFlag(rest);
  const result = await runStart({
    claim,
    device: rest.includes('--device'),
    entry: detectEntry({ claim }),
  });
  return result.exitCode;
}

/**
 * Test seams for the command dispatch. Only the surfaces the dispatch tests need to
 * keep off the network/browser are injectable; everything else runs the real impl.
 * Defaults wire the production behavior, so `main(argv)` works with no second arg.
 */
export interface MainDeps {
  /** The unified onboarding runner (bare `npx backthread` + `start`). Defaults to runOnboarding. */
  runOnboardingImpl?: (rest: string[]) => Promise<number>;
  /** Test seam for the `how`/`ask` grounded-ask dispatch. Defaults to queryDecisions. */
  queryDecisionsImpl?: typeof queryDecisions;
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number | null> {
  const [command, ...rest] = argv;
  const onboarding = deps.runOnboardingImpl ?? runOnboarding;

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
        const agent = parseAgent(flagValue(rest, '--agent'));
        // ARP-732 — stamp the real provider on the operational-metadata headers. The
        // detached re-spawn re-runs `capture --from-hook --no-detach --agent <agent>`,
        // so this propagates through the whole chain (hook → detached worker → POST).
        setRequestAgent(agent);
        const result = await runFromHook({
          rawPayload: raw,
          agent,
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
        // The bare `backthread capture` default IS the legacy Claude Code SessionEnd
        // hook (reads CC-shaped stdin) — stamp the provider accordingly (ARP-732).
        setRequestAgent('claude-code');
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
      // `/backthread:start` slash command — and the SAME flow a bare `npx backthread`
      // runs (see the `undefined` case). Idempotent: a returning user is short-
      // circuited (never re-onboarded). Otherwise: never-store-source trust copy →
      // one-tap auth (claim handoff or browser loopback; `--device` is OUT OF SCOPE →
      // loud stub) → the unified state's canonical next step (the connect
      // nudge when no repo). runStart reports each step to stderr and returns a non-zero
      // exit ONLY on a genuine auth failure (capture won't run until the user acts).
      return onboarding(rest);
    }
    case 'install': {
      // onboarding glue: auth handshake → register the SessionEnd hook
      // (settings.json fallback) → chain the one-shot backfill. runInstall reports
      // each step to stderr and returns an exit code (non-zero only on a genuine
      // auth failure — the backfill leg is best-effort and never fails install).
      // `--agent <codex|cursor|gemini>` writes that agent's user-global MCP + hook
      // instead (ARP-503). A bad --agent value fails fast rather than silently
      // falling back to the Claude Code path.
      const agentFlag = flagValue(rest, '--agent');
      const agent = parseInstallAgent(agentFlag);
      if (agentFlag !== undefined && agent === null) {
        console.error(`Unknown --agent "${agentFlag}". Use one of: codex, cursor, gemini, claude-code.`);
        return 1;
      }
      const result = await runInstall({
        claim: parseClaimFlag(rest),
        agent: agent ?? undefined,
        skipAuth: rest.includes('--skip-auth'),
        skipHook: rest.includes('--skip-hook'),
        skipBackfill: rest.includes('--skip-backfill'),
      });
      return result.exitCode;
    }
    case 'how':
    case 'ask': {
      // The /backthread:how slash command (ARP-759) — DETERMINISTIC grounded ask.
      // The free-text args ARE the question; --cwd resolves the repo (the slash host
      // passes the session cwd). Relays to the worker's /grounded-ask (via
      // queryDecisions) and prints the synthesized, cited answer to STDOUT for the
      // host (or the user) to read — the reliable Tier-1 path that never depends on
      // the agent's probabilistic tool routing. Exits non-zero on a non-ok outcome
      // (not-logged-in / no-repo / read-failed) so a failure is visible.
      const query = deps.queryDecisionsImpl ?? queryDecisions;
      const cwd = flagValue(rest, '--cwd') ?? process.cwd();
      const question = stripFlag(rest, '--cwd').join(' ').trim();
      const outcome = await query({ question, cwd });
      console.log(formatQueryOutcome(outcome, question));
      return outcome.status === 'ok' ? 0 : 1;
    }
    case undefined:
      // BARE `npx backthread` (no subcommand) IS the canonical unified front door
      // (ARP-703): run the SAME onboarding as `backthread start` — NOT help. Idempotent
      // for a returning user; entry-point-aware order (terminal-first by default, web-
      // initiated when a `--claim` code is present). `backthread help` still shows usage.
      return onboarding(rest);
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      // A leading FLAG (e.g. `npx backthread --claim <code>` / `--device`) is still the
      // bare front door — the user passed an onboarding flag with no subcommand, so
      // route the whole arg list to onboarding (help flags were handled just above).
      // Anything else is a genuine unknown subcommand → error + usage.
      if (command.startsWith('-')) return onboarding(argv);
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

// Auto-run ONLY when this file is the process entry point (invoked as the bin /
// the bundle / the detached re-spawn) — NOT when a test imports `main`/`runOnboarding`
// for dispatch coverage. We compare this module's path to argv[1] AFTER resolving
// symlinks on BOTH sides: an npm-installed bin lives at `node_modules/.bin/backthread`
// (a SYMLINK to the real file), and Node leaves argv[1] as that symlink path while
// import.meta.url is the realpath — so a naive string compare would wrongly suppress a
// real run. realpathSync collapses both to the same target. Wrapped defensively: any
// resolution hiccup FALLS BACK TO RUNNING (a bin must execute; never accidentally
// no-op). The only thing it suppresses is the import-from-a-test case (argv[1] is the
// test runner, never this file), which is exactly what we want.
function isEntryPoint(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const self = fileURLToPath(import.meta.url);
    const resolve = (p: string): string => {
      try {
        return realpathSync(p);
      } catch {
        return p; // not on disk (unusual) → compare the raw path
      }
    };
    return resolve(self) === resolve(entry);
  } catch {
    return true; // never let a guard failure stop the bin from running
  }
}

if (isEntryPoint()) {
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
}
