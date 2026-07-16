// deterministic NOISE FILTERING before clustering.
//
// The module graph should describe ARCHITECTURE, not the scaffolding around it.
// Tests, generated code, build output, config, stories, and mocks ingested as
// modules inflate boxes, blur domains, and pull the directory-primary subsystem
// grouping toward meaningless buckets. This pass classifies every file
// by its repo-relative POSIX path and drops the noise BEFORE clustering —
// config-driven (one ordered rule table below), deterministic, and LOGGED by
// category at the call sites (house rule: never a silent cap).
//
// WHERE IT RUNS (the graph stage, never the twins): applied to the assembled
// NormalizedGraph at every graph-stage exit toward clustering — extractGraph
// (the full-extract path: cli + container single-window + changelog A/B) and the
// incremental engine's seed/patch returns (the merge-walk path). It is NOT
// applied inside graphFromState or the ts-morph adapter: those stay PURE
// assemblers, and the carried FileGraphState keeps ALL files (filtering is an
// OUTPUT concern only). That keeps incremental patching + the blob parse-cache
// unaffected, and preserves the Stage-A/B equivalence contract by construction —
// filterNoise is a PURE, DETERMINISTIC function of the (identical) unfiltered
// graph, so applying it identically on both the incremental and full-extract
// sides cannot break their equality.
//
// Dropped files are RETAINED in the returned summary's `files` list (a cheap,
// queryable side channel) so the drop is auditable, not just a count.

import type { GraphEdge, NormalizedGraph } from './types.js';

export type NoiseCategory =
  | 'test'
  | 'generated'
  | 'stories'
  | 'mocks'
  | 'config'
  | 'types'
  | 'build';

/** Every category, in a stable order (drives empty-count init + log order). */
export const NOISE_CATEGORIES: readonly NoiseCategory[] = [
  'test',
  'generated',
  'stories',
  'mocks',
  'config',
  'types',
  'build',
] as const;

export interface NoiseRule {
  category: NoiseCategory;
  /** Human-readable description of what this rule targets (logs/docs). */
  description: string;
  /** True when a repo-relative POSIX path is noise of this category. */
  match: (path: string) => boolean;
}

// --- path helpers ----------------------------------------------------------

/** Directory segments of a repo-relative posix path (excludes the basename). */
function dirSegments(path: string): string[] {
  return path.split('/').slice(0, -1);
}

function hasDirSegment(path: string, dirs: ReadonlySet<string>): boolean {
  return dirSegments(path).some((s) => dirs.has(s));
}

// Source-file extension class shared by the basename matchers: ts/tsx/js/jsx +
// the m*/c* ESM/CJS variants (mts/cts/mjs/cjs). Mirrors SOURCE_EXTENSIONS.
const SRC_EXT = '[cm]?[jt]sx?';

const TEST_DIRS = new Set(['__tests__']);
const GENERATED_DIRS = new Set(['__generated__']);
const MOCK_DIRS = new Set(['__mocks__', '__fixtures__']);
// Build output. Most are already skipped upstream (the adapter's EXCLUDE_DIRS /
// dot-segment glob), but the rule is explicit + defensive so the policy is
// self-contained and robust to glob changes.
const BUILD_DIRS = new Set(['dist', 'build', 'out', 'coverage', '.next', '.expo']);

const TEST_FILE_RE = new RegExp(`\\.(test|spec)\\.${SRC_EXT}$`);
const GENERATED_FILE_RE = new RegExp(`\\.(gen|generated)\\.${SRC_EXT}$`);
const STORIES_FILE_RE = new RegExp(`\\.(stories|story)\\.${SRC_EXT}$`);
const MOCK_FILE_RE = new RegExp(`\\.(mock|fixture)s?\\.${SRC_EXT}$`);
const CONFIG_FILE_RE = new RegExp(`\\.config\\.${SRC_EXT}$`);
const DTS_FILE_RE = /\.d\.[cm]?ts$/;

// Python noise. The regexes above are all `.<ext>`-suffixed with the
// TS SRC_EXT class, so a `.py` path never matches any of them — Python needs its
// own rule shapes. Conventions: pytest/unittest use `tests/` + `test/` dirs and
// `test_*.py` / `*_test.py` / `conftest.py`; Django + Alembic emit schema
// migrations into `migrations/`; `setup.py` is packaging config, not architecture.
const PYTHON_TEST_DIRS = new Set(['tests', 'test']);
const PYTHON_MIGRATION_DIRS = new Set(['migrations']);
const PYTHON_TEST_FILE_RE = /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.pyi?$/;
const PYTHON_SETUP_RE = /(^|\/)setup\.py$/;

// Swift noise. SwiftPM puts test targets in a CAPITALIZED `Tests/` dir (the
// lowercase `test`/`tests` dirs the Python rule catches don't cover it), and XCTest
// / Quick test files are conventionally `<Name>Tests.swift` / `<Name>Spec.swift`
// (the plural `Tests` matches the XCTestCase-subclass naming convention; an Xcode
// `<App>UITests.swift` is caught by the same suffix). The TS/Python file regexes
// never match a `.swift` path, so Swift needs its own shapes. `*Test.swift`
// (singular) is deliberately NOT matched — it would drop a legit feature like
// `ABTest.swift`; a real unit test is plural or lives under a Tests dir.
const SWIFT_TEST_DIRS = new Set(['Tests']);
const SWIFT_TEST_FILE_RE = /(^|\/)[^/]*(Tests|Spec)\.swift$/;

// --- the rule table (config-driven; ORDERED — first match wins for the
// category label; a file is dropped regardless of which rule claims it) -------

export const NOISE_RULES: readonly NoiseRule[] = [
  {
    category: 'test',
    description: '__tests__/ dirs and *.test.* / *.spec.* files',
    match: (p) => hasDirSegment(p, TEST_DIRS) || TEST_FILE_RE.test(p),
  },
  {
    category: 'generated',
    description: '__generated__/ dirs and *.gen.* / *.generated.* codegen output',
    match: (p) => hasDirSegment(p, GENERATED_DIRS) || GENERATED_FILE_RE.test(p),
  },
  {
    category: 'stories',
    description: '*.stories.* / *.story.* component stories',
    match: (p) => STORIES_FILE_RE.test(p),
  },
  {
    category: 'mocks',
    description: '__mocks__/ + __fixtures__/ dirs and *.mock.* / *.fixture.* files',
    match: (p) => hasDirSegment(p, MOCK_DIRS) || MOCK_FILE_RE.test(p),
  },
  {
    category: 'config',
    description: '*.config.* tool config (vite/jest/tailwind/… config modules)',
    match: (p) => CONFIG_FILE_RE.test(p),
  },
  {
    category: 'types',
    description: 'redundant *.d.ts / *.d.mts / *.d.cts declaration files',
    match: (p) => DTS_FILE_RE.test(p),
  },
  {
    category: 'build',
    description: 'build output dirs (dist/ build/ out/ coverage/ .next/ .expo/)',
    match: (p) => hasDirSegment(p, BUILD_DIRS),
  },
  {
    category: 'test',
    description: 'Python tests: tests/ + test/ dirs and test_*.py / *_test.py / conftest.py',
    match: (p) => hasDirSegment(p, PYTHON_TEST_DIRS) || PYTHON_TEST_FILE_RE.test(p),
  },
  {
    category: 'generated',
    description: 'Python migrations/ dirs (Django + Alembic schema migrations)',
    match: (p) => hasDirSegment(p, PYTHON_MIGRATION_DIRS),
  },
  {
    category: 'config',
    description: 'Python setup.py packaging config',
    match: (p) => PYTHON_SETUP_RE.test(p),
  },
  {
    category: 'test',
    description: 'Swift tests: SwiftPM Tests/ dirs and *Tests.swift / *Spec.swift (XCTest/Quick)',
    match: (p) => hasDirSegment(p, SWIFT_TEST_DIRS) || SWIFT_TEST_FILE_RE.test(p),
  },
];

/**
 * The noise category of a repo-relative posix path, or null if it is legitimate
 * source. Pure; first matching rule wins. Exported for unit tests + callers that
 * want to classify without filtering a whole graph.
 */
export function classifyNoise(path: string): NoiseCategory | null {
  for (const rule of NOISE_RULES) {
    if (rule.match(path)) return rule.category;
  }
  return null;
}

// --- the filter ------------------------------------------------------------

export interface DroppedNoise {
  /** Total files dropped. */
  total: number;
  /** Per-category drop counts (every category present, 0 when none). */
  byCategory: Record<NoiseCategory, number>;
  /** Internal/external edges removed because an endpoint was dropped. */
  edgesDropped: number;
  /** The dropped files (queryable side list): path + the category that claimed it. */
  files: { path: string; category: NoiseCategory }[];
}

function emptyCounts(): Record<NoiseCategory, number> {
  const c = {} as Record<NoiseCategory, number>;
  for (const cat of NOISE_CATEGORIES) c[cat] = 0;
  return c;
}

/**
 * Drop noise nodes (tests/generated/build/config/stories/mocks/types) from a
 * NormalizedGraph, along with any edge whose endpoint left, and any external
 * referenced ONLY by dropped files. Pure + deterministic (output order follows
 * the input's file/edge order). Returns the filtered graph plus an auditable
 * drop summary. When nothing matches, the SAME graph object is returned
 * (referential stability for the common no-noise case).
 */
export function filterNoise(graph: NormalizedGraph): { graph: NormalizedGraph; dropped: DroppedNoise } {
  const byCategory = emptyCounts();
  const droppedFiles: { path: string; category: NoiseCategory }[] = [];
  const keep = new Set<string>();

  for (const f of graph.files) {
    const cat = classifyNoise(f.id);
    if (cat) {
      byCategory[cat] += 1;
      droppedFiles.push({ path: f.id, category: cat });
    } else {
      keep.add(f.id);
    }
  }

  if (droppedFiles.length === 0) {
    return { graph, dropped: { total: 0, byCategory, edgesDropped: 0, files: [] } };
  }

  const files = graph.files.filter((f) => keep.has(f.id));
  const edges: GraphEdge[] = [];
  const usedExternals = new Set<string>();
  let edgesDropped = 0;
  for (const e of graph.edges) {
    if (!keep.has(e.from)) {
      edgesDropped += 1;
      continue;
    }
    if (e.external) {
      usedExternals.add(e.to);
      edges.push(e);
    } else if (keep.has(e.to)) {
      edges.push(e);
    } else {
      // internal edge into a dropped node — remove cleanly (no dangling endpoint)
      edgesDropped += 1;
    }
  }
  // Prune externals nothing kept references anymore (e.g. vitest / testing-library
  // imported only from tests) — keeps the externals list dangle-free + meaningful.
  const externals = graph.externals.filter((x) => usedExternals.has(x.id));

  return {
    graph: { root: graph.root, files, edges, externals },
    dropped: { total: droppedFiles.length, byCategory, edgesDropped, files: droppedFiles },
  };
}

/** One-line log summary of a drop result (only meaningful when total > 0). */
export function summarizeNoise(dropped: DroppedNoise): string {
  const parts = NOISE_CATEGORIES.filter((c) => dropped.byCategory[c] > 0).map(
    (c) => `${c}: ${dropped.byCategory[c]}`,
  );
  return `noise filter dropped ${dropped.total} file(s) [${parts.join(', ')}] + ${dropped.edgesDropped} edge(s)`;
}
