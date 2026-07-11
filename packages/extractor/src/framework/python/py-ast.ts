// minimal Pyright parse-tree helpers for the FastAPI adapter.
//
// Drives Pyright's PARSER ONLY — a pure, install-free SYNTACTIC parse of one
// file's text (no Program, no binding, no type checker, no venv, no subprocess,
// never executes repo code). This mirrors 's pure-static discipline and
// reuses Pyright's own parser rather than a second grammar (the tree-sitter WASM
// dead-end, ) — no native binary, so it runs identically local + in the
// destroy-on-exit container.
//
// `ParseNodeType` is a `const enum` (erased from the .d.ts, and unimportable under
// isolatedModules), so — exactly like 's `IMPORT_TYPE_LOCAL` — we PIN the
// handful of node-type values we branch on. `parsePython()` asserts the module
// node's type equals the pinned `Module`, a fail-loud canary if a future exactly-
// pinned pyright bump ever renumbers the enum.

import { Parser, ParseOptions } from '@zzzen/pyright-internal/dist/parser/parser.js';
import { DiagnosticSink } from '@zzzen/pyright-internal/dist/common/diagnosticSink.js';
import { ParseTreeWalker } from '@zzzen/pyright-internal/dist/analyzer/parseTreeWalker.js';
import type {
  AssignmentNode,
  BinaryOperationNode,
  CallNode,
  ClassNode,
  ConstantNode,
  DictionaryNode,
  DictionaryKeyEntryNode,
  ExpressionNode,
  FunctionNode,
  ImportFromNode,
  ImportNode,
  IndexNode,
  ListNode,
  MemberAccessNode,
  ModuleNode,
  NameNode,
  ParseNode,
  StatementListNode,
  StringListNode,
  TypeAnnotationNode,
} from '@zzzen/pyright-internal/dist/parser/parseNodes.js';

// Pinned ParseNodeType values (parser/parseNodes.js). The dep is pinned EXACTLY,
// so these are stable; the canary in parsePython() catches any drift.
export const PN = {
  Assignment: 3,
  BinaryOperation: 7,
  Call: 9,
  Class: 10,
  Constant: 14,
  Dictionary: 18,
  DictionaryKeyEntry: 20,
  Import: 23,
  Index: 27,
  ImportFrom: 25,
  Function: 31,
  List: 34,
  MemberAccess: 35,
  Module: 36,
  Name: 38,
  StatementList: 47,
  StringList: 48,
  String: 49,
  TypeAnnotation: 54,
} as const;

// KeywordType values (tokenizerTypes.js) for the boolean constant literals — used
// to read `table=True` (SQLModel) statically. Pinned like the ParseNodeType set.
const KW_TRUE = 33;

/** A repo file's collected top-level-relevant nodes (recursive — nested `if:`
 *  blocks matter, e.g. an env-gated `include_router`). `classes` +
 *  `typeAnnotations` were added for the ORM entity pass; `binaryOps`
 * collects EVERY binary-operation node (a >> b, a << b, a + b, …) so
 *  an adapter that reads operator wiring — the Airflow `a >> b` / `a << b`
 *  task-dependency DSL — can interpret it without a second parse. Existing
 *  consumers read only the fields they need, so each addition is backward-safe. */
export interface CollectedNodes {
  assignments: AssignmentNode[];
  functions: FunctionNode[];
  calls: CallNode[];
  imports: (ImportNode | ImportFromNode)[];
  classes: ClassNode[];
  typeAnnotations: TypeAnnotationNode[];
  binaryOps: BinaryOperationNode[];
}

class NodeCollector extends ParseTreeWalker {
  readonly out: CollectedNodes = {
    assignments: [],
    functions: [],
    calls: [],
    imports: [],
    classes: [],
    typeAnnotations: [],
    binaryOps: [],
  };
  override visitAssignment(node: AssignmentNode): boolean {
    this.out.assignments.push(node);
    return true;
  }
  override visitFunction(node: FunctionNode): boolean {
    this.out.functions.push(node);
    return true;
  }
  override visitCall(node: CallNode): boolean {
    this.out.calls.push(node);
    return true;
  }
  override visitImport(node: ImportNode): boolean {
    this.out.imports.push(node);
    return true;
  }
  override visitImportFrom(node: ImportFromNode): boolean {
    this.out.imports.push(node);
    return true;
  }
  override visitClass(node: ClassNode): boolean {
    this.out.classes.push(node);
    return true;
  }
  override visitTypeAnnotation(node: TypeAnnotationNode): boolean {
    this.out.typeAnnotations.push(node);
    return true;
  }
  override visitBinaryOperation(node: BinaryOperationNode): boolean {
    this.out.binaryOps.push(node);
    return true;
  }
}

/**
 * Parse one Python file's text into a Pyright module node, or undefined on any
 * parse failure (degrade-not-throw — one unparseable file must never sink the
 * adapter). The `Module` node-type canary fails loud if the pinned enum drifts.
 */
export function parsePython(text: string): ModuleNode | undefined {
  try {
    const parser = new Parser();
    const result = parser.parseSourceFile(text, new ParseOptions(), new DiagnosticSink());
    const tree = result.parserOutput.parseTree;
    if (!tree || (tree as ParseNode).nodeType !== PN.Module) {
      if (tree && (tree as ParseNode).nodeType !== PN.Module) {
        throw new Error(
          `Pyright ParseNodeType pin drift: module node is ${(tree as ParseNode).nodeType}, expected ${PN.Module}`,
        );
      }
      return undefined;
    }
    return tree;
  } catch (err) {
    // A pin-drift canary is a real error worth surfacing; a genuine parse failure
    // is expected noise. Re-throw the canary, swallow the rest.
    if (err instanceof Error && err.message.startsWith('Pyright ParseNodeType pin drift')) throw err;
    return undefined;
  }
}

/** Recursively collect assignments / functions / calls / imports from a module. */
export function collectNodes(tree: ModuleNode): CollectedNodes {
  const collector = new NodeCollector();
  collector.walk(tree);
  return collector.out;
}

// ---------------------------------------------------------------------------
// Typed accessors (all guard on the pinned nodeType, so a wrong-shaped node
// degrades to undefined rather than throwing).

function isName(n: ParseNode | undefined): n is NameNode {
  return !!n && (n as ParseNode).nodeType === PN.Name;
}
function isMemberAccess(n: ParseNode | undefined): n is MemberAccessNode {
  return !!n && (n as ParseNode).nodeType === PN.MemberAccess;
}
function isCall(n: ParseNode | undefined): n is CallNode {
  return !!n && (n as ParseNode).nodeType === PN.Call;
}

/** A Name node's identifier value, or undefined. */
export function nameValue(n: ParseNode | undefined): string | undefined {
  return isName(n) ? n.d.value : undefined;
}

/** A pure Name / MemberAccess chain → `{ root, path }` (`a.b.c` → root `a`, path
 *  `['b','c']`); undefined if the expression isn't a plain dotted-name chain. */
export function memberChain(n: ParseNode | undefined): { root: string; path: string[] } | undefined {
  if (isName(n)) return { root: n.d.value, path: [] };
  if (isMemberAccess(n)) {
    const base = memberChain(n.d.leftExpr);
    if (!base) return undefined;
    return { root: base.root, path: [...base.path, n.d.member.d.value] };
  }
  return undefined;
}

/** The callee chain of a call expression (`x.include_router(...)` → root `x`,
 *  path `['include_router']`); undefined for a non-dotted-name callee. */
export function callCallee(call: CallNode): { root: string; path: string[] } | undefined {
  return memberChain(call.d.leftExpr);
}

/** A call's callee, IF the whole callee is itself a call (`Foo()(...)`). */
export function calleeCall(call: CallNode): CallNode | undefined {
  return isCall(call.d.leftExpr) ? call.d.leftExpr : undefined;
}

/** The concatenated value of a string-literal expression (adjacent literals
 *  join; f-strings are skipped), or undefined if it isn't a plain string. */
export function stringValue(expr: ExpressionNode | undefined): string | undefined {
  if (!expr) return undefined;
  if ((expr as ParseNode).nodeType === PN.StringList) {
    const parts: string[] = [];
    for (const s of (expr as StringListNode).d.strings) {
      if ((s as ParseNode).nodeType === PN.String) parts.push((s as { d: { value: string } }).d.value);
      else return undefined; // an f-string component → not a static literal
    }
    return parts.join('');
  }
  if ((expr as ParseNode).nodeType === PN.String) return (expr as { d: { value: string } }).d.value;
  return undefined;
}

/** The value expression of a call's keyword argument `name=…`, or undefined. */
export function keywordArg(call: CallNode, name: string): ExpressionNode | undefined {
  for (const arg of call.d.args) {
    if (arg.d.name && arg.d.name.d.value === name) return arg.d.valueExpr;
  }
  return undefined;
}

/** A call's positional argument value expressions, in order. */
export function positionalArgs(call: CallNode): ExpressionNode[] {
  return call.d.args.filter((a) => !a.d.name).map((a) => a.d.valueExpr);
}

/** The first string literal in a list-literal expression (`["users", …]` →
 *  `'users'`), or undefined if it isn't a list or its first item isn't a string. */
export function firstListString(expr: ExpressionNode | undefined): string | undefined {
  if (!expr || (expr as ParseNode).nodeType !== PN.List) return undefined;
  const items = (expr as ListNode).d.items;
  return items.length > 0 ? stringValue(items[0]) : undefined;
}

// ---------------------------------------------------------------------------
// Class + type-annotation accessors (the ORM entity pass; generic
// Python-AST primitives, reusable by any class/annotation-driven adapter).

/** A class definition's name identifier, or undefined. */
export function className(cls: ClassNode): string | undefined {
  return nameValue(cls.d.name);
}

/** A class's POSITIONAL base-class expressions as `{ root, path }` chains
 *  (`class X(models.Model)` → `{ root:'models', path:['Model'] }`); keyword
 *  arguments (`table=True`, `metaclass=…`) are excluded. Non-dotted-name bases
 *  are dropped. */
export function classBaseChains(cls: ClassNode): Array<{ root: string; path: string[] }> {
  const out: Array<{ root: string; path: string[] }> = [];
  for (const arg of cls.d.arguments) {
    if (arg.d.name) continue; // keyword arg, not a base
    const chain = memberChain(arg.d.valueExpr);
    if (chain) out.push(chain);
  }
  return out;
}

/** The value expression of a class's keyword argument `name=…` (`table=True`),
 *  or undefined. */
export function classKeywordArg(cls: ClassNode, name: string): ExpressionNode | undefined {
  for (const arg of cls.d.arguments) {
    if (arg.d.name && arg.d.name.d.value === name) return arg.d.valueExpr;
  }
  return undefined;
}

/** Walk a class BODY (its suite) into the same collected-node shape — the
 *  per-class attribute assignments / field calls / `Mapped[…]` annotations an
 *  entity detector inspects. */
export function collectClassBody(cls: ClassNode): CollectedNodes {
  const collector = new NodeCollector();
  collector.walk(cls.d.suite);
  return collector.out;
}

/** The FunctionNodes declared DIRECTLY in a class body (its methods) — NOT nested
 *  functions inside those methods, and unlike `collectClassBody().functions` which
 *  recurses. Used by the GraphQL adapter to find field-resolver
 *  methods without descending into their bodies. */
export function classDirectFunctions(cls: ClassNode): FunctionNode[] {
  const out: FunctionNode[] = [];
  const suite = cls.d.suite;
  if (!suite || !suite.d) return out;
  for (const stmt of suite.d.statements) {
    if ((stmt as ParseNode).nodeType === PN.Function) out.push(stmt as FunctionNode);
  }
  return out;
}

/** The AssignmentNodes declared DIRECTLY in a class body (its class-level field
 *  assignments, e.g. graphene's `user = graphene.Field(User)`) — NOT assignments
 *  inside methods (which `collectClassBody().assignments` would include). Bare
 *  annotations (`user: User` with no `=`) are not assignments and are excluded. */
export function classDirectAssignments(cls: ClassNode): AssignmentNode[] {
  const out: AssignmentNode[] = [];
  const suite = cls.d.suite;
  if (!suite || !suite.d) return out;
  for (const stmt of suite.d.statements) {
    // Simple statements sit inside a StatementList line; class-body fields are
    // assignments within those lines.
    if ((stmt as ParseNode).nodeType !== PN.StatementList) continue;
    for (const s of (stmt as StatementListNode).d.statements) {
      if ((s as ParseNode).nodeType === PN.Assignment) out.push(s as AssignmentNode);
    }
  }
  return out;
}

/** The head of a (possibly subscripted) type expression as a `{ root, path }`
 *  chain: `Mapped[list["X"]]` → the `Mapped` chain; a plain `Foo`/`a.Foo` → its
 *  own chain. Undefined when the head isn't a dotted-name. */
export function annotationChain(
  expr: ExpressionNode | undefined,
): { root: string; path: string[] } | undefined {
  if (!expr) return undefined;
  if ((expr as ParseNode).nodeType === PN.Index) return memberChain((expr as IndexNode).d.leftExpr);
  return memberChain(expr);
}

/** The subscript argument value expressions of an index expression
 *  (`Mapped[list["X"]]` → `[ list["X"] ]`), or `[]` when it isn't a subscript. */
export function subscriptArgs(expr: ExpressionNode | undefined): ExpressionNode[] {
  if (!expr || (expr as ParseNode).nodeType !== PN.Index) return [];
  return (expr as IndexNode).d.items.map((a) => a.d.valueExpr);
}

/** True iff `expr` is the boolean literal `True` (for `table=True`). */
export function isTrueConstant(expr: ExpressionNode | undefined): boolean {
  return (
    !!expr &&
    (expr as ParseNode).nodeType === PN.Constant &&
    (expr as ConstantNode).d.constType === KW_TRUE
  );
}

// ---------------------------------------------------------------------------
// List + direct class-attribute accessors (Litestar's `route_handlers`
// list + a Controller's class-body `path`/`tags`; generic, reusable primitives).

/** A list-literal expression's item expressions (`[a, b.c, D()]` → the three
 *  item nodes), or `[]` if it isn't a list. */
export function listItems(expr: ExpressionNode | undefined): ExpressionNode[] {
  if (!expr || (expr as ParseNode).nodeType !== PN.List) return [];
  return (expr as ListNode).d.items;
}

/** The RHS value expression of a DIRECT class-body assignment (`class C: path =
 *  "/x"` → the `"/x"` expr for name `'path'`), or undefined. Only the class's own
 *  top-level body is inspected (not nested classes/methods); the first match wins. */
export function classAttr(cls: ClassNode, name: string): ExpressionNode | undefined {
  for (const stmt of cls.d.suite.d.statements) {
    // Simple statements are wrapped in a StatementList; handle a bare Assignment too.
    const assigns =
      (stmt as ParseNode).nodeType === PN.StatementList
        ? (stmt as StatementListNode).d.statements
        : [stmt as ParseNode];
    for (const inner of assigns) {
      if ((inner as ParseNode).nodeType !== PN.Assignment) continue;
      const a = inner as unknown as AssignmentNode;
      if (nameValue(a.d.leftExpr) === name) return a.d.rightExpr;
    }
  }
  return undefined;
}

/** The value of a DIRECT class-body STRING assignment (`class C: path = "/x"` →
 *  `'/x'`), or undefined if absent / not a plain string literal. */
export function classAttrString(cls: ClassNode, name: string): string | undefined {
  return stringValue(classAttr(cls, name));
}

/** A dict literal's plain `key: value` entries, in source order (`{**spread}`
 *  expand entries are skipped). Empty for a non-dict expression. The key/value
 *  are raw expressions — resolve string keys/values with `stringValue`. Used by
 *  the Celery adapter to read a `beat_schedule = {…}` config statically. */
export function dictEntries(
  expr: ExpressionNode | undefined,
): Array<{ keyExpr: ExpressionNode; valueExpr: ExpressionNode }> {
  if (!expr || (expr as ParseNode).nodeType !== PN.Dictionary) return [];
  const out: Array<{ keyExpr: ExpressionNode; valueExpr: ExpressionNode }> = [];
  for (const item of (expr as DictionaryNode).d.items) {
    if ((item as ParseNode).nodeType !== PN.DictionaryKeyEntry) continue; // skip ** expand entries
    const entry = item as DictionaryKeyEntryNode;
    out.push({ keyExpr: entry.d.keyExpr, valueExpr: entry.d.valueExpr });
  }
  return out;
}
