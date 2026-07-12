// Prism parse-tree helpers for the Ruby framework adapters — the analogue of
// framework/python/py-ast.ts. Drives Prism (@ruby/prism) for a pure, install-free
// SYNTACTIC parse of one file's text; the parser never executes repo code. The
// node classes are exported from @ruby/prism, so we narrow with `instanceof`
// (clean + type-safe) rather than string checks.
//
// These are the primitives every Ruby adapter reuses: parse once, walk classes
// (nesting-aware, with their superclass + top-level DSL calls), walk calls, and
// read the literal/symbol/keyword arguments of a DSL call (`has_many :posts`,
// `belongs_to :author, class_name: "User"`, `get "/health", to: "system#health"`).

import {
  loadPrism,
  AssocNode,
  CallNode,
  ClassNode,
  ConstantPathNode,
  ConstantReadNode,
  KeywordHashNode,
  ModuleNode,
  StringNode,
  SymbolNode,
} from '@ruby/prism';
import type { Node } from '@ruby/prism';

// One Prism parser per process, reused for every file + repo (loadPrism spins up
// the WASI module — do it lazily + once). The returned parse function is
// SYNCHRONOUS; only the initial load is async, so the batch entry point
// (parseRubyScope) awaits getRubyParser() once and then parses every file sync.
let prismPromise: ReturnType<typeof loadPrism> | undefined;

/** The cached Prism parser (loads the WASI module on first call). */
export function getRubyParser(): ReturnType<typeof loadPrism> {
  return (prismPromise ??= loadPrism());
}

/** Parse one file's text into its AST root with an already-loaded parser, or
 *  undefined on any failure (degrade-not-throw — one unparseable file must never
 *  sink an adapter). */
export function parseRubyTree(
  parse: (source: string) => { value: Node },
  text: string,
): Node | undefined {
  try {
    return parse(text).value;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Literal + constant accessors.

/** The dotted constant name a ConstantRead/ConstantPath node denotes
 *  (`User`, `Payment::Charge`), or undefined for a non-constant / anonymous path. */
export function constantName(node: Node | null): string | undefined {
  if (!node) return undefined;
  if (node instanceof ConstantReadNode) return node.name;
  if (node instanceof ConstantPathNode) {
    const child = node.name;
    if (!child) return undefined;
    if (!node.parent) return child;
    const parent = constantName(node.parent);
    return parent ? `${parent}::${child}` : child;
  }
  return undefined;
}

/** A string literal's value (`"users"` -> `users`), or undefined. */
export function stringValue(node: Node | null | undefined): string | undefined {
  return node instanceof StringNode ? node.unescaped?.value : undefined;
}

/** A symbol literal's value (`:index` -> `index`), or undefined. */
export function symbolValue(node: Node | null | undefined): string | undefined {
  return node instanceof SymbolNode ? node.unescaped?.value : undefined;
}

/** A string OR symbol literal's value (DSL args are often either), else undefined. */
export function literalValue(node: Node | null | undefined): string | undefined {
  return stringValue(node) ?? symbolValue(node);
}

// ---------------------------------------------------------------------------
// Call accessors.

/** A CallNode's method name (`has_many`, `perform_async`), or undefined. */
export function callName(node: Node | null | undefined): string | undefined {
  return node instanceof CallNode ? node.name : undefined;
}

/** The constant a call's RECEIVER denotes (`UserJob.perform_async` -> `UserJob`),
 *  or undefined for a self/implicit/non-constant receiver. */
export function callReceiverConstant(call: CallNode): string | undefined {
  return constantName(call.receiver);
}

/** A call's POSITIONAL argument nodes, in order (the trailing bare-keyword hash
 *  `key: value, ...` is excluded — read it with keywordArg/keywordArgs). */
export function positionalArgs(call: CallNode): Node[] {
  const args = call.arguments_?.arguments_ ?? [];
  return args.filter((a) => !(a instanceof KeywordHashNode));
}

/** The value node of a call's trailing keyword argument `name:` (`belongs_to
 *  :author, class_name: "User"` -> the `"User"` node for `class_name`), or undefined.
 *  Handles both symbol (`class_name:`) and string (`'class_name' =>`) hash keys. */
export function keywordArg(call: CallNode, name: string): Node | undefined {
  const args = call.arguments_?.arguments_ ?? [];
  for (const a of args) {
    if (!(a instanceof KeywordHashNode)) continue;
    for (const el of a.elements) {
      if (el instanceof AssocNode && literalValue(el.key) === name) return el.value;
    }
  }
  return undefined;
}

/** All of a call's trailing keyword arguments as name -> value-node. */
export function keywordArgs(call: CallNode): Map<string, Node> {
  const out = new Map<string, Node>();
  const args = call.arguments_?.arguments_ ?? [];
  for (const a of args) {
    if (!(a instanceof KeywordHashNode)) continue;
    for (const el of a.elements) {
      if (el instanceof AssocNode) {
        const key = literalValue(el.key);
        if (key !== undefined && el.value) out.set(key, el.value);
      }
    }
  }
  return out;
}

/** The block attached to a call (`get "/x" do ... end` -> the block node), or null. */
export function blockOf(call: CallNode): Node | null {
  return call.block;
}

// ---------------------------------------------------------------------------
// Structural collection.

/** Every CallNode in a subtree (recursive, source order). */
export function collectCalls(root: Node): CallNode[] {
  const out: CallNode[] = [];
  const visit = (n: Node | null): void => {
    if (!n) return;
    if (n instanceof CallNode) out.push(n);
    for (const k of n.compactChildNodes()) visit(k);
  };
  visit(root);
  return out;
}

/** A class/module definition + the context an adapter needs to classify it. */
export interface RubyClass {
  node: ClassNode | ModuleNode;
  kind: 'class' | 'module';
  /** Nesting-qualified name, e.g. `Admin::UsersController`. */
  name: string;
  /** The final segment, e.g. `UsersController`. */
  simpleName: string;
  /** Enclosing module/class name parts (not including self). */
  nesting: string[];
  /** For a class: the superclass constant's full name (`ApplicationController`). */
  superclass?: string;
  /** The class/module body node (a StatementsNode) or null. */
  body: Node | null;
  /** The DSL calls at the TOP LEVEL of the body (`has_many :x`, `include M`,
   *  `resources :posts`) — NOT calls nested inside methods. */
  bodyCalls: CallNode[];
}

/** The top-level CallNodes directly in a class/module body (its DSL statements). */
function directBodyCalls(body: Node | null): CallNode[] {
  if (!body) return [];
  return body.compactChildNodes().filter((n): n is CallNode => n instanceof CallNode);
}

/**
 * Every class + module in a file, nesting-aware (so `class UsersController` inside
 * `module Admin` reports `Admin::UsersController`), each carrying its superclass and
 * its top-level body DSL calls. Recurses into nested definitions.
 */
export function collectClasses(root: Node): RubyClass[] {
  const out: RubyClass[] = [];
  const visit = (node: Node | null, nesting: string[]): void => {
    if (!node) return;
    if (node instanceof ClassNode || node instanceof ModuleNode) {
      const defName = constantName(node.constantPath);
      const parts = defName ? defName.split('::') : [];
      const inner = [...nesting, ...parts];
      out.push({
        node,
        kind: node instanceof ClassNode ? 'class' : 'module',
        name: inner.join('::'),
        simpleName: parts[parts.length - 1] ?? inner.join('::'),
        nesting: [...nesting],
        superclass: node instanceof ClassNode ? constantName(node.superclass) : undefined,
        body: node.body,
        bodyCalls: directBodyCalls(node.body),
      });
      visit(node.body, inner);
      return;
    }
    for (const k of node.compactChildNodes()) visit(k, nesting);
  };
  visit(root, []);
  return out;
}
