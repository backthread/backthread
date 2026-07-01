// doctor.ts — `backthread doctor`: diagnose a broken / half-set-up install in one shot.
//
// As install volume grows, the top support cost is "I installed it but nothing happens".
// `doctor` runs the handful of checks that explain WHY, each as a ✓/✗/⚠/ℹ line with a
// concrete fix hint, and exits non-zero when a CRITICAL check fails (so it's scriptable in
// CI / a setup script). It is READ-ONLY and SAFE: it never prints the device token (only
// whether one is present), touches nothing, and every check is best-effort — a check that
// errors degrades to a warning, it never crashes the command.
//
// Checks (in report order):
//   • Auth         — a device token is present in ~/.backthread/config.json          [critical]
//   • Config perms — the config file is 0600 and its dir 0700 (POSIX)                 [warn]
//   • Repo         — a connected repo slug (owner/name) resolves                      [warn]
//   • Capture hook — the SessionEnd/Stop hook is wired for a host agent, and NOT      [warn]
//                    only project-scoped (the ARP-680 worktree-blind trap)
//   • Connectivity — the worker + Functions origins are reachable (honors overrides)  [warn]
//   • Version      — installed vs latest on npm (+ the redact version)                [info]
//
// Only Auth is critical: a missing token means nothing works, and that's the clean
// scriptable "is this set up at all?" signal. Everything else is advisory (a missing repo
// still allows repo-less capture; a hook we can't see may still be wired by the plugin
// manifest; connectivity/version can fail transiently) — we surface them loudly but never
// fail the exit code on a heuristic.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { readConfig, configPath, configDir, type BackthreadConfig } from './config.js';
import { cliVersion, redactVersion } from './version.js';
import { workerBaseUrl, functionsBaseUrl } from './urls.js';
import { runNpm as realRunNpm, type NpmRun } from './npm.js';

export type CheckStatus = 'ok' | 'fail' | 'warn' | 'info';

export interface Check {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Only a `fail` on a `critical` check drives the non-zero exit code. */
  critical?: boolean;
}

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  /** Home dir for the host-agent hook scan (~/.claude, ~/.codex, …). Defaults to os.homedir(). */
  home?: string;
  /** Cwd for the project-scope-trap check. Defaults to process.cwd(). */
  cwd?: string;
  /** Test seam: connectivity fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: npm spawn for the version check. Defaults to the shared runNpm. */
  runNpm?: (args: string[]) => Promise<NpmRun>;
  /** Test seam: read a file as utf8 (hook scan). Defaults to fs.readFile. Rejects ⇒ absent. */
  readFileImpl?: (path: string) => Promise<string>;
  /** Test seam: stat a path for perms. Defaults to fs.stat. */
  statImpl?: (path: string) => Promise<{ mode: number }>;
  /** Connectivity per-request timeout (ms). Default 5000. */
  connectTimeoutMs?: number;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const REPO_SLUG_RE = /^[^/\s]+\/[^/\s]+$/;

// --- individual checks (each best-effort; never throws) ----------------------

// The config is read ONCE per doctor run (loadConfig) and shared by the auth + repo checks —
// so a broken/unreadable config surfaces the same way in both, and we don't touch disk twice.
interface LoadedConfig {
  config: BackthreadConfig | null;
  error: Error | null;
}

async function loadConfig(env: NodeJS.ProcessEnv): Promise<LoadedConfig> {
  try {
    return { config: await readConfig(env), error: null };
  } catch (e) {
    return { config: null, error: e as Error };
  }
}

function authCheck(loaded: LoadedConfig, env: NodeJS.ProcessEnv): Check {
  if (loaded.error) {
    return {
      key: 'auth',
      label: 'Auth',
      status: 'fail',
      critical: true,
      detail: `couldn't read ${configHint(env)} (${loaded.error.message ?? loaded.error}) — check its permissions`,
    };
  }
  if (loaded.config?.device_token) {
    return { key: 'auth', label: 'Auth', status: 'ok', detail: 'signed in (device token present)' };
  }
  return { key: 'auth', label: 'Auth', status: 'fail', critical: true, detail: 'not signed in — run `backthread login`' };
}

async function permsCheck(deps: DoctorDeps, env: NodeJS.ProcessEnv): Promise<Check> {
  if (process.platform === 'win32') {
    return { key: 'perms', label: 'Config perms', status: 'info', detail: 'n/a on Windows (POSIX modes not enforced)' };
  }
  const doStat = deps.statImpl ?? ((p: string) => stat(p));
  const filePath = configPath(env);
  const dirPath = configDir(env);
  let fileMode: number | null = null;
  let dirMode: number | null = null;
  try {
    fileMode = (await doStat(filePath)).mode & 0o777;
  } catch {
    // No config file yet (or unreadable) → nothing to check.
    return { key: 'perms', label: 'Config perms', status: 'info', detail: 'no config file yet (run `backthread login`)' };
  }
  try {
    dirMode = (await doStat(dirPath)).mode & 0o777;
  } catch {
    dirMode = null;
  }
  const fileLoose = (fileMode & 0o077) !== 0; // any group/other bit on the credential file
  const dirLoose = dirMode !== null && (dirMode & 0o077) !== 0;
  if (fileLoose || dirLoose) {
    return {
      key: 'perms',
      label: 'Config perms',
      status: 'warn',
      detail: `too open (config ${octal(fileMode)}${dirMode !== null ? `, dir ${octal(dirMode)}` : ''}) — run \`chmod 600 ${configHint(env)}\` (dir 700)`,
    };
  }
  return { key: 'perms', label: 'Config perms', status: 'ok', detail: `config 0600${dirMode !== null ? ', dir 0700' : ''}` };
}

function repoCheck(loaded: LoadedConfig): Check {
  if (loaded.error) {
    return { key: 'repo', label: 'Repo', status: 'warn', detail: 'could not read the connected repo' };
  }
  const repo = loaded.config?.repo;
  if (repo && REPO_SLUG_RE.test(repo)) {
    return { key: 'repo', label: 'Repo', status: 'ok', detail: repo };
  }
  if (repo) {
    return { key: 'repo', label: 'Repo', status: 'warn', detail: `connected slug "${repo}" is not owner/name — reconnect in the web app` };
  }
  return { key: 'repo', label: 'Repo', status: 'warn', detail: 'no repo connected — run `backthread install` (or connect it in the web app)' };
}

// Host agents whose user-global hook we can look for, and the files that would carry it.
const AGENT_HOOK_FILES: ReadonlyArray<{ agent: string; files: (home: string) => string[] }> = [
  { agent: 'claude-code', files: (h) => [join(h, '.claude', 'settings.json')] },
  { agent: 'gemini', files: (h) => [join(h, '.gemini', 'settings.json')] },
  { agent: 'codex', files: (h) => [join(h, '.codex', 'hooks.json'), join(h, '.codex', 'config.toml')] },
  { agent: 'cursor', files: (h) => [join(h, '.cursor', 'hooks.json'), join(h, '.cursor', 'mcp.json')] },
];

async function hookCheck(deps: DoctorDeps, env: NodeJS.ProcessEnv): Promise<Check> {
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const doRead = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  const mentions = async (path: string): Promise<boolean> => {
    try {
      return (await doRead(path)).includes('backthread');
    } catch {
      return false; // absent / unreadable → not wired here
    }
  };

  // Running AS the Claude Code plugin → the plugin manifest wires the hook for us.
  const asPlugin = typeof env.CLAUDE_PLUGIN_ROOT === 'string' && env.CLAUDE_PLUGIN_ROOT.trim().length > 0;

  const wired: string[] = [];
  if (asPlugin) wired.push('claude-code (plugin)');
  for (const { agent, files } of AGENT_HOOK_FILES) {
    for (const f of files(home)) {
      if (await mentions(f)) {
        wired.push(agent);
        break;
      }
    }
  }

  // The ARP-680 trap: a PROJECT-scoped CC hook (in this repo's .claude/) is blind in git
  // worktrees + every other repo. Flag it when present here but NOT wired user-globally.
  const projectScoped =
    (await mentions(join(cwd, '.claude', 'settings.json'))) ||
    (await mentions(join(cwd, '.claude', 'settings.local.json')));
  const userScopedCC = asPlugin || (await mentions(join(home, '.claude', 'settings.json')));

  const uniqueWired = Array.from(new Set(wired));
  if (projectScoped && !userScopedCC) {
    return {
      key: 'hook',
      label: 'Capture hook',
      status: 'warn',
      detail:
        'PROJECT-scoped only — blind in git worktrees + other repos (ARP-680). ' +
        'Re-run `backthread install` for the user-scope hook.',
    };
  }
  if (uniqueWired.length > 0) {
    return { key: 'hook', label: 'Capture hook', status: 'ok', detail: `wired for ${uniqueWired.join(', ')}` };
  }
  return {
    key: 'hook',
    label: 'Capture hook',
    status: 'warn',
    detail: 'not detected — run `backthread install` here (or `backthread install --agent <codex|cursor|gemini>`)',
  };
}

async function connectivityCheck(deps: DoctorDeps, env: NodeJS.ProcessEnv): Promise<Check> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeout = deps.connectTimeoutMs ?? 5000;
  const targets: Array<{ name: string; url: string }> = [
    { name: 'worker', url: workerBaseUrl(env) },
    { name: 'functions', url: functionsBaseUrl(env) },
  ];

  const results = await Promise.all(
    targets.map(async ({ name, url }) => {
      // Own AbortController (not AbortSignal.timeout) so the timer is CLEARED on success —
      // no pending 5s timer lingering after the check resolves.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        // ANY HTTP response (even 401/404) proves the origin is reachable. Only a thrown
        // fetch (DNS/network/timeout) is "unreachable". GET (not HEAD) — some gateways 405 HEAD.
        const res = await doFetch(url, { method: 'GET', signal: controller.signal });
        // Drain the body so the socket is freed immediately (we only needed the status line).
        await res.body?.cancel?.().catch(() => {});
        return { name, reachable: true };
      } catch {
        return { name, reachable: false };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const down = results.filter((r) => !r.reachable).map((r) => r.name);
  if (down.length === 0) {
    return { key: 'connectivity', label: 'Connectivity', status: 'ok', detail: 'worker + functions reachable' };
  }
  return {
    key: 'connectivity',
    label: 'Connectivity',
    status: 'warn',
    detail: `couldn't reach ${down.join(' + ')} (offline, or blocked by a proxy/firewall?)`,
  };
}

async function versionCheck(deps: DoctorDeps): Promise<Check> {
  const current = cliVersion();
  const redact = redactVersion();
  const base = `backthread ${current} · redact ${redact}`;
  const runNpm = deps.runNpm ?? realRunNpm;
  const view = await runNpm(['view', 'backthread', 'version']);
  if (!view.ok || !SEMVER_RE.test(view.stdout)) {
    return { key: 'version', label: 'Version', status: 'info', detail: `${base} (couldn't check npm for the latest — offline?)` };
  }
  const latest = view.stdout;
  if (current === latest) {
    return { key: 'version', label: 'Version', status: 'ok', detail: `${base} (latest)` };
  }
  return { key: 'version', label: 'Version', status: 'info', detail: `${base} — update available (${latest}): \`backthread update\`` };
}

// --- orchestration + formatting ----------------------------------------------

/** Run every check. Order is stable (matches the report). Never throws. */
export async function collectChecks(deps: DoctorDeps = {}): Promise<Check[]> {
  const env = deps.env ?? process.env;
  // Read the config ONCE, shared by auth + repo. Perms is a stat, hook is local file reads,
  // connectivity + version hit the network — run the async checks concurrently, then present
  // everything in a fixed order.
  const loaded = await loadConfig(env);
  const [perms, hook, connectivity, version] = await Promise.all([
    permsCheck(deps, env),
    hookCheck(deps, env),
    connectivityCheck(deps, env),
    versionCheck(deps),
  ]);
  return [authCheck(loaded, env), perms, repoCheck(loaded), hook, connectivity, version];
}

const GLYPH: Record<CheckStatus, string> = { ok: '✓', fail: '✗', warn: '⚠', info: 'ℹ' };

/** Render the checks as an aligned ✓/✗/⚠/ℹ report + a one-line summary. Pure. */
export function formatReport(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines = checks.map((c) => `${GLYPH[c.status]} ${c.label.padEnd(width)}  ${c.detail}`);
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  let summary: string;
  if (fails > 0) summary = `\n${fails} issue${fails === 1 ? '' : 's'} to fix — see the ✗ above, then re-run \`backthread doctor\`.`;
  else if (warns > 0) summary = `\nMostly good — the ⚠ above are worth a look but capture can still run.`;
  else summary = `\nAll good — Backthread is set up. 🧵`;
  return ['backthread doctor\n', ...lines, summary].join('\n');
}

export interface DoctorResult {
  text: string;
  exitCode: number;
  checks: Check[];
}

/**
 * Run `backthread doctor`. Returns the formatted report + an exit code (non-zero iff a
 * CRITICAL check failed). The dispatcher prints `text` and returns `exitCode`. Never throws
 * — a check that blows up is captured as a failing/warning line, not an unhandled error.
 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorResult> {
  const checks = await collectChecks(deps);
  const exitCode = checks.some((c) => c.status === 'fail' && c.critical) ? 1 : 0;
  return { text: formatReport(checks), exitCode, checks };
}

// --- small helpers -----------------------------------------------------------

function octal(mode: number): string {
  return '0' + mode.toString(8).padStart(3, '0');
}

function configHint(env: NodeJS.ProcessEnv): string {
  return env.BACKTHREAD_CONFIG_DIR ? configPath(env) : '~/.backthread/config.json';
}
