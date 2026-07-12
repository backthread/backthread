// Elixir standard-library top-level module namespaces — the analogue of the
// ts-morph adapter's Node `isBuiltin` drop (and PYTHON_STDLIB). A directive
// (`alias`/`import`/`require`/`use`) whose target module is NOT defined in the repo
// and whose TOP-LEVEL namespace is in this set is DROPPED (substrate, never a
// diagram node) rather than emitted as an external. Anything else non-internal is a
// real dependency → an `ext:<namespace>` external node.
//
// A first-party module that SHADOWS a stdlib name still wins — it resolves to a
// repo file first (the internal registry is checked before this set), so this
// filter only ever sees genuinely-external module references.
//
// Top-level namespaces only (the leftmost segment of a dotted alias), so
// `Enum.map`, `String.Chars`, and `Task.Supervisor` all reduce to `Enum` / `String`
// / `Task`. Erlang modules are lowercase atoms (`:ets`, `:gen_server`) and never
// match a `[A-Z]`-initial module reference, so they need no entry here. A static
// snapshot of the Elixir + built-in OTP-wrapper namespaces (Elixir ~1.16); the
// pipeline never runs Elixir.

export const ELIXIR_STDLIB: ReadonlySet<string> = new Set([
  // Kernel + basic data types
  'Kernel',
  'Atom',
  'Base',
  'Bitwise',
  'Float',
  'Integer',
  'Module',
  'Record',
  'Tuple',
  'Exception',
  'Function',
  'Access',
  // Collections
  'Enum',
  'Keyword',
  'List',
  'Map',
  'MapSet',
  'Range',
  'Stream',
  'Collectable',
  'Enumerable',
  // Strings / text
  'String',
  'Regex',
  'Version',
  'URI',
  'OptionParser',
  // Calendar
  'Calendar',
  'Date',
  'DateTime',
  'NaiveDateTime',
  'Time',
  'Duration',
  // IO / system
  'IO',
  'File',
  'Path',
  'Port',
  'StringIO',
  'System',
  'Node',
  // Processes / OTP
  'Agent',
  'Application',
  'Config',
  'DynamicSupervisor',
  'GenServer',
  'GenEvent',
  'Process',
  'Registry',
  'Supervisor',
  'Task',
  'PartitionSupervisor',
  // Metaprogramming / protocols
  'Code',
  'Macro',
  'Protocol',
  'Behaviour',
  'Inspect',
  // Logging / tooling (build + test frameworks — their refs are substrate, and
  // test files are noise-filtered downstream anyway)
  'Logger',
  'Mix',
  'ExUnit',
  'IEx',
]);
