// localRefresh.ts — spawn a DETACHED, fire-and-forget refresh of the repo-local
// cache (the two-tier grep-hook's data): `backthread sync` (the merged decision
// "why") + `backthread graph` (the structural graph).
//
// WHY detached: the SessionStart hook that triggers this is SYNCHRONOUS (Claude
// Code reads its stdout for the injected context), and both refreshes are slow —
// `sync` does a network read, `graph` loads the (heavy) extractor. Running them
// inline would block every session start. So we re-spawn them as detached,
// unref'd, stdio-ignored children that outlive this process and update the cache
// in the background for the session's greps to use. Mirrors the capture hook's
// detach pattern (fromHook.ts).
//
// FAIL-SOFT: a failed/absent spawn degrades to "no refresh this time" (the cache
// keeps its prior contents; the next session retries). NEVER throws.

import { spawn } from 'node:child_process';

export interface SpawnRefreshDeps {
  /** Test seam: the spawner. Defaults to child_process.spawn. */
  spawnImpl?: typeof spawn;
  /** Test seam: argv[0] (the node executable). Defaults to process.execPath. */
  execPath?: string;
  /** Test seam: argv[1] (this bin/bundle). Defaults to process.argv[1]. */
  scriptPath?: string;
  /** Env for the children. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn detached `sync` + `graph` children against `cwd` to refresh the repo-local
 * cache in the background. Each is fully decoupled (own group, stdio ignored,
 * unref'd) so it survives the host CLI exiting. Returns whether at least one child
 * was launched (for tests/logs). NEVER throws.
 */
export function spawnCacheRefresh(cwd: string, deps: SpawnRefreshDeps = {}): boolean {
  const doSpawn = deps.spawnImpl ?? spawn;
  const execPath = deps.execPath ?? process.execPath;
  const scriptPath = deps.scriptPath ?? process.argv[1];
  const env = deps.env ?? process.env;
  if (!scriptPath) return false; // can't locate the bin to re-exec → no-op

  let launched = false;
  for (const args of [
    ['sync', '--cwd', cwd],
    ['graph', '--cwd', cwd],
  ]) {
    try {
      const child = doSpawn(execPath, [scriptPath, ...args], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.unref();
      child.on?.('error', () => {}); // swallow a late spawn error (ENOENT, …)
      launched = true;
    } catch {
      /* synchronous spawn failure (bad path, EAGAIN, …) — skip this one */
    }
  }
  return launched;
}
