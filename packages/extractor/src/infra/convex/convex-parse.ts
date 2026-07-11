// Convex config + schema + source-usage parsers.
//
// All pure (string in, data out) and dependency-free — the same vitest invariant
// as supabase-parse.ts / compose-parse.ts: unit-testable without the Convex/fs
// import chain. Three deterministic signals feed the adapter:
//   1. convex.json `functions`   → the functions dir (default `convex/`)
//   2. convex/schema.ts          → the table inventory (defineTable keys)
//   3. source `ctx.db` usage     → the function→datastore `stores-in` edge
//      (evidence-gated, like Supabase's `.from()` grep)

/** Strip `//` line comments and `/* … *\/` block comments so a commented
 * `defineTable` / `ctx.db` can't register a phantom table or edge. */
function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Table names declared by a `convex/schema.ts`. Convex schemas are
 *   export default defineSchema({ messages: defineTable({…}), users: defineTable({…}) })
 * so a table is any object KEY whose value is a `defineTable(` call. The key may
 * be a bare identifier or a quoted string. Index/search chaining
 * (`defineTable({…}).index(…)`) doesn't affect the key match. Deterministic,
 * sorted, deduped. Returns [] for a schemaless repo (no schema.ts).
 */
export function parseConvexSchema(source: string): string[] {
  const tables = new Set<string>();
  const src = stripComments(source);
  // key (bare | "quoted" | 'quoted') : defineTable(
  const re = /(?:^|[,{(])\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*defineTable\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name) tables.add(name);
  }
  return [...tables].sort();
}

/**
 * The configured functions dir from a `convex.json`, repo-relative + normalized
 * (no leading `./`, no trailing `/`). Convex's `functions` key overrides the
 * default `convex/` dir. Returns undefined ONLY when the key is absent / blank /
 * unparseable — the caller then falls back to the `convex` convention. A key that
 * is PRESENT but normalizes to the repo root (`"."`, `"./"`) returns '' — an
 * explicit repo-root deploy, distinct from "absent": the caller keeps it (so the
 * worker still renders) and the repo-root guard drops its sourceRoots (no catch-all).
 */
export function parseConvexFunctionsDir(json: string): string | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== 'object') return undefined;
  const fns = (doc as Record<string, unknown>).functions;
  if (typeof fns !== 'string' || !fns.trim()) return undefined;
  return fns.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').replace(/^\.$/, '');
}

/**
 * Does this source file read/write the Convex database? Convex query/mutation
 * functions receive a `ctx` with a `db` handle (`ctx.db.query(...)`,
 * `ctx.db.insert(...)`); some destructure it (`const { db } = ctx`). We gate the
 * function→datastore edge on this evidence so a functions-only-no-data repo
 * doesn't sprout a phantom `stores-in`. Comment-stripped to avoid false hits.
 */
export function usesConvexDb(source: string): boolean {
  const src = stripComments(source);
  if (/\bctx\s*\.\s*db\b/.test(src)) return true;
  // Destructured handle: `db.query(` / `db.insert(` / `db.get(` / …
  return /\bdb\s*\.\s*(?:query|get|insert|patch|replace|delete|normalizeId|system)\s*\(/.test(src);
}
