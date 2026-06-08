// config.ts — local Backthread CLI config at ~/.backthread/config.json.
//
// This is the credential + identity store the rest of the plugin (hook,
// slash command, MCP) reads. The device token lives here, so the file
// is written at chmod 0600 (owner read/write only) — never logged, never echoed.
//
// Shape (all optional so a partial config is valid — `backthread login` may run before
// a repo is connected; repo-less capture is also supported):
//   {
//     "account":     "<account uuid>"   | undefined,
//     "repo":        "owner/name"        | undefined,   // canonical repo slug
//     "device_token":"backthread_pat_…"          | undefined    // the device token
//   }
//
// Pure-ish: the path helpers + (de)serialization are unit-tested by pointing
// BACKTHREAD_CONFIG_DIR at a temp dir, so no real $HOME is touched in tests.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';

// Owner-only read/write. The device token is a bearer credential, so the file
// must never be group/world readable. 0o600 = rw-------.
export const CONFIG_MODE = 0o600;
export const DIR_MODE = 0o700;

export interface BackthreadConfig {
  /** Account UUID the device token is scoped to. */
  account?: string;
  /** Canonical repo slug `owner/name` (set on connect; may be absent — Thread A). */
  repo?: string;
  /** The `backthread_pat_…` device token. Bearer credential — never log this. */
  device_token?: string;
}

// The config directory. Overridable via BACKTHREAD_CONFIG_DIR so tests (and CI) never
// touch the real ~/.backthread. Defaults to ~/.backthread.
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BACKTHREAD_CONFIG_DIR;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), '.backthread');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'config.json');
}

// Parse a config blob defensively: anything that isn't a JSON object yields an
// empty config rather than throwing (a hand-corrupted file shouldn't brick the
// CLI — the user can just `backthread login` again). Unknown fields are dropped.
export function parseConfig(raw: string): BackthreadConfig {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const rec = obj as Record<string, unknown>;
  const out: BackthreadConfig = {};
  if (typeof rec.account === 'string' && rec.account.length > 0) out.account = rec.account;
  if (typeof rec.repo === 'string' && rec.repo.length > 0) out.repo = rec.repo;
  if (typeof rec.device_token === 'string' && rec.device_token.length > 0) {
    out.device_token = rec.device_token;
  }
  return out;
}

// Serialize a config to the on-disk form (stable key order, trailing newline).
export function serializeConfig(config: BackthreadConfig): string {
  // Only persist known keys, in a stable order.
  const ordered: BackthreadConfig = {};
  if (config.account !== undefined) ordered.account = config.account;
  if (config.repo !== undefined) ordered.repo = config.repo;
  if (config.device_token !== undefined) ordered.device_token = config.device_token;
  return JSON.stringify(ordered, null, 2) + '\n';
}

// Read the config from disk. A missing file is not an error — it yields an empty
// config (the user simply hasn't logged in yet).
export async function readConfig(env: NodeJS.ProcessEnv = process.env): Promise<BackthreadConfig> {
  try {
    const raw = await readFile(configPath(env), 'utf8');
    return parseConfig(raw);
  } catch (err) {
    if (isNotFound(err)) return {};
    throw err;
  }
}

// Write the config to disk at chmod 0600, creating ~/.backthread at 0700 if needed.
// The directory is created first so the file lands in a private dir even for the
// brief moment before its own mode is set. We chmod explicitly after write
// because the process umask can otherwise widen the create mode.
export async function writeConfig(
  config: BackthreadConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // Best-effort tighten the dir even if it pre-existed with a looser mode.
  await chmod(dir, DIR_MODE).catch(() => {});
  const path = configPath(env);
  await writeFile(path, serializeConfig(config), { mode: CONFIG_MODE });
  // Enforce 0600 even if the file pre-existed (writeFile's mode only applies on
  // create) or the umask widened it.
  await chmod(path, CONFIG_MODE);
}

// Merge a patch into the existing config and persist. Read-modify-write so a
// `backthread login` that only sets device_token + account doesn't clobber a repo slug
// some other command wrote.
export async function updateConfig(
  patch: Partial<BackthreadConfig>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BackthreadConfig> {
  const current = await readConfig(env);
  const next: BackthreadConfig = { ...current, ...patch };
  await writeConfig(next, env);
  return next;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
