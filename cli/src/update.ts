// update.ts — the `backthread update` command.
//
// Explicit, on-demand self-update. It COMPLEMENTS two existing mechanisms rather than
// replacing them:
//   • the PASSIVE npx `@latest` hooks — the capture / MCP wirings run `npx backthread@latest`,
//     so they already re-resolve the newest published version on every run (ARP-733/739);
//   • the 24h upgrade NUDGE — a whisper on interactive surfaces when the server sees an
//     old client (ARP-731→735).
// This command is for the developer who installed the CLI GLOBALLY (`npm i -g backthread`)
// and wants to pull latest right now.
//
// Three install contexts, three behaviours — we never pretend to update something we don't
// own, and never leave a half-updated state:
//   • ephemeral npx      → nothing to update; `npx backthread@latest` already fetches latest
//                          every run. Explain, and how to pin a global binary.
//   • Claude Code plugin → the plugin ships its own bundled copy (`/plugin update` owns it);
//                          a global `npm i -g` wouldn't change the copy the plugin runs.
//   • global / other     → resolve latest FIRST (a cheap `npm view`), skip when already
//                          current, else `npm install -g backthread@latest`; report old → new
//                          and quiet the upgrade nudge. Any npm/offline error → a clear
//                          message + non-zero exit, current install untouched.
import { realpathSync } from 'node:fs';
import { cliVersion } from './version.js';
import { resetUpgradeNudge } from './upgradeNudge.js';
import { runNpm as realRunNpm, type NpmRun } from './npm.js';

// Re-exported so existing importers (update.test.ts) keep the type off ./update.js.
export type { NpmRun } from './npm.js';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** npm's ephemeral npx cache always lives under a `_npx` path segment (all npm versions/OSes). */
const NPX_SEGMENT_RE = /(?:^|[\\/])_npx[\\/]/;

export type InstallContext = 'npx' | 'plugin' | 'global';

export interface UpdateResult {
  ok: boolean;
  context: InstallContext;
  /** True iff a global install actually ran and moved the version. */
  updated: boolean;
  message: string;
}

export interface UpdateDeps {
  env?: NodeJS.ProcessEnv;
  /** Progress lines (human, non-final) → stderr by default so the final summary owns stdout. */
  log?: (msg: string) => void;
  /** Test seam: the currently-running version. Defaults to cliVersion (reads package.json). */
  currentVersion?: () => string;
  /** Test seam: run an npm subcommand. Defaults to a real `npm` spawn. */
  runNpm?: (args: string[]) => Promise<NpmRun>;
  /** Test seam: the resolved path of the running bin (for context detection). */
  scriptPath?: string;
  /** Test seam: quiet the upgrade-nudge throttle. Defaults to resetUpgradeNudge. */
  resetNudge?: (env: NodeJS.ProcessEnv) => Promise<void>;
}

/**
 * Classify how this CLI is being run. `CLAUDE_PLUGIN_ROOT` (set by Claude Code for its
 * bundled plugin copy) → 'plugin'; a `_npx` path segment → ephemeral 'npx'; everything else
 * (a real global bin, or local dev) → 'global'. Pure + injectable for tests.
 */
export function detectInstallContext(env: NodeJS.ProcessEnv, scriptPath: string | undefined): InstallContext {
  if (typeof env.CLAUDE_PLUGIN_ROOT === 'string' && env.CLAUDE_PLUGIN_ROOT.trim().length > 0) return 'plugin';
  if (scriptPath && NPX_SEGMENT_RE.test(scriptPath)) return 'npx';
  return 'global';
}

// The path of the running bin, for context detection. A RAW `_npx` segment is the
// definitive npx signal, so keep the raw argv path when it has one (npm puts the ephemeral
// `.bin/backthread` symlink INSIDE `_npx`; realpath-ing it could resolve to a target
// outside `_npx` and erase the signal). Otherwise realpath for a stable, canonical path.
// Falls back to raw (then empty) — a resolution hiccup must never crash `update`, only make
// it assume 'global'.
function resolveScriptPath(): string {
  const raw = process.argv[1] ?? '';
  if (!raw) return '';
  if (NPX_SEGMENT_RE.test(raw)) return raw;
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

// First non-empty line of npm's stderr, for a compact one-line error hint.
function firstLine(s: string): string {
  const line = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? 'unknown npm error';
}

/**
 * Run `backthread update`. Returns a result (the dispatcher prints result.message to stdout
 * and maps result.ok to the exit code); progress goes to deps.log (stderr). Never throws.
 */
export async function runUpdate(deps: UpdateDeps = {}): Promise<UpdateResult> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((m: string) => console.error(m));
  const current = (deps.currentVersion ?? cliVersion)();
  const runNpm = deps.runNpm ?? realRunNpm;
  const resetNudge = deps.resetNudge ?? ((e: NodeJS.ProcessEnv) => resetUpgradeNudge({ env: e }));
  const scriptPath = deps.scriptPath ?? resolveScriptPath();

  const context = detectInstallContext(env, scriptPath);

  if (context === 'npx') {
    return {
      ok: true,
      context,
      updated: false,
      message:
        "You're running Backthread via `npx`, which already fetches the latest published version\n" +
        "on every run — nothing to update. Want a pinned, always-available binary?\n" +
        '  npm i -g backthread\n' +
        'Then `backthread update` pulls new releases on demand.',
    };
  }

  if (context === 'plugin') {
    return {
      ok: true,
      context,
      updated: false,
      message:
        "This is the Claude Code plugin's bundled copy of Backthread — the plugin manages it,\n" +
        'not npm. Update it from Claude Code:\n' +
        '  /plugin update backthread\n' +
        'For a standalone terminal CLI too: `npm i -g backthread`.',
    };
  }

  // --- global / other: resolve latest, then install if behind ------------------
  log('Checking npm for the latest backthread…');
  const view = await runNpm(['view', 'backthread', 'version']);
  if (!view.ok || !SEMVER_RE.test(view.stdout)) {
    const why = view.ok ? `unexpected npm output "${view.stdout}"` : firstLine(view.stderr);
    return {
      ok: false,
      context,
      updated: false,
      message: `Couldn't check npm for the latest version (${why}). Are you online? Your current install (${current}) is untouched.`,
    };
  }
  const latest = view.stdout;

  if (current === latest) {
    await resetNudge(env);
    return { ok: true, context, updated: false, message: `Backthread is already up to date (${current} is the latest).` };
  }

  log(`Updating backthread ${current} → ${latest} (npm i -g backthread@latest)…`);
  const install = await runNpm(['install', '-g', 'backthread@latest']);
  if (!install.ok) {
    return {
      ok: false,
      context,
      updated: false,
      message:
        `npm couldn't install backthread@latest: ${firstLine(install.stderr)}\n` +
        `Your current install (${current}) is untouched. If this is a permissions error, retry with your global-install method (e.g. a Node version manager, or sudo).`,
    };
  }

  await resetNudge(env);
  return {
    ok: true,
    context,
    updated: true,
    message: `Updated Backthread ${current} → ${latest}. Restart any long-running sessions to pick it up.`,
  };
}
