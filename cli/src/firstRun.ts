// firstRun.ts — the CC-plugin FIRST-RUN experience.
//
// The in-agent onboarding for the plugin half of the both-equal front door.
// When a brand-new user installs the plugin (marketplace 1-click) the
// SessionEnd hook is armed automatically by the manifest — but NOTHING has told the
// user how Backthread handles their code, and the device may not be authed yet. This
// module is the first-run ORCHESTRATION + copy that fills that gap. It is pure
// glue: every load-bearing primitive already exists (TRUST_COPY, ensureAuth/claim,
// fetchOnboardingState, the connect-nudge throttle pattern) — we sequence them.
//
// ──────────────────────────────────────────────────────────────────────────────
// THE FLOW (states), in order:
//
//   1. IDEMPOTENCE GATE. Read ~/.backthread/first-run.json. If `onboarded` is set,
//      a returning user is NEVER re-onboarded (AC: idempotent) — we short-circuit
//      with status 'already-onboarded'. (The connect nudge + post-capture confirm
//      still fire on their own throttles; this gate only suppresses the WIZARD.)
//
//   2. TRUST GATE. Print TRUST_COPY (install.ts — the never-store-source claim,
//      consistent with /security) BEFORE anything else. The AC is unambiguous:
//      "first run … shows trust copy before any transcript is processed." On the
//      explicit `/backthread:start` path this is trivially satisfied (no transcript
//      is read here at all). For the HOOK-fires-before-install path the trust copy is
//      ALSO guaranteed first by maybeShowTrustGate (see below + capture.ts), so the
//      claim holds on both entrypoints.
//
//   3. AUTH. One tap. Two real auth paths exist (device-code / is OUT of scope
//      → loud stub):
//        • claim-code handoff: when the web app handed the user a `--claim`
//          code, exchange it for a device token — no browser. This is the "one-tap"
//          the AC names ("auth is one tap via claim-code … no separate browser
//          `backthread login` step"); it's the WEB-initiated door.
//        • browser loopback (ensureAuth): a purely PLUGIN-initiated first run (no
//          claim code) uses the loopback — one browser click. Already-authed devices
//          short-circuit (ensureAuth returns the existing token).
//      `--device` is refused here with the existing loud stub guidance (deviceLogin),
//      never silently fallen back to (it would HANG a headless box on the loopback).
//
//   4. STATE-DRIVEN NEXT STEP. Read the UNIFIED onboarding state
//      (fetchOnboardingState) and render its canonical next step — the SAME
//      backend signal the web wizard reads, so the cell→next-step decision lives once
//      server-side. When the state says "repo not connected" the next step IS the
//      connect nudge copy (server-driven). A terminal state renders cleanly,
//      no nudge. A returning-but-not-yet-marked edge (no auth, fetch failed) degrades
//      to a plain "run a session / connect a repo" hint — never a crash.
//
//   5. MARK ONBOARDED. Persist the flag so step 1 short-circuits next time.
//
// The "captured N decisions — view them at <deep-link>" confirmation is NOT here: it
// belongs in the CAPTURE path (it can only fire after a real capture lands), emitted
// once-per-install on its own throttle — see firstCapture.ts, wired into capture.ts.
//
// ──────────────────────────────────────────────────────────────────────────────
// "ONBOARDED" — PINNED DEFINITION (decided here, tested in firstRun.test.ts):
//
//   onboarded ⇔ the `onboarded` flag is set in ~/.backthread/first-run.json.
//
// We use an EXPLICIT flag, NOT the derived "token present + ≥1 capture", because:
//   • The trust gate must precede ANY transcript processing — including the very
//     first capture — so we cannot key "show onboarding" off having already captured
//     (that's circular: you'd onboard only AFTER the thing onboarding must precede).
//   • A returning user who rotates/clears their token must NOT be re-shown the full
//     wizard (the AC). An explicit flag survives a token change; "token present" does
//     not.
//   • The flag is set once the first-run wizard COMPLETES its trust + auth handoff —
//     independent of whether a repo is connected yet (that's a later, state-driven
//     nudge, not an onboarding precondition).
// The DERIVED onboarding STATE (fetchOnboardingState) still drives the NEXT-STEP copy
// — we just don't use it as the "already onboarded?" gate.
//
// POSTURE: `/backthread:start` is interactive + user-invoked, so it REPORTS each step
// to stderr and returns an exit code (non-zero only on a genuine auth failure the
// user must act on — mirrors install.ts). The trust-gate helper (used on the silent
// hook path) is best-effort + NEVER throws (it must not break always-exit-0 capture).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { configDir, readConfig, CONFIG_MODE, DIR_MODE, type BackthreadConfig } from './config.js';
import { ensureAuth, deviceLogin, type LoginOptions } from './login.js';
import { TRUST_COPY } from './install.js';
import { captureGuidance, detectEntry, isInsideClaudeCode, type EntryPoint } from './entry.js';
import { detectInstalledAgents } from './detectAgents.js';
import { promptYesNo } from './prompt.js';
import { runInstallAgent, type InstallAgent } from './installAgent.js';
import {
  fetchOnboardingState,
  resolveOnboardingRepo,
  type OnboardingInput,
  type OnboardingDeps,
  type OnboardingOutcome,
} from './onboardingState.js';
import { appBaseUrl, buildRepoDeepLink } from './urls.js';

// ──────────────────────────────────────────────────────────────────────────────
// First-run state — a tiny owner-only (0600) flag file, separate from config.json
// and from the capture/nudge ring files. Separate on purpose: config.json holds
// CREDENTIALS (rotated by login), the nudge/capture rings hold per-session THROTTLES,
// and this holds the once-per-install ONBOARDING flags (onboarded + firstCaptureShown).
// Different lifecycles → different files. Same defensive read/write as connectNudge.
// ──────────────────────────────────────────────────────────────────────────────

export function firstRunStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'first-run.json');
}

export interface FirstRunState {
  /** Set once the first-run wizard completed its trust + auth handoff. THE onboarded flag. */
  onboarded?: boolean;
  /**
   * Set once the trust copy has been shown on the silent hook path (so we don't
   * re-print it on every capture before the user ever runs `/backthread:start`).
   * Distinct from `onboarded`: the hook can show trust copy without the full wizard
   * having run, and the full wizard sets `onboarded` regardless of this.
   */
  trustShown?: boolean;
  /** Set once the "captured N — view at <link>" confirmation has been emitted (firstCapture.ts). */
  firstCaptureShown?: boolean;
}

/** Parse the state blob defensively → empty state on anything unexpected (never throws). */
export function parseFirstRunState(raw: string): FirstRunState {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const r = obj as Record<string, unknown>;
      const out: FirstRunState = {};
      if (r.onboarded === true) out.onboarded = true;
      if (r.trustShown === true) out.trustShown = true;
      if (r.firstCaptureShown === true) out.firstCaptureShown = true;
      return out;
    }
  } catch {
    // fall through to empty (a corrupt file just means "not onboarded yet" — harmless;
    // worst case the user sees the wizard once more, never a crash).
  }
  return {};
}

export async function readFirstRunState(env: NodeJS.ProcessEnv = process.env): Promise<FirstRunState> {
  try {
    return parseFirstRunState(await readFile(firstRunStatePath(env), 'utf8'));
  } catch {
    // Missing file (genuine first run) or unreadable → empty state. Never throw.
    return {};
  }
}

/** Merge a patch into the on-disk first-run state and persist at 0600. Never throws. */
export async function updateFirstRunState(
  patch: Partial<FirstRunState>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const current = await readFirstRunState(env);
    const next: FirstRunState = { ...current, ...patch };
    const dir = configDir(env);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE).catch(() => {});
    const path = firstRunStatePath(env);
    await writeFile(path, JSON.stringify(next) + '\n', { mode: CONFIG_MODE });
    await chmod(path, CONFIG_MODE).catch(() => {});
  } catch {
    // A write failure means we might re-show the wizard / trust copy next time — a
    // mild over-show, never a crash. Swallow it (best-effort posture).
  }
}

/** True if this install has completed the first-run wizard (THE onboarded gate). */
export async function isOnboarded(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await readFirstRunState(env)).onboarded === true;
}

// ──────────────────────────────────────────────────────────────────────────────
// TRUST GATE for the silent hook path.
//
// The CC SessionEnd hook (manifest-registered) can fire BEFORE any install/start ran.
// runCapture's no-auth path fire-and-forgets ensureAuth (which can open a browser).
// The AC requires the never-store-source trust copy to precede ANY transcript
// processing — including this path. So capture.ts calls maybeShowTrustGate BEFORE it
// reads the transcript or fires ensureAuth, and we print TRUST_COPY exactly ONCE
// (throttled via `trustShown`, like the connect nudge), then never again.
//
// WHY this is safe for the always-exit-0 / never-blocks capture contract: this is a
// synchronous-ish best-effort stderr emit + a tiny state write, both wrapped — it
// NEVER throws and NEVER blocks on a network or browser. It's the SAME posture as
// maybeNudge. If the user already ran `/backthread:start` (which sets `onboarded`),
// or the trust copy was already shown, this is a no-op.
// ──────────────────────────────────────────────────────────────────────────────

export interface TrustGateDeps {
  env?: NodeJS.ProcessEnv;
  /** Where the trust copy goes. Defaults to console.error (stderr — capture's channel). */
  log?: (msg: string) => void;
  /** Test seam: the state reader. Defaults to readFirstRunState. */
  readStateImpl?: (env: NodeJS.ProcessEnv) => Promise<FirstRunState>;
  /** Test seam: the state writer. Defaults to updateFirstRunState. */
  writeStateImpl?: (patch: Partial<FirstRunState>, env: NodeJS.ProcessEnv) => Promise<void>;
}

/**
 * Show the never-store-source trust copy ONCE on the silent hook path, before any
 * transcript is read or any login is fired. Returns whether the copy was emitted.
 * Suppressed (returns false) when the install is already onboarded, or the trust copy
 * was already shown. NEVER throws — it's wired into the always-exit-0 capture path.
 */
export async function maybeShowTrustGate(deps: TrustGateDeps = {}): Promise<boolean> {
  try {
    const env = deps.env ?? process.env;
    const readState = deps.readStateImpl ?? readFirstRunState;
    const state = await readState(env);
    // Already onboarded (full wizard ran) OR trust copy already shown → no-op. Either
    // way the founder has seen the never-store-source claim once.
    if (state.onboarded === true || state.trustShown === true) return false;

    const log = deps.log ?? ((m: string) => console.error(m));
    log(TRUST_COPY);

    const writeState = deps.writeStateImpl ?? updateFirstRunState;
    await writeState({ trustShown: true }, env);
    return true;
  } catch {
    // Ultimate backstop — the trust gate is wired into capture; it can never throw.
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// The `/backthread:start` first-run wizard.
// ──────────────────────────────────────────────────────────────────────────────

export interface StartOptions {
  /** Working directory (used to resolve the repo for the state call). Defaults to cwd. */
  cwd?: string;
  /**
   * A single-use claim code handed off by the web app —
   * `/backthread:start --claim …` / `backthread start --claim …`. Exchanged for a
   * device token (no browser) — the "one-tap" WEB-initiated auth. Wins over loopback.
   */
  claim?: string;
  /**
   * The entry point that arrived here. Drives the step ORDER (terminal-first leads
   * with capture, then nudges connect-repo; web-initiated skips the re-nudge — the
   * repo was almost certainly connected in the web wizard). When omitted we derive
   * it: a claim code ⇒ 'web', otherwise 'terminal' (see entry.detectEntry).
   */
  entry?: EntryPoint;
  /**
   * Headless/SSH device-code login. OUT OF SCOPE: we
   * refuse with the existing loud stub guidance rather than silently fall back to the
   * loopback (which would HANG a headless box).
   */
  device?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Where human-readable progress goes. Defaults to console.error (stderr). */
  log?: (msg: string) => void;
}

export interface StartDeps {
  /** Test seam: the auth handshake. Defaults to ensureAuth (loopback / claim). */
  ensureAuthImpl?: (opts: LoginOptions) => Promise<BackthreadConfig>;
  /** Test seam: the unified onboarding-state fetch. Defaults to fetchOnboardingState. */
  fetchStateImpl?: (input?: OnboardingInput, deps?: OnboardingDeps) => Promise<OnboardingOutcome>;
  /** OnboardingDeps threaded into the state fetch (env, fetch, readers) — for tests. */
  onboardingDeps?: OnboardingDeps;
  /** Test seam: the first-run state reader. Defaults to readFirstRunState. */
  readStateImpl?: (env: NodeJS.ProcessEnv) => Promise<FirstRunState>;
  /** Test seam: the first-run state writer (marks onboarded). Defaults to updateFirstRunState. */
  writeStateImpl?: (patch: Partial<FirstRunState>, env: NodeJS.ProcessEnv) => Promise<void>;
  /** Test seam: the on-disk config reader (used by the already-onboarded short-circuit). Defaults to readConfig. */
  readConfigImpl?: (env: NodeJS.ProcessEnv) => Promise<BackthreadConfig>;
  // --- bare-terminal capture-install offer (step 4a) ------------------------------
  /** Test seam: detect which non-CC agents are installed (by config-dir presence). Defaults to detectInstalledAgents. */
  detectAgentsImpl?: (home: string) => InstallAgent[];
  /**
   * Test seam: the interactive yes/no prompt for the capture-install offer. Defaults to a
   * TTY-guarded readline (defaultAnswer = Yes for the `[Y/n]` offer; a non-TTY resolves
   * false WITHOUT prompting, so a non-interactive run never hangs and falls back to guidance).
   */
  promptYesNoImpl?: (question: string) => Promise<boolean>;
  /** Test seam: the per-agent install writer used when the user accepts the offer. Defaults to runInstallAgent. */
  installAgentImpl?: typeof runInstallAgent;
  /** Home dir override (tests) for agent detection + install. Defaults to os.homedir(). */
  home?: string;
}

export interface StartResult {
  /** 0 on success; 1 only on a genuine auth failure (capture won't run until the user acts). */
  exitCode: number;
  /**
   * A terse machine status for the bin + tests:
   *   - 'already-onboarded'  idempotent short-circuit (returning user).
   *   - 'onboarded'          first run completed (trust + auth + next-step shown, flag set).
   *   - 'auth-failed'        auth didn't yield a token; reported + flag NOT set (so a retry re-runs).
   *   - 'device-unsupported' `--device` refused (out of scope → loud stub).
   */
  status: 'already-onboarded' | 'onboarded' | 'auth-failed' | 'device-unsupported';
  /** Whether the device ended up authorized. */
  authed: boolean;
}

/**
 * Run the `/backthread:start` first-run wizard end to end. Idempotent: a returning
 * user (onboarded flag set) is short-circuited. Otherwise: trust copy → one-tap auth
 * (claim handoff or loopback; device-code refused) → state-driven next step → mark
 * onboarded. Reports each step to stderr; exits non-zero only on a genuine auth
 * failure (capture genuinely won't run until the user authorizes).
 */
export async function runStart(opts: StartOptions = {}, deps: StartDeps = {}): Promise<StartResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.error(m));
  const cwd = opts.cwd ?? process.cwd();
  // Entry point drives the step order. Explicit wins; otherwise derive it (a claim
  // code ⇒ web-initiated). 'terminal' leads with capture then nudges connect; 'web'
  // skips the connect re-nudge (the repo was connected in the web wizard).
  const entry: EntryPoint = opts.entry ?? detectEntry({ claim: opts.claim, env });

  // (1) IDEMPOTENCE GATE — a returning user is never re-onboarded.
  const readState = deps.readStateImpl ?? readFirstRunState;
  const existingState = await readState(env).catch(() => ({}) as FirstRunState);
  if (existingState.onboarded === true) {
    // The `onboarded` flag deliberately survives token rotation/clearing (so a
    // returning user is never re-shown the full wizard). But that means we can't
    // assume the device is still authed — read the on-disk config (cheap, no
    // network) and derive the real auth state instead of hardcoding it. Otherwise
    // a user whose token was revoked would get a false "you're good to go" while
    // captures silently no-op into the no-auth path.
    const readCfg = deps.readConfigImpl ?? readConfig;
    const cfg = await readCfg(env).catch(() => ({}) as BackthreadConfig);
    if (cfg.device_token) {
      log("Backthread is already set up on this machine — you're good to go.");
      log('  New sessions are captured automatically when they end.');
      // Surface the diagram deep-link so a returning user's short message is
      // actionable ("view your diagram at <link>", the AC). Resolved LOCALLY
      // (config.repo → cwd git remote) — no network, never throws; omitted cleanly
      // when no repo resolves (e.g. run outside a connected repo).
      const repo = resolveOnboardingRepo({ cwd }, cfg, deps.onboardingDeps?.readRemoteImpl);
      if (repo) {
        log(`  View your "How it works" diagram: ${buildRepoDeepLink(repo.owner, repo.name, env)}`);
      }
      log('  Run `/backthread:capture` to capture the current session now.');
      return { exitCode: 0, status: 'already-onboarded', authed: true };
    }
    // Onboarded but this device isn't signed in. exitCode stays 0: the user IS
    // onboarded (the wizard already ran) — a missing token is actionable guidance,
    // not a wizard failure, so we don't fail the command.
    log("Backthread is already set up on this machine, but this device isn't signed in —");
    log('  run `backthread login` (or `/backthread:start --claim <code>` with a code from the web app).');
    return { exitCode: 0, status: 'already-onboarded', authed: false };
  }

  // `--device` is OUT OF SCOPE — refuse loudly, never silently loopback.
  if (opts.device) {
    deviceLogin(log); // the existing loud stub guidance (login.ts)
    return { exitCode: 1, status: 'device-unsupported', authed: false };
  }

  log("Welcome to Backthread — let's get you set up.\n");

  // (2) TRUST GATE — the never-store-source claim before anything else. (No transcript
  // is read on this path at all, so the AC is trivially satisfied; we still record
  // trustShown so the silent hook path won't re-print it.)
  log(TRUST_COPY + '\n');

  // (3) AUTH — one tap. Claim handoff (web-initiated) or browser loopback (plugin-
  // initiated). An already-authed device short-circuits inside ensureAuth.
  const doEnsureAuth = deps.ensureAuthImpl ?? ensureAuth;
  let authed = false;
  try {
    const cfg = await doEnsureAuth({ env, claim: opts.claim });
    authed = !!cfg.device_token;
    log(
      authed
        ? opts.claim
          ? '[1/2] Auth: device authorized (claim code accepted — no browser needed).'
          : '[1/2] Auth: device authorized.'
        : '[1/2] Auth: completed but no token found.',
    );
  } catch (e) {
    // A genuine auth failure means capture can't run yet. Report + exit non-zero, but
    // DON'T mark onboarded — so re-running `/backthread:start` retries the auth.
    log(`[1/2] Auth: failed — ${(e as Error).message}`);
    log('      Run `/backthread:start` again to retry, or `backthread login` to authorize.');
    return { exitCode: 1, status: 'auth-failed', authed: false };
  }

  if (!authed) {
    // ensureAuth resolved without a token (unusual) — same posture as a thrown failure.
    log('      Run `/backthread:start` again to retry authorizing this device.');
    return { exitCode: 1, status: 'auth-failed', authed: false };
  }

  // (4a) CAPTURE STEP (the "why") — entry-aware. On the TERMINAL door we lead with
  // capture: it's the thing only this machine can do. INSIDE Claude Code the RIGHT
  // wiring is the PLUGIN — we only RECOMMEND it (captureGuidance routes that copy) and
  // NEVER auto-install: the CLI can't install a CC plugin, and must not hand-write the
  // fragile npx settings.json hook (the ARP-680 worktree-freeze path). In a BARE
  // terminal we go one better — DETECT the user's agent and OFFER to wire its capture
  // inline (prompted, never silent; see offerCaptureInstall). On the WEB door (claim
  // handoff) the user just came from the wizard; auth already armed capture for this
  // session, so we keep it terse and skip the capture step entirely.
  if (entry === 'terminal') {
    if (isInsideClaudeCode(env)) {
      log('\n' + captureGuidance(env));
    } else {
      await offerCaptureInstall(env, log, deps);
    }
  }

  // (4b) STATE-DRIVEN NEXT STEP — read the SAME unified state the web wizard reads and
  // render its canonical next step (the cell→next-step decision lives once
  // server-side). A repo-not-connected state surfaces the connect nudge copy; a terminal
  // state renders cleanly. Best-effort: a failed state fetch degrades to a plain hint.
  // On the WEB door we still fetch + render (the deep-link to the diagram is the payoff),
  // but the connect nudge will be absent because the wizard already connected the repo.
  const fetchState = deps.fetchStateImpl ?? fetchOnboardingState;
  // fetchOnboardingState reads the on-disk device token itself (the one auth just wrote)
  // and resolves the repo from cwd; onboardingDeps lets tests inject a fake config/fetch/
  // remote so this runs with no real network hop.
  const stateOut = await fetchState({ cwd }, { env, ...deps.onboardingDeps }).catch(
    () => ({ status: 'error', detail: 'state fetch failed (swallowed)' }) as OnboardingOutcome,
  );
  log('\n' + renderNextStep(stateOut, env));

  // (5) MARK ONBOARDED — step 1 short-circuits from here on (idempotence). We also set
  // trustShown so the silent hook path never re-prints the trust copy.
  const writeState = deps.writeStateImpl ?? updateFirstRunState;
  await writeState({ onboarded: true, trustShown: true }, env);

  return { exitCode: 0, status: 'onboarded', authed: true };
}

/** Display labels for the offer copy + success line (Title-cased, not the lowercase enum). */
const AGENT_LABEL: Record<InstallAgent, string> = {
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
};

/**
 * BARE-TERMINAL (not-inside-CC) capture wiring offer — detect → offer → install.
 *
 * Detect which non-CC agents are installed (by config-dir presence under $HOME). The
 * offer fires ONLY when we can name EXACTLY ONE agent: zero leaves us nothing to wire,
 * and MULTIPLE would force us to guess between them — both fall back to PRINTING the
 * explicit `captureGuidance` (the command for later). For a single agent we PROMPT
 * (consent-gated, never silent); the prompt's TTY guard means a non-interactive run
 * (CI, pipe, hook) resolves "no" WITHOUT hanging on stdin, so it too falls back to
 * printed guidance. On YES we run the SAME per-agent writer `backthread install --agent
 * <x>` runs — auth already happened in step 3, so (matching that path's per-agent leg)
 * we do NOT re-auth and do NOT backfill. A corrupt existing config throws inside the
 * writer; we report it and fall back to guidance rather than fail the wizard.
 */
async function offerCaptureInstall(
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void,
  deps: StartDeps,
): Promise<void> {
  const home = deps.home ?? homedir();
  const detect = deps.detectAgentsImpl ?? detectInstalledAgents;
  let detected: InstallAgent[];
  try {
    detected = detect(home);
  } catch {
    detected = [];
  }

  // 0 detected → nothing to wire; >1 → we won't guess between agents. Either way, print
  // the explicit command so the user can wire capture themselves whenever they like.
  if (detected.length !== 1) {
    log('\n' + captureGuidance(env));
    return;
  }

  const agent = detected[0];
  const label = AGENT_LABEL[agent];
  // The prompt owns the TTY decision (its default resolves Yes on empty input, false on
  // a non-TTY without prompting) — so a non-interactive run lands in the `!yes` branch
  // and gets printed guidance instead of a hang.
  const prompt = deps.promptYesNoImpl ?? ((q: string) => promptYesNo(q, { defaultAnswer: true }));
  const yes = await prompt(`Detected ${label} — wire capture for it now? [Y/n] `).catch(() => false);
  if (!yes) {
    // Declined (or non-interactive) — leave them the explicit command for later.
    log('\n' + captureGuidance(env));
    return;
  }

  // YES → run the same USER-GLOBAL per-agent writer as `backthread install --agent <x>`.
  // No re-auth (step 3 did it), no backfill (matches that path's per-agent leg).
  const doInstall = deps.installAgentImpl ?? runInstallAgent;
  try {
    const result = await doInstall(agent, { home });
    if (result.versionWarning) log(`  ⚠ ${result.versionWarning}`);
    log(`Capture wired for ${label} — new sessions are captured automatically when they end.`);
  } catch (e) {
    log(`Couldn't wire capture for ${label} automatically — ${(e as Error).message}`);
    log('\n' + captureGuidance(env));
  }
}

/**
 * Render the second wizard line from the unified onboarding state. The server owns
 * the next-step COPY (so it's identical across surfaces); we prefix "[2/2]" and, for
 * the connect-driven steps, append the repo deep-link (built from config/cwd, never
 * hardcoded — same rule as connectNudge.nextStepMessage). A terminal state, or any
 * non-ok fetch, degrades to a plain, vocabulary-disciplined hint. Never says
 * "architectural memory".
 */
export function renderNextStep(
  out: OnboardingOutcome,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Non-ok fetch (no-auth shouldn't happen here — we just authed — but be defensive;
  // fetch-failed / error are best-effort degradations). Give a plain, useful hint.
  if (out.status !== 'ok' || !out.state) {
    return (
      '[2/2] You\'re set up. New sessions are captured automatically when they end.\n' +
      '      Connect a repo to see your "How it works" diagram: ' +
      appReposLink(env)
    );
  }

  const state = out.state;
  const repo = out.repo ?? state.repo ?? null;

  // Terminal (fully onboarded / transcript-less) → render cleanly, no nudge.
  if (state.nextStep === null) {
    if (repo) {
      return (
        '[2/2] You\'re all set — your "How it works" diagram is live: ' +
        buildRepoDeepLink(repo.owner, repo.name, env)
      );
    }
    return '[2/2] You\'re all set. New sessions are captured automatically when they end.';
  }

  // A server-provided next step. The body is the server's canonical copy; append the
  // repo deep-link for connect-driven slugs (same LINKED_SLUGS rule as the nudge).
  const step = state.nextStep;
  const base = `[2/2] ${step.body}`;
  if ((step.slug === 'connect_repo' || step.slug === 'cold_start') && repo) {
    return `${base} ${buildRepoDeepLink(repo.owner, repo.name, env)}`;
  }
  if (step.slug === 'connect_repo' || step.slug === 'cold_start') {
    // No repo resolved (cold start) — point at the app's repo-connect surface.
    return `${base} ${appReposLink(env)}`;
  }
  return base;
}

/** The app's connect landing (no specific repo resolved yet). Built from BACKTHREAD_APP_URL. */
function appReposLink(env: NodeJS.ProcessEnv = process.env): string {
  // appBaseUrl is the canonical origin helper; we link its root (the in-product wizard /
  // connect entry) rather than hardcode a path so it tracks the app's routing.
  return appBaseUrl(env);
}
