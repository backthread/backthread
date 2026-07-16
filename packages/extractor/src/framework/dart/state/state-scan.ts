// Pure, comment-aware state-consumption scanners for Dart/Flutter — the pieces the
// state-management adapter's `reads` edges need: which state-holder CLASS a widget
// consumes (`BlocBuilder<T>`, `Consumer<T>`, `context.watch<T>()`), which provider
// VARIABLE a Riverpod `ref.watch(...)` reads, and the provider→notifier binding a
// Riverpod provider declaration establishes. All best-effort + deterministic (a
// hand-rolled scanner, never executes repo code), reusing dart-scan's comment/string
// blanking so a commented-out consumption never registers.
//
// Documented degrades (accepted, v1): a Riverpod provider var is often codegen-
// generated (`@riverpod`), so `ref.watch(fooProvider)` resolves only when `fooProvider`
// is a resolvable top-level declaration (or its codegen name maps to an in-repo class);
// a non-literal `ref.watch(someExpr())` is surfaced in `dynamic` for logging. GetX
// consumption (`Get.find<T>()`) is deliberately NOT scanned (skipped per the epic).

import { sourceLines } from '../../../graph/dart-scan.js';

/** Comment-stripped source as one string (reuses dart-scan's blanking). */
function cleanText(text: string): string {
  return sourceLines(text).join('\n');
}

// A type-arg consumption: the widget/API + the first state-holder class it names.
// * flutter_bloc:  BlocBuilder<T,…> / BlocConsumer / BlocListener / BlocSelector
// * provider:      Consumer<T> / Consumer2<A,B>… / Selector<T,R> / context.watch<T>() /
//                  context.read<T>() / context.select<T,R>() / Provider.of<T>(context)
const TYPE_ARG_CONSUMER_RE =
  /\b(BlocBuilder|BlocConsumer|BlocListener|BlocSelector|Consumer\d?|Selector\d?)\s*<\s*([A-Z][A-Za-z0-9_]*)/g;
const CONTEXT_CONSUMER_RE =
  /\bcontext\s*\.\s*(?:watch|read|select)\s*<\s*([A-Z][A-Za-z0-9_]*)/g;
const PROVIDER_OF_RE = /\bProvider\s*\.\s*of\s*<\s*([A-Z][A-Za-z0-9_]*)/g;

/**
 * The state-holder CLASS NAMES a file consumes via a literal type argument — the
 * flutter_bloc widgets, the provider `Consumer<T>` / `context.watch<T>()` /
 * `Provider.of<T>()` forms. Deduped in source order. The caller resolves each name
 * through the class registry (a name that isn't an in-repo state holder drops).
 */
export function scanTypeArgConsumers(text: string): string[] {
  const clean = cleanText(text);
  const out: string[] = [];
  for (const m of clean.matchAll(TYPE_ARG_CONSUMER_RE)) out.push(m[2]);
  for (const m of clean.matchAll(CONTEXT_CONSUMER_RE)) out.push(m[1]);
  for (const m of clean.matchAll(PROVIDER_OF_RE)) out.push(m[1]);
  return out;
}

/** A Riverpod provider declaration: the top-level var → the notifier class it exposes. */
export interface ProviderDecl {
  providerVar: string;
  notifierClass?: string; // the first type-arg, or a `=> Class()` create fallback
}

// `final xProvider = <Kind>Provider<Notifier, …>(…)` — capture the var + the first
// type-arg (the notifier). The `Provider` token family covers NotifierProvider /
// StateNotifierProvider / ChangeNotifierProvider / AsyncNotifierProvider / Provider /
// StateProvider / FutureProvider, incl. the `.autoDispose`/`.family` modifiers.
const PROVIDER_DECL_RE =
  /\b(?:final|const|late\s+final|var)\s+([a-z_]\w*)\s*=\s*[A-Za-z]*Provider[A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*\s*(?:<\s*([A-Z][A-Za-z0-9_]*))?/g;
// Fallback: a `=> Class(` create closure in the same declaration (when no type-arg).
const CREATE_CLASS_RE = /=>\s*(?:const\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/;

/**
 * Every Riverpod provider declaration in `text`: the provider variable + the notifier
 * class it binds (from the first type-arg, or a `create: () => Class()` fallback in the
 * same declaration line). Best-effort; a provider with neither is still returned (var
 * only) so the codegen-name heuristic can try it.
 */
export function scanProviderDecls(text: string): ProviderDecl[] {
  const clean = cleanText(text);
  const out: ProviderDecl[] = [];
  const lines = clean.split('\n');
  for (const line of lines) {
    for (const m of line.matchAll(PROVIDER_DECL_RE)) {
      const providerVar = m[1];
      let notifierClass: string | undefined = m[2];
      if (!notifierClass) notifierClass = line.slice(m.index ?? 0).match(CREATE_CLASS_RE)?.[1];
      out.push({ providerVar, notifierClass });
    }
  }
  return out;
}

/** The result of scanning a file's Riverpod `ref.watch/read/listen` calls. */
export interface RefReads {
  /** The provider variable names a `ref.watch/read/listen(...)` reads (bare identifiers). */
  providerVars: string[];
  /** Count of `ref.watch(...)` calls whose target is a non-literal (dynamic) — for logging. */
  dynamic: number;
}

// `ref.watch(fooProvider)` / `ref.read(fooProvider)` / `ref.listen(fooProvider, …)` —
// capture a BARE identifier first arg (also matches `ref.watch(fooProvider.select(...))`,
// whose head identifier is the provider). `ref.watch(` NOT followed by an identifier is
// dynamic.
const REF_READ_VAR_RE = /\bref\s*\.\s*(?:watch|read|listen)\s*\(\s*([a-z_]\w*)/g;
const REF_READ_ANY_RE = /\bref\s*\.\s*(?:watch|read|listen)\s*\(/g;

/**
 * The Riverpod provider variables a file reads (via `ref.watch/read/listen`) + a count
 * of dynamic (non-identifier) reads to log. Comment-aware. The caller resolves each var
 * through the provider→notifier map (or the codegen-name heuristic).
 */
export function scanRefReads(text: string): RefReads {
  const clean = cleanText(text);
  const providerVars: string[] = [];
  for (const m of clean.matchAll(REF_READ_VAR_RE)) providerVars.push(m[1]);
  const total = [...clean.matchAll(REF_READ_ANY_RE)].length;
  return { providerVars, dynamic: Math.max(0, total - providerVars.length) };
}
