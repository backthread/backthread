// installAgent.ts — `backthread install --agent <codex|cursor|gemini>`: write the
// agent's USER-GLOBAL MCP-server config + session-end capture hook, idempotently.
//
// WHY user-global (load-bearing, ARP-680): a per-PROJECT hook (e.g. <repo>/.cursor/
// hooks.json) is absent in git worktrees + every other repo, so capture silently
// never fires there — the exact bug that froze the dogfood log for a week. An
// installed plugin/extension registers globally; these manual writers must do the
// same, so they target ~/.<agent>/ (the user scope), never the project directory.
//
// Each writer MERGES (never clobbers): it reads the existing config, adds our entry
// only if absent, preserves everything else, and writes back. Re-running is a no-op.
// The MCP server + hook both invoke the published CLI via `npx -y backthread` (the
// 8A.8 spike's shape for non-CC agents — no bundled-binary pattern). The hook routes
// through the shared `--from-hook` entrypoint (per-agent payload via --agent) +
// --detach (so a slow/awaited hook never blocks the agent; the shared entrypoint
// dedupes per session, since Codex/Cursor stop fire per turn).
//
// The hosted query MCP (ARP-480) is NOT wired here: it needs a per-user device
// token, which can't be baked into a shared config — the LOCAL stdio `backthread
// mcp` reads the user's ~/.backthread token instead. Auth is a separate `backthread
// login` (the claim-code handoff threads it through `install`).
//
// CONFIG SHAPES are from the ARP-481 spike (verified against each agent's docs).
// Cursor's stop payload / hooks.json shape is confirmed-pending a live install
// (ARP-507) — flagged where used.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const execFileP = promisify(execFile);

export type InstallAgent = 'codex' | 'cursor' | 'gemini';
export const INSTALL_AGENTS: readonly InstallAgent[] = ['codex', 'cursor', 'gemini'];

// The MCP stdio server every writer registers: the published CLI's `mcp` subcommand.
const MCP_COMMAND = 'npx';
const MCP_ARGS: readonly string[] = ['-y', 'backthread', 'mcp'];

/** The session-end/stop hook command for an agent (routes through the shared entrypoint). */
export function hookCommand(agent: string): string {
  return `npx -y backthread capture --from-hook --agent ${agent} --detach`;
}

// Minimum agent versions that support the hooks engine (spike ARP-481). Below these
// we WARN (not hard-block): a too-old agent ignores the hook config, but the MCP
// server still works, and we can't reliably detect every version — so we never
// refuse to write, we just tell the user to upgrade.
const MIN_VERSION: Record<InstallAgent, string> = {
  codex: '0.124.0',
  cursor: '1.7.0',
  gemini: '0.26.0',
};

// The binary we probe for `--version` per agent. Cursor's CLI is `cursor-agent`
// (confirmed-pending ARP-507); a missing binary just skips the version gate.
const VERSION_BIN: Record<InstallAgent, string> = {
  codex: 'codex',
  cursor: 'cursor-agent',
  gemini: 'gemini',
};

export interface AgentInstallDeps {
  /** Home dir override (tests). Defaults to os.homedir(). */
  home?: string;
  readFileImpl?: (p: string) => Promise<string>;
  writeFileImpl?: (p: string, d: string) => Promise<void>;
  mkdirImpl?: (d: string) => Promise<void>;
  /** Test seam: the version probe. Defaults to running `<bin> --version`. */
  probeVersionImpl?: (agent: InstallAgent) => Promise<string | null>;
}

export interface AgentFileWrite {
  path: string;
  /** true = we wrote a change; false = already present (idempotent no-op). */
  wrote: boolean;
}

export interface AgentInstallResult {
  agent: InstallAgent;
  /** Every config file we touched (MCP + hook), with whether a change was written. */
  writes: AgentFileWrite[];
  /** A "please upgrade <agent>" message when a too-old version was detected, else null. */
  versionWarning: string | null;
  /** Cursor only: the one-click `cursor://…` MCP-install deeplink (informational). */
  deeplink: string | null;
}

// --- shared JSON config helpers ----------------------------------------------

/**
 * Load a JSON config object: {} on a missing file (ENOENT), the parsed object when
 * valid, and a THROW on a present-but-corrupt / non-object file (never clobber the
 * user's recoverable content — mirrors install.ts registerHook).
 */
async function loadJsonObject(
  readFileImpl: (p: string) => Promise<string>,
  path: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFileImpl(path);
  } catch (e) {
    if (isNotFound(e)) return {};
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} exists but is not valid JSON — refusing to overwrite it. Fix it (or add the config manually) and re-run.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object — refusing to overwrite it. Fix it (or add the config manually) and re-run.`);
  }
  return parsed as Record<string, unknown>;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/** Our MCP server entry — the value under mcpServers.backthread. */
function mcpServerEntry(): Record<string, unknown> {
  return { command: MCP_COMMAND, args: [...MCP_ARGS] };
}

/**
 * Ensure `obj.mcpServers.backthread` is our entry. Returns a NEW settings object +
 * whether it changed. Idempotent: an identical existing entry is a no-op; a stale
 * one is updated to ours (we own that key).
 */
function withMcpServer(settings: Record<string, unknown>): { next: Record<string, unknown>; changed: boolean } {
  const mcpServers = asObject(settings.mcpServers);
  const desired = mcpServerEntry();
  if (JSON.stringify(mcpServers.backthread) === JSON.stringify(desired)) {
    return { next: settings, changed: false };
  }
  mcpServers.backthread = desired;
  return { next: { ...settings, mcpServers }, changed: true };
}

/**
 * Ensure `obj.hooks[event]` contains a CC/Gemini/Codex-shaped command group running
 * `command` (`[{ hooks: [{ type:'command', command, ...extra }] }]`). Appends a fresh
 * group only if no existing group already runs `command` (preserving foreign hooks).
 * Returns a NEW settings object + whether it changed.
 */
function withNestedHook(
  settings: Record<string, unknown>,
  event: string,
  command: string,
  extra: Record<string, unknown> = {},
): { next: Record<string, unknown>; changed: boolean } {
  const hooks = asObject(settings.hooks);
  const list: unknown[] = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  const present = list.some((g) => {
    const inner = (g as { hooks?: unknown })?.hooks;
    return Array.isArray(inner) && inner.some((h) => (h as { command?: unknown })?.command === command);
  });
  if (present) return { next: settings, changed: false };
  list.push({ hooks: [{ type: 'command', command, ...extra }] });
  hooks[event] = list;
  return { next: { ...settings, hooks }, changed: true };
}

async function writeJson(
  deps: AgentInstallDeps,
  path: string,
  obj: Record<string, unknown>,
): Promise<void> {
  const doMkdir = deps.mkdirImpl ?? (async (d: string) => void (await mkdir(d, { recursive: true })));
  const doWrite = deps.writeFileImpl ?? ((p: string, d: string) => writeFile(p, d));
  await doMkdir(dirname(path));
  await doWrite(path, JSON.stringify(obj, null, 2) + '\n');
}

// --- per-agent writers -------------------------------------------------------

/** Gemini: ~/.gemini/settings.json holds BOTH mcpServers + hooks.SessionEnd. */
async function installGemini(home: string, deps: AgentInstallDeps): Promise<AgentFileWrite[]> {
  const doRead = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  const path = join(home, '.gemini', 'settings.json');
  const current = await loadJsonObject(doRead, path);
  const a = withMcpServer(current);
  const b = withNestedHook(a.next, 'SessionEnd', hookCommand('gemini-cli'), { name: 'backthread-capture' });
  if (a.changed || b.changed) await writeJson(deps, path, b.next);
  return [{ path, wrote: a.changed || b.changed }];
}

/** Codex: MCP → ~/.codex/config.toml ([mcp_servers.backthread]); hook → ~/.codex/hooks.json (Stop). */
async function installCodex(home: string, deps: AgentInstallDeps): Promise<AgentFileWrite[]> {
  const doRead = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  const writes: AgentFileWrite[] = [];

  // MCP — append a [mcp_servers.backthread] TOML table at the END (tables are
  // append-safe; the "root keys before tables" gotcha can't bite a trailing table).
  // Idempotent on the literal table header.
  const tomlPath = join(home, '.codex', 'config.toml');
  let toml = '';
  try {
    toml = await doRead(tomlPath);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  if (toml.includes('[mcp_servers.backthread]')) {
    writes.push({ path: tomlPath, wrote: false });
  } else {
    const block = `[mcp_servers.backthread]\ncommand = "${MCP_COMMAND}"\nargs = [${MCP_ARGS.map((a) => `"${a}"`).join(', ')}]\n`;
    const sep = toml.length === 0 ? '' : toml.endsWith('\n') ? '\n' : '\n\n';
    const doMkdir = deps.mkdirImpl ?? (async (d: string) => void (await mkdir(d, { recursive: true })));
    const doWrite = deps.writeFileImpl ?? ((p: string, d: string) => writeFile(p, d));
    await doMkdir(dirname(tomlPath));
    await doWrite(tomlPath, toml + sep + block);
    writes.push({ path: tomlPath, wrote: true });
  }

  // Hook — ~/.codex/hooks.json, Stop event (turn-scope; --detach + dedupe handle it).
  const hooksPath = join(home, '.codex', 'hooks.json');
  const current = await loadJsonObject(doRead, hooksPath);
  const h = withNestedHook(current, 'Stop', hookCommand('codex'), { timeout: 60 });
  if (h.changed) await writeJson(deps, hooksPath, h.next);
  writes.push({ path: hooksPath, wrote: h.changed });
  return writes;
}

/** Cursor: ~/.cursor/mcp.json + ~/.cursor/hooks.json (stop event; flat { command } entries). */
async function installCursor(home: string, deps: AgentInstallDeps): Promise<AgentFileWrite[]> {
  const doRead = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  const writes: AgentFileWrite[] = [];

  // MCP — ~/.cursor/mcp.json: { mcpServers: { backthread: {...} } }.
  const mcpPath = join(home, '.cursor', 'mcp.json');
  const mcpCurrent = await loadJsonObject(doRead, mcpPath);
  const m = withMcpServer(mcpCurrent);
  if (m.changed) await writeJson(deps, mcpPath, m.next);
  writes.push({ path: mcpPath, wrote: m.changed });

  // Hook — ~/.cursor/hooks.json: { version: 1, hooks: { stop: [{ command }] } }. Cursor's
  // entries are FLAT { command } (no nested type/hooks), unlike CC/Gemini/Codex — so
  // it gets its own merge. (Shape confirmed-pending a live Cursor install, ARP-507.)
  const hooksPath = join(home, '.cursor', 'hooks.json');
  const hooksCurrent = await loadJsonObject(doRead, hooksPath);
  const c = withCursorStopHook(hooksCurrent);
  if (c.changed) await writeJson(deps, hooksPath, c.next);
  writes.push({ path: hooksPath, wrote: c.changed });
  return writes;
}

/** Cursor-specific: ensure hooks.stop contains our flat `{ command }` entry; set version:1. */
function withCursorStopHook(settings: Record<string, unknown>): { next: Record<string, unknown>; changed: boolean } {
  const command = hookCommand('cursor');
  const hooks = asObject(settings.hooks);
  const stop: unknown[] = Array.isArray(hooks.stop) ? [...(hooks.stop as unknown[])] : [];
  const present = stop.some((h) => (h as { command?: unknown })?.command === command);
  const versionOk = settings.version === 1;
  if (present && versionOk) return { next: settings, changed: false };
  if (!present) stop.push({ command });
  hooks.stop = stop;
  return { next: { ...settings, version: 1, hooks }, changed: true };
}

// --- the Cursor deeplink -----------------------------------------------------

/** The one-click Cursor MCP-install deeplink (the website/app can render this). */
export function cursorDeeplink(): string {
  const config = Buffer.from(JSON.stringify(mcpServerEntry())).toString('base64');
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=backthread&config=${config}`;
}

// --- version gate ------------------------------------------------------------

function parseSemver(s: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isBelow(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** Best-effort: run `<bin> --version`, return the raw output, or null on any failure. */
async function probeVersion(agent: InstallAgent): Promise<string | null> {
  try {
    const { stdout } = await execFileP(VERSION_BIN[agent], ['--version'], { timeout: 3000 });
    return stdout?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Decide a version warning: null when we can't detect (proceed silently) or the
 * version is fine; a "please upgrade" string when a detected version is below the
 * hooks floor. Never throws — the gate must never block a write.
 */
async function versionGate(agent: InstallAgent, deps: AgentInstallDeps): Promise<string | null> {
  const probe = deps.probeVersionImpl ?? probeVersion;
  const raw = await probe(agent).catch(() => null);
  if (!raw) return null;
  const got = parseSemver(raw);
  const min = parseSemver(MIN_VERSION[agent])!;
  if (got && isBelow(got, min)) {
    return `Detected ${agent} ${got.join('.')}, but the capture hook needs ${MIN_VERSION[agent]}+. The MCP query tool works now; upgrade ${agent} for auto-capture.`;
  }
  return null;
}

// --- the dispatcher ----------------------------------------------------------

/**
 * Write the per-agent USER-GLOBAL MCP config + capture hook for `agent`, idempotently.
 * Returns every file touched + a version warning + (Cursor) the install deeplink.
 * A corrupt existing config THROWS (never clobbered); the caller reports it.
 */
export async function runInstallAgent(
  agent: InstallAgent,
  deps: AgentInstallDeps = {},
): Promise<AgentInstallResult> {
  const home = deps.home ?? homedir();
  const versionWarning = await versionGate(agent, deps);
  let writes: AgentFileWrite[];
  switch (agent) {
    case 'gemini':
      writes = await installGemini(home, deps);
      break;
    case 'codex':
      writes = await installCodex(home, deps);
      break;
    case 'cursor':
      writes = await installCursor(home, deps);
      break;
  }
  return { agent, writes, versionWarning, deeplink: agent === 'cursor' ? cursorDeeplink() : null };
}

/** Parse a `--agent <x>` value into an InstallAgent, or null (CC path / unknown). */
export function parseInstallAgent(value: string | undefined): InstallAgent | 'claude-code' | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'claude-code' || v === 'claude' || v === 'cc') return 'claude-code';
  if (v === 'gemini' || v === 'gemini-cli') return 'gemini';
  if (v === 'codex' || v === 'cursor') return v;
  return null;
}
