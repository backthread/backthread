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
// CALL EDGES (v2) — in addition to the directive backbone, the scanner reads inline
// remote calls (`X.fn(...)`, `MyApp.X.fn(...)`, `arg |> X.fn(...)`) so the adapter can
// resolve them to `call` edges. Two helpers back this: `scanAliasScope` (the file's
// `alias` bindings, local-name → fully-qualified module, AMBIGUOUS names dropped) and
// `scanCallSites` (every `Module.function` callee token, strings/comments stripped).
// Resolution stays ACCURACY-FIRST (a wrong call edge teaches a false mental model,
// ARP-325): the adapter emits an edge ONLY when the callee module resolves
// unambiguously — via the alias scope or a literal registry hit — to an in-repo file.
//
// KNOWN degrades (documented, accepted): an UNqualified call (`get_user(id)`, whether
// local or `import`-injected) is not an edge — only qualified `Module.fn` callees are;
// a `defmodule` nested with a RELATIVE name registers under the written name, not the
// parent-qualified one (rare); and a call inside a sigil (`~s`/`~r`) body is not
// stripped, so a `Foo.bar` literal there could register (rare, and only if `Foo` is a
// first-party module).

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

// ---------------------------------------------------------------------------
// Call-edge scanning (v2). The pieces the import backbone never needed: the file's
// `alias` bindings (so a bare `User.fn` resolves to its full module) and the inline
// `Module.fn` callee tokens.

const ALIAS_RE = /^\s*alias\s+(.+)$/;
// A `, as: Local` rename tail on a single `alias`.
const ALIAS_AS_RE = /^([A-Z][A-Za-z0-9_.]*)\s*,\s*as:\s*([A-Z][A-Za-z0-9_]*)/;
// A leading dotted module path (`Foo`, `Foo.Bar.Baz`).
const MODULE_PATH_RE = /^[A-Z][A-Za-z0-9_.]*/;

/** The last (rightmost) segment of a dotted module name (`A.B.C` → `C`). */
function lastSegment(mod: string): string {
  const i = mod.lastIndexOf('.');
  return i >= 0 ? mod.slice(i + 1) : mod;
}

/**
 * The file's `alias` bindings: local reference name → fully-qualified module. Reads
 * ONLY `alias` (the sole directive that renames a module for qualified calls; `import`
 * injects unqualified fns — deliberately not resolved — and `require`/`use` don't
 * rebind). Handles the three forms:
 *   * `alias A.B.C`            → `C` → `A.B.C`
 *   * `alias A.B.C, as: X`     → `X` → `A.B.C`
 *   * `alias A.B.{C, D.E}`     → `C` → `A.B.C`, `E` → `A.B.D.E`
 *
 * A local name that would bind to TWO DIFFERENT modules in the same file (a genuine
 * ambiguity for a whole-file scanner — e.g. `alias A.User` + `alias B.User`) is
 * DROPPED, not last-wins: accuracy over recall (ARP-325). Deterministic; never throws.
 */
export function scanAliasScope(text: string): ReadonlyMap<string, string> {
  const lines = preprocessLines(text);
  const candidates = new Map<string, Set<string>>();
  const bind = (local: string, full: string): void => {
    (candidates.get(local) ?? candidates.set(local, new Set()).get(local)!).add(full);
  };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ALIAS_RE);
    if (!m) continue;
    let expr = m[1];
    // Join a multi-line `{...}` group (`alias Foo.{\n  Bar,\n  Baz\n}`).
    if (expr.includes('{') && !expr.includes('}')) {
      let j = i + 1;
      while (j < lines.length && !expr.includes('}')) {
        expr += ' ' + lines[j].trim();
        j++;
      }
      i = j - 1;
    }
    addAliasBindings(expr.trim(), bind);
  }
  // Keep only unambiguous (single-module) bindings.
  const scope = new Map<string, string>();
  for (const [local, mods] of candidates) {
    if (mods.size === 1) scope.set(local, [...mods][0]);
  }
  return scope;
}

/** Parse ONE `alias` expression into local→module bindings via `bind`. */
function addAliasBindings(expr: string, bind: (local: string, full: string) => void): void {
  // Multi-alias sugar: `PREFIX.{A, B.C}`.
  const multi = expr.match(/^([A-Z][A-Za-z0-9_.]*)\.\{([^}]*)\}/);
  if (multi) {
    const prefix = multi[1];
    for (const raw of multi[2].split(',')) {
      const item = raw.trim();
      if (!/^[A-Z][A-Za-z0-9_.]*$/.test(item)) continue;
      const full = `${prefix}.${item}`;
      bind(lastSegment(full), full);
    }
    return;
  }
  // `MODULE, as: Local`.
  const asMatch = expr.match(ALIAS_AS_RE);
  if (asMatch) {
    bind(asMatch[2], asMatch[1]);
    return;
  }
  // Plain `alias MODULE` — the local name is the module's last segment.
  const head = expr.match(MODULE_PATH_RE);
  if (head) bind(lastSegment(head[0]), head[0]);
}

// A qualified remote call: a dotted PascalCase module path followed by `.fn` (a
// lowercase function name). The negative lookbehind `(?<![\w.])` stops the module
// token being the tail of a longer chain / a variable field access (`conn.User.x`).
// Captures the MODULE path only; the function name is irrelevant to the edge.
const CALL_SITE_RE = /(?<![\w.])([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)\.[a-z_][A-Za-z0-9_]*[!?]?/g;

/**
 * Strip double-quoted strings, single-quoted charlists, and a trailing `#` line
 * comment from one physical line, so a `Foo.bar` inside a string/comment never
 * registers as a call. Strings are removed FIRST, so a `#{...}` interpolation or a
 * `#` inside a string can't be mistaken for a comment start. Best-effort (a sigil
 * body is not stripped — a documented, rare degrade).
 */
function stripStringsAndComments(line: string): string {
  let s = line.replace(/"(?:[^"\\]|\\.)*"/g, '  ').replace(/'(?:[^'\\]|\\.)*'/g, '  ');
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  return s;
}

/**
 * Every inline qualified-call callee MODULE token in `text`, in source order (one
 * entry per call site, so the adapter can weight an edge by call count). Heredoc- and
 * string/comment-aware. Does NOT resolve — the adapter maps each token through the
 * alias scope + module registry and drops anything it can't place unambiguously.
 */
export function scanCallSites(text: string): string[] {
  const out: string[] = [];
  for (const line of preprocessLines(text)) {
    const cleaned = stripStringsAndComments(line);
    for (const m of cleaned.matchAll(CALL_SITE_RE)) out.push(m[1]);
  }
  return out;
}

/**
 * Expand a call callee's module token through the file's `alias` scope. The token's
 * HEAD segment (`Accounts` in `Accounts.User`) is replaced by its aliased module when
 * bound (`alias MyApp.Accounts` → `MyApp.Accounts.User`); an unbound head is returned
 * unchanged (a literal fully-qualified reference the adapter then looks up directly).
 * Pure.
 */
export function aliasExpand(moduleToken: string, aliasScope: ReadonlyMap<string, string>): string {
  const dot = moduleToken.indexOf('.');
  const head = dot === -1 ? moduleToken : moduleToken.slice(0, dot);
  const full = aliasScope.get(head);
  if (full === undefined) return moduleToken;
  return dot === -1 ? full : full + moduleToken.slice(dot);
}
