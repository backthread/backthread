// Go-manifest-gated registration of the Go framework fleet.
//
// SPLIT OUT from register.ts (the eager JS/Python builtins), imported DYNAMICALLY from
// register.ts's Go gate and only when the repo declares a Go module/workspace (a go.mod /
// go.work, root OR nested), so a non-Go ingest never module-loads the Go framework adapters
// (their scanner is hand-rolled + dep-free, so this gate is purely about not loading dead
// code for a non-Go repo).
//
// Registration order = co-fire priority (web → data). Adapters named `go-web` / `go-gorm`.
// This module is only ever DYNAMICALLY imported, so its static imports of the Go adapters +
// their scanner load ONLY for a Go repo. Synchronous (register.ts calls it without await).

import { registerFrameworkAdapter } from './registry.js';
import { goWebAdapter } from './go/web/web.js';
import { goGormAdapter } from './go/gorm/gorm.js';

/**
 * Register every builtin Go framework adapter. Called (once per process) from register.ts's
 * Go gate. Idempotent on name. The log line makes the gate firing observable (the "a Go repo
 * loaded the Go fleet, a non-Go repo did not" isolation probe).
 */
export function registerGoFrameworkAdapters(): void {
  registerFrameworkAdapter(goWebAdapter); // web (net/http / Gin / Echo / Chi / Fiber / Gorilla)
  registerFrameworkAdapter(goGormAdapter); // data (GORM)
  console.log('  [go] framework fleet registered (Go manifest present)');
}
