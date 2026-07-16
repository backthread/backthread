// Swift-manifest-gated registration of the Swift framework fleet.
//
// SPLIT OUT from register.ts (the eager JS/Python builtins) to honor the "ship N
// adapters, zero cost when absent" promise: register.ts imports THIS module
// DYNAMICALLY, and only when the repo declares Swift (a Package.swift / Podfile /
// *.xcodeproj), so a TS/Python/Ruby/Elixir/Dart/PHP/Kotlin ingest never module-loads
// the Swift scanner. (The scanner is hand-rolled + dep-free, so — like Elixir/Dart/
// Kotlin — there is no native parser to keep off the load path; this gate is purely
// about not loading dead code for a non-Swift repo.)
//
// Registration order = co-fire priority (web → data), mirroring the other fleets. The
// two web adapters register first (ui before vapor: a client-UI role/grouping wins
// over the server-route adapter on any file both touch, though in practice an iOS app
// and a Vapor server rarely share files), then the data adapter last (additive — it
// claims only the model dirs the UI/Vapor priors didn't).
//
// This module is itself only ever DYNAMICALLY imported (from register.ts's manifest
// gate), so its static imports of the Swift adapters + their scanner load ONLY for a
// Swift repo. It stays SYNCHRONOUS (register.ts calls it without await).

import { registerFrameworkAdapter } from './registry.js';
import { swiftUiAdapter } from './swift/ui/ui.js';
import { vaporAdapter } from './swift/vapor/vapor.js';
import { swiftDataAdapter } from './swift/data/data.js';

/**
 * Register every builtin Swift framework adapter. Called (once per process) from
 * register.ts's Swift-manifest gate. Idempotent on name — safe to call more than once.
 * The log line makes the gate firing observable (the "a Swift repo loaded the Swift
 * fleet, a non-Swift repo did not" isolation probe).
 */
export function registerSwiftFrameworkAdapters(): void {
  // web → data (registration order = co-fire priority).
  registerFrameworkAdapter(swiftUiAdapter); // web (SwiftUI / UIKit client UI)
  registerFrameworkAdapter(vaporAdapter); // web (Vapor server routes)
  registerFrameworkAdapter(swiftDataAdapter); // data (SwiftData / CoreData / Fluent)
  console.log('  [swift] framework fleet registered (Swift manifest present)');
}
