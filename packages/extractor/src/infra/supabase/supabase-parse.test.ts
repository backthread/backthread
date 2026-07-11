// Supabase parser tests (pure → no Supabase import chain).

import { describe, it, expect } from '../../testkit.js';
import {
  parseTableNames,
  parseSupabaseUsage,
  mergeUsage,
  readSubServiceFlags,
} from './supabase-parse.js';

describe('parseTableNames', () => {
  it('extracts public-schema CREATE TABLE names, skipping internal schemas', () => {
    const sql = `
      create table public.repos (id uuid primary key);
      CREATE TABLE IF NOT EXISTS snapshots (id text);
      create table "changelog" (id text);
      create table auth.sessions (id uuid);  -- internal, skip
    `;
    expect(parseTableNames(sql)).toEqual(['changelog', 'repos', 'snapshots']);
  });

  it('returns empty for SQL with no tables', () => {
    expect(parseTableNames('create policy x on y;')).toEqual([]);
  });

  it('ignores CREATE TABLE inside SQL comments (PR #9 review)', () => {
    const sql = `
      -- create table orders later
      /* create table archived_invoices ( ... ) */
      create table public.real_table (id uuid);
    `;
    expect(parseTableNames(sql)).toEqual(['real_table']);
  });

  it('captures quoted names with non-word chars and temp/unlogged tables', () => {
    const sql = `
      create table "my-orders" (id uuid);
      create temp table scratch (id int);
      create unlogged table fast_log (id int);
      create global temporary table gtt (id int);
    `;
    expect(parseTableNames(sql)).toEqual(['fast_log', 'gtt', 'my-orders', 'scratch']);
  });
});

describe('parseSupabaseUsage', () => {
  it('captures table reads and writes with the right verb', () => {
    const u = parseSupabaseUsage(
      `await supabase.from('repos').select('*');
       await supabase.from('snapshots').insert({ x: 1 });
       await supabase.from('repos').update({ y: 2 }).eq('id', id);`,
      'src/data.ts',
    );
    expect(u.tableRefs).toContainEqual({ file: 'src/data.ts', table: 'repos', op: 'reads' });
    expect(u.tableRefs).toContainEqual({ file: 'src/data.ts', table: 'snapshots', op: 'writes' });
    expect(u.tableRefs).toContainEqual({ file: 'src/data.ts', table: 'repos', op: 'writes' });
  });

  it('does not mistake .storage.from(bucket) for a table', () => {
    const u = parseSupabaseUsage(`supabase.storage.from('avatars').upload(f)`, 'f.ts');
    expect(u.tableRefs).toEqual([]);
    expect(u.usesStorage).toBe(true);
  });

  it('detects auth and realtime usage', () => {
    expect(parseSupabaseUsage(`supabase.auth.getUser()`, 'f.ts').usesAuth).toBe(true);
    expect(parseSupabaseUsage(`supabase.channel('room').subscribe()`, 'f.ts').usesRealtime).toBe(true);
  });

  it('does not mistake JS built-in .from() for a table (PR #9 review)', () => {
    const u = parseSupabaseUsage(
      `const a = Array.from('abc');
       const b = Buffer.from('xyz');
       const rows = await supabase.from('repos').select('*');`,
      'f.ts',
    );
    expect(u.tableRefs).toEqual([{ file: 'f.ts', table: 'repos', op: 'reads' }]);
  });
});

describe('mergeUsage', () => {
  it('dedupes table refs across files and ORs the sub-service flags', () => {
    const merged = mergeUsage([
      { tableRefs: [{ file: 'a.ts', table: 'repos', op: 'reads' }], usesAuth: true, usesStorage: false, usesRealtime: false },
      { tableRefs: [{ file: 'a.ts', table: 'repos', op: 'reads' }], usesAuth: false, usesStorage: false, usesRealtime: true },
    ]);
    expect(merged.tableRefs).toHaveLength(1);
    expect(merged.usesAuth).toBe(true);
    expect(merged.usesRealtime).toBe(true);
  });
});

describe('readSubServiceFlags', () => {
  it('treats a present section as enabled unless explicitly false', () => {
    expect(readSubServiceFlags({ auth: { enabled: true }, storage: { enabled: false }, realtime: {} })).toEqual({
      auth: true,
      storage: false,
      realtime: true,
    });
  });
  it('leaves absent sections undefined', () => {
    expect(readSubServiceFlags({})).toEqual({ auth: undefined, storage: undefined, realtime: undefined });
  });
});
