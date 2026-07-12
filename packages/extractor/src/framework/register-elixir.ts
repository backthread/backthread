// mix.exs-gated registration of the Elixir framework fleet.
//
// SPLIT OUT from register.ts (the eager JS/Python builtins) to honor the "ship N
// adapters, zero cost when absent" promise: register.ts imports THIS module
// DYNAMICALLY, and only when the repo declares Elixir (a mix.exs), so a
// TS/Python/Ruby ingest never module-loads the Elixir scanner. (The scanner is
// hand-rolled + dep-free, so unlike Ruby's Prism there is no native parser to keep
// off the load path — this gate is purely about not loading dead code for a
// non-Elixir repo.)
//
// Registration order = co-fire priority (web → data → async → protocol), mirroring
// the Python fleet's ordering in register.ts.

/**
 * Register every builtin Elixir framework adapter. Called (once per process) from
 * register.ts's mix.exs gate. Idempotent on name — safe to call more than once.
 *
 * The fleet lands incrementally: the Phoenix (web), Ecto (data), Oban/Broadway
 * (async) and Absinthe/gRPC (protocol) adapters register here as each ships. Until
 * then this is a no-op — the seam is wired and the isolation gate proven, with no
 * adapters to run yet. The log line makes the gate firing observable (the "an
 * Elixir repo loaded the Elixir fleet, a TS/Python repo did not" isolation probe).
 */
export function registerElixirFrameworkAdapters(): void {
  // web → data → async → protocol (each registerFrameworkAdapter(...) call is
  // added as its adapter lands):
  //   registerFrameworkAdapter(phoenixAdapter);
  //   registerFrameworkAdapter(ectoAdapter);
  //   registerFrameworkAdapter(obanAdapter);
  //   registerFrameworkAdapter(broadwayAdapter);
  //   registerFrameworkAdapter(absintheAdapter);
  //   registerFrameworkAdapter(grpcElixirAdapter);
  console.log('  [elixir] framework fleet registered (mix.exs present)');
}
