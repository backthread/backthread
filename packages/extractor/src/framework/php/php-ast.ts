// php-parser parse-tree helpers for the PHP framework adapters — the analogue of
// framework/ruby/ruby-ast.ts. Drives php-parser (npm, pure-JS) for a pure,
// install-free SYNTACTIC parse of one file's text; the parser never executes repo
// code. php-parser's node kinds are lowercase string tags (`class`, `namespace`,
// `staticlookup`, `attrgroup`, …); we narrow on `node.kind` and read the fields
// its bundled types declare.
//
// These are the primitives every PHP adapter reuses: parse once (with docblock
// extraction on, so Doctrine's `@ORM\…` annotations survive), walk classes
// (namespace-aware, with their extends/implements/traits, PHP-8 attributes, and
// methods), read a call's static-class receiver + `X::class` constant references,
// and read an attribute's positional/named arguments (`#[Route('/x', name: 'y')]`,
// `#[ORM\ManyToOne(targetEntity: Post::class)]`).

import PhpParser from 'php-parser';
import type { Program, Node } from 'php-parser';
import { normalizeFqn } from '../../graph/php-psr4.js';

// php-parser ships its Engine as a CommonJS default export, but its bundled
// types.d.ts omits the module export, so the default import isn't seen as
// constructable — cast once, here (the runtime value IS the Engine constructor).
type PhpEngine = { parseCode(buffer: string, filename: string): Program };
type PhpEngineCtor = new (options: unknown) => PhpEngine;
const Engine = PhpParser as unknown as PhpEngineCtor;

// One parser per process, reused for every file + repo. extractDoc:true keeps
// docblock comments as leadingComments (Doctrine annotations live only there);
// suppressErrors keeps a partly-invalid file from throwing (degrade-not-throw).
let engine: PhpEngine | undefined;

/** The cached php-parser engine (lazy; docblocks on, PHP 8.3, error-tolerant). */
export function getPhpEngine(): PhpEngine {
  return (engine ??= new Engine({
    parser: { extractDoc: true, suppressErrors: true, version: 803 },
    ast: { withPositions: false },
  }));
}

/** Parse one file's text into its Program root, or undefined on any failure
 *  (degrade-not-throw — one unparseable file must never sink an adapter). */
export function parsePhpTree(eng: PhpEngine, text: string): Program | undefined {
  try {
    return eng.parseCode(text, 'x.php');
  } catch {
    return undefined;
  }
}

// A loose view of a php-parser node: kind + arbitrary fields. We narrow by `.kind`.
type AnyNode = Node & Record<string, unknown>;
function asNode(v: unknown): AnyNode | undefined {
  return v && typeof v === 'object' && typeof (v as { kind?: unknown }).kind === 'string'
    ? (v as AnyNode)
    : undefined;
}

// ---------------------------------------------------------------------------
// Name / literal accessors.

/** The written text of a `name` (class reference) node (`App\Models\User`), or
 *  undefined. Preserves the leading `\` of an absolute name (resolution honors it). */
export function nameText(node: unknown): string | undefined {
  const n = asNode(node);
  if (n && (n.kind === 'name' || n.kind === 'classreference') && typeof n.name === 'string') return n.name;
  return undefined;
}

/** An `identifier` node's name (`index`, `UserController`), or undefined. */
export function identifierName(node: unknown): string | undefined {
  const n = asNode(node);
  if (n && n.kind === 'identifier' && typeof n.name === 'string') return n.name;
  // A class/method `.name` is sometimes a bare string, sometimes an identifier node.
  if (typeof node === 'string') return node;
  return undefined;
}

/** A string-literal node's value (`'users'` → `users`), or undefined. */
export function stringValue(node: unknown): string | undefined {
  const n = asNode(node);
  return n && n.kind === 'string' && typeof n.value === 'string' ? n.value : undefined;
}

/** The elements of an array-literal node (`[A::class, 'm']`), or []. */
export function arrayItems(node: unknown): AnyNode[] {
  const n = asNode(node);
  if (!n || n.kind !== 'array' || !Array.isArray(n.items)) return [];
  // Each item is an `entry` (with `.value`) or a bare expression.
  return (n.items as unknown[])
    .map((it) => {
      const e = asNode(it);
      if (e && e.kind === 'entry') return asNode(e.value);
      return e;
    })
    .filter((x): x is AnyNode => !!x);
}

// ---------------------------------------------------------------------------
// Class-reference accessors (the `use`-free structural references adapters chase).

/** A `X::class` staticlookup → the referenced class name `X` (as written), or
 *  undefined for any other static lookup (`X::method`, `X::CONST`). */
export function classConstRef(node: unknown): string | undefined {
  const n = asNode(node);
  if (!n || n.kind !== 'staticlookup') return undefined;
  const offset = asNode(n.offset);
  if (offset && offset.kind === 'identifier' && offset.name === 'class') return nameText(n.what);
  return undefined;
}

/** A `new X()` expression → the instantiated class name `X` (as written), or
 *  undefined (anonymous class / dynamic `new $var`). */
export function newClass(node: unknown): string | undefined {
  const n = asNode(node);
  if (!n || n.kind !== 'new') return undefined;
  return nameText(n.what);
}

/** The invoked method/function name of a call node: `X::m()` / `$o->m()` → `m`,
 *  a free `f()` → `f`. Undefined for a dynamic call. */
export function callMethodName(call: unknown): string | undefined {
  const n = asNode(call);
  if (!n || n.kind !== 'call') return undefined;
  const what = asNode(n.what);
  if (!what) return undefined;
  if (what.kind === 'name') return typeof what.name === 'string' ? what.name : undefined;
  if (what.kind === 'staticlookup' || what.kind === 'propertylookup' || what.kind === 'nullsafepropertylookup') {
    return identifierName(what.offset);
  }
  return undefined;
}

/** The static-receiver class of a call `X::m()` → `X` (as written), or undefined
 *  (non-static call). Does NOT recurse chains — use baseStaticClass for that. */
export function staticCallClass(call: unknown): string | undefined {
  const n = asNode(call);
  if (!n || n.kind !== 'call') return undefined;
  const what = asNode(n.what);
  if (what && what.kind === 'staticlookup') return nameText(what.what);
  return undefined;
}

/** The base static-receiver class of a (possibly chained) call — `J::dispatch()`
 *  and `J::dispatch()->onQueue(…)` both → `J`. Recurses through `->`/`?->`/`::`
 *  method chains and the call wrapping them to the root static class. */
export function baseStaticClass(call: unknown): string | undefined {
  let node = asNode(call);
  const seenGuard = 64; // defensive: bound pathological chains
  for (let i = 0; node && i < seenGuard; i++) {
    if (node.kind === 'call') {
      node = asNode(node.what);
      continue;
    }
    if (node.kind === 'staticlookup') {
      const cls = nameText(node.what);
      if (cls) return cls;
      node = asNode(node.what);
      continue;
    }
    if (node.kind === 'propertylookup' || node.kind === 'nullsafepropertylookup') {
      node = asNode(node.what);
      continue;
    }
    break;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Attribute accessors (PHP-8 `#[…]`).

/** One PHP-8 attribute: its name (as written, e.g. `Route` / `ORM\Entity`) + args. */
export interface PhpAttribute {
  name: string;
  args: AnyNode[];
}

/** Every attribute across a node's `attrGroups` (a class/method/property/param). */
export function attributesOf(node: unknown): PhpAttribute[] {
  const n = asNode(node);
  const groups = n && Array.isArray(n.attrGroups) ? (n.attrGroups as unknown[]) : [];
  const out: PhpAttribute[] = [];
  for (const g of groups) {
    const gg = asNode(g);
    const attrs = gg && Array.isArray(gg.attrs) ? (gg.attrs as unknown[]) : [];
    for (const a of attrs) {
      const aa = asNode(a);
      if (aa && typeof aa.name === 'string') {
        out.push({ name: aa.name, args: Array.isArray(aa.args) ? (aa.args as AnyNode[]) : [] });
      }
    }
  }
  return out;
}

/** The value node of an attribute's named argument (`name: 'x'`), or undefined. */
export function attrNamedArg(attr: PhpAttribute, name: string): AnyNode | undefined {
  for (const arg of attr.args) {
    if (arg.kind === 'namedargument' && arg.name === name) return asNode(arg.value);
  }
  return undefined;
}

/** The attribute's POSITIONAL argument nodes, in order (named args excluded). */
export function attrPositionalArgs(attr: PhpAttribute): AnyNode[] {
  return attr.args.filter((a) => a.kind !== 'namedargument');
}

// ---------------------------------------------------------------------------
// Structural collection.

/** A class/interface/trait/enum + the context an adapter needs to classify it. */
export interface PhpClass {
  kind: 'class' | 'interface' | 'trait' | 'enum';
  /** The fully-qualified name, e.g. `App\Http\Controllers\UserController`. */
  fqn: string;
  /** The final segment, e.g. `UserController`. */
  simpleName: string;
  /** The enclosing namespace (`` for the global namespace). */
  namespace: string;
  /** The superclass reference as WRITTEN (`BaseController`), or undefined. */
  extends?: string;
  /** Implemented interface references as WRITTEN. */
  implements: string[];
  /** Trait `use` references (inside the class body) as WRITTEN. */
  traits: string[];
  /** PHP-8 attributes on the class (`#[ORM\Entity]`, `#[Route]`). */
  attributes: PhpAttribute[];
  /** The leading docblock text (`/** … *\/`) — Doctrine `@ORM\…` annotations, else undefined. */
  doc?: string;
  /** The class-body method declarations. */
  methods: PhpMethod[];
  /** The class-body statement node (for a full-body walk when an adapter needs it). */
  body: AnyNode;
}

/** A method declaration + the context an adapter needs. */
export interface PhpMethod {
  name: string;
  visibility: string;
  isStatic: boolean;
  /** Parameters, each with its (written) type-hint name when present. */
  params: Array<{ name: string; type?: string }>;
  /** PHP-8 attributes on the method (`#[Route(...)]`, `#[AsMessageHandler]`). */
  attributes: PhpAttribute[];
  /** The leading docblock text, or undefined. */
  doc?: string;
  /** The method AST node (for a body walk — call/dispatch detection). */
  node: AnyNode;
}

/** The leading docblock (`/** … *\/`) immediately preceding a node, or undefined. */
export function docOf(node: unknown): string | undefined {
  const n = asNode(node);
  const comments = n && Array.isArray(n.leadingComments) ? (n.leadingComments as unknown[]) : [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i] as { kind?: string; value?: unknown };
    if (c && c.kind === 'commentblock' && typeof c.value === 'string' && c.value.startsWith('/**')) {
      return c.value;
    }
  }
  return undefined;
}

/** A parameter's written type-hint name (`Request` for `Request $r`), or undefined
 *  (untyped, or a union/intersection/builtin — the single-name case is what
 *  handler-matching needs). */
function paramType(param: AnyNode): string | undefined {
  const t = asNode(param.type);
  if (t && (t.kind === 'name' || t.kind === 'classreference') && typeof t.name === 'string') return t.name;
  return undefined;
}

function collectMethods(body: unknown): PhpMethod[] {
  const stmts = Array.isArray(body) ? body : asNode(body)?.children;
  const items = Array.isArray(stmts) ? stmts : [];
  const out: PhpMethod[] = [];
  for (const raw of items) {
    const m = asNode(raw);
    if (!m || m.kind !== 'method') continue;
    const params = (Array.isArray(m.arguments) ? (m.arguments as unknown[]) : [])
      .map((p) => asNode(p))
      .filter((p): p is AnyNode => !!p && p.kind === 'parameter')
      .map((p) => ({ name: identifierName(p.name) ?? '', type: paramType(p) }));
    out.push({
      name: identifierName(m.name) ?? '',
      visibility: typeof m.visibility === 'string' ? m.visibility : 'public',
      isStatic: m.isStatic === true,
      params,
      attributes: attributesOf(m),
      doc: docOf(m),
      node: m,
    });
  }
  return out;
}

const CLASS_KINDS = new Set(['class', 'interface', 'trait', 'enum']);

/**
 * Every class + interface + trait + enum in a file, namespace-aware (so
 * `class UserController` inside `namespace App\Http\Controllers` reports the FQN
 * `App\Http\Controllers\UserController`), each carrying its extends/implements/
 * traits (as-written references), PHP-8 attributes, leading docblock, and methods.
 */
export function collectClasses(program: Program): PhpClass[] {
  const out: PhpClass[] = [];

  const visit = (node: unknown, ns: string): void => {
    const n = asNode(node);
    if (!n) return;
    if (n.kind === 'namespace') {
      const inner = typeof n.name === 'string' ? normalizeFqn(n.name) : ns;
      for (const child of Array.isArray(n.children) ? n.children : []) visit(child, inner);
      return;
    }
    if (CLASS_KINDS.has(n.kind)) {
      const simpleName = identifierName(n.name) ?? '';
      const fqn = ns ? `${ns}\\${simpleName}` : simpleName;
      const traits: string[] = [];
      const bodyItems = Array.isArray(n.body) ? (n.body as unknown[]) : [];
      for (const b of bodyItems) {
        const bn = asNode(b);
        if (bn && bn.kind === 'traituse') {
          for (const tr of Array.isArray(bn.traits) ? bn.traits : []) {
            const t = nameText(tr);
            if (t) traits.push(t);
          }
        }
      }
      const implementsRefs: string[] = [];
      // A class carries `.implements` (Name[]); an interface carries `.extends` (Name[]).
      const implSrc = n.kind === 'interface' ? n.extends : n.implements;
      for (const impl of Array.isArray(implSrc) ? implSrc : []) {
        const t = nameText(impl);
        if (t) implementsRefs.push(t);
      }
      out.push({
        kind: n.kind as PhpClass['kind'],
        fqn,
        simpleName,
        namespace: ns,
        extends: n.kind === 'interface' ? undefined : nameText(n.extends),
        implements: implementsRefs,
        traits,
        attributes: attributesOf(n),
        doc: docOf(n),
        methods: collectMethods(n.body),
        body: n,
      });
      // A class can nest declarations only via anonymous classes in bodies — skip.
      return;
    }
    // Descend to reach namespaced declarations + global-scope classes.
    for (const [key, value] of Object.entries(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child, ns);
      } else if (asNode(value)) {
        visit(value, ns);
      }
    }
  };

  visit(program, '');
  return out;
}

/** Every call node in a subtree (recursive, source order). */
export function collectCalls(root: unknown): AnyNode[] {
  const out: AnyNode[] = [];
  const visit = (node: unknown): void => {
    const n = asNode(node);
    if (!n) return;
    if (n.kind === 'call') out.push(n);
    for (const [key, value] of Object.entries(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (asNode(value)) visit(value);
    }
  };
  visit(root);
  return out;
}

/**
 * The file's `use` scope: alias (or trailing segment) → imported FQN. Grouped uses
 * (`use App\Traits\{A, B}`) expand under the group prefix; function/const imports
 * are skipped (class backbone only). The cross-module resolver an adapter uses to
 * turn a written short reference (`UserController`) into its FQN.
 */
export function collectUseMap(program: Program): Map<string, string> {
  const useMap = new Map<string, string>();
  const visit = (node: unknown): void => {
    const n = asNode(node);
    if (!n) return;
    if (n.kind === 'usegroup') {
      const prefix = typeof n.name === 'string' && n.name ? `${normalizeFqn(n.name)}\\` : '';
      // A `use function …` / `use const …` marks the type on the GROUP node
      // (item.type is null) — read it so a function/const import isn't bound as a class.
      const groupType = typeof n.type === 'string' ? n.type : null;
      for (const raw of Array.isArray(n.items) ? n.items : []) {
        const it = asNode(raw);
        if (!it || it.kind !== 'useitem' || typeof it.name !== 'string') continue;
        const useType = (typeof it.type === 'string' ? it.type : null) ?? groupType;
        if (useType === 'function' || useType === 'const') continue;
        const fqn = normalizeFqn(`${prefix}${it.name}`);
        const aliasNode = asNode(it.alias);
        const alias = aliasNode && typeof aliasNode.name === 'string' ? aliasNode.name : undefined;
        const last = fqn.slice(fqn.lastIndexOf('\\') + 1);
        useMap.set(alias ?? last, fqn);
      }
      return;
    }
    for (const [key, value] of Object.entries(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (asNode(value)) visit(value);
    }
  };
  visit(program);
  return useMap;
}

/** Resolve a written class reference to its FQN, honoring a file's `use` scope +
 *  namespace (PHP name-resolution). Shared by the extractor + every adapter. */
export function resolveRefToFqn(
  raw: string,
  useMap: ReadonlyMap<string, string>,
  currentNs: string,
): string {
  if (raw.startsWith('\\')) return normalizeFqn(raw);
  const clean = normalizeFqn(raw);
  const segs = clean.split('\\');
  const mapped = useMap.get(segs[0]);
  if (mapped) return segs.length === 1 ? mapped : `${mapped}\\${segs.slice(1).join('\\')}`;
  return currentNs ? `${currentNs}\\${clean}` : clean;
}
