// Gemfile-gated registration of the Ruby framework fleet.
//
// SPLIT OUT from register.ts (the eager JS/Python builtins) on purpose: every Ruby
// adapter's analysis imports the shared Ruby AST layer, which loads the Prism
// parser (@ruby/prism — a WASM module). Registering the fleet therefore MODULE-
// LOADS that parser. To keep the "ship N adapters, zero cost when absent" promise,
// register.ts imports THIS module DYNAMICALLY, and only when the repo declares Ruby
// (a Gemfile / *.gemspec) — so a TS/Python ingest never loads the Ruby toolchain.
//
// Registration order = co-fire priority (web → data → async → protocol), mirroring
// the Python fleet's ordering in register.ts.

import { registerFrameworkAdapter } from './registry.js';
import { railsAdapter } from './rails/rails.js';
import { activeRecordAdapter } from './activerecord/activerecord.js';

/**
 * Register every builtin Ruby framework adapter. Called (once per process) from
 * register.ts's Gemfile gate. Idempotent on name — safe to call more than once.
 *
 * The fleet lands incrementally (web → data → async → protocol); the remaining
 * Sidekiq (async) and GraphQL/gRPC (protocol) adapters register here as each ships.
 */
export function registerRubyFrameworkAdapters(): void {
  // web
  registerFrameworkAdapter(railsAdapter);
  // data
  registerFrameworkAdapter(activeRecordAdapter);
}
