// Shared JVM package helpers — the one thing the Java and Kotlin adapters agree on.
//
// Kept in its own module rather than in either adapter so neither has to import the
// other: both are hand-rolled and dep-free, and `selectAdapter` lazy-loads exactly
// one of them per repo, so a Kotlin-only ingest must not pull in the Java scanner,
// stdlib tables and manifest reader for a two-line string helper. It also gives the
// helper a language-neutral home if Scala or Groovy ever land — their package syntax
// is identical.

/**
 * A declared package as a directory path (`com.foo.bar` → `com/foo/bar`), or
 * undefined for the unnamed package.
 *
 * This is the file's `groupingPath` (see GraphFile) — the namespace clustering groups
 * by INSTEAD of the physical path, which on a JVM repo is buried under the build
 * source root (`src/main/java/…`) and collapses every module onto the segment `main`.
 * Dots are the only separator a package name allows, so the mapping is total and
 * lossless; a segment neither scanner can produce (e.g. a Kotlin backtick-quoted
 * name) simply never reaches here, yielding no grouping path rather than a corrupt one.
 */
export function packageGroupingPath(pkg: string): string | undefined {
  return pkg ? pkg.split('.').join('/') : undefined;
}
