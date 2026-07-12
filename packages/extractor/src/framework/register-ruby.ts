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

/**
 * Register every builtin Ruby framework adapter. Called (once per process) from
 * register.ts's Gemfile gate. Idempotent on name — safe to call more than once.
 *
 * The fleet lands incrementally: the Rails (web), ActiveRecord (data), Sidekiq
 * (async) and GraphQL/gRPC (protocol) adapters register here as each ships. Until
 * then this is a no-op — the seam is wired and the isolation gate proven, with no
 * adapters to run yet. The log line makes the gate firing observable (the "a Ruby
 * repo loaded the Ruby fleet, a TS/Python repo did not" isolation probe).
 */
export function registerRubyFrameworkAdapters(): void {
  // web → data → async → protocol (each registerFrameworkAdapter(...) call is
  // added as its adapter lands):
  //   registerFrameworkAdapter(railsAdapter);
  //   registerFrameworkAdapter(activeRecordAdapter);
  //   registerFrameworkAdapter(sidekiqAdapter);
  //   registerFrameworkAdapter(sinatraAdapter);
  //   registerFrameworkAdapter(hanamiAdapter);
  //   registerFrameworkAdapter(graphqlRubyAdapter);
  //   registerFrameworkAdapter(grpcRubyAdapter);
  console.log('  [ruby] framework fleet registered (Ruby manifest present)');
}
