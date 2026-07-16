// Gradle-manifest-gated registration of the Kotlin framework fleet.
//
// SPLIT OUT from register.ts (the eager JS/Python builtins) to honor the "ship N
// adapters, zero cost when absent" promise: register.ts imports THIS module DYNAMICALLY,
// and only when the repo declares a Kotlin/Gradle project (a build.gradle(.kts) /
// settings.gradle(.kts)), so a TS/Python/Ruby/Elixir/Dart/PHP ingest never module-loads
// the Kotlin scanner. (The scanner is hand-rolled + dep-free, so unlike Ruby's Prism there
// is no native parser to keep off the load path — this gate is purely about not loading
// dead code for a non-Kotlin repo.)
//
// Registration order = co-fire priority (web → data → async → protocol), mirroring the
// Python/Elixir fleets. The fleet lands incrementally: Android (web/UI) is first; the
// Ktor/Spring (web) and Room/JPA/Exposed (data) adapters register here as each ships.
//
// This module is itself only ever DYNAMICALLY imported (from register.ts's Gradle gate),
// so its static imports of the Kotlin adapters + their scanner load ONLY for a Kotlin
// repo. It stays SYNCHRONOUS (register.ts calls it without await, before detection).

import { registerFrameworkAdapter } from './registry.js';
import { androidAdapter } from './kotlin/android/android.js';

/**
 * Register every builtin Kotlin framework adapter. Called (once per process) from
 * register.ts's Gradle gate. Idempotent on name — safe to call more than once. The log
 * line makes the gate firing observable (the "a Kotlin repo loaded the Kotlin fleet, a
 * TS/Python repo did not" isolation probe).
 */
export function registerKotlinFrameworkAdapters(): void {
  registerFrameworkAdapter(androidAdapter); // web / UI
  console.log('  [kotlin] framework fleet registered (Gradle manifest present)');
}
