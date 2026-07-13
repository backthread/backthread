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
//
// This module is itself only ever DYNAMICALLY imported (from register.ts's mix.exs
// gate), so its static imports of the Elixir adapters + their scanner load ONLY for
// an Elixir repo — which is what keeps the "zero cost when absent" promise. It stays
// SYNCHRONOUS (register.ts calls it without await, before detection).

import { registerFrameworkAdapter } from './registry.js';
import { phoenixAdapter } from './phoenix/phoenix.js';
import { otpAdapter } from './otp/otp.js';
import { ectoAdapter } from './ecto/ecto.js';
import { ashAdapter } from './ash/ash.js';
import { obanAdapter } from './oban/oban.js';
import { broadwayAdapter } from './broadway/broadway.js';
import { commandedAdapter } from './commanded/commanded.js';
import { absintheAdapter } from './absinthe/absinthe.js';
import { grpcElixirAdapter } from './grpc-elixir/grpc-elixir.js';

/**
 * Register every builtin Elixir framework adapter. Called (once per process) from
 * register.ts's mix.exs gate. Idempotent on name — safe to call more than once.
 *
 * The fleet lands incrementally: Phoenix (web) is first; the Ecto (data),
 * Oban/Broadway (async) and Absinthe/gRPC (protocol) adapters register here as each
 * ships. The log line makes the gate firing observable (the "an Elixir repo loaded
 * the Elixir fleet, a TS/Python repo did not" isolation probe).
 */
export function registerElixirFrameworkAdapters(): void {
  // web → data → async → protocol (registration order = co-fire priority, so a
  // web framework's request-entry role/grouping wins over an additive data/async/
  // protocol adapter on the same module).
  registerFrameworkAdapter(phoenixAdapter); // web
  registerFrameworkAdapter(otpAdapter); // runtime / supervision (spans web→data)
  registerFrameworkAdapter(ectoAdapter); // data
  registerFrameworkAdapter(ashAdapter); // data
  registerFrameworkAdapter(obanAdapter); // async
  registerFrameworkAdapter(broadwayAdapter); // async
  // Commanded (CQRS/event-sourcing) sits between async + protocol — its dispatch
  // router is a gateway, its handlers/projectors are event-driven jobs. Registered
  // LATE so a web (phoenix) / data (ecto) adapter's role wins over commanded on any
  // module they both touch (registration order = co-fire priority).
  registerFrameworkAdapter(commandedAdapter); // async/protocol (CQRS)
  registerFrameworkAdapter(absintheAdapter); // protocol
  registerFrameworkAdapter(grpcElixirAdapter); // protocol
  console.log('  [elixir] framework fleet registered (mix.exs present)');
}
