// Shared Elixir framework-analysis accessors — the analogue of
// framework/python/py-ast.ts and framework/ruby/ruby-ast.ts. Where those drive a
// real parser (Pyright / Prism), Elixir has no install-free parser, so these
// accessors are thin, line-oriented readers over the SAME hand-rolled scanner the
// import extractor uses (graph/elixir-scan.ts) — reusing its heredoc-aware line
// splitting so a directive/macro-looking line inside a `@doc` is never misread.
//
// The framework adapters (Phoenix, Ecto, Oban, …) consume these to recognize their
// DSL: a `use Ecto.Schema` / `use Phoenix.Controller` directive, a `schema "table"`
// / `has_many :posts` / `get "/", …` macro call, a `@behaviour` attribute, etc.

import { sourceLines, scanModuleDefs, scanDirectives } from '../../graph/elixir-scan.js';

export { scanModuleDefs, scanDirectives };
export type { ElixirDirective } from '../../graph/elixir-scan.js';

/** A `use` directive: `use MyAppWeb, :controller` → { module: 'MyAppWeb', args: ':controller' }. */
export interface ElixirUse {
  module: string;
  /** The raw text after the module + comma (`:controller`, `otp_app: :my_app`), or ''. */
  args: string;
}

/** A top-level DSL macro invocation: `has_many :posts, Post` → { name, args }. */
export interface ElixirMacroCall {
  name: string;
  /** The raw text after the macro name (`:posts, Post`, `"users" do`), trimmed. */
  args: string;
}

/** A module attribute: `@behaviour Oban.Worker` → { name: 'behaviour', value: 'Oban.Worker' }. */
export interface ElixirModuleAttribute {
  name: string;
  value: string;
}

/** A function/macro definition: `def create(params)` → { kind: 'def', name: 'create' }. */
export interface ElixirDef {
  kind: 'def' | 'defp' | 'defmacro' | 'defmacrop';
  name: string;
}

const USE_RE = /^\s*use\s+([A-Z][A-Za-z0-9_.]*)\b(.*)$/;
const ATTR_RE = /^\s*@([a-z_][A-Za-z0-9_]*)\s+(.+?)\s*$/;
const DEF_RE = /^\s*(defp?|defmacrop?)\s+([a-z_][A-Za-z0-9_]*[!?]?)/;
const CALL_RE = /^\s*([a-z_][A-Za-z0-9_]*[!?]?)\s+(\S.*?)\s*$/;

// Line-leading lowercase keywords that look like a macro call but are language
// constructs / directives / definitions — never a framework DSL macro.
const NON_MACRO = new Set<string>([
  'def',
  'defp',
  'defmacro',
  'defmacrop',
  'defmodule',
  'defstruct',
  'defprotocol',
  'defimpl',
  'defdelegate',
  'defexception',
  'defguard',
  'defguardp',
  'defoverridable',
  'alias',
  'import',
  'require',
  'use',
  'if',
  'unless',
  'case',
  'cond',
  'with',
  'for',
  'fn',
  'quote',
  'unquote',
  'receive',
  'try',
  'do',
  'end',
  'else',
  'after',
  'catch',
  'rescue',
  'raise',
  'throw',
  'when',
]);

/** The primary (first) module a file defines, or undefined. */
export function moduleName(text: string): string | undefined {
  return scanModuleDefs(text)[0];
}

/** Every module a file defines. */
export function moduleNames(text: string): string[] {
  return scanModuleDefs(text);
}

/** More opening than closing brackets/braces/parens → the expression continues. */
function hasUnclosedBracket(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  return depth > 0;
}

/**
 * The `use` directives in a file, with their trailing args. Handles the idiomatic
 * MULTI-LINE option list (`use Ecto.Repo,\n  otp_app: :app` / a wrapped
 * `producer: [ … ]`): when the option list clearly continues — a trailing comma or
 * an unclosed bracket — following lines are joined before the args are read.
 * Single-line directives are unchanged.
 */
export function useDirectives(text: string): ElixirUse[] {
  const lines = sourceLines(text);
  const out: ElixirUse[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(USE_RE);
    if (!m) continue;
    let rest = m[2].trim();
    while (i + 1 < lines.length && (rest.endsWith(',') || hasUnclosedBracket(rest))) {
      rest = `${rest} ${lines[i + 1].trim()}`.trim();
      i++;
    }
    const args = rest.startsWith(',') ? rest.slice(1).trim() : rest;
    out.push({ module: m[1], args });
  }
  return out;
}

/** The `@attr value` module attributes in a file. */
export function moduleAttributes(text: string): ElixirModuleAttribute[] {
  const out: ElixirModuleAttribute[] = [];
  for (const line of sourceLines(text)) {
    const m = line.match(ATTR_RE);
    if (m) out.push({ name: m[1], value: m[2].trim() });
  }
  return out;
}

/** The `def`/`defp`/`defmacro`/`defmacrop` definitions in a file. */
export function defCalls(text: string): ElixirDef[] {
  const out: ElixirDef[] = [];
  for (const line of sourceLines(text)) {
    const m = line.match(DEF_RE);
    if (m) out.push({ kind: m[1] as ElixirDef['kind'], name: m[2] });
  }
  return out;
}

/**
 * Top-level DSL macro invocations — a line-leading lowercase identifier followed by
 * args that is NOT a language construct/directive/definition/attribute. Adapters
 * filter by macro name (`schema`, `has_many`, `get`, `plug`, `field`, …). Best-
 * effort: it can't tell a genuine DSL macro from a bare top-level function call, so
 * adapters must match the names they care about rather than trust every entry.
 */
export function macroCalls(text: string): ElixirMacroCall[] {
  const out: ElixirMacroCall[] = [];
  for (const line of sourceLines(text)) {
    if (/^\s*@/.test(line)) continue; // module attribute, not a macro call
    const m = line.match(CALL_RE);
    if (!m) continue;
    const name = m[1];
    if (NON_MACRO.has(name)) continue;
    // Trim obvious non-DSL noise: an assignment / pipe / operator continuation
    // (`x = 1`, `conn |> foo`, `a <> b`) is not a macro call. A real DSL macro's
    // args start with a literal/atom/module (`:posts`, `"users" do`, `Post`).
    if (/^[=|<>&.]/.test(m[2])) continue;
    out.push({ name, args: m[2] });
  }
  return out;
}
