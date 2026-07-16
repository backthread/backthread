// pubspec-gated registration of the Dart/Flutter framework fleet.
//
// SPLIT OUT from register.ts (the eager JS/Python builtins) to honor the "ship N
// adapters, zero cost when absent" promise: register.ts imports THIS module
// DYNAMICALLY, and only when the repo declares Dart (a pubspec.yaml, nested-aware), so
// a TS/Python/Ruby/Elixir ingest never module-loads the Dart scanner. (The scanner is
// hand-rolled + dep-free — the manifest reuses the already-bundled `yaml` parser — so
// unlike Ruby's Prism / Python's Pyright there is no native parser to keep off the
// load path; this gate is purely about not loading dead code for a non-Dart repo.)
//
// Registration order = co-fire priority (web/UI → state → data), mirroring the Python
// and Elixir fleets' ordering. On a real Flutter app the three adapters CO-FIRE (a
// widget file may carry a `frontend` role from flutter AND a `reads` edge from state);
// registration order decides which role wins where they overlap on one module.
//
// This module is itself only ever DYNAMICALLY imported (from register.ts's pubspec
// gate), so its static imports of the Dart adapters + their scanner load ONLY for a
// Dart repo. It stays SYNCHRONOUS (register.ts calls it without await, before detection).

import { registerFrameworkAdapter } from './registry.js';
import { flutterAdapter } from './dart/flutter/flutter.js';
import { stateAdapter } from './dart/state/state.js';
import { dataAdapter } from './dart/data/data.js';

/**
 * Register every builtin Dart/Flutter framework adapter. Called (once per process)
 * from register.ts's pubspec gate. Idempotent on name — safe to call more than once.
 * The log line makes the gate firing observable (the "a Dart repo loaded the Dart
 * fleet, a TS/Python repo did not" isolation probe).
 */
export function registerDartFrameworkAdapters(): void {
  // web/UI → state → data (registration order = co-fire priority, so the Flutter
  // widget/app-entry role wins over an additive state/data role on the same module).
  registerFrameworkAdapter(flutterAdapter); // web/UI (widgets + navigation)
  registerFrameworkAdapter(stateAdapter); // state (Bloc/Provider/Riverpod/GetX)
  registerFrameworkAdapter(dataAdapter); // data (Drift/Isar/Floor)
  console.log('  [dart] framework fleet registered (pubspec.yaml present)');
}
