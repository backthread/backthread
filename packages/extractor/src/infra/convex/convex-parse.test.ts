// Convex parser tests (pure: string in, data out).

import { describe, it, expect } from '../../testkit.js';
import { parseConvexSchema, parseConvexFunctionsDir, usesConvexDb } from './convex-parse.js';

const SCHEMA = `
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    body: v.string(),
    author: v.id("users"),
  }).index("by_author", ["author"]),
  users: defineTable({ name: v.string(), email: v.string() }),
  "audit-log": defineTable({ at: v.number() }),
});
`;

describe('parseConvexSchema', () => {
  it('extracts table names from defineTable keys (bare + quoted), sorted + deduped', () => {
    expect(parseConvexSchema(SCHEMA)).toEqual(['audit-log', 'messages', 'users']);
  });

  it('a schemaless source (no defineTable) yields no tables', () => {
    expect(parseConvexSchema('export const noop = 1;')).toEqual([]);
  });

  it('ignores a commented-out defineTable (no phantom table)', () => {
    const src = `export default defineSchema({\n  // ghosts: defineTable({}),\n  real: defineTable({}),\n});`;
    expect(parseConvexSchema(src)).toEqual(['real']);
  });

  it('does not match a key whose VALUE merely mentions defineTable in a string', () => {
    const src = `export default defineSchema({ note: "see defineTable(docs)" });`;
    expect(parseConvexSchema(src)).toEqual([]);
  });
});

describe('parseConvexFunctionsDir', () => {
  it('reads the functions key, normalized (no trailing slash / leading ./)', () => {
    expect(parseConvexFunctionsDir('{"functions":"./src/convex/"}')).toBe('src/convex');
    expect(parseConvexFunctionsDir('{"functions":"convex"}')).toBe('convex');
  });

  it('returns undefined when functions is absent, blank, or non-string', () => {
    expect(parseConvexFunctionsDir('{}')).toBeUndefined();
    expect(parseConvexFunctionsDir('{"functions":""}')).toBeUndefined();
    expect(parseConvexFunctionsDir('{"functions":42}')).toBeUndefined();
  });

  it('returns undefined for unparseable JSON (never throws)', () => {
    expect(parseConvexFunctionsDir('{not json')).toBeUndefined();
  });

  it('a PRESENT functions key of "." / "./" normalizes to the repo root ("") — not undefined', () => {
    // Distinct from "absent": the worker still renders, and the repo-root guard
    // drops its sourceRoots (no catch-all).
    expect(parseConvexFunctionsDir('{"functions":"."}')).toBe('');
    expect(parseConvexFunctionsDir('{"functions":"./"}')).toBe('');
  });
});

describe('usesConvexDb', () => {
  it('detects ctx.db usage', () => {
    expect(usesConvexDb('export const f = query(async (ctx) => ctx.db.query("m").collect());')).toBe(true);
  });

  it('detects a destructured db handle', () => {
    expect(usesConvexDb('const { db } = ctx; await db.insert("users", {});')).toBe(true);
  });

  it('returns false for a function that never touches the db', () => {
    expect(usesConvexDb('export const ping = action(async () => fetch("https://x"));')).toBe(false);
  });

  it('ignores ctx.db inside a comment', () => {
    expect(usesConvexDb('// historically used ctx.db here\nexport const f = 1;')).toBe(false);
  });
});
