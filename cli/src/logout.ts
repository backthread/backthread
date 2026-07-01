// logout.ts — the `backthread logout` command.
//
// Sign THIS device out: drop the device token from ~/.backthread/config.json while
// KEEPING the rest of the config (repo slug + account), so a later `backthread login`
// re-authorizes this machine in place without re-connecting the repo. A security win on
// shared / handed-down machines — the bearer token is the only sensitive field, and this
// removes it locally in one command.
//
// NOTE (scope): this is a LOCAL sign-out — it removes the token from disk, it does NOT
// revoke it server-side. The confirmation points the user at the web app's "Connected
// devices" list for a true server-side revoke. Best-effort + idempotent: running it with
// no token stored is a clean no-op, not an error.
import { readConfig, writeConfig, configPath, type BackthreadConfig } from './config.js';

export interface LogoutResult {
  ok: boolean;
  /** True iff a token was actually present and removed (vs an already-signed-out no-op). */
  cleared: boolean;
  message: string;
}

/**
 * Clear the device token from the local config, preserving account + repo. Rebuilds the
 * config from the known non-token fields (rather than deleting the key) so no stale token
 * can survive, and writeConfig re-applies chmod 0600. Returns a result; never throws for a
 * missing config (that's just "already signed out").
 */
export async function runLogout(env: NodeJS.ProcessEnv = process.env): Promise<LogoutResult> {
  const cfg = await readConfig(env);
  const where = configLocationHint(env);

  if (!cfg.device_token) {
    return { ok: true, cleared: false, message: `Already signed out — no device token in ${where}.` };
  }

  // Rewrite WITHOUT the token, keeping the repo link + account. Explicit rather than a
  // delete so we can't accidentally carry a stale token field forward.
  const next: BackthreadConfig = {};
  if (cfg.account !== undefined) next.account = cfg.account;
  if (cfg.repo !== undefined) next.repo = cfg.repo;
  await writeConfig(next, env);

  const kept = cfg.repo ? ` (kept your ${cfg.repo} link)` : '';
  return {
    ok: true,
    cleared: true,
    message:
      `Signed out. Removed this device's token from ${where}${kept}.\n` +
      'Revoke it server-side under Account → Connected devices; `backthread login` re-authorizes.',
  };
}

// Human-readable config path for the confirmation, honoring BACKTHREAD_CONFIG_DIR so the
// message is accurate under a test / custom config dir without leaking anything sensitive.
function configLocationHint(env: NodeJS.ProcessEnv): string {
  return env.BACKTHREAD_CONFIG_DIR ? configPath(env) : '~/.backthread/config.json';
}
