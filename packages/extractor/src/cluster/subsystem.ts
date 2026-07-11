// Subsystem partition (, semantic-zoom epic ) — the STABLE,
// path-derived grouping ONE LEVEL UP from a module.
//
// Today's modules (cluster/louvain.ts) are path-derived Louvain clusters whose
// id is the slugified DOMINANT path segment of their files. A SUBSYSTEM groups
// modules by their dominant TOP-LEVEL directory segment — "auth", "billing",
// "ingest" — so the canvas can collapse a whole neighbourhood into one named
// super-node and re-expand it as the user zooms.
//
// The grouping identity was resolved at the  design checkpoint to
// DIRECTORY-PRIMARY + Louvain-refinement (NOT raw Louvain). The decisive
// constraint: the subsystem id must be STABLE ACROSS SNAPSHOTS — it is read as
// the time slider scrubs, and a Louvain community INDEX reshuffles run-to-run /
// snapshot-to-snapshot (degrades the moat; UA never faced this — no time axis).
// A top-level directory is stable across snapshots, already encodes the human
// mental model, and NAMES ITSELF (humanized dir → ~zero net-new LLM cost).
//
// Subsystems are a COMPLETE, MUTUALLY-EXCLUSIVE partition: every module gets
// exactly one (the  validation gate enforces this once SUBSYSTEM_REQUIRED
// flips). External / infra-namespaced modules are NOT path-derived (no fileIds),
// so they get a fixed `external` subsystem rather than a phantom directory.
//
// Naming is HEURISTIC-FIRST (humanized directory) — a cheap Flash-Lite pass
// (enrich/subsystem-names.ts) is the ONLY fallback, used for flat/uninformative
// repos where the directory name is useless. This module is the DETERMINISTIC
// half: it always produces a complete partition with heuristic names, with NO
// LLM dependency, so it runs even in the --no-llm structural pre-pass.

import type { PackageRole } from '../types.js';
import type { ClusteredModule } from './louvain.js';
import { slugify } from './overrides.js';

// The shape threaded onto Module.subsystem (src/types). `description` is set
// only by the optional Flash-Lite pass — the deterministic computation leaves it
// undefined (the heuristic directory name is self-explanatory enough for the
// collapsed super-node card until/unless the fallback enriches it). `role`
// is set only for workspace-package subsystems (app/lib/tooling).
export interface Subsystem {
  id: string;
  name: string;
  description?: string;
  role?: PackageRole;
}

// The fixed subsystem every non-path-derived module (external dep / infra node)
// lands in. These have no source directory of their own, so a directory-derived
// id would be a phantom; they belong to the "Externals" neighbourhood. Its id is
// the load-bearing colon-free `external` SENTINEL (grouping-gate's framework
// discriminator + several consumers key off it) — deliberately NOT `dir:`/`pkg:`
// namespaced. It only holds namespaced/external modules, so it collides with a
// module id only in the rare case of an internal module literally slugged
// `external`; that is out of 's directory-derived scope and left as-is.
export const EXTERNAL_SUBSYSTEM_ID = 'external';
const EXTERNAL_SUBSYSTEM: Subsystem = { id: EXTERNAL_SUBSYSTEM_ID, name: 'Externals' };

// A module id is "namespaced" (external dep `ext:…`, infra `cloudflare:worker:…`)
// when it carries a ':' — slugify strips ':', so a namespaced id can never collide
// with a path-derived internal subsystem id. These never get a directory subsystem.
function isNamespaced(moduleId: string): boolean {
  return moduleId.includes(':');
}

// directory/package-derived subsystem ids are NAMESPACED so a subsystem
// SUPER-NODE id can NEVER equal a MODULE id. React Flow keys both nodes and
// container nodes by id; a collision (e.g. a `components`/`e2e` directory box vs a
// `components`/`e2e` module) corrupts its node store — getNodesBounds under-reports
// and edges mis-anchor (this is the latent bug 's camera fix had to work
// around). MODULE ids are either bare path-derived slugs (slugify strips ':', so
// they NEVER carry one) or already-namespaced infra/external ids (`ext:…`,
// `cloudflare:…`); a subsystem id under a reserved `dir:`/`pkg:` namespace collides
// with neither. The id changes; the human display NAME stays the dir/package label.
//
// The ':' is ALSO the existing framework-vs-directory discriminator
// (grouping-gate.ts → isFrameworkSubsystemId): framework adapters namespace their
// subsystems `<adapter>:<id>` (`nest:auth`, `react-native:root`). So `dir:`/`pkg:`
// are RESERVED as NON-framework namespaces, and isFrameworkSubsystemId excludes them
// — keeping the locked framework > package > directory precedence intact.
export const DIR_SUBSYSTEM_PREFIX = 'dir:';
export const PKG_SUBSYSTEM_PREFIX = 'pkg:';
// the LLM domain-pass (cluster/domain-grouping.ts → decisions/subsystem-
// grouping.ts) mints its OWN group ids and overwrites measured directory subsystems
// with them when the quality gate trips. Those ids must ALSO be disjoint from module
// ids (a bare slug), so they carry this prefix. It is RESERVED here (a non-framework
// namespace) so isFrameworkSubsystemId treats `domain:` as non-framework — a domain
// group is the LLM's own output over non-framework modules, NOT framework-authoritative,
// so it must stay re-groupable (pinning it would make the domain-pass refuse to
// re-group its own modules). domain-grouping.ts imports this constant so there is one
// definition of the `domain:` namespace.
export const DOMAIN_SUBSYSTEM_PREFIX = 'domain:';

// The reserved NON-framework subsystem namespaces. A colon-bearing
// subsystem id under one of these is directory/package-derived or LLM domain-pass-
// derived, not a framework adapter id — grouping-gate's discriminator reads this list
// so it never mistakes a namespaced directory/package/domain box for a framework-owned
// one (and so never pins a domain-pass id out of its own re-grouping).
export const RESERVED_SUBSYSTEM_PREFIXES: readonly string[] = [
  DIR_SUBSYSTEM_PREFIX,
  PKG_SUBSYSTEM_PREFIX,
  DOMAIN_SUBSYSTEM_PREFIX,
];

// The bare slug behind a (possibly namespaced) subsystem id — strips a reserved
// `dir:`/`pkg:` prefix; a framework (`nest:…`) or the fixed `external` id is
// returned unchanged. Used ONLY by the subsystem-naming heuristic, which inspects
// the underlying slug to detect uninformative ids; everywhere else the subsystem
// id is treated as OPAQUE.
export function bareSubsystemSlug(id: string): string {
  for (const p of RESERVED_SUBSYSTEM_PREFIXES) {
    if (id.startsWith(p)) return id.slice(p.length);
  }
  return id;
}

// The TOP-LEVEL directory segment of a file id, after stripping an optional
// leading `src/` (so `src/auth/login.ts` and `auth/login.ts` both → `auth`). A
// file sitting at the root (or directly under `src/`) has no top-level dir; it
// returns null and is handled as a root-level module by the caller.
function topLevelDir(fileId: string): string | null {
  const rel = fileId.replace(/^src\//, '');
  const slash = rel.indexOf('/');
  return slash > 0 ? rel.slice(0, slash) : null;
}

// The dominant top-level directory across a module's files — the most common
// top-level segment (ties broken alphabetically for determinism). Returns null
// when EVERY file is root-level (no top-level dir at all), so the caller can
// route such a module through the flat-repo refinement.
//
// Exported so the LLM domain-pass QUALITY GATE (cluster/grouping-gate.ts)
// measures directory quality with the EXACT same dominant-dir heuristic this
// deterministic partition uses — one definition of "a module's directory box",
// not two that could drift.
export function dominantTopLevelDir(fileIds: string[]): string | null {
  const counts = new Map<string, number>();
  for (const f of fileIds) {
    const d = topLevelDir(f);
    if (d !== null) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestN = -1;
  for (const [seg, n] of counts) {
    // Strictly-greater keeps the first by iteration order; the alpha tiebreak
    // below makes that order-independent (Map iteration is insertion order, and
    // module fileIds order is itself deterministic, but we don't rely on it).
    if (n > bestN || (n === bestN && (best === null || seg < best))) {
      best = seg;
      bestN = n;
    }
  }
  return best;
}

// Short technical words that should stay UPPER-cased as acronyms (not Title-
// cased) when they appear as a word in a directory segment — e.g. `payment-api`
// → "Payment API", not "Payment Api". This is an ALLOW-LIST, deliberately NOT a
// "≤3 chars ⇒ upper" rule: blanket length-upper-casing produced ugly names for
// ordinary short dirs (`web→WEB`, `app→APP`, `log→LOG`, `bin→BIN`) on the
// deterministic path where no LLM pass corrects them ( review nit).
// Lowercase keys; matched case-insensitively. Extend here, don't widen by length.
const ACRONYMS = new Set([
  'api', 'db', 'ui', 'ux', 'cli', 'sdk', 'id', 'io', 'os', 'http', 'https',
  'url', 'uri', 'ai', 'ml', 'css', 'html', 'json', 'xml', 'sql', 'jwt',
  'cdn', 'dns', 'tcp', 'udp', 'ssl', 'tls', 'cors', 'rpc', 'grpc', 'graphql',
  'oauth', 'sso', 'iam', 's3', 'gcp', 'aws', 'k8s', 'ci', 'cd', 'qa',
]);

// Humanize a directory segment into a display name: split on common separators,
// title-case each word, and special-case a few conventional dir names that read
// better expanded (the same dir-name → friendly-name heuristic Understand-
// Anything uses). Pure presentation — the id is the slug, not this.
const NAME_OVERRIDES: Record<string, string> = {
  src: 'Source',
  lib: 'Library',
  libs: 'Libraries',
  api: 'API',
  apis: 'APIs',
  db: 'Database',
  auth: 'Auth',
  ui: 'UI',
  cli: 'CLI',
  ingest: 'Ingestion',
  infra: 'Infrastructure',
  config: 'Configuration',
  utils: 'Utilities',
  util: 'Utilities',
  pkg: 'Packages',
  pkgs: 'Packages',
  cmd: 'Commands',
};
export function humanizeDir(segment: string): string {
  const key = segment.toLowerCase();
  if (NAME_OVERRIDES[key]) return NAME_OVERRIDES[key];
  const words = segment
    .replace(/[_\-.]+/g, ' ')
    // split camelCase / PascalCase boundaries (fooBar → foo Bar)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return segment;
  return words
    .map((w) => (ACRONYMS.has(w.toLowerCase())
      ? w.toUpperCase() // a known acronym (api, db, ui, …) reads better upper
      : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// Build a Subsystem from a raw directory segment (namespaced slug id + humanized
// name). the id is `dir:<slug>` so it can never equal a module id (a bare
// slug); the display name is unchanged.
function subsystemFromDir(segment: string): Subsystem {
  const id = DIR_SUBSYSTEM_PREFIX + (slugify(segment) || 'module');
  return { id, name: humanizeDir(segment) };
}

// build a Subsystem from a workspace package — ONE box per package.
// The id is the (stable, path-derived) package slug; the name humanizes the
// package name's last segment (`@org/ui` → "UI") so the super-node reads well,
// falling back to the slug when the package is unnamed; role labels it
// app/lib/tooling.
function packageSubsystem(m: ClusteredModule): Subsystem {
  const rawId = m.packageId!;
  // namespace the bare workspace-package slug as `pkg:<slug>` so it can't
  // equal a module id (a single-module package's entry module shares the slug).
  // Framework adapters (/729) ride packageId with an ALREADY-namespaced
  // `<adapter>:<id>` (e.g. `nest:auth`) — keep those verbatim (never double-prefix).
  const id = rawId.includes(':') ? rawId : PKG_SUBSYSTEM_PREFIX + rawId;
  const fromName = m.packageName ? humanizeDir(m.packageName.split('/').pop() ?? m.packageName) : '';
  const sub: Subsystem = { id, name: fromName || humanizeDir(rawId) };
  if (m.packageRole) sub.role = m.packageRole;
  return sub;
}

/**
 * Compute the complete subsystem partition for a cluster's modules.
 *
 * DETERMINISTIC + LLM-FREE. Returns a moduleId → Subsystem map covering EVERY
 * module (the "exactly one" partition the validation gate asserts):
 *
 *   - External / infra (namespaced) modules → the fixed `external` subsystem.
 *: a module belonging to a workspace PACKAGE (packageId set) → ONE
 *     subsystem per package (the monorepo's declared top-level partition), so a
 *     shared lib isn't shredded into the app that imports it. Within-package
 *     Louvain module clustering is unchanged — many modules, one package box.
 *   - Other internal modules (root scope / non-monorepo) → their dominant
 *     TOP-LEVEL directory, slugified + humanized.
 *   - Root-level internal modules (no top-level dir) → fall back to the module's
 *     OWN id-derived grouping (see flat-repo refinement below).
 *
 * FLAT-REPO REFINEMENT (the  "Louvain only to refine/split" rule): when
 * the directory heuristic yields a SINGLE non-external subsystem for the whole
 * repo (a flat repo: everything at root, or every module under one top-level
 * dir), a single super-node would be useless. We then refine by giving each
 * internal MODULE its own subsystem keyed by the module's id — and module ids
 * are already the Louvain-derived dominant-segment slugs (stabilized across
 * snapshots by stabilizeModuleIds), so this split is BOTH meaningful AND stable.
 * (Package-assigned modules are out of this refinement — a package is always a
 * real declared boundary, never a flat-repo collapse candidate.)
 */
export function computeSubsystems(modules: ReadonlyArray<ClusteredModule>): Map<string, Subsystem> {
  const out = new Map<string, Subsystem>();

  // Externals + infra → fixed subsystem; workspace-package modules → one box per
  // package; the rest fall through to the directory heuristic below.
  const internal: ClusteredModule[] = [];
  for (const m of modules) {
    if (m.kind === 'external' || isNamespaced(m.id)) {
      out.set(m.id, EXTERNAL_SUBSYSTEM);
    } else if (m.packageId) {
      out.set(m.id, packageSubsystem(m));
    } else {
      internal.push(m);
    }
  }

  // Per-internal-module dominant top-level dir. null ⇒ a root-level module
  // (handled by the refinement below so it still lands in exactly one subsystem).
  const dirOf = new Map<string, string | null>();
  // Distinct directory-box slugs, only to COUNT them for the flat decision below
  // (a bijection with the namespaced ids — so the bare slug is fine here).
  const dirSubsystemIds = new Set<string>();
  for (const m of internal) {
    const dir = dominantTopLevelDir(m.fileIds);
    dirOf.set(m.id, dir);
    if (dir !== null) dirSubsystemIds.add(slugify(dir) || 'module');
  }

  // FLAT-REPO REFINEMENT trigger: the directory heuristic collapses the whole
  // repo into ≤1 subsystem. Refine by module id (Louvain-derived, stable) so a
  // flat repo still gets a legible multi-subsystem overview instead of one box.
  const flat = dirSubsystemIds.size <= 1;

  for (const m of internal) {
    const dir = dirOf.get(m.id) ?? null;
    if (!flat && dir !== null) {
      out.set(m.id, subsystemFromDir(dir));
    } else {
      // Refinement: the module's own id drives its subsystem. The id is already a
      // slug (cluster/louvain.ts), and stable across snapshots — exactly the
      // stability the time slider needs. namespace it `dir:<id>` so the
      // per-module super-node id can't equal the module's OWN node id (which it
      // did by construction before — a guaranteed collision). Humanize the bare id
      // for the display name (unchanged).
      out.set(m.id, { id: DIR_SUBSYSTEM_PREFIX + m.id, name: humanizeDir(m.id) });
    }
  }

  return out;
}

// The set of DISTINCT subsystems in a partition (deduped by id), the input the
// optional Flash-Lite naming/description fallback ranks over. Deterministic
// order: by id, so a repeated run prompts identically (prompt-cache friendly).
export function distinctSubsystems(partition: ReadonlyMap<string, Subsystem>): Subsystem[] {
  const byId = new Map<string, Subsystem>();
  for (const s of partition.values()) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
