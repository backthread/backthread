// Java/JDK standard-library + platform top-level package roots — the analogue of
// KOTLIN_STDLIB / PYTHON_STDLIB. An `import` whose fully-qualified name is NOT defined
// in the repo and whose TOP-LEVEL segment is in this set is DROPPED (substrate, never a
// diagram node) rather than emitted as an external. Anything else non-internal is a real
// dependency → an `ext:<group>` external node.
//
// A first-party declaration that SHADOWS a stdlib name still wins — it resolves to a
// repo file first (the FQN registry is checked before this set), so this filter only
// ever sees genuinely-external references.
//
//   * `java`          — the JDK proper (`java.util`, `java.io`, `java.lang`, `java.time`,
//                       `java.nio` …). Bundled with the runtime; pure substrate.
//   * `sun` / `jdk`   — JDK-internal / vendor implementation namespaces (substrate).
//
// DELIBERATELY NOT dropped: `javax.*` and `jakarta.*`. Unlike Kotlin (which drops
// `javax` as platform), those namespaces are DOMINATED by Java-EE / Jakarta-EE API jars
// that ARE third-party dependencies — `javax.persistence` / `jakarta.persistence` (JPA),
// `javax.servlet` / `jakarta.servlet`, `javax.validation`, `javax.inject`, `javax.ws.rs`
// (JAX-RS) … Surfacing those as `ext:` externals is correct + informative for the
// server/web ICP (a JPA entity importing `jakarta.persistence.Entity` is a real
// dependency edge). The few genuinely-JDK `javax.*` roots (`javax.swing`, `javax.sql`,
// `javax.crypto`, `javax.net`) becoming externals instead is an accepted, low-noise
// degrade — they are rare in our target repos and read fine as platform boxes.
//
// A static snapshot; the pipeline never runs Java or the JVM.

export const JAVA_STDLIB: ReadonlySet<string> = new Set(['java', 'sun', 'jdk']);

/** Is a fully-qualified import name rooted in a dropped JDK/platform namespace? */
export function isJavaStdlib(fqn: string): boolean {
  return JAVA_STDLIB.has(fqn.split('.')[0]);
}
