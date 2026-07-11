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
//                         copy → one-tap auth (claim handoff / browser poll flow) → the
//                         unified state's next step. Idempotent (returning user not
//                         re-onboarded). Backs the /backthread:start slash command.
//   backthread login            browser poll flow → device token in ~/.backthread/config.json
//   backthread login --device   headless device-code fallback (stubbed)
//   backthread whoami           show what's in ~/.backthread/config.json (NEVER prints the token)
//   backthread capture          SessionEnd/Stop hook: read transcript_path off the
//                         hook's STDIN → redact LOCALLY → derive → persist. Best-
//                         effort + NON-BLOCKING — it ALWAYS exits 0 so a capture
//                         hiccup can never disrupt or delay the user's CC session.
//   backthread mcp              start the MCP server over stdio — exposes the
//                         `capture` + `query` ("how does X work?") tools to Claude
//                         Code. Long-running: serves until stdin closes.
//   backthread graph            refresh the repo-local STRUCTURE cache (the grep-time
//                         context hook's local tier) by running @backthread/extractor
//                         on the working tree, incrementally. Offline + fail-open.
//   backthread sync             sync the repo's MERGED decision log ("why") into the
//                         repo-local cache (device-token auth, hours-TTL) — the grep
//                         hook's why tier. Best-effort + fail-soft.
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
import { runLogout } from '../logout.js';
import { runUpdate } from '../update.js';
import { runDoctor } from '../doctor.js';
import { readConfig } from '../config.js';
import { readHookInput, readRawHookInput, runCapture } from '../capture.js';
import { parseManualArgs, runManualCapture } from '../captureCommand.js';
import { parseAgent, runFromHook } from '../fromHook.js';
import { setRequestAgent, cliVersion } from '../version.js';
import { nearestCommand } from '../suggest.js';
import { startMcpServer, formatQueryOutcome } from '../mcp.js';
import { queryDecisions } from '../query.js';
import { runInstall } from '../install.js';
import { parseInstallAgent } from '../installAgent.js';
import { runStart } from '../firstRun.js';
import { detectEntry } from '../entry.js';
import { runSessionStart } from '../sessionStart.js';
import { refreshStructure } from '../localGraph.js';
import { syncDecisions } from '../localDecisions.js';
import { runGrepContext } from '../grepContext.js';

const USAGE = `backthread — keep the thread on what your AI agent actually shipped

Usage:
  backthread [command] [flags]

Setup
  backthread                    Set up Backthread here (the front door): sign in, connect
                          this repo, wire up capture. Idempotent — re-run it anytime.
                          [--claim <code>]
  backthread start              Same as above, behind the /backthread:start slash command.
  backthread login              Authorize this device (opens your browser; works over SSH —
                          the printed URL opens on any device) [--claim <code>] [--device]
  backthread logout             Sign this device out — drop the local token, keep the repo link
  backthread whoami             Show this device's config (the token is never printed)

Ask
  backthread how <question>     Ask how/why something here works — a grounded, cited answer
                          from your decision log (backs /backthread:how). [--cwd <path>]

Capture
  backthread capture            Capture this session's decisions (run by the SessionEnd/Stop hook)
  backthread capture --manual   Capture the current session now (the /backthread capture command)
                          [--session <id>] [--transcript <path>] [--cwd <dir>]
  backthread mcp                Start the MCP server (capture + query tools) over stdio
  backthread graph              Refresh the local structure cache for this repo (offline,
                          incremental). Powers the grep-time context hook. [--cwd <path>] [--force]
  backthread sync               Sync this repo's merged decision log into the local cache
                          (hours-TTL; the why half of the grep hook). [--cwd <path>] [--force]

Manage
  backthread install            Set up capture for this repo (login + hook + backfill history)
                          [--claim <code>] [--agent <codex|cursor|gemini>] [--skip-auth]
                          [--skip-hook] [--skip-backfill]
  backthread update             Update a global install to the latest (also -u). npx is
                          always latest already; the plugin updates via /plugin update.
  backthread doctor             Diagnose your setup — auth, capture hook, connectivity,
                          version, repo. Prints ✓/✗ with fix hints; exits non-zero if broken.
  backthread version            Print the installed version (also --version, -v)
  backthread help               Show this message (also --help, -h)

Your source never leaves your machine unredacted — it's checkable in this OSS repo.
Docs:     https://app.backthread.dev
Security: https://backthread.dev/security`;

// The user-facing subcommands "did you mean …?" suggests against (see suggest.ts). The
// bare front door, internal hook entrypoints (session-start / capture --from-hook), and
// pure flags are deliberately excluded — they aren't things a user types by name.
const KNOWN_COMMANDS = [
  'start',
  'login',
  'logout',
  'whoami',
  'how',
  'ask',
  'capture',
  'mcp',
  'graph',
  'sync',
  'install',
  'update',
  'doctor',
  'version',
  'help',
] as const;

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
  /** Test seam for `logout` (touches ~/.backthread on disk). Defaults to runLogout. */
  runLogoutImpl?: typeof runLogout;
  /** Test seam for `update` (spawns npm / touches the network). Defaults to runUpdate. */
  runUpdateImpl?: typeof runUpdate;
  /** Test seam for `doctor` (reads config/hook files, fetch + npm). Defaults to runDoctor. */
  runDoctorImpl?: typeof runDoctor;
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
    case 'logout': {
      // Sign THIS device out: drop the local device token, keep the repo link + account
      // so a later `backthread login` re-authorizes in place. Local-only (does not revoke
      // server-side — the confirmation points at Account → Connected devices for that).
      // Idempotent: a no-token config is a clean no-op, not an error.
      const logoutImpl = deps.runLogoutImpl ?? runLogout;
      const result = await logoutImpl();
      console.log(result.message);
      return result.ok ? 0 : 1;
    }
    case 'doctor': {
      // One-shot diagnostics: ✓/✗/⚠/ℹ over auth, config perms, repo, capture-hook wiring
      // (incl. the ARP-680 project-scope trap), connectivity, and version. READ-ONLY + safe
      // (never prints the token). Exits non-zero only when a CRITICAL check (auth) fails, so
      // it's usable in a setup script. runDoctor never throws.
      const doctorImpl = deps.runDoctorImpl ?? runDoctor;
      const result = await doctorImpl();
      console.log(result.text);
      return result.exitCode;
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
    case 'session-start': {
      // The Claude Code SessionStart hook (ARP-763) — AMBIENT ROUTING. Injects a
      // one-time instruction telling Claude to call `query` FIRST on how/why
      // questions (before grepping). SYNCHRONOUS, NOT detached: CC reads THIS
      // command's STDOUT for hookSpecificOutput.additionalContext, so we print it
      // here. Drain the SessionStart payload off stdin (we don't need its fields, but
      // a hook must consume its stdin) and stamp the provider for the stats path's
      // best-effort telemetry. runSessionStart does only a fast local config read and
      // NEVER throws → always exit 0 with valid JSON, so a hiccup can't break or stall
      // session start. An empty `{}` (not set up) = no injection.
      // Honor --agent (the manifest passes claude-code); default to claude-code when
      // absent — this hook is the CC path, and parseAgent('') would be 'unknown'.
      const ssAgent = parseAgent(flagValue(rest, '--agent'));
      setRequestAgent(ssAgent === 'unknown' ? 'claude-code' : ssAgent);
      await readRawHookInput().catch(() => '');
      const output = await runSessionStart();
      console.log(JSON.stringify(output));
      return 0;
    }
    case 'grep-context': {
      // The PreToolUse grep hook (the two-tier local context hook). CC is about to
      // run Grep/Glob; we read the search term off the stdin payload, join it
      // against the repo-local cache (structure + merged decision "why"), and print
      // `hookSpecificOutput.additionalContext` so CC injects it BEFORE the grep.
      // SYNCHRONOUS (CC reads this stdout), FAST (a local cache read + pure join —
      // no extractor, no network), and FAIL-OPEN: an empty `{}` (no cache / no
      // match / any hiccup) means no injection and the grep proceeds. ALWAYS exit 0;
      // it must never block or delay the grep.
      const raw = await readRawHookInput().catch(() => '');
      const output = await runGrepContext(raw);
      console.log(JSON.stringify(output));
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
    case 'graph': {
      // Refresh the repo-local STRUCTURE cache (the two-tier grep-hook's local
      // tier). Runs @backthread/extractor on the working tree, incrementally.
      // Fail-open: a missing extractor / any hiccup returns a non-'error' status
      // and writes nothing, so a hook that chains this can never be disrupted.
      // Exits 0 for every outcome except a genuine 'error'.
      const cwd = flagValue(rest, '--cwd') ?? process.cwd();
      const outcome = await refreshStructure({ cwd, force: rest.includes('--force') });
      console.error(`backthread graph: ${outcome.status} — ${outcome.detail}`);
      return outcome.status === 'error' ? 1 : 0;
    }
    case 'sync': {
      // Pull the repo's MERGED decision log into the local cache (the grep-hook's
      // "why" tier). Device-token auth; server gates by membership; hours-TTL
      // (skips a fresh cache). Best-effort + fail-soft: an auth/repo/network
      // problem returns a clear status. Exits 0 when it synced or was already
      // fresh; non-zero on a genuine problem so an explicit `sync` shows it.
      const cwd = flagValue(rest, '--cwd') ?? process.cwd();
      const outcome = await syncDecisions({ cwd, force: rest.includes('--force') });
      console.error(`backthread sync: ${outcome.status} — ${outcome.detail}`);
      return outcome.status === 'synced' || outcome.status === 'fresh' ? 0 : 1;
    }
    case 'start': {
      // The CC-plugin FIRST-RUN experience, behind the
      // `/backthread:start` slash command — and the SAME flow a bare `npx backthread`
      // runs (see the `undefined` case). Idempotent: a returning user is short-
      // circuited (never re-onboarded). Otherwise: never-store-source trust copy →
      // one-tap auth (claim handoff or browser poll flow; `--device` is OUT OF SCOPE →
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
    case 'update':
    case '--update':
    case '-u': {
      // Explicit on-demand self-update. Context-aware (see update.ts): a global install
      // gets `npm i -g backthread@latest` (old → new, nudge quieted); an ephemeral npx run
      // or the CC-plugin copy is EXPLAINED, not faked. Progress → stderr, final summary →
      // stdout; exit non-zero only on a genuine npm/offline failure (current install intact).
      const updateImpl = deps.runUpdateImpl ?? runUpdate;
      const result = await updateImpl();
      console.log(result.message);
      return result.ok ? 0 : 1;
    }
    case 'version':
    case '--version':
    case '-v':
      // Print the installed version and nothing else — the scriptable convention (`node
      // -v`, `npm -v`). Reads cli/package.json (the same source as the x-backthread-version
      // header), so it NEVER needs auth or the network and can't drift from what npm ships.
      console.log(cliVersion());
      return 0;
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      // A leading FLAG (e.g. `npx backthread --claim <code>` / `--device`) is still the
      // bare front door — the user passed an onboarding flag with no subcommand, so
      // route the whole arg list to onboarding (version/help flags were handled just above).
      if (command.startsWith('-')) return onboarding(argv);
      // A genuine unknown subcommand → a FRIENDLY pointer, never a bare stack trace or a
      // wall of usage: name the typo, offer the nearest command when one is close, and
      // point at `backthread help`. `backthread help` shows the full list on demand.
      {
        const guess = nearestCommand(command, KNOWN_COMMANDS);
        const didYouMean = guess ? ` Did you mean \`backthread ${guess}\`?` : '';
        console.error(
          `Unknown command: ${command}.${didYouMean}\nRun \`backthread help\` to see everything backthread can do.`,
        );
      }
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
