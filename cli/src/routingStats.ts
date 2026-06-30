// routingStats.ts — the local "routing offered" counter (ARP-763 measurement half).
//
// Routing hit-rate = how often Claude reaches for `query` unprompted. The CONVERSION
// half (query CALLS) is already measured SERVER-SIDE: each grounded-ask writes a
// grounded_ask_logs row stamped with the client-meta headers (version/agent/platform,
// ARP-731→735/766). This file is the OPPORTUNITY half: a tiny local counter the
// SessionStart hook bumps each time it injects the routing instruction. Pairing the
// local injected-count with the server-side query-count over a window gives the
// founder a real hit-rate read on their own dogfood — no new server endpoint, no
// network call on the (synchronous, must-stay-fast) SessionStart path.
//
// BEST-EFFORT (load-bearing): the SessionStart hook must always exit 0 fast, so
// nothing here may throw or block meaningfully. A missing/corrupt/unwritable stats
// file degrades to "don't count" — never crashing, never delaying session start.

import { join } from 'node:path';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { configDir, CONFIG_MODE, DIR_MODE } from './config.js';

const STATS_FILE = 'routing-stats.json';

export interface RoutingStats {
  /** How many sessions had the routing instruction injected (the opportunity count). */
  injected: number;
  /** ISO timestamp of the most recent injection. */
  lastInjectedAt?: string;
}

// Narrow call-signatures (not `typeof readFile` etc.) so a test can pass a plain
// async stub without fighting fs/promises' overloads. The real fns are assignable.
export interface RoutingStatsDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  readFileImpl?: (path: string, encoding: 'utf8') => Promise<string>;
  writeFileImpl?: (path: string, data: string, options: { mode: number }) => Promise<void>;
  mkdirImpl?: (path: string, options: { recursive: boolean; mode: number }) => Promise<unknown>;
  chmodImpl?: (path: string, mode: number) => Promise<void>;
}

function statsPath(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), STATS_FILE);
}

/** Read the routing stats; any error (absent/corrupt) → a zeroed default. */
export async function readRoutingStats(deps: RoutingStatsDeps = {}): Promise<RoutingStats> {
  const env = deps.env ?? process.env;
  const read = deps.readFileImpl ?? readFile;
  try {
    const raw = await read(statsPath(env), 'utf8');
    const obj = JSON.parse(raw) as Partial<RoutingStats>;
    return {
      injected: typeof obj.injected === 'number' && obj.injected >= 0 ? Math.floor(obj.injected) : 0,
      lastInjectedAt: typeof obj.lastInjectedAt === 'string' ? obj.lastInjectedAt : undefined,
    };
  } catch {
    return { injected: 0 };
  }
}

/**
 * Increment the injected counter (read-modify-write). BEST-EFFORT: returns silently
 * on any failure so the SessionStart hook never crashes or stalls. A rare concurrent
 * same-instant write could lose one increment — accepted (a hit-rate signal doesn't
 * need exactness, and locking a courtesy counter isn't worth it; mirrors connectNudge).
 */
export async function recordRoutingInjected(deps: RoutingStatsDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const write = deps.writeFileImpl ?? writeFile;
  const mkdirp = deps.mkdirImpl ?? mkdir;
  const chmodp = deps.chmodImpl ?? chmod;
  try {
    const prev = await readRoutingStats(deps);
    const next: RoutingStats = { injected: prev.injected + 1, lastInjectedAt: now().toISOString() };
    await mkdirp(configDir(env), { recursive: true, mode: DIR_MODE });
    await write(statsPath(env), `${JSON.stringify(next, null, 2)}\n`, { mode: CONFIG_MODE });
    await chmodp(statsPath(env), CONFIG_MODE).catch(() => {});
  } catch {
    /* best-effort — never throw */
  }
}
