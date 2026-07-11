// Supabase config + migration + source-usage parsers.
//
// All pure (string/regex in, data out) and dependency-free — the same vitest
// invariant as classify/env-vars.ts and the CF parser: unit-testable without
// the Supabase/Anthropic import chain.
//
// Three deterministic signals feed the adapter:
//   1. supabase/migrations/*.sql  → the table inventory (CREATE TABLE names)
//   2. source `.from('table')`    → app→datastore read/write edges, with the
//                                    operation verb inferred from the chain
//   3. source auth/storage/realtime usage → which managed sub-services are
//      actually used (evidence-gated, so we never hallucinate a sub-service)

/** Table names declared by a migration SQL file (public-schema CREATE TABLE). */
export function parseTableNames(sql: string): string[] {
  const tables = new Set<string>();
  // Strip SQL comments first (PR #9 review): a `-- create table foo` line or a
  // `/* … */` block must not register a phantom table.
  const src = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  // create [ [global] temp|temporary | unlogged ] table [if not exists]
  //   [schema.]name — schema and name may be double-quoted, and a quoted name
  //   can contain non-word chars (e.g. "my-orders"), so capture the quoted and
  //   bare forms separately instead of the old loose `"?(\w+)"?` (which dropped
  //   everything after the first hyphen and missed temp/unlogged tables).
  const re =
    /create\s+(?:(?:global\s+)?(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:(?:"([^"]+)"|(\w+))\s*\.\s*)?(?:"([^"]+)"|(\w+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const schema = m[1] ?? m[2];
    const name = m[3] ?? m[4];
    if (!name) continue;
    // Skip non-public schemas (auth.*, storage.*, realtime.*) — those are
    // Supabase-internal, not the app's own tables.
    if (schema && schema !== 'public') continue;
    tables.add(name);
  }
  return [...tables].sort();
}

export interface TableRef {
  /** repo-relative posix path of the file the reference was found in. */
  file: string;
  table: string;
  op: 'reads' | 'writes';
}

export interface SupabaseUsage {
  tableRefs: TableRef[];
  usesAuth: boolean;
  usesStorage: boolean;
  usesRealtime: boolean;
}

const WRITE_OPS = /\.(insert|update|upsert|delete)\s*\(/;

/**
 * Pure scan of one source file's text for Supabase usage. `file` is the
 * repo-relative posix path stamped onto each TableRef (so the assemble join can
 * resolve it to a code module via fileModuleMap).
 */
export function parseSupabaseUsage(content: string, file: string): SupabaseUsage {
  const tableRefs: TableRef[] = [];
  // `.from('table')` — but NOT `.storage.from('bucket')` (a storage bucket, not
  // a DB table), and NOT JS built-ins that also expose a string-arg `.from`
  // (Array.from('abc'), Buffer.from(...), typed-array `.from`, etc.). The old
  // code only excluded `storage`, so `Array.from('abc')` produced a phantom
  // table `abc` (PR #9 review). We skip when the receiver token is one of these.
  const re = /\.from\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const NOT_SUPABASE =
    /(?:^|[^A-Za-z0-9_$])(?:storage|Array|Buffer|Object|Promise|Set|Map|Date|String|Number|JSON|Reflect|Int8Array|Uint8Array|Uint8ClampedArray|Int16Array|Uint16Array|Int32Array|Uint32Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array)$/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    // Look back far enough to see the full receiver identifier before `.from`.
    const before = content.slice(Math.max(0, m.index - 24), m.index);
    if (NOT_SUPABASE.test(before)) continue;
    // Infer the operation from THIS `.from(...)` chain only — bound the window
    // at the next `.from(` call (and a 200-char hard cap) so a write op in a
    // later statement doesn't bleed onto this read.
    const tail = content.slice(m.index + m[0].length);
    const nextFrom = tail.search(/\.from\(/);
    const end = m.index + m[0].length + (nextFrom === -1 ? 200 : Math.min(nextFrom, 200));
    const window = content.slice(m.index, end);
    const op: TableRef['op'] = WRITE_OPS.test(window) ? 'writes' : 'reads';
    tableRefs.push({ file, table: m[1], op });
  }
  return {
    tableRefs,
    usesAuth: /\.auth\./.test(content) || /supabase\.auth\b/.test(content),
    usesStorage: /\.storage\./.test(content),
    usesRealtime: /\.channel\s*\(/.test(content) || /\.realtime\b/.test(content),
  };
}

/** Merge per-file usage scans into one repo-level signal (refs deduped). */
export function mergeUsage(scans: SupabaseUsage[]): SupabaseUsage {
  const seen = new Set<string>();
  const tableRefs: TableRef[] = [];
  let usesAuth = false;
  let usesStorage = false;
  let usesRealtime = false;
  for (const s of scans) {
    for (const r of s.tableRefs) {
      const key = `${r.file}\x1f${r.table}\x1f${r.op}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tableRefs.push(r);
    }
    usesAuth ||= s.usesAuth;
    usesStorage ||= s.usesStorage;
    usesRealtime ||= s.usesRealtime;
  }
  return { tableRefs, usesAuth, usesStorage, usesRealtime };
}

export interface SubServiceFlags {
  auth?: boolean;
  storage?: boolean;
  realtime?: boolean;
}

/**
 * Read `[auth]/[storage]/[realtime]` `enabled` flags from a parsed config.toml
 * tree (see parseTomlSubset). A section that's present with no explicit
 * `enabled = false` counts as enabled (Supabase's default).
 */
export function readSubServiceFlags(tree: Record<string, unknown>): SubServiceFlags {
  const flag = (key: string): boolean | undefined => {
    const section = tree[key];
    if (!section || typeof section !== 'object') return undefined;
    const enabled = (section as Record<string, unknown>).enabled;
    return enabled === false ? false : true;
  };
  return { auth: flag('auth'), storage: flag('storage'), realtime: flag('realtime') };
}
