// composer.json-gated registration of the PHP framework fleet.
//
// SPLIT OUT from register.ts (the eager JS/Python builtins) on purpose: every PHP
// adapter's analysis imports the shared PHP AST layer, which loads `php-parser`.
// Registering the fleet therefore MODULE-LOADS that parser. To keep the "ship N
// adapters, zero cost when absent" promise, register.ts imports THIS module
// DYNAMICALLY, and only when the repo declares PHP (a composer.json / composer.lock)
// — so a TS/Python/Ruby/Elixir/Dart ingest never loads the PHP toolchain.
//
// Registration order = co-fire priority (web → data → async → protocol), mirroring
// the Python and Ruby fleets' ordering in register.ts.

import { registerFrameworkAdapter } from './registry.js';
import { laravelAdapter } from './php/laravel/laravel.js';
import { symfonyAdapter } from './php/symfony/symfony.js';
import { ormAdapter as phpOrmAdapter } from './php/orm/orm.js';
import { asyncAdapter as phpAsyncAdapter } from './php/async/async.js';
import { apiPlatformAdapter } from './php/api-platform/api-platform.js';

/**
 * Register every builtin PHP framework adapter. Called (once per process) from
 * register.ts's composer.json gate. Idempotent on name — safe to call more than
 * once. Registration order = co-fire priority: web → data → async → protocol.
 */
export function registerPhpFrameworkAdapters(): void {
  // web
  registerFrameworkAdapter(laravelAdapter);
  registerFrameworkAdapter(symfonyAdapter);
  // data
  registerFrameworkAdapter(phpOrmAdapter);
  // async
  registerFrameworkAdapter(phpAsyncAdapter);
  // protocol
  registerFrameworkAdapter(apiPlatformAdapter);
  console.log('[php] framework fleet registered');
}
