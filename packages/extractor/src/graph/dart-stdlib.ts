// Dart's "standard library" is addressed by a URI SCHEME, not a set of package
// names — the analogue of PYTHON_STDLIB / ELIXIR_STDLIB, but one line instead of a
// list. Every core library is imported as `dart:<name>` (`dart:async`, `dart:io`,
// `dart:core`, `dart:convert`, `dart:ui`, `dart:html`, …), so a single scheme check
// drops the whole standard library as SUBSTRATE (never a diagram node), no
// enumeration needed. Anything under the `package:` scheme is either first-party
// (an internal package's own `name:`) or a real dependency (`ext:<pkg>`); a relative
// URI is always first-party. Only `dart:` is substrate.

/** Is a Dart import URI a `dart:` core-library reference (substrate, dropped)? */
export function isDartCoreUri(uri: string): boolean {
  return uri.startsWith('dart:');
}
