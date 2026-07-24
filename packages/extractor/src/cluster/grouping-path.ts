// PURE helpers for NAMESPACE-derived grouping — the JVM fix.
//
// Clustering names a module (and its subsystem box) from the dominant leading
// segment of its files' paths. That works when the physical path IS the mental
// model (`src/auth/login.ts` → `auth`), and fails completely on a JVM repo, where
// two layers of ceremony sit above the meaningful structure:
//
//   1. the BUILD SOURCE ROOT — `src/main/java/…` (the Maven Standard Directory
//      Layout, which Gradle inherits). Clustering strips only a leading `src/`, so
//      every file's leading segment became `main`;
//   2. the REVERSE-DNS PACKAGE PREFIX — `com/company/product/…`, shared by every
//      file in the repo, so even past the source root everything would collapse
//      onto one segment.
//
// The JVM adapters therefore hand each file a `groupingPath` (its declared package
// as dirs — see GraphFile.groupingPath), which skips ceremony (1) by construction,
// and this module removes ceremony (2) by stripping the longest COMMON prefix.
//
// Everything here is a pure function of the SORTED file set, which is load-bearing:
// module ids and subsystem ids are read as the time slider scrubs, so a derivation
// that depended on iteration order would reshuffle boxes between snapshots.
//
// NOTHING here fires for a file without a `groupingPath` — i.e. for every language
// but Java and Kotlin — so non-JVM clustering is byte-identical.

/** Split a posix-ish path into non-empty segments. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/**
 * The longest common leading SEGMENT run shared by every path — the repo-wide (or
 * per-workspace-package) namespace prefix that carries no distinguishing
 * information (`ai/luun/investigation` when every file lives under it).
 *
 * EMPTY paths are IGNORED rather than vetoing the prefix: a file in the unnamed
 * package declares no namespace, so it has nothing to say about what the others
 * share (it simply falls back to its physical path downstream). Without this, one
 * default-package file anywhere in a repo would disable the strip for all of it.
 *
 * The result can never swallow a segment that distinguishes two files — that is
 * what "common" means — so no extra guard is needed against over-stripping
 * SIDEWAYS. The guard that IS needed is against stripping everything DOWN to
 * nothing (a repo whose files all sit in exactly one package): `stripCommonPrefix`
 * reports that case so the caller can fall back rather than group by empty string.
 */
export function commonPrefixSegments(paths: readonly string[]): string[] {
  const nonEmpty = paths.filter((p) => p.length > 0).map(segmentsOf);
  if (nonEmpty.length === 0) return [];
  let prefix = nonEmpty[0];
  for (const segs of nonEmpty.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < segs.length && prefix[i] === segs[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix;
}

/**
 * Strip the common namespace prefix from every path, keyed by file id.
 *
 * A file whose whole namespace IS the prefix (the app-entry class sitting at the
 * root of the package tree — `PetClinicApplication` in `…samples.petclinic`) keeps
 * the prefix's LAST segment rather than an empty remainder. Falling back to its
 * physical path instead would drop exactly that file back onto the build source
 * root, leaving one stray "Main" box next to the real feature boxes — the ceremony
 * this whole module exists to remove.
 *
 * A file with NO namespace at all is absent from the result and falls back to its
 * physical path.
 *
 * NOTE the visible consequence of the app-entry rule: that file gets its OWN
 * subsystem box, named after the namespace root — "Petclinic" for
 * `org.springframework.samples.petclinic`, or a bare org name like "Acme" for a
 * `com.acme` prefix. That is a real (if small) box beside the feature boxes, and it
 * is still strictly better than the stray "Main" box it replaces.
 *
 * THE GUARD: if every surviving remainder is the SAME, the namespace distinguishes
 * nothing (a repo whose files all live in one package), so an empty map is returned
 * and the caller keeps its pre-existing physical-path behavior wholesale. This is
 * what stops the strip from ever collapsing a repo into a single bucket.
 */
export function stripCommonPrefix(
  pathById: ReadonlyMap<string, string>,
): Map<string, string> {
  // Sorted for determinism — each prefix is order-independent, but keeping the
  // iteration stable makes the whole derivation reproducible by inspection.
  const ids = [...pathById.keys()].sort();

  // PER-ROOT, not repo-wide (REVIEWER, PR #145). Requiring the prefix to be
  // UNIVERSAL made one outlier file disable the strip for the entire repo: add a
  // generated `org.other.gen` protobuf, a shaded vendor package, or an
  // `org.example` sample to a `com.acme.*` repo and the common prefix is empty, so
  // nothing strips and every box collapses onto `Com`/`Org` — the same
  // one-meaningless-mega-box symptom this module exists to remove, and a
  // cross-snapshot stability break besides (adding or deleting that single file
  // would retroactively rename every subsystem box as the time slider scrubs).
  // Bucketing by first segment makes each namespace root strip its own prefix, so
  // an outlier can only ever affect its own bucket.
  const byRoot = new Map<string, string[]>();
  for (const id of ids) {
    const segs = segmentsOf(pathById.get(id) ?? '');
    if (segs.length === 0) continue; // no namespace declared → physical fallback
    (byRoot.get(segs[0]) ?? byRoot.set(segs[0], []).get(segs[0])!).push(id);
  }

  const out = new Map<string, string>();
  for (const rootIds of byRoot.values()) {
    const prefix = commonPrefixSegments(rootIds.map((id) => pathById.get(id) ?? ''));
    for (const id of rootIds) {
      const segs = segmentsOf(pathById.get(id) ?? '');
      const rest = segs.slice(prefix.length);
      out.set(id, rest.length > 0 ? rest.join('/') : (prefix[prefix.length - 1] ?? ''));
    }
  }

  // THE GUARD, applied across every bucket: if the namespace ends up distinguishing
  // nothing, grouping by it would collapse the repo into a single box, so fall back
  // to physical paths wholesale.
  return new Set(out.values()).size <= 1 ? new Map() : out;
}

/**
 * The deepest namespace that contains ALL of a module's files — the module's own
 * common prefix, whose LAST segment is the feature name we want as its id
 * (`adapter/database` → `database`). A module spanning two sibling features falls
 * back to their shared parent; one spanning unrelated roots yields '' and the
 * caller uses `dominantTopSegment` instead.
 */
export function commonDir(paths: readonly string[]): string {
  return commonPrefixSegments(paths).join('/');
}

/**
 * The most common TOP-LEVEL segment across a module's (already prefix-stripped)
 * namespace paths — the module's subsystem box. Ties break alphabetically so the
 * result never depends on input order. Null when there is nothing to group by.
 */
export function dominantTopSegment(paths: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const top = segmentsOf(p)[0];
    if (top === undefined) continue;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = -1;
  for (const [seg, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && seg < best)) {
      best = seg;
      bestN = n;
    }
  }
  return best;
}

/** The last segment of a namespace dir (`adapter/database` → `database`), or null. */
export function leafSegment(dir: string): string | null {
  const segs = segmentsOf(dir);
  return segs.length > 0 ? segs[segs.length - 1] : null;
}
