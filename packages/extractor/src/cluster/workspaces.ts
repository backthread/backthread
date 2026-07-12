// Stage C — monorepo workspace/package boundary detection (decides
// manifest-first, Louvain fallback).
//
// Declared package boundaries are the ONE structural signal in a repo that is
// authored, not inferred: a workspace glob in package.json / pnpm-workspace.yaml
// / lerna.json is the developer SAYING "this is a unit". Stage C makes those
// boundaries first-class in clustering — Louvain runs only WITHIN a package
// (small graphs, stable partitions), and the boundary between packages is
// deterministic from manifests rather than statistical. This module is the
// detection half: fs-reading, pure-output, NEVER throws (a malformed manifest
// must degrade to "fewer boundaries", never fail the ingest — worst case is a
// single-package layout, i.e. exactly the pre-Stage-C behavior).
//
// Detection rules (manifest-first, ):
//   DECLARED  — root package.json `workspaces` (array or `{packages}` object
//               form), pnpm-workspace.yaml `packages:`, lerna.json `packages`.
//               Globs are expanded against the package.json dirs found by the
//               fs walk with a minimal matcher (literal, `dir/*`, `dir/**`);
//               `!`-negations are IGNORED (rare in the wild, and ignoring a
//               negation only yields an extra boundary — the override map's
//               `drop` rules handle any noise it causes).
//   INFERRED  — any non-root package.json with a `"name"` field counts as a
//               package even when not declared. This covers undeclared
//               multi-package repos (this very repo's `worker/` is exactly
//               that). Tradeoff: a test fixture containing a named
//               package.json creates a noise boundary — accepted, because the
//               override map's `drop` handles it and missing a real boundary
//               is worse (it lets Louvain blend two packages).
//
// Membership is by LONGEST matching package root (a file under
// `worker/container/` belongs to that package, not `worker/`), with the repo
// root ('' scope) as the universal fallback.
//
// (monorepo-aware subsystem partition) extends Stage C with three
// PURE, DETERMINISTIC, ZERO-LLM signals computed off the same manifests:
//   - turbo.json / nx.json recognition. Turborepo reuses the package manager's
//     workspaces, so turbo.json adds no globs (named packages are already found
//     INFERRED) — it's recognized only as a layout-trigger manifest. Nx declares
//     its package dirs via `workspaceLayout` (appsDir/libsDir, default apps/libs),
//     so nx.json contributes `<appsDir>/*` + `<libsDir>/*` DECLARED globs.
//   - ROLE per package (app / lib / tooling) — descriptive metadata threaded onto
//     the package's subsystem so the canvas can label the top-level box. NOT a
//     Module kind (the kind enum stays locked).
//   - declaredDeps: the internal package→package dependency graph, from each
//     package.json's deps that NAME a workspace sibling (a workspace dep shadows
//     the registry, so a name match IS the dep). The cluster layer turns these
//     into cross-package `calls` edges (filling gaps the import graph alone
//     missed). A tsconfig `references` / path-alias dep source is a possible
//     follow-up — deliberately OUT of this slice.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import type { PackageRole } from '../types.js';
import { compileMatchers, slugify } from './overrides.js';
import { EXCLUDE_DIRS, PYTHON_EXCLUDE_DIRS, RUBY_EXCLUDE_DIRS, ELIXIR_EXCLUDE_DIRS } from '../graph/file-graph.js';
import { normalizePyName, requirementName } from '../graph/python-manifest.js';

export interface WorkspacePackage {
  /** Repo-relative posix dir, '' for the repo root scope. */
  root: string;
  /** package.json "name", null when unnamed. */
  name: string | null;
  /**
   * Stable slug for module-id prefixes (from the name's last segment or the
   * dir basename, slugified via overrides.ts's slugify). Unique within a
   * layout (collisions dedup deterministically, root-sorted order).
   */
  slug: string;
  /**
   * Candidate entry files (repo-relative), best-first — package.json
   * main/module/exports['.'] resolved + .js→.ts(x) variants + index.ts(x) /
   * src/index.ts(x) fallbacks. Existence is NOT checked here (the cluster
   * layer checks against the actual file set — it owns the graph).
   */
  entryFileIds: string[];
  /** Was this boundary DECLARED (workspaces/pnpm/lerna/nx glob) vs inferred from a nested named package.json? */
  declared: boolean;
  /**
   * the package's architectural role (app / lib / tooling), derived
   * deterministically from its dir convention (apps/ vs packages/libs/ vs
   * tools/config), package name (eslint-config / tsconfig / *-config →
   * tooling) and scripts (a runnable start/dev/build/bin → app). The root scope
   * carries a role too, but it's never surfaced (root-scope modules group by
   * directory, not package).
   */
  role: PackageRole;
  /**
   * repo-relative roots of the workspace SIBLINGS this package depends
   * on — from its package.json deps (all four dependency fields) whose KEY names
   * a workspace sibling. Sorted, deduped, excludes self + the root scope. Empty
   * on the root scope and on leaf packages. The cluster layer (louvain.ts)
   * materializes these as cross-package `calls` edges between the two packages'
   * entry modules. (tsconfig references/path-alias deps are a possible follow-up.)
   */
  declaredDeps: string[];
}

export interface WorkspaceLayout {
  /** Includes the root scope package; >1 ⇒ a real multi-package layout. */
  packages: WorkspacePackage[];
  /** Longest-prefix match over package roots; falls back to the root scope. */
  packageOf(fileId: string): WorkspacePackage;
  /**
   * Named non-root packages, by package.json name — the lookup the cluster
   * layer uses to remap workspace-name bare-specifier externals back onto
   * internal modules. On a (broken) duplicate name, the first package in
   * root-sorted order wins — deterministic, and the loser just keeps its
   * external node (fail-soft).
   */
  nameToPackage: ReadonlyMap<string, WorkspacePackage>;
}

// The manifests that can DEFINE workspace boundaries. A diff touching any of
// these is the container's trigger to recompute the layout (and invalidateAll()
// the partition cache) — everything else leaves the layout memoizable across
// checkpoints. pnpm only reads `pnpm-workspace.yaml` (no `.yml` variant).
// adds turbo.json / nx.json (monorepo layout signals).
const WORKSPACE_MANIFEST_BASENAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'lerna.json',
  'turbo.json',
  'nx.json',
  // Python package/workspace manifests. A diff touching any of these
  // moves Python package boundaries → recompute the layout, exactly like the JS
  // manifests above.
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  // Elixir Mix project file. A repo-root mix.exs plus one per umbrella app
  // (`apps/*/mix.exs`) defines the Elixir package boundaries.
  'mix.exs',
]);

/** Does a repo-relative path name a workspace-layout-defining manifest? */
export function isWorkspaceManifestPath(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return WORKSPACE_MANIFEST_BASENAMES.has(base);
}

// Walk depth cap — pathological repos (vendored trees, generated dirs that
// dodge EXCLUDE_DIRS) must not turn detection into a full-disk crawl. Real
// workspace packages live 1-3 levels deep; 8 is generous.
const MAX_WALK_DEPTH = 8;

const EXCLUDE_SET = new Set<string>(EXCLUDE_DIRS);

// `.js` entry points (typically a build artifact path like `dist/index.js`)
// almost never exist in the SOURCE graph the extractor builds — the TS sibling
// next to them often does. Map each transpiled extension to the source
// extensions it could have come from.
const TS_VARIANTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['.js', ['.ts', '.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
];

/**
 * Detect the workspace/package layout of a checked-out repo. fs-reading;
 * NEVER throws — any unreadable/malformed manifest source is skipped, and the
 * worst case is a single-package (root-only) layout, which downstream treats
 * as "no Stage-C behavior" (status quo ante).
 */
export function detectWorkspaceLayout(rootDir: string): WorkspaceLayout {
  // 1. Candidate package dirs: every non-root dir holding a package.json,
  //    pruning EXCLUDE_DIRS + dot-directories — MUST mirror file-graph.ts's
  //    isSourceFilePath policy, or a package boundary could claim files the
  //    graph will never contain (or vice versa). Sorted for determinism.
  const candidates = findPackageJsonDirs(rootDir);

  // 2. Declared workspace globs, from package.json/pnpm/lerna + nx.json's
  //    workspaceLayout. nxLayout also carries the apps/libs dir
  //    convention used for role classification below.
  const rootManifest = readJsonObject(join(rootDir, 'package.json'));
  const nxLayout = readNxLayout(rootDir);
  const matchesDeclared = compileMatchers([
    ...collectDeclaredGlobs(rootDir, rootManifest, nxLayout),
    // uv workspace member globs (`[tool.uv.workspace].members`) are the
    // Python analogue of package.json `workspaces`.
    ...collectPythonDeclaredGlobs(rootDir),
    // Elixir umbrella `apps_path` (root mix.exs) declares `apps/*` members — the
    // analogue of package.json `workspaces` / uv members.
    ...collectElixirDeclaredGlobs(rootDir),
  ]);

  // 3. Materialize packages. The root scope is ALWAYS present (and always
  //    declared — the repo root is a boundary by definition). Slugs dedup
  //    through a used-set in root-sorted order so they're stable across runs.
  const usedSlugs = new Set<string>();
  const reserveSlug = (base: string): string => {
    let slug = base;
    let i = 2;
    while (usedSlugs.has(slug)) slug = `${base}-${i++}`;
    usedSlugs.add(slug);
    return slug;
  };

  const packages: WorkspacePackage[] = [];
  // keep each package's parsed package.json for the declaredDeps
  // second pass (it needs the full name→package map, so it can't run inline).
  const manifestByRoot = new Map<string, Record<string, unknown> | null>();

  const rootName = nameOf(rootManifest);
  manifestByRoot.set('', rootManifest);
  packages.push({
    root: '',
    name: rootName,
    slug: reserveSlug(slugFor(rootName, 'root')),
    entryFileIds: entryCandidates('', rootManifest),
    declared: true,
    role: roleOf('', rootManifest, nxLayout),
    declaredDeps: [], // root scope groups by directory, not as a package — no edges
  });

  for (const dir of candidates) {
    const manifest = readJsonObject(join(rootDir, dir, 'package.json'));
    const name = nameOf(manifest);
    const declared = matchesDeclared(dir);
    // A boundary needs a reason to exist: either someone DECLARED it, or the
    // package names itself (inferred). An unnamed, undeclared package.json
    // (e.g. `{"type":"module"}` markers, fixtures) is not a boundary.
    if (!declared && name === null) continue;
    manifestByRoot.set(dir, manifest);
    packages.push({
      root: dir,
      name,
      slug: reserveSlug(slugFor(name, dir.split('/').pop() ?? dir)),
      entryFileIds: entryCandidates(dir, manifest),
      declared,
      role: roleOf(dir, manifest, nxLayout),
      declaredDeps: [], // filled by the second pass once nameToPackage exists
    });
  }

  // 3b. Python packages. Every non-root dir with a pyproject.toml /
  //    setup.py / setup.cfg that either NAMES a package (PEP 621 `[project].name`
  //    or `[tool.poetry].name`) or is a DECLARED uv workspace member. Merged into
  //    the SAME packages list so packageOf partitions Python + polyglot repos
  //    uniformly. A dir that is ALREADY a JS package (a polyglot single package
  //    with both manifests) keeps its one boundary (skip — first wins).
  const seenRoots = new Set(packages.map((p) => p.root));
  const pyManifestByRoot = new Map<string, Record<string, unknown>>();
  for (const dir of findPythonPackageDirs(rootDir)) {
    if (seenRoots.has(dir)) continue;
    const py = readPyproject(join(rootDir, dir));
    const name = py ? pyPackageName(py) : null;
    const declared = matchesDeclared(dir);
    if (!declared && name === null) continue;
    seenRoots.add(dir);
    if (py) pyManifestByRoot.set(dir, py);
    packages.push({
      root: dir,
      name,
      slug: reserveSlug(slugFor(name, dir.split('/').pop() ?? dir)),
      entryFileIds: pythonEntryCandidates(dir, name),
      declared,
      role: pythonRoleOf(dir, py),
      declaredDeps: [], // filled by the second pass once nameToPackage exists
    });
  }

  // 3c. Elixir umbrella apps. Every non-root dir with a mix.exs — in an umbrella
  //    that's `apps/<child>/mix.exs`, one boundary per child app. The OTP app name
  //    (`app: :my_app` in `def project`) names the package; the whole repo is still
  //    extracted as ONE graph, so cross-app `alias` edges already connect the apps —
  //    this partition just groups each app into its own subsystem. A dir already a
  //    JS/Python package keeps its one boundary (first wins). Cross-app deps
  //    (`{:sibling, in_umbrella: true}`) are left to the import graph (declaredDeps
  //    stays empty) — the alias edges already span apps.
  for (const dir of findMixPackageDirs(rootDir)) {
    if (seenRoots.has(dir)) continue;
    const name = mixAppName(join(rootDir, dir));
    const declared = matchesDeclared(dir);
    if (!declared && name === null) continue;
    seenRoots.add(dir);
    packages.push({
      root: dir,
      name,
      slug: reserveSlug(slugFor(name, dir.split('/').pop() ?? dir)),
      entryFileIds: elixirEntryCandidates(dir, name),
      declared,
      role: elixirRoleOf(dir),
      declaredDeps: [],
    });
  }

  // 3d. Ruby packages / mountable Rails engines. Every non-root dir with a
  //     *.gemspec — a gem or an in-repo engine (engines/<name>/<name>.gemspec) — is
  //     a boundary (the gemspec IS the declaration; no workspace glob needed). Merged
  //     into the SAME packages list so an engine becomes its own subsystem and Louvain
  //     runs within it. A dir already claimed (JS/Python/Elixir) keeps its boundary (first wins).
  for (const dir of findRubyPackageDirs(rootDir)) {
    if (seenRoots.has(dir)) continue;
    const name = rubyPackageName(rootDir, dir);
    seenRoots.add(dir);
    packages.push({
      root: dir,
      name,
      slug: reserveSlug(slugFor(name, dir.split('/').pop() ?? dir)),
      entryFileIds: rubyEntryCandidates(dir, name),
      declared: false,
      role: rubyRoleOf(dir),
      declaredDeps: [], // Ruby cross-package deps aren't wired (rare); left empty
    });
  }

  // 4. Longest-prefix membership. Walking the file's own dir chain upward
  //    visits prefixes longest-first, so the first hit IS the longest match;
  //    nested packages (worker/container under worker) resolve correctly.
  const byRoot = new Map(packages.map((p) => [p.root, p] as const));
  const rootScope = packages[0];
  const packageOf = (fileId: string): WorkspacePackage => {
    let prefix = fileId;
    for (;;) {
      const cut = prefix.lastIndexOf('/');
      if (cut < 0) return rootScope;
      prefix = prefix.slice(0, cut);
      const hit = byRoot.get(prefix);
      if (hit) return hit;
    }
  };

  const nameToPackage = new Map<string, WorkspacePackage>();
  for (const p of packages) {
    if (p.root === '' || p.name === null) continue;
    if (!nameToPackage.has(p.name)) nameToPackage.set(p.name, p);
  }

  // 5.  cross-package dependency graph (second pass — needs the full
  //    nameToPackage map). Each non-root package's declaredDeps are the sibling
  //    roots it depends on, from its package.json deps (by sibling name).
  const knownRoots = new Set(packages.map((p) => p.root));
  // Roots that came from a PYTHON manifest — used to scope Python name-matching to
  // Python siblings, so a same-named npm package can't shadow a Python dep.
  const pyRoots = new Set(pyManifestByRoot.keys());
  for (const pkg of packages) {
    if (pkg.root === '') continue;
    const js = computeDeclaredDeps(pkg.root, manifestByRoot.get(pkg.root) ?? null, nameToPackage);
    // a Python package's sibling deps — a dep NAMING a sibling (PEP 621 /
    // poetry, normalized) or a poetry `{path=…}` dep resolving to a sibling root.
    const py = computePythonDeclaredDeps(
      pkg.root,
      pyManifestByRoot.get(pkg.root) ?? null,
      nameToPackage,
      knownRoots,
      pyRoots,
    );
    pkg.declaredDeps = [...new Set([...js, ...py])].sort();
  }

  // 6. Observability (no silent caps): for a real multi-package layout, log the
  //    packages found, their roles, and any cross-package deps — so a monorepo's
  //    partition is never silently mis-derived. Every package gets a role
  //    deterministically (lib is the fallback), so there is no "unclassified"
  //    bucket; the full breakdown is logged instead.
  if (packages.length > 1) {
    const summary = packages
      .filter((p) => p.root !== '')
      .map((p) => `${p.root}=${p.role}${p.declaredDeps.length ? ` →[${p.declaredDeps.join(', ')}]` : ''}`)
      .join('  ');
    console.log(`  [workspaces] ${packages.length - 1} package(s): ${summary}`);
  }

  return { packages, packageOf, nameToPackage };
}

// ---------------------------------------------------------------------------
// fs walk

/** Sorted repo-relative posix dirs (non-root) that contain a package.json. */
function findPackageJsonDirs(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(rel === '' ? rootDir : join(rootDir, rel), { withFileTypes: true });
    } catch {
      return; // unreadable dir → skip subtree, never throw
    }
    // Sort for cross-platform determinism (readdir order is fs-dependent).
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.isDirectory()) {
        // Mirror isSourceFilePath: dot-dirs + EXCLUDE_DIRS segments are never
        // part of the graph, so a package.json inside them is not a boundary.
        // (Symlinked dirs fail isDirectory() and are skipped — no cycles.)
        if (ent.name.startsWith('.') || EXCLUDE_SET.has(ent.name)) continue;
        walk(rel === '' ? ent.name : `${rel}/${ent.name}`, depth + 1);
      } else if (rel !== '' && ent.isFile() && ent.name === 'package.json') {
        out.push(rel);
      }
    }
  };
  walk('', 0);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Declared-glob collection

/**
 * Normalized declared workspace globs from root package.json `workspaces`
 * (array or `{packages}`), pnpm-workspace.yaml `packages:`, lerna.json
 * `packages`, and nx.json `workspaceLayout` (apps/libs dirs). Each
 * parse failure skips that SOURCE only.
 */
function collectDeclaredGlobs(
  rootDir: string,
  rootManifest: Record<string, unknown> | null,
  nx: NxLayout,
): string[] {
  const globs: string[] = [];
  const pushAll = (v: unknown): void => {
    if (!Array.isArray(v)) return;
    for (const raw of v) {
      if (typeof raw !== 'string') continue;
      let g = raw.trim().replace(/\\/g, '/');
      if (g.startsWith('!')) continue; // negations ignored (see header)
      if (g.startsWith('./')) g = g.slice(2);
      g = g.replace(/\/+$/, '');
      if (g) globs.push(g);
    }
  };

  // package.json: `"workspaces": [...]` or the yarn object form
  // `"workspaces": { "packages": [...] }`.
  const ws = rootManifest?.workspaces;
  if (Array.isArray(ws)) pushAll(ws);
  else if (ws && typeof ws === 'object') pushAll((ws as Record<string, unknown>).packages);

  // pnpm-workspace.yaml — parsed with the `yaml` package (already a root dep,
  // same parser the infra adapters use).
  try {
    const doc: unknown = parseYaml(readFileSync(join(rootDir, 'pnpm-workspace.yaml'), 'utf8'));
    if (doc && typeof doc === 'object') pushAll((doc as Record<string, unknown>).packages);
  } catch {
    // absent or malformed → skip this source
  }

  // lerna.json
  const lerna = readJsonObject(join(rootDir, 'lerna.json'));
  if (lerna) pushAll(lerna.packages);

  // nx.json workspaceLayout — Nx declares its package homes via
  // appsDir/libsDir (default apps/libs), not a glob list, so synthesize the
  // conventional `<appsDir>/*` + `<libsDir>/*` boundaries. Turbo adds none
  // (Turborepo reuses the package-manager workspaces handled above; named
  // packages are still found via the INFERRED path).
  if (nx.present) {
    if (nx.appsDir) globs.push(`${nx.appsDir}/*`);
    if (nx.libsDir) globs.push(`${nx.libsDir}/*`);
  }

  return globs;
}

// ---------------------------------------------------------------------------
// Entry-point candidates

/**
 * Candidate entry files for a package, best-first. Drawn from package.json
 * `main` / `module` / `exports` ('.' entry — string, `{".": …}` subpath form,
 * or top-level `{import|default}` conditions form), normalized repo-relative;
 * each transpiled (.js/.mjs/.cjs) candidate also yields its TS sibling(s);
 * the conventional index locations are always appended as fallbacks.
 * Existence is NOT checked — the cluster layer resolves the first candidate
 * present in its file→module map (fail-soft: none present ⇒ no remap).
 */
function entryCandidates(pkgRoot: string, manifest: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  const push = (p: string | null): void => {
    if (p && !out.includes(p)) out.push(p);
  };
  const pushWithVariants = (raw: unknown): void => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const norm = normalizeEntry(pkgRoot, raw);
    if (!norm) return;
    push(norm);
    for (const [ext, variants] of TS_VARIANTS) {
      if (!norm.endsWith(ext)) continue;
      for (const v of variants) push(norm.slice(0, -ext.length) + v);
    }
  };

  pushWithVariants(manifest?.main);
  pushWithVariants(manifest?.module);
  pushWithVariants(dotExport(manifest?.exports));

  // Conventional fallbacks — these resolve install-free packages with no
  // explicit entry fields (and dist-pointing manifests whose source lives at
  // the conventional spots).
  for (const f of ['index.ts', 'index.tsx', 'src/index.ts', 'src/index.tsx']) {
    push(pkgRoot ? `${pkgRoot}/${f}` : f);
  }
  return out;
}

/** Extract the '.' export target as a string, or undefined. */
function dotExport(exp: unknown): string | undefined {
  let dot: unknown = exp;
  if (dot && typeof dot === 'object' && !Array.isArray(dot)) {
    const e = dot as Record<string, unknown>;
    // Subpath-map form has a '.' key; bare-conditions form doesn't (the object
    // itself is the '.' entry's conditions).
    dot = '.' in e ? e['.'] : e;
  }
  if (dot && typeof dot === 'object' && !Array.isArray(dot)) {
    const d = dot as Record<string, unknown>;
    dot = typeof d.import === 'string' ? d.import : d.default;
  }
  return typeof dot === 'string' ? dot : undefined;
}

/** `./dist/index.js` (package-relative) → `worker/dist/index.js` (repo-relative). */
function normalizeEntry(pkgRoot: string, raw: string): string | null {
  let p = raw.trim().replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  // Refuse anything that escapes the package (or the repo): an entry above the
  // package root can't be a meaningful module-id anchor.
  if (!p || p.startsWith('/') || p === '..' || p.startsWith('../') || p.includes('/../')) return null;
  return pkgRoot ? `${pkgRoot}/${p}` : p;
}

// ---------------------------------------------------------------------------
// Small helpers

/** Read + parse a JSON file into an object; null on ANY failure (never throws). */
function readJsonObject(absPath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(absPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nameOf(manifest: Record<string, unknown> | null): string | null {
  const n = manifest?.name;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

/** Slug from a package name's last segment (`@scope/pkg` → `pkg`), else the dir basename. */
function slugFor(name: string | null, fallback: string): string {
  const fromName = name ? slugify(name.split('/').pop() ?? name) : '';
  return fromName || slugify(fallback) || 'pkg';
}

// ---------------------------------------------------------------------------
// nx layout, roles, cross-package dependency graph

/**
 * Nx's package-home convention. ALWAYS resolves (nx defaults appsDir=apps,
 * libsDir=libs) so role classification has stable dir conventions even in a
 * non-nx repo; `present` flags whether nx.json actually exists (→ its dirs also
 * seed DECLARED globs).
 */
interface NxLayout {
  appsDir: string;
  libsDir: string;
  present: boolean;
}

function readNxLayout(rootDir: string): NxLayout {
  const nx = readJsonObject(join(rootDir, 'nx.json'));
  if (!nx) return { appsDir: 'apps', libsDir: 'libs', present: false };
  let appsDir = 'apps';
  let libsDir = 'libs';
  const wl = nx.workspaceLayout;
  if (wl && typeof wl === 'object' && !Array.isArray(wl)) {
    const o = wl as Record<string, unknown>;
    if (typeof o.appsDir === 'string' && o.appsDir.trim()) appsDir = cleanDir(o.appsDir);
    if (typeof o.libsDir === 'string' && o.libsDir.trim()) libsDir = cleanDir(o.libsDir);
  }
  return { appsDir, libsDir, present: true };
}

/** Normalize a config dir value to a clean repo-relative posix segment chain. */
function cleanDir(s: string): string {
  return s.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// Conventional tooling DIR names + package-name patterns. A package that is
// build/lint/config tooling is labeled `tooling` (most specific signal — checked
// before app/lib so a config package with a build script isn't mislabeled app).
const TOOLING_DIRS = new Set(['tools', 'tooling', 'config', 'configs']);

function isToolingName(name: string): boolean {
  const last = (name.split('/').pop() ?? name).toLowerCase();
  return (
    last.includes('eslint-config') ||
    last.includes('eslint-plugin') ||
    last.includes('prettier-config') ||
    last.includes('stylelint-config') ||
    last === 'tsconfig' ||
    last.startsWith('tsconfig-') ||
    last.endsWith('-tsconfig') ||
    last === 'config' ||
    last.endsWith('-config') ||
    last.endsWith('-preset')
  );
}

function hasAnyScript(manifest: Record<string, unknown> | null, names: string[]): boolean {
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return false;
  const s = scripts as Record<string, unknown>;
  return names.some((n) => typeof s[n] === 'string' && (s[n] as string).trim() !== '');
}

/**
 * Classify a package app / lib / tooling. Deterministic, pure:
 *   1. tooling — conventional tooling dir (tools/config) or a config/eslint/
 *      tsconfig package name (most specific, checked first).
 *   2. directory convention dominates the script heuristic: `<appsDir>/*` → app;
 *      `<libsDir>/*` (or the generic `packages`/`libs`) → lib. This keeps a
 *      `packages/ui` library a lib even when it has a build script.
 *   3. otherwise (a non-conventional location) a runnable program — a
 *      start/dev/build/serve script, or a `bin` — is an app; everything else lib.
 */
function roleOf(
  pkgRoot: string,
  manifest: Record<string, unknown> | null,
  nx: NxLayout,
): PackageRole {
  const seg0 = pkgRoot.split('/')[0]; // '' for the root scope
  const name = nameOf(manifest);
  if (seg0 !== '' && TOOLING_DIRS.has(seg0)) return 'tooling';
  if (name && isToolingName(name)) return 'tooling';
  if (seg0 !== '' && seg0 === nx.appsDir) return 'app';
  if (seg0 === nx.libsDir || seg0 === 'packages' || seg0 === 'libs') return 'lib';
  if (hasAnyScript(manifest, ['start', 'dev', 'build', 'serve']) || manifest?.bin != null) {
    return 'app';
  }
  return 'lib';
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Sibling roots a package depends on — sorted, deduped, self/root
 * excluded. Source: this package's package.json deps (all four dependency
 * fields) whose KEY names a workspace sibling (a workspace dep shadows the
 * registry, so a name match IS the dep). A tsconfig `references` / path-alias
 * dep source is a possible follow-up, deliberately OUT of this slice.
 */
function computeDeclaredDeps(
  pkgRoot: string,
  manifest: Record<string, unknown> | null,
  nameToPackage: ReadonlyMap<string, WorkspacePackage>,
): string[] {
  const deps = new Set<string>();

  for (const field of DEP_FIELDS) {
    const d = manifest?.[field];
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    for (const depName of Object.keys(d as Record<string, unknown>)) {
      const sib = nameToPackage.get(depName);
      if (sib && sib.root !== '' && sib.root !== pkgRoot) deps.add(sib.root);
    }
  }

  return [...deps].sort();
}

// ---------------------------------------------------------------------------
// Python package/workspace detection (the Python analogue of the JS
// machinery above). All pure + fs-reading + NEVER-throws (a malformed manifest
// degrades to fewer boundaries). Merged into the SAME WorkspacePackage list, so
// the cluster layer partitions Python + polyglot repos with no change.

const PY_MANIFEST_FILES = new Set(['pyproject.toml', 'setup.py', 'setup.cfg']);
// A Python package dir must skip BOTH the JS excludes and the Python ones (venvs,
// caches) — a vendored `.venv/**/pyproject.toml` is never a first-party boundary.
const PY_EXCLUDE_SET = new Set<string>([...EXCLUDE_DIRS, ...PYTHON_EXCLUDE_DIRS]);

/** Sorted non-root dirs containing a pyproject.toml / setup.py / setup.cfg. */
function findPythonPackageDirs(rootDir: string): string[] {
  const out = new Set<string>();
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(rel === '' ? rootDir : join(rootDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || PY_EXCLUDE_SET.has(ent.name)) continue;
        walk(rel === '' ? ent.name : `${rel}/${ent.name}`, depth + 1);
      } else if (rel !== '' && ent.isFile() && PY_MANIFEST_FILES.has(ent.name)) {
        out.add(rel);
      }
    }
  };
  walk('', 0);
  return [...out].sort();
}

// ── Elixir umbrella package detection ──────────────────────────────────────
const EX_MANIFEST_FILES = new Set(['mix.exs']);
const EX_EXCLUDE_SET = new Set<string>([...EXCLUDE_DIRS, ...ELIXIR_EXCLUDE_DIRS]);

/** Sorted non-root dirs containing a mix.exs (umbrella children at apps/<child>). */
function findMixPackageDirs(rootDir: string): string[] {
  const out = new Set<string>();
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(rel === '' ? rootDir : join(rootDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || EX_EXCLUDE_SET.has(ent.name)) continue;
        walk(rel === '' ? ent.name : `${rel}/${ent.name}`, depth + 1);
      } else if (rel !== '' && ent.isFile() && EX_MANIFEST_FILES.has(ent.name)) {
        out.add(rel);
      }
    }
  };
  walk('', 0);
  return [...out].sort();
}

/** Read a dir's mix.exs text; '' on absence/any failure. NEVER evaluated. */
function readMixExs(absDir: string): string {
  try {
    const p = join(absDir, 'mix.exs');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  } catch {
    return '';
  }
}

/** The OTP app name from `def project`'s `app: :name`, or null. Regex, never eval. */
function mixAppName(absDir: string): string | null {
  const m = readMixExs(absDir).match(/\bapp:\s*:([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : null;
}

/** Root mix.exs umbrella `apps_path: "apps"` → `["apps/*"]`; else []. */
function collectElixirDeclaredGlobs(rootDir: string): string[] {
  const m = readMixExs(rootDir).match(/apps_path:\s*"([^"]+)"/);
  return m ? [`${m[1]}/*`] : [];
}

/** Best-first entry candidates for an Elixir package (existence checked by caller). */
function elixirEntryCandidates(pkgRoot: string, name: string | null): string[] {
  const rel = (f: string): string => (pkgRoot ? `${pkgRoot}/${f}` : f);
  const out: string[] = [];
  const push = (p: string): void => {
    if (!out.includes(p)) out.push(p);
  };
  if (name) {
    push(rel(`lib/${name}.ex`));
    push(rel(`lib/${name}/application.ex`));
  }
  const dirBase = pkgRoot.split('/').pop() ?? '';
  if (dirBase) push(rel(`lib/${dirBase}.ex`));
  return out;
}

/** Role for an Elixir package: an umbrella app under `apps/` is an app, else a lib. */
function elixirRoleOf(pkgRoot: string): PackageRole {
  const seg0 = pkgRoot.split('/')[0];
  if (seg0 !== '' && TOOLING_DIRS.has(seg0)) return 'tooling';
  if (seg0 === 'apps') return 'app';
  return 'lib';
}

/** Parse a dir's pyproject.toml into an object; null on absence/any failure. */
function readPyproject(absDir: string): Record<string, unknown> | null {
  try {
    const p = join(absDir, 'pyproject.toml');
    if (!existsSync(p)) return null;
    const parsed: unknown = parseToml(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** `[project].name` or `[tool.poetry].name`, or null. */
function pyPackageName(py: Record<string, unknown>): string | null {
  const project = asObject(py.project);
  if (typeof project?.name === 'string' && project.name.trim()) return project.name.trim();
  const poetry = asObject(asObject(py.tool)?.poetry);
  if (typeof poetry?.name === 'string' && poetry.name.trim()) return poetry.name.trim();
  return null;
}

/** Root pyproject `[tool.uv.workspace].members` globs (normalized). */
function collectPythonDeclaredGlobs(rootDir: string): string[] {
  const py = readPyproject(rootDir);
  if (!py) return [];
  const uv = asObject(asObject(asObject(py.tool)?.uv)?.workspace);
  const members = uv?.members;
  if (!Array.isArray(members)) return [];
  const globs: string[] = [];
  for (const m of members) {
    if (typeof m !== 'string') continue;
    let g = m.trim().replace(/\\/g, '/');
    if (g.startsWith('!')) continue;
    if (g.startsWith('./')) g = g.slice(2);
    g = g.replace(/\/+$/, '');
    if (g) globs.push(g);
  }
  return globs;
}

/** Best-first candidate entry files for a Python package (its top-level
 *  `__init__.py`), from the dist name's import module + the dir basename. */
function pythonEntryCandidates(pkgRoot: string, name: string | null): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    if (!out.includes(p)) out.push(p);
  };
  const rel = (f: string): string => (pkgRoot ? `${pkgRoot}/${f}` : f);
  const bases: string[] = [];
  if (name) bases.push(name.replace(/[-.]/g, '_').toLowerCase()); // dist name → import module
  const dirBase = pkgRoot.split('/').pop() ?? '';
  if (dirBase) bases.push(dirBase);
  for (const base of bases) {
    push(rel(`src/${base}/__init__.py`));
    push(rel(`${base}/__init__.py`));
  }
  push(rel('__init__.py'));
  push(rel('main.py'));
  return out;
}

/**
 * Classify a Python package app / lib / tooling. Directory convention first
 * (apps/ → app; packages|libs → lib; tools|config → tooling), then a runnable
 * entry point (`[project.scripts]` / `[tool.poetry.scripts]`) → app, else lib.
 */
function pythonRoleOf(pkgRoot: string, py: Record<string, unknown> | null): PackageRole {
  const seg0 = pkgRoot.split('/')[0];
  if (seg0 !== '' && TOOLING_DIRS.has(seg0)) return 'tooling';
  if (seg0 === 'apps') return 'app';
  if (seg0 === 'packages' || seg0 === 'libs') return 'lib';
  const scripts =
    asObject(asObject(py?.project)?.scripts) ?? asObject(asObject(asObject(py?.tool)?.poetry)?.scripts);
  if (scripts && Object.keys(scripts).length > 0) return 'app';
  return 'lib';
}

// ---------------------------------------------------------------------------
// Ruby package / mountable-engine detection. A gemspec-bearing dir is a boundary
// (a gem or an in-repo Rails engine). Pure + fs-reading + never-throws.

// Skip both JS and Ruby excludes — a vendored `vendor/bundle/**/x.gemspec` is
// never a first-party boundary.
const RUBY_PKG_EXCLUDE_SET = new Set<string>([...EXCLUDE_DIRS, ...RUBY_EXCLUDE_DIRS]);

/** Sorted non-root dirs containing a `*.gemspec`. */
function findRubyPackageDirs(rootDir: string): string[] {
  const out = new Set<string>();
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(rel === '' ? rootDir : join(rootDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || RUBY_PKG_EXCLUDE_SET.has(ent.name)) continue;
        walk(rel === '' ? ent.name : `${rel}/${ent.name}`, depth + 1);
      } else if (rel !== '' && ent.isFile() && ent.name.endsWith('.gemspec')) {
        out.add(rel);
      }
    }
  };
  walk('', 0);
  return [...out].sort();
}

/** The gem/engine name from a dir's gemspec filename, else the dir basename. */
function rubyPackageName(rootDir: string, dir: string): string | null {
  try {
    const specs = readdirSync(join(rootDir, dir))
      .filter((f) => f.endsWith('.gemspec'))
      .sort();
    if (specs.length) return specs[0].replace(/\.gemspec$/, '');
  } catch {
    // unreadable — fall through to the dir basename
  }
  return dir.split('/').pop() ?? null;
}

/** Best-first candidate entry files for a Ruby package/engine (its lib entry). */
function rubyEntryCandidates(dir: string, name: string | null): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    if (!out.includes(p)) out.push(p);
  };
  const base = name ?? dir.split('/').pop() ?? '';
  if (base) {
    push(`${dir}/lib/${base}/engine.rb`);
    push(`${dir}/lib/${base}.rb`);
  }
  push(`${dir}/lib/engine.rb`);
  return out;
}

/** Classify a Ruby package: apps/ → app, tools/config → tooling, else lib (a gem
 *  or engine is a reusable unit). */
function rubyRoleOf(dir: string): PackageRole {
  const seg0 = dir.split('/')[0];
  if (TOOLING_DIRS.has(seg0)) return 'tooling';
  if (seg0 === 'apps') return 'app';
  return 'lib';
}

/** Distribution names this pyproject depends on (PEP 621 + poetry deps). */
function pyprojectDepNames(py: Record<string, unknown>): string[] {
  const names: string[] = [];
  const project = asObject(py.project);
  if (Array.isArray(project?.dependencies)) {
    for (const d of project.dependencies) {
      if (typeof d !== 'string') continue;
      const n = requirementName(d);
      if (n) names.push(n);
    }
  }
  const poetryDeps = asObject(asObject(asObject(py.tool)?.poetry)?.dependencies);
  if (poetryDeps) {
    for (const k of Object.keys(poetryDeps)) if (k.toLowerCase() !== 'python') names.push(k);
  }
  return names;
}

/** Local `{path=…}` sibling deps (poetry deps + uv sources). */
function pythonPathDeps(py: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const collect = (table: Record<string, unknown> | undefined): void => {
    if (!table) return;
    for (const v of Object.values(table)) {
      const o = asObject(v);
      if (typeof o?.path === 'string' && o.path.trim()) paths.push(o.path.trim());
    }
  };
  collect(asObject(asObject(asObject(py.tool)?.poetry)?.dependencies));
  collect(asObject(asObject(asObject(py.tool)?.uv)?.sources));
  return paths;
}

/** Resolve a package-relative dir (with `..`) to a repo-relative root, or null
 *  if it escapes the repo. */
function resolveRelDir(pkgRoot: string, rel: string): string | null {
  const p = rel.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const segs = pkgRoot ? pkgRoot.split('/') : [];
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (segs.length === 0) return null;
      segs.pop();
    } else {
      segs.push(s);
    }
  }
  return segs.join('/');
}

/**
 * A Python package's sibling deps — sibling roots it depends on, from a
 * dep NAMING a sibling (PEP 621 / poetry, PEP-503 normalized) or a `{path=…}` dep
 * resolving to a known sibling root. Sorted, deduped, self/root excluded.
 */
function computePythonDeclaredDeps(
  pkgRoot: string,
  py: Record<string, unknown> | null,
  nameToPackage: ReadonlyMap<string, WorkspacePackage>,
  knownRoots: ReadonlySet<string>,
  pyRoots: ReadonlySet<string>,
): string[] {
  if (!py) return [];
  const deps = new Set<string>();
  // Only PYTHON siblings are name-matchable (a shared-name npm package must not
  // shadow a Python dep — the two ecosystems share the `nameToPackage` namespace).
  const normToRoot = new Map<string, string>();
  for (const [name, pkg] of nameToPackage) {
    if (pkg.root !== '' && pkg.root !== pkgRoot && pyRoots.has(pkg.root)) {
      normToRoot.set(normalizePyName(name), pkg.root);
    }
  }
  for (const depName of pyprojectDepNames(py)) {
    const root = normToRoot.get(normalizePyName(depName));
    if (root) deps.add(root);
  }
  for (const rel of pythonPathDeps(py)) {
    const root = resolveRelDir(pkgRoot, rel);
    if (root !== null && root !== pkgRoot && knownRoots.has(root)) deps.add(root);
  }
  return [...deps].sort();
}
