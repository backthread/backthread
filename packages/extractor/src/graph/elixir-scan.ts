// Pure, hand-rolled SYNTACTIC scanner for Elixir source — the install-free,
// native-dependency-free backbone of the Elixir extractor. It reads the two things
// the import graph needs: the modules a file DEFINES (`defmodule`) and the modules
// it REFERENCES via directives (`alias`/`import`/`require`/`use`, including the
// multi-alias `alias Foo.{Bar, Baz}` sugar). No tree-sitter, no `@ruby/prism`-style
// WASM, no repo-code execution — just deterministic string scanning.
//
// Scanning is LINE-ORIENTED and anchored at the start of a (logical) line: in real
// Elixir, `defmodule`/`alias`/`import`/`require`/`use` are the first token on their
// line. That anchor is what makes a hand-rolled scanner robust — a keyword sitting
// mid-line inside an expression or string is not a directive. Heredoc interiors
// (`"""` / `'''`, e.g. a `@doc` with a code example) are skipped so a directive-
// looking doc line never registers as a real directive.
//
// KNOWN v1 degrades (documented, accepted): fully-qualified inline references
// (`MyApp.Accounts.get_user(id)` with no alias) are NOT edges — only the four
// directives are; and a `defmodule` nested with a RELATIVE name registers under the
// written name, not the parent-qualified one (rare). Both are fine for the import
// backbone; call edges are out of scope for v1.

export type ElixirDirectiveKeyword = 'alias' | 'import' | 'require' | 'use';

export interface ElixirDirective {
  keyword: ElixirDirectiveKeyword;
  /** Fully-qualified module names this directive references (multi-alias expanded). */
  targets: string[];
}

const DEFMODULE_RE = /^\s*defmodule\s+([A-Z][A-Za-z0-9_.]*)/;
const DIRECTIVE_RE = /^\s*(alias|import|require|use)\s+(.+)$/;
// A leading fully-qualified module path: `Foo`, `Foo.Bar`, `Foo.Bar.Baz`.
const MODULE_HEAD_RE = /^([A-Z][A-Za-z0-9_.]*)/;

/**
 * Physical lines with heredoc interiors removed. A line that opens a `"""` / `'''`
 * heredoc (an odd count of the delimiter) starts a skip that runs until the
 * closing delimiter line; the opening line keeps only its pre-delimiter text. This
 * prevents a directive-looking line inside a `@doc`/`@moduledoc` code example from
 * being read as a real directive. Cheap + deterministic; never throws.
 */
export function sourceLines(text: string): string[] {
  return preprocessLines(text);
}
function preprocessLines(text: string): string[] {
  const raw = text.split('\n');
  const out: string[] = [];
  let inHeredoc = false;
  let delim = '';
  for (let line of raw) {
    if (inHeredoc) {
      if (line.includes(delim)) inHeredoc = false;
      out.push(''); // keep line indices stable; interior contributes nothing
      continue;
    }
    const open = line.match(/"""|'''/);
    if (open) {
      const d = open[0];
      const count = line.split(d).length - 1;
      if (count % 2 === 1) {
        inHeredoc = true;
        delim = d;
        line = line.slice(0, line.indexOf(d));
      }
    }
    out.push(line);
  }
  return out;
}

/** All module names `defmodule`-defined in `text`, in source order. */
export function scanModuleDefs(text: string): string[] {
  const names: string[] = [];
  for (const line of preprocessLines(text)) {
    const m = line.match(DEFMODULE_RE);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Expand a directive's target expression into fully-qualified module names.
 * Handles: a plain module (`Foo.Bar`), a trailing option list (`Foo, as: X` /
 * `Foo, only: [...]` / `Foo, :controller` → just `Foo`), and the multi-alias sugar
 * `Foo.Bar.{Baz, Qux}` → `Foo.Bar.Baz`, `Foo.Bar.Qux` (inner items may themselves
 * be dotted). Returns [] for anything with no leading module (e.g. `__MODULE__`).
 */
export function expandDirectiveTargets(expr: string): string[] {
  const trimmed = expr.trim();
  // Multi-alias: PREFIX.{A, B.C, D}
  const multi = trimmed.match(/^([A-Z][A-Za-z0-9_.]*)\.\{([^}]*)\}/);
  if (multi) {
    const prefix = multi[1];
    return multi[2]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[A-Z][A-Za-z0-9_.]*$/.test(s))
      .map((s) => `${prefix}.${s}`);
  }
  const head = trimmed.match(MODULE_HEAD_RE);
  return head ? [head[1]] : [];
}

/**
 * All `alias`/`import`/`require`/`use` directives in `text`, each with its resolved
 * target module name(s). A directive whose `{`-group spans multiple physical lines
 * (`alias Foo.{\n  Bar,\n  Baz\n}`) is joined before parsing.
 */
export function scanDirectives(text: string): ElixirDirective[] {
  const lines = preprocessLines(text);
  const out: ElixirDirective[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DIRECTIVE_RE);
    if (!m) continue;
    let expr = m[2];
    // Join a multi-line `{...}` group so multi-line aliases resolve fully.
    if (expr.includes('{') && !expr.includes('}')) {
      let j = i + 1;
      while (j < lines.length && !expr.includes('}')) {
        expr += ' ' + lines[j].trim();
        j++;
      }
      i = j - 1;
    }
    const targets = expandDirectiveTargets(expr);
    if (targets.length) out.push({ keyword: m[1] as ElixirDirectiveKeyword, targets });
  }
  return out;
}

/** The top-level (leftmost) segment of a dotted module name. */
export function topNamespace(mod: string): string {
  return mod.split('.')[0];
}

/**
 * The external-node id for a non-internal module reference: its TOP-LEVEL namespace
 * underscore-cased (Elixir packages are snake_case). This collapses a dependency
 * FAMILY to one node — `Phoenix.PubSub`, `Phoenix.LiveView` → `ext:phoenix`;
 * `Ecto.Query`, `Ecto.Changeset` → `ext:ecto`; `ExAws.S3` → `ext:ex_aws` — which is
 * the desired rendering (one box per dependency, not per sub-namespace). The
 * analogue of `pythonExternalIdFor`'s top-level collapse.
 */
export function elixirExternalId(mod: string): { id: string; specifier: string } {
  const pkg = underscore(topNamespace(mod));
  return { id: `ext:${pkg}`, specifier: pkg };
}

/** PascalCase module segment → snake_case package name (`ExAws` → `ex_aws`). */
function underscore(seg: string): string {
  return seg
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}
