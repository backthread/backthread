// Java-manifest-gated registration of the Java framework fleet.
//
// SPLIT OUT from register.ts (the eager JS/Python builtins), imported DYNAMICALLY from
// register.ts's Java gate and only when the repo declares a Java project (a pom.xml or any
// `.java` source), so a TS/Python/Ruby/Elixir/Dart/Kotlin/PHP/Swift/Go ingest never
// module-loads the Java framework adapters (their scanner is hand-rolled + dep-free, so this
// gate is purely about not loading dead code for a non-Java repo).
//
// Registration order = co-fire priority (web → data), mirroring the other fleets. The Java
// Spring adapter is named `java-spring` and the JPA adapter `java-jpa` (NOT `spring`/`jpa`),
// so on a mixed Java+Kotlin Gradle repo — where both fleets register — the Java adapters
// never replace the Kotlin `spring`/`kotlin-orm` adapters (the registry is idempotent on
// name); each tags only its own language's files.
//
// This module is itself only ever DYNAMICALLY imported, so its static imports of the Java
// adapters + their scanner load ONLY for a Java repo. Synchronous (register.ts calls it
// without await, before detection).

import { registerFrameworkAdapter } from './registry.js';
import { javaSpringAdapter } from './java/spring/spring.js';
import { javaJpaAdapter } from './java/jpa/jpa.js';

/**
 * Register every builtin Java framework adapter. Called (once per process) from
 * register.ts's Java gate. Idempotent on name — safe to call more than once. The log line
 * makes the gate firing observable (the "a Java repo loaded the Java fleet, a non-Java repo
 * did not" isolation probe).
 */
export function registerJavaFrameworkAdapters(): void {
  registerFrameworkAdapter(javaSpringAdapter); // web + async (Spring MVC / stereotypes / listeners)
  registerFrameworkAdapter(javaJpaAdapter); // data (JPA / Hibernate)
  console.log('  [java] framework fleet registered (Java manifest present)');
}
