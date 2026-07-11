// Python manifest parsing ( FastAPI detect ·  workspaces) —
// install-free + deterministic. Reads dependency + workspace declarations from
// pyproject.toml / requirements*.txt WITHOUT installing anything, the Python
// analogue of the framework detect-util `readDeps` for package.json. PURE: it
// touches only the manifest, never application source (never-store-source), and
// never spawns a resolver.
//
// TOML is parsed with `smol-toml` (already in the tree as pyright-internal's own
// dep; declared as a direct devDependency so a pyright bump can't drop it). A
// malformed manifest degrades to empty rather than throwing — a broken pyproject
// must never sink detection.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

/** PEP 503 normalized distribution name: lowercase, runs of `-_.` → single `-`. */
export function normalizePyName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The distribution NAME from one PEP 508 / requirements requirement line:
 *   'fastapi[standard]>=0.1; python_version<"3.9"'  → 'fastapi'
 *   'git+https://github.com/x/y#egg=foo'            → 'foo'
 * Returns undefined for a non-name line (blank, comment, `-r`/`-e`/option, or a
 * bare URL with no `#egg=`).
 */
export function requirementName(spec: string): string | undefined {
  let s = spec.trim();
  if (!s || s.startsWith('#')) return undefined;
  // Strip a trailing inline comment (` #…`), then reject option/include lines.
  const cmt = s.indexOf(' #');
  if (cmt >= 0) s = s.slice(0, cmt).trim();
  if (!s || s.startsWith('-')) return undefined;
  // A URL/VCS requirement only names a package via `#egg=`.
  if (s.includes('://')) {
    const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(s);
    return egg ? normalizePyName(egg[1]) : undefined;
  }
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s);
  return m ? normalizePyName(m[1]) : undefined;
}

// A poetry-style dependency table: keys are distribution names (values are
// version constraints / tables). `python` is the interpreter pin, not a dep.
function addPoetryTableNames(table: unknown, into: Set<string>): void {
  if (!table || typeof table !== 'object') return;
  for (const name of Object.keys(table as Record<string, unknown>)) {
    if (name.toLowerCase() === 'python') continue;
    const n = normalizePyName(name);
    if (n) into.add(n);
  }
}

function addRequirementList(list: unknown, into: Set<string>): void {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (typeof item !== 'string') continue; // PEP 735 {include-group} entries skipped
    const n = requirementName(item);
    if (n) into.add(n);
  }
}

/**
 * Every declared third-party distribution name (PEP 503 normalized) under
 * `baseDir`, across the layouts the Python ecosystem actually uses:
 *   • PEP 621   `[project].dependencies` + `[project.optional-dependencies].*`
 *   • PEP 735   `[dependency-groups].*` (string entries)
 *   • Poetry    `[tool.poetry.dependencies]`, `.dev-dependencies`, `.group.*.dependencies`
 *   • pip       `requirements*.txt` in the dir
 * Never throws. Detection asks membership (`deps.has('fastapi')`); it does not
 * need versions, so only names are returned.
 */
export function readPythonDeps(baseDir: string): Set<string> {
  const names = new Set<string>();

  try {
    const pyprojectPath = join(baseDir, 'pyproject.toml');
    if (existsSync(pyprojectPath)) {
      const t = parseToml(readFileSync(pyprojectPath, 'utf8')) as Record<string, unknown>;
      const project = (t.project as Record<string, unknown>) ?? {};
      addRequirementList(project.dependencies, names);
      const optional = project['optional-dependencies'];
      if (optional && typeof optional === 'object') {
        for (const grp of Object.values(optional as Record<string, unknown>)) addRequirementList(grp, names);
      }
      const groups = t['dependency-groups'];
      if (groups && typeof groups === 'object') {
        for (const grp of Object.values(groups as Record<string, unknown>)) addRequirementList(grp, names);
      }
      const poetry = ((t.tool as Record<string, unknown>)?.poetry as Record<string, unknown>) ?? {};
      addPoetryTableNames(poetry.dependencies, names);
      addPoetryTableNames(poetry['dev-dependencies'], names);
      const poetryGroups = poetry.group;
      if (poetryGroups && typeof poetryGroups === 'object') {
        for (const g of Object.values(poetryGroups as Record<string, unknown>)) {
          addPoetryTableNames((g as Record<string, unknown>)?.dependencies, names);
        }
      }
    }
  } catch {
    // Malformed pyproject → skip it; requirements*.txt may still name deps.
  }

  try {
    for (const entry of readdirSync(baseDir)) {
      if (!/^requirements.*\.txt$/i.test(entry)) continue;
      let text: string;
      try {
        text = readFileSync(join(baseDir, entry), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const n = requirementName(line);
        if (n) names.add(n);
      }
    }
  } catch {
    // baseDir unreadable — return whatever pyproject gave.
  }

  return names;
}
