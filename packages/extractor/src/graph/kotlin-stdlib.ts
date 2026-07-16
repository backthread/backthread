// Kotlin/JVM standard-library + platform top-level package roots — the analogue of
// ELIXIR_STDLIB / PYTHON_STDLIB. An `import` whose fully-qualified name is NOT defined
// in the repo and whose TOP-LEVEL segment is in this set is DROPPED (substrate, never a
// diagram node) rather than emitted as an external. Anything else non-internal is a real
// dependency → an `ext:<group>` external node.
//
// A first-party declaration that SHADOWS a stdlib name still wins — it resolves to a
// repo file first (the FQN registry is checked before this set), so this filter only
// ever sees genuinely-external references.
//
// Top-level segments only (the leftmost segment of a dotted import), so `kotlin.collections
// .List`, `java.util.ArrayList`, and `javax.inject.Inject` all reduce to `kotlin` / `java`
// / `javax`.
//
//   * `java` / `javax`   — the JDK/Java platform (bundled with the runtime; substrate).
//   * `kotlin`           — the Kotlin standard library (bundled with the compiler).
//   * `kotlinx`          — the kotlinx FAMILY (coroutines / serialization / collections-
//                          immutable / datetime …). These are separately-versioned
//                          libraries rather than compiler-bundled stdlib, but the KO1
//                          spec drops them as substrate: they are near-ubiquitous,
//                          low-architectural-signal language-adjacent utilities (Kotlin
//                          coroutines is effectively a language feature), so surfacing
//                          them as external nodes would only clutter the Map. Dropping
//                          the whole `kotlinx` top-namespace keeps the external boxes to
//                          real third-party dependencies. (Accepted call — matches the
//                          "stdlib java/javax/kotlin/kotlinx dropped" backbone spec.)
//
// A static snapshot; the pipeline never runs Kotlin or the JVM.

export const KOTLIN_STDLIB: ReadonlySet<string> = new Set(['java', 'javax', 'kotlin', 'kotlinx']);

/** Is a fully-qualified import name rooted in a dropped stdlib/platform namespace? */
export function isKotlinStdlib(fqn: string): boolean {
  return KOTLIN_STDLIB.has(fqn.split('.')[0]);
}
