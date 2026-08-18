// The lockstep guard for `ciValidate.ts`'s copies of two published
// extractor facts.
//
// WHY COPIES EXIST AT ALL. The gate wants to run the IDENTICAL published check
// the customer's runner runs — that is the "validated derived data" claim made
// auditable. It cannot import it: `@backthread/extractor`'s only export path is
// its root, which pulls in `version.js`, whose fallback branch calls
// `fileURLToPath(import.meta.url)`. esbuild lowers that to `__filename` as a
// module-level transform, and the Workers runtime has no such symbol — the upload
// fails validation before the code ever runs.
//
// So the guarantee degrades from "the same function" to "a function this test
// proves equivalent", and this file is that proof. Same shape, and the same
// reason, as `supabase/functions/filePaths.lockstep.test.ts`.
//
// ⚠ THIS TEST IMPORTS THE REAL PACKAGE. That is fine here and only here: tests run
// under tsx on Node, where `version.js` works. If this file ever stops importing
// `@backthread/extractor`, the lockstep is gone and the copies are free to drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_KINDS,
  FORBIDDEN_EDGE_KINDS,
  INFRA_MODULE_KINDS,
  MODULE_KINDS,
  DART_SOURCE_EXTENSIONS,
  ELIXIR_SOURCE_EXTENSIONS,
  GO_SOURCE_EXTENSIONS,
  JAVA_SOURCE_EXTENSIONS,
  KOTLIN_SOURCE_EXTENSIONS,
  PYTHON_SOURCE_EXTENSIONS,
  RUBY_SOURCE_EXTENSIONS,
  SOURCE_EXTENSIONS,
  SWIFT_SOURCE_EXTENSIONS,
  isValidFileRecord as publishedIsValidFileRecord,
  isWorkspaceManifestPath,
} from '@backthread/extractor';
import {
  INFRA_EDGE_KIND_VALUES,
  INFRA_MODULE_KIND_VALUES,
  KNOWN_LANGUAGES,
  WORKSPACE_MANIFEST_BASENAMES,
  isValidFileRecord,
  isWorkspaceManifestBasename,
} from './validate.js';

test('KNOWN_LANGUAGES equals the union of the published per-language extension lists', () => {
  const published = new Set<string>([
    ...SOURCE_EXTENSIONS,
    ...PYTHON_SOURCE_EXTENSIONS,
    ...RUBY_SOURCE_EXTENSIONS,
    ...ELIXIR_SOURCE_EXTENSIONS,
    ...DART_SOURCE_EXTENSIONS,
    ...KOTLIN_SOURCE_EXTENSIONS,
    ...SWIFT_SOURCE_EXTENSIONS,
    ...JAVA_SOURCE_EXTENSIONS,
    ...GO_SOURCE_EXTENSIONS,
    // The package exports every other language's list from its root but NOT
    // PHP_SOURCE_EXTENSIONS, so `php` is the one value neither side can derive.
    'php',
  ]);
  assert.deepEqual(
    [...KNOWN_LANGUAGES].sort(),
    [...published].sort(),
    'a new language in the extractor must be added to KNOWN_LANGUAGES, or its repos are refused',
  );
});

test('the local isValidFileRecord agrees with the published one on every case that matters', () => {
  const good = { loc: 1, language: 'ts', imports: [], externals: [], calls: [], reexports: [] };
  const cases: unknown[] = [
    good,
    { ...good, groupingPath: 'com/acme' },
    { ...good, blobSha: 'abc1234' },
    { ...good, imports: [{ to: 'src/a.ts', weight: 1 }] },
    { ...good, calls: [{ to: 'src/a.ts', weight: 2 }] },
    { ...good, externals: [{ id: 'ext:react', specifier: 'react', weight: 1 }] },
    { ...good, reexports: ['src/a.ts'] },
    // The shapes it accepts that a hostility check would not — pinned so the
    // transcription's LOOSENESS is proven identical too, not just its strictness.
    { ...good, loc: -5 },
    { ...good, loc: 1.5 },
    { ...good, imports: [{ to: 'src/a.ts', weight: Number.POSITIVE_INFINITY }] },
    { ...good, unknownKey: 'tolerated' },
    // Rejections.
    null,
    undefined,
    'nope',
    42,
    [],
    {},
    { loc: 1, language: 'ts' },
    { ...good, loc: '1' },
    { ...good, language: 5 },
    { ...good, imports: null },
    { ...good, imports: [{ to: 5, weight: 1 }] },
    { ...good, imports: [{ to: 'a' }] },
    { ...good, externals: [{ id: 'x', specifier: 'y' }] },
    { ...good, externals: [{ id: 'x', specifier: 5, weight: 1 }] },
    { ...good, calls: 'nope' },
    { ...good, reexports: [5] },
    { ...good, groupingPath: 5 },
  ];
  for (const c of cases) {
    assert.equal(
      isValidFileRecord(c),
      publishedIsValidFileRecord(c),
      `divergence on ${JSON.stringify(c)}`,
    );
  }
});

test('the corpus is not one-sided — it contains both accepted and rejected cases', () => {
  // Non-vacuity control. If every case were a rejection, a local function that
  // returned `false` unconditionally would pass the agreement test above.
  const good = { loc: 1, language: 'ts', imports: [], externals: [], calls: [], reexports: [] };
  assert.equal(isValidFileRecord(good), true);
  assert.equal(isValidFileRecord({}), false);
});

// ---------------------------------------------------------------------------
// The workspace-manifest basename allowlist
// ---------------------------------------------------------------------------
//
// This copy decides which paths the container is allowed to WRITE into its
// scratch tree, so a drift between it and the published predicate is not a
// cosmetic mismatch: too narrow and a legitimate monorepo's layout silently stops
// being detectable through the CI door, too wide and the payload gains a filename
// the layout detector never asked for.
//
// ⚠ WHAT THIS CAN AND CANNOT CATCH, SINCE THE PUBLISHED SET IS NOT EXPORTED.
// `@backthread/extractor` exports the PREDICATE (`isWorkspaceManifestPath`) but
// not `WORKSPACE_MANIFEST_BASENAMES` itself, so there is no way to enumerate the
// original and diff it. What this test does instead is assert agreement over a
// CORPUS: every basename in our copy, plus a wide list of manifest names from
// ecosystems the extractor might plausibly grow into, plus ordinary source files.
//
// So it catches our copy drifting AND the extractor adding any basename on the
// candidate list. It would NOT catch the extractor adding a manifest name nobody
// thought to put in the corpus — and the cost of that miss is the safe direction:
// a repo whose layout is defined by the new manifest type gets a visible
// `not_a_workspace_manifest` refusal on its runner, not a wrong answer.

const CANDIDATE_BASENAMES = [
  // ours
  ...WORKSPACE_MANIFEST_BASENAMES,
  // plausible additions the extractor does not (yet) recognise
  'go.mod',
  'go.work',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'Gemfile.lock',
  'requirements.txt',
  'Pipfile',
  'poetry.lock',
  'build.sbt',
  'pom.xml',
  'deno.json',
  'deno.jsonc',
  'bun.lockb',
  'rush.json',
  'workspace.json',
  'project.json',
  'BUILD.bazel',
  'WORKSPACE',
  'CMakeLists.txt',
  'Package.swift',
  'flake.nix',
  // ordinary files, which must never be admitted
  'index.ts',
  'tsconfig.json',
  '.npmrc',
  '.env',
  'README.md',
  'Makefile',
  'Dockerfile',
];

test('the workspace-manifest basename copy agrees with the published predicate', () => {
  const disagreements: string[] = [];
  for (const base of CANDIDATE_BASENAMES) {
    for (const path of [base, `packages/core/${base}`, `a/b/c/${base}`]) {
      const mine = isWorkspaceManifestBasename(path);
      const published = isWorkspaceManifestPath(path);
      if (mine !== published) disagreements.push(`${path}: copy=${mine} published=${published}`);
    }
  }
  assert.deepEqual(disagreements, []);
});

test('the copy is not vacuous — it admits real manifests and refuses real source files', () => {
  // Without this, a copy that returned `false` for everything would pass the
  // agreement test above only if the published one did too, which is exactly the
  // kind of mutual-nothing a lockstep is prone to certifying.
  assert.equal(isWorkspaceManifestBasename('package.json'), true);
  assert.equal(isWorkspaceManifestBasename('packages/core/package.json'), true);
  assert.equal(isWorkspaceManifestBasename('pnpm-workspace.yaml'), true);
  assert.equal(isWorkspaceManifestBasename('src/index.ts'), false);
  assert.equal(isWorkspaceManifestBasename('go.mod'), false);
  assert.ok(WORKSPACE_MANIFEST_BASENAMES.size >= 15);
});

test('a basename match is not a substring match', () => {
  // `notpackage.json` and `package.json.bak` both contain the allowed name. The
  // published predicate splits on `/` and compares the last segment exactly; a
  // copy that used `endsWith` or `includes` would admit both, and each is a
  // filename a producer chooses.
  for (const p of ['notpackage.json', 'package.json.bak', 'dir/xpackage.json', 'package.jsonx']) {
    assert.equal(isWorkspaceManifestBasename(p), false, p);
    assert.equal(isWorkspaceManifestPath(p), false, p);
  }
});

// ---------------------------------------------------------------------------
// The two locked enums the infra tier validates against.
//
// ⚠ THIS IS THE RUNTIME HALF OF A TWO-PART GUARD, AND THE OTHER HALF IS STRONGER.
// `ciValidate.ts` writes these as `Record<InfraModuleKind, true>` and
// `Record<EdgeKind, true>`, keyed by the PUBLISHED TYPES — so `tsc` already refuses
// a missing member or an invented one. What tsc cannot see is a member the package
// adds at RUNTIME to an array whose type is also widened in the same release, which
// is what these assert. A `Set<string>` of literals would have had neither.
// ---------------------------------------------------------------------------

test('the infra-kind copy equals the published INFRA_MODULE_KINDS', () => {
  assert.deepEqual([...INFRA_MODULE_KIND_VALUES].sort(), [...INFRA_MODULE_KINDS].sort());
  // Not vacuous: both must be non-empty, or two empty lists agree perfectly.
  assert.ok(INFRA_MODULE_KIND_VALUES.length === 8, 'the 8 infra kinds are locked');
});

test('the infra-EDGE-kind copy equals the published EDGE_KINDS — the 8-verb taxonomy', () => {
  assert.deepEqual([...INFRA_EDGE_KIND_VALUES].sort(), [...EDGE_KINDS].sort());
  assert.ok(INFRA_EDGE_KIND_VALUES.length === 8, 'the 8 verbs are locked');
});

test('the infra-kind copy is a STRICT SUBSET of MODULE_KINDS, never equal to it', () => {
  // The infra door may only ever admit the eight INFRA kinds. `parseModuleKind`
  // would happily accept `frontend`; validating against MODULE_KINDS here would let
  // a payload declare a code module through the infra door.
  const all = new Set<string>(MODULE_KINDS);
  for (const k of INFRA_MODULE_KIND_VALUES) assert.ok(all.has(k), k);
  assert.ok(INFRA_MODULE_KIND_VALUES.length < MODULE_KINDS.length);
});

test('no FORBIDDEN edge verb is admissible through the infra door', () => {
  // `imports` / `depends-on` / `uses` are substrate-only. They are absent from
  // EDGE_KINDS by construction, and this asserts the construction rather than
  // trusting it.
  for (const forbidden of FORBIDDEN_EDGE_KINDS) {
    assert.ok(!INFRA_EDGE_KIND_VALUES.includes(forbidden), forbidden);
  }
  assert.ok(FORBIDDEN_EDGE_KINDS.length > 0, 'precondition: there ARE forbidden verbs to check');
});
