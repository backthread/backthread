// detectAgents.ts — which non-CC coding agents are installed on THIS machine.
//
// The bare-terminal front door (firstRun.ts step 4a) wants to OFFER to wire capture
// for the agent the user actually has — but only when it can name exactly ONE, so it
// never has to guess between two. The cheapest reliable signal is the agent's
// USER-GLOBAL config directory under $HOME: Codex writes ~/.codex, Cursor ~/.cursor,
// Gemini ~/.gemini the first time they run. Presence of that dir ⇒ "installed enough
// to have a config we can merge into" — which is exactly the precondition the per-agent
// install writers (installAgent.ts) need anyway.
//
// Deliberately a tiny PURE module: a synchronous `existsSync` sweep, no network, no
// process probe (the `<bin> --version` probe lives in installAgent's version gate and
// runs only once we've committed to installing). `home` is injected so the caller can
// thread a test/override home, and firstRun.ts can stub the whole thing via a DI seam.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { INSTALL_AGENTS, type InstallAgent } from './installAgent.js';

// The user-global config dir each agent creates on first run. All three happen to be
// `~/.<agent>`, but we map them EXPLICITLY so a future agent whose dir doesn't follow
// that convention can't silently misdetect.
const AGENT_CONFIG_DIR: Record<InstallAgent, string> = {
  codex: '.codex',
  cursor: '.cursor',
  gemini: '.gemini',
};

/**
 * Return the installable agents whose user-global config dir exists under `home`, in
 * the canonical INSTALL_AGENTS order. Pure + synchronous; never throws (a bad `home`
 * just yields []). The caller decides what to do with 0 / 1 / many matches.
 */
export function detectInstalledAgents(home: string): InstallAgent[] {
  return INSTALL_AGENTS.filter((agent) => {
    try {
      return existsSync(join(home, AGENT_CONFIG_DIR[agent]));
    } catch {
      return false;
    }
  });
}
