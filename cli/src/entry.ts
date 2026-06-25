// entry.ts — entry-point detection + the entry-aware capture guidance.
//
// `npx backthread` is now the canonical UNIFIED front door (ARP-703): a bare
// invocation runs the SAME onboarding as `backthread start`. But the right step
// ORDER depends on HOW the user arrived, and the capture-step wording depends on
// WHERE they're running. Both of those decisions live here, in one tiny pure
// module, so the bin and firstRun.ts just consume the result.
//
// ──────────────────────────────────────────────────────────────────────────────
// ENTRY POINT — terminal/agent-first vs web-initiated (the locked order):
//
//   • TERMINAL  (bare `npx backthread`, or the CC plugin's `/backthread:start`):
//     the user is at a keyboard with their code in front of them. Lead with
//     CAPTURE (arm the "why" of every session), THEN nudge connect-repo (the
//     "map"). Capture is the thing only the local machine can do; the repo
//     connect is a browser hop they can do any time.
//
//   • WEB       (`--claim <code>` handoff from the lander / demo wizard): the
//     user started on the web, where they almost certainly ALREADY connected a
//     repo as part of the wizard. This terminal invocation exists only to ADD
//     capture, so we don't re-nudge the connect they just did.
//
// DETECTION (deliberately simple + deterministic): a claim code present ⇒
// web-initiated (the web app is the only thing that hands out claim codes).
// Otherwise ⇒ terminal-first. A future explicit signal (a `--web` flag, a web-
// origin env var) can widen `webInitiated` without changing any caller.
// ──────────────────────────────────────────────────────────────────────────────

export type EntryPoint = 'terminal' | 'web';

/** The plugin marketplace + install slugs (mirrors cli/README.md "Quick start"). */
export const PLUGIN_MARKETPLACE = 'backthread/backthread';
export const PLUGIN_INSTALL = 'backthread@backthread';

export interface EntryInput {
  /** A claim code, when one was handed to us (the WEB-initiated signal). */
  claim?: string;
  /** Override the environment (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Classify the entry point. A claim code ⇒ 'web' (only the web app mints them);
 * everything else ⇒ 'terminal'. Pure + deterministic — the order decision and the
 * capture wording both branch off this.
 */
export function detectEntry(input: EntryInput = {}): EntryPoint {
  if (input.claim && input.claim.trim().length > 0) return 'web';
  return 'terminal';
}

/**
 * True when this process is running INSIDE a Claude Code session — the user typed
 * `npx backthread` into Claude Code's terminal, or a slash command / hook spawned
 * us. Claude Code sets CLAUDECODE=1 in every child it spawns (documented + stable
 * as of CC v2). We use it to ROUTE the capture step: inside CC the right capture
 * wiring is the PLUGIN (it registers the SessionEnd hook + MCP at user/global
 * scope, surviving worktrees — ARP-680), NEVER a hand-written, fragile npx-based
 * ~/.claude/settings.json hook.
 */
export function isInsideClaudeCode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDECODE === '1';
}

/**
 * The capture-step guidance, routed by where we're running.
 *
 *   • INSIDE Claude Code → recommend the PLUGIN. The plugin bundles the CLI and
 *     registers the capture hook + MCP at user/global scope (works across every
 *     repo + git worktree). We NEVER tell a CC user to write the npx settings.json
 *     hook — that's the stale, worktree-fragile path ARP-680 retired.
 *
 *   • Any other agent / bare terminal → point at `npx backthread install`
 *     (the CC settings.json fallback) and `--agent <x>` for Codex/Cursor/Gemini.
 *
 * Pure (returns the lines); the caller logs them. Vocabulary-disciplined — never
 * says "architectural memory".
 */
export function captureGuidance(env: NodeJS.ProcessEnv = process.env): string {
  if (isInsideClaudeCode(env)) {
    return [
      'Capture (the "why"): you\'re in Claude Code — install the plugin so every',
      '  session is captured automatically (it wires the hook + MCP across all your',
      '  repos and worktrees):',
      `    /plugin marketplace add ${PLUGIN_MARKETPLACE}`,
      `    /plugin install ${PLUGIN_INSTALL}`,
    ].join('\n');
  }
  return [
    'Capture (the "why"): run `npx backthread install` here to wire the capture hook',
    '  so each Claude Code session is captured automatically when it ends.',
    '  Using Codex / Cursor / Gemini? `npx backthread install --agent <codex|cursor|gemini>`.',
  ].join('\n');
}
